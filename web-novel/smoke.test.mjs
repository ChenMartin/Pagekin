import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createReadStream } from 'node:fs'
import { test } from 'node:test'
import { crc32 } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { desktopCopy } from './desktop-copy.mjs'
import { hash, openStore } from './store.mjs'
import { splitManuscript } from './public/manuscript.mjs'
import { backupDatabase, restoreDatabase, verifyDatabase } from './maintenance.mjs'
import { releaseVersion } from './version.mjs'

const password = 'test-password-local-only'

function storedDesktopArchive(database, expectedHash = hash(database)) {
  const manifest = Buffer.from(JSON.stringify({
    formatVersion: 1, sourceSchemaVersion: 9,
    declaredCompressedBytes: database.length, declaredUncompressedBytes: database.length,
    entries: [{ path: 'project.db', byteSize: database.length, sha256: expectedHash, disposition: 'portable-database' }],
  }))
  const records = [['manifest.json', manifest], ['project.db', database]]
  const local = []
  const central = []
  let offset = 0
  for (const [index, [name, data]] of records.entries()) {
    const filename = Buffer.from(name)
    const checksum = crc32(data)
    const flags = index ? 0x808 : 0x800
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(flags, 6)
    if (!index) {
      header.writeUInt32LE(checksum, 14)
      header.writeUInt32LE(data.length, 18)
      header.writeUInt32LE(data.length, 22)
    }
    header.writeUInt16LE(filename.length, 26)
    const descriptor = Buffer.alloc(index ? 16 : 0)
    if (index) [0x08074b50, checksum, data.length, data.length].forEach((value, i) => descriptor.writeUInt32LE(value, i * 4))
    local.push(header, filename, data, descriptor)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(0x314, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(flags, 8)
    entry.writeUInt32LE(checksum, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(filename.length, 28)
    entry.writeUInt32LE(0x81800000, 38)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, filename)
    offset += header.length + filename.length + data.length + descriptor.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(records.length, 8)
  end.writeUInt16LE(records.length, 10)
  end.writeUInt32LE(central.reduce((sum, item) => sum + item.length, 0), 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

async function launch(directory, port) {
  const entry = process.env.PAGEKIN_TEST_APP_DIR
    ? join(process.env.PAGEKIN_TEST_APP_DIR, 'server.mjs')
    : fileURLToPath(new URL('./server.mjs', import.meta.url))
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env, APP_PASSWORD: password, APP_PASSWORD_FILE: '', APP_SECURE_COOKIE: '0',
      APP_HOST: '127.0.0.1', APP_ORIGIN: '', APP_DATA_DIR: directory, PORT: '0', LLM_MODEL: 'test',
      LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, LLM_API_KEY: '', LLM_CONTEXT_CHARS: '8000',
      EMBEDDING_BASE_URL: `http://127.0.0.1:${port}/v1`, EMBEDDING_MODEL: 'embedding-test', EMBEDDING_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const ready = once(child.stdout, 'data').then(([buffer]) => JSON.parse(buffer.toString().trim().split('listening on ')[1]))
  try {
    const { port } = await Promise.race([
      ready,
      once(child, 'exit').then(() => { throw new Error('Web server exited before listen') }),
      delay(5000, null, { ref: false }).then(() => { throw new Error('Web server start timed out') }),
    ])
    return { child, base: `http://127.0.0.1:${port}` }
  } catch (error) { child.kill(); throw error }
}

async function stop(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return
  const exit = once(server.child, 'exit')
  server.child.kill()
  await exit
}

async function readProjectEvent(url, cookie, cursor) {
  const response = await fetch(url, { headers: { Cookie: cookie, ...(cursor === undefined ? {} : { 'Last-Event-ID': cursor }) },
    signal: AbortSignal.timeout(4000) })
  assert.equal(response.status, 200)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let text = ''
  try {
    while (!text.includes('\n\n')) {
      const { done, value } = await reader.read()
      if (done) assert.fail('Event stream ended without an event')
      text += value
    }
    return text.split('\n\n')[0]
  } finally { await reader.cancel() }
}

test('novel workflow through HTTP across devices, generation, export and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pagekin-web-smoke-'))
  let upstreamCalls = 0
  let embeddingCalls = 0
  let lastPrompt = ''
  const revisedProse = '保留开场\n船已离港。\n\n雾从海面升起。\n灯塔整夜发亮。\n'
  const reviewIssue = { title: '补足场景动作', severity: 'major', quote: '电脑上的稿', reason: '场景过于简略', suggestion: '补写登船动作' }
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const part of req) chunks.push(part)
    const input = JSON.parse(Buffer.concat(chunks))
    if (req.url === '/v1/embeddings') {
      embeddingCalls++
      assert.equal(input.model, 'embedding-test')
      assert.ok(input.input.length <= 8)
      if (embeddingCalls === 2) {
        res.writeHead(503)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const vector = text => /灯塔建于|如何找到海岸标志/.test(text) ? [1, 0, 0] : [0, 1, 0]
      // A compatible endpoint may return the array in a different order.
      res.end(JSON.stringify({ data: input.input.map((text, index) => ({ index, embedding: vector(text) })).reverse() }))
      return
    }
    upstreamCalls++
    lastPrompt = input.messages.at(-1).content
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const instruction = input.messages[0].content
    let output = '候选正文'
    if (instruction.includes('生成写前细纲')) output = '1. 抵达灯塔并核对钥匙。'
    if (instruction.includes('返回修订后的完整正文') && lastPrompt.includes('逐段合并')) output = revisedProse
    if (instruction.includes('审查当前正文')) {
      output = lastPrompt.includes('纯文本回退') ? '这里是一条纯文本意见。' : '```json\n' + JSON.stringify({ issues: [
        reviewIssue,
        { ...reviewIssue, title: '引文重复', severity: 'minor', quote: '电脑' },
        { ...reviewIssue, title: '引文缺失', quote: '离开灯塔' },
      ] }) + '\n```'
    }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: output } }] }) + '\n\n')
    if (lastPrompt.includes('hold')) return
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  let server
  let a = ''
  let b = ''
  async function request(path, { method = 'GET', value, cookie = a, status = 200, origin } = {}) {
    const response = await fetch(server.base + path, {
      method, headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}),
        ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: value === undefined ? undefined : JSON.stringify(value),
    })
    const result = (response.headers.get('content-type') || '').includes('application/json')
      ? await response.json() : await response.text()
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result).slice(0, 600)}`)
    return { result, response }
  }
  try {
    server = await launch(directory, upstream.address().port)
    const page = await request('/')
    assert.match(page.result, /小说工作区/)
    if (process.env.PAGEKIN_TEST_EDITOR === 'enhanced') {
      const nonce = /<meta name="editor-style-nonce" content="([A-Za-z0-9+/=]+)">/.exec(page.result)?.[1]
      assert.ok(nonce)
      assert.match(page.response.headers.get('content-security-policy'), /style-src 'self' 'nonce-[A-Za-z0-9+/=]+'/)
      assert.ok(page.response.headers.get('content-security-policy').includes("'nonce-" + nonce + "'"))
      assert.match((await request('/editor.bundle.mjs')).result, /createEditor/)
      assert.match((await request('/editor.notices.txt')).result, /@codemirror\/view/)
    }
    assert.deepEqual((await request('/healthz')).result, { ok: true, version: releaseVersion })
    await request('/api/projects', { status: 401 })
    await request('/api/session', { method: 'POST', value: { password }, status: 403, origin: 'http://evil.test' })
    await request('/api/session', { method: 'POST', value: { password: 'incorrect' }, status: 401 })
    const login = async () => (await request('/api/session', { method: 'POST', value: { password }, cookie: '' }))
      .response.headers.get('set-cookie').split(';')[0]
    a = await login()
    b = await login()
    assert.notEqual(a, b)
    const { result: project } = await request('/api/projects', { method: 'POST', value: { title: '夜航' }, status: 201 })
    const { result: second } = await request('/api/projects', { method: 'POST', value: { title: '其他作品' }, status: 201 })
    const importPath = '/api/projects/' + second.id + '/chapter-imports'
    const importRequest = { mutationId: randomUUID(), chapters: [
      { title: '启航', number: 1, body: '序章正文' }, { title: '回港', number: 2, body: '第二章正文' },
    ] }
    const options = { method: 'POST', value: importRequest, status: 201 }
    const imports = await Promise.all([request(importPath, options), request(importPath, { ...options, cookie: b })])
    assert.deepEqual(imports[0].result, imports[1].result)
    await request(importPath, { method: 'POST', status: 422,
      value: { ...importRequest, chapters: [{ title: '不同内容', number: 1, body: '不能复用编号' }] } })
    const rejected = await request(importPath, { method: 'POST', status: 409, value: {
      mutationId: randomUUID(), chapters: [{ title: '新稿', number: 3, body: '' }, { title: '冲突', number: 2, body: '' }],
    } })
    assert.deepEqual(rejected.result.current.occupied, [2])
    const otherDocs = (await request('/api/projects/' + second.id + '/documents')).result
    assert.deepEqual(otherDocs.map(doc => doc.number), [1, 2])
    const base = '/api/projects/' + project.id
    assert.equal((await request(base, { method: 'PATCH', value: { title: '夜间航行', baseTitle: '夜航' } })).result.title, '夜间航行')
    await request(base, { method: 'PATCH', cookie: b, status: 409, value: { title: '旧书名', baseTitle: '夜航' } })
    const docs = base + '/documents'
    const create = value => request(docs, { method: 'POST', value, status: 201 }).then(res => res.result)
    const plotThread = { title: '灯塔里的旧钥匙', body: '钥匙能打开阁楼', kind: 'foreshadow', status: 'open', planted: 1, due: 2 }
    const { result: thread } = await request(base + '/threads', { method: 'POST', status: 201, value: plotThread })
    await request(base + '/threads/' + thread.id, { method: 'PUT', status: 400,
      value: { ...plotThread, status: 'resolved', baseRev: 1 } })
    const chosen = (await request(base + '/references', { method: 'POST', status: 201,
      value: { title: '灯塔史', body: '开头不相关的地理信息'.repeat(300) + '灯塔建于一百年前' } })).result
    await request(base + '/references', { method: 'POST', status: 201, value: { title: '私人笔记', body: '此条未选中' } })
    await request('/api/projects/' + second.id + '/references/' + chosen.id, { status: 404 })
    await request(base + '/semantic/search', { method: 'POST', status: 422, value: { q: '如何找到海岸标志' } })
    assert.equal(embeddingCalls, 0)
    async function buildReferenceIndex() {
      await request(base + '/semantic/index', { method: 'POST', status: 202, value: {} })
      for (let attempt = 0; attempt < 40; attempt++) {
        const state = (await request(base + '/semantic')).result
        if (state.state !== 'running') return state
        await delay(50)
      }
      assert.fail('Semantic index did not finish')
    }
    const failedIndex = await buildReferenceIndex()
    assert.equal(failedIndex.state, 'failed')
    assert.equal(failedIndex.indexed, 1)
    const semanticState = await buildReferenceIndex()
    assert.equal(semanticState.state, 'complete', JSON.stringify(semanticState))
    assert.equal(semanticState.indexed, 2)
    assert.equal(embeddingCalls, 3)
    const callsAfterIndex = embeddingCalls
    await request(base + '/semantic/index', { method: 'POST', status: 202, value: {} })
    assert.equal(embeddingCalls, callsAfterIndex)
    await request('/api/projects/' + second.id + '/semantic/search',
      { method: 'POST', status: 422, value: { q: '如何找到海岸标志' } })
    assert.equal(embeddingCalls, callsAfterIndex)
    const semanticHits = (await request(base + '/semantic/search', { method: 'POST', value: { q: '如何找到海岸标志' } })).result
    const hit = semanticHits[0]
    assert.equal(hit.id, chosen.id)
    assert.match(hit.excerpt, /灯塔建于/)
    const settings = await create({ kind: 'settings', title: '世界观', body: '港口常年起雾' })
    await create({ kind: 'character', title: '小舟', body: '船长' })
    await create({ kind: 'blueprint', number: 1, title: '寻找线索', body: '主角抵达码头' })
    const chapter = await create({ kind: 'chapter', number: 1, title: '抵达', body: '原稿' })
    const doc = docs + '/' + chapter.id
    const span = { id: hit.id, start: hit.start, end: hit.end }
    const selectedContext = { kind: 'draft', baseRev: 1, referenceIds: [chosen.id], referenceSpans: [span] }
    const preview = (await request(doc + '/context', { method: 'POST', value: selectedContext })).result.messages.at(-1).content
    assert.ok(preview.includes(hit.excerpt))
    await request(doc + '/context', { method: 'POST', status: 400,
      value: { ...selectedContext, referenceSpans: [{ id: hit.id, start: chosen.body.length, end: chosen.body.length + 10 }] } })
    const eventUrl = server.base + base + '/events'
    const initial = await readProjectEvent(eventUrl, b)
    assert.match(initial, /event: sync/)
    const cursor = /^id: (\d+)/.exec(initial)[1]
    await request('/api/projects/' + second.id + '/documents/' + chapter.id, { status: 404 })
    const save = { title: '抵达', body: '电脑上的稿\n合上电脑。', baseRev: 1, mutationId: randomUUID() }
    const receipt = (await request(doc, { method: 'PUT', value: save })).result
    assert.equal(receipt.rev, 2)
    const event = await readProjectEvent(eventUrl, b, cursor)
    assert.match(event, /event: document/)
    assert.deepEqual(JSON.parse(event.split('data: ')[1]), { id: chapter.id, rev: 2 })
    assert.deepEqual((await request(doc, { method: 'PUT', value: save, cookie: b })).result, receipt)
    await request(doc, { method: 'PUT', value: { ...save, body: '不同内容' }, status: 422 })
    const stale = await request(doc, { method: 'PUT', cookie: b, status: 409,
      value: { ...save, body: '手机旧稿', mutationId: randomUUID() } })
    assert.equal(stale.result.current.body, save.body)
    const run = async (kind, baseRev, guidance = '') => {
      const value = { kind, baseRev, guidance, mutationId: randomUUID() }
      const { result } = await request(doc + '/runs', { method: 'POST', value, status: 202 })
      await request(doc + '/runs', { method: 'POST', value, status: 202 })
      return base + '/runs/' + result.id
    }
    async function awaitRun(path, accept) {
      for (let tries = 0; tries < 50; tries++) {
        const { result } = await request(path, { cookie: b })
        if (accept(result)) return result
        await delay(30)
      }
      assert.fail('job did not reach expected state')
    }
    const staleRun = await run('revise', 2)
    await awaitRun(staleRun, job => job.status === 'done')
    assert.match(lastPrompt, /港口常年起雾/)
    assert.match(lastPrompt, /主角抵达码头/)
    assert.equal(upstreamCalls, 1)
    const staleMerge = (await request(staleRun + '/merge')).result
    await request(docs + '/' + settings.id, { method: 'PUT',
      value: { title: settings.title, body: '晴天', baseRev: 1, mutationId: randomUUID() } })
    await request(staleRun + '/apply', { method: 'POST', status: 409 })
    await request(staleRun + '/merge', { method: 'POST', value: { plan: staleMerge.plan, picks: [0] }, status: 409 })
    assert.equal((await request(doc + '/history')).result.some(item => item.rev === 2), false)
    const review = await run('review', 2)
    const reviewResult = await awaitRun(review, job => job.status === 'done')
    assert.deepEqual(reviewResult.reviewReport.issues[0], { ...reviewIssue, evidence: 'verified' })
    assert.deepEqual(reviewResult.reviewReport.issues.map(issue => issue.evidence), ['verified', 'ambiguous', 'missing'])
    assert.equal((await request(doc + '/history')).result.find(item => item.rev === 2).reason, 'before-review')
    await request(review + '/apply', { method: 'POST', status: 422 })
    const rawReview = await run('review', 2, '纯文本回退')
    const rawReviewResult = await awaitRun(rawReview, job => job.status === 'done')
    assert.equal(rawReviewResult.output, '这里是一条纯文本意见。')
    assert.equal(rawReviewResult.reviewReport, undefined)
    const revise = await run('revise', 2)
    assert.equal((await awaitRun(revise, job => job.status === 'done')).output, '候选正文')
    assert.equal((await request(doc)).result.body, save.body)
    assert.equal((await request(revise + '/apply', { method: 'POST' })).result.rev, 3)
    assert.equal((await request(revise + '/apply', { method: 'POST' })).result.rev, 3)
    assert.deepEqual((await request(review)).result.reviewReport, reviewResult.reviewReport)
    const paused = await run('draft', 3, 'hold')
    await awaitRun(paused, job => !!job.output)
    await request(paused + '/cancel', { method: 'POST' })
    assert.equal((await awaitRun(paused, job => job.status === 'cancelled')).output, '候选正文')
    await request(doc + '/status', { method: 'POST', value: { baseRev: 3, action: 'finalize' } })
    assert.match((await request(base + '/export')).result, /候选正文/)
    await request(doc, { method: 'PUT', status: 409, value: { ...save, baseRev: 4, mutationId: randomUUID() } })
    await request(doc + '/status', { method: 'POST', value: { baseRev: 4, action: 'reopen' } })
    await request(doc + '/history', { method: 'POST', value: { baseRev: 5, rev: 2 } })
    assert.equal((await request(doc)).result.body, save.body)
    assert.match((await request(base + '/export')).result, /候选正文/)
    assert.doesNotMatch((await request(base + '/export')).result, /电脑上的稿/)
    assert.match((await request(base + '/export?drafts=1')).result, /电脑上的稿/)
    const next = await create({ kind: 'chapter', number: 2, title: '前往灯塔', body: '' })
    const nextDoc = docs + '/' + next.id
    const scope = { baseRev: 1, referenceIds: [chosen.id], referenceQuery: '灯塔建于' }
    async function nextRun(kind, outlineId) {
      return (await request(nextDoc + '/runs', { method: 'POST', status: 202,
        value: { ...scope, kind, outlineId, mutationId: randomUUID() } })).result
    }
    const plan = await nextRun('outline')
    const planPath = base + '/runs/' + plan.id
    assert.match((await awaitRun(planPath, job => job.status === 'done')).output, /核对钥匙/)
    assert.equal((await request(nextDoc)).result.body, '')
    await request(planPath + '/apply', { method: 'POST', status: 422 })
    await request(nextDoc + '/context', { method: 'POST', status: 400,
      value: { ...scope, kind: 'review', outlineId: plan.id } })
    await request(nextDoc + '/context', { method: 'POST', status: 409,
      value: { ...scope, kind: 'draft', outlineId: plan.id, guidance: '更改作者要求' } })
    await request(doc + '/context', { method: 'POST', status: 409,
      value: { ...scope, baseRev: 6, kind: 'draft', outlineId: plan.id } })
    const nextJob = await nextRun('draft', plan.id)
    assert.equal(nextJob.outline_id, plan.id)
    await awaitRun(base + '/runs/' + nextJob.id, job => job.status === 'done')
    assert.match(lastPrompt, /上一已定稿章节末尾：抵达\n候选正文/)
    assert.match(lastPrompt, /灯塔建于一百年前/)
    assert.match(lastPrompt, /灯塔里的旧钥匙/)
    assert.match(lastPrompt, /【已选写前细纲】[\s\S]*核对钥匙/)
    assert.doesNotMatch(lastPrompt, /此条未选中/)
    const callsBeforePreview = upstreamCalls
    const context = (await request(nextDoc + '/context', { method: 'POST',
      value: { ...scope, kind: 'draft', outlineId: plan.id } })).result
    assert.equal(context.messages.at(-1).content, lastPrompt)
    await request(base + '/threads/' + thread.id, { method: 'PUT',
      value: { ...plotThread, status: 'resolved', resolved: 2, baseRev: 1 } })
    await request(base + '/threads/' + thread.id, { method: 'PUT', status: 409,
      value: { ...plotThread, body: '另一台设备的旧稿', baseRev: 1 }, cookie: b })
    await request(base + '/runs/' + nextJob.id + '/apply', { method: 'POST', status: 409 })
    await request(nextDoc + '/context', { method: 'POST', status: 409,
      value: { ...scope, kind: 'draft', outlineId: plan.id } })
    const large = await create({ kind: 'chapter', number: 3, title: '长稿', body: '正文'.repeat(5000) })
    await request(docs + '/' + large.id + '/runs', { method: 'POST', status: 422,
      value: { kind: 'revise', baseRev: 1, mutationId: randomUUID() } })
    assert.equal(upstreamCalls, callsBeforePreview)
    assert.deepEqual((await request(docs + '/' + large.id + '/runs')).result, [])
    const updatedPlan = await nextRun('outline')
    await awaitRun(base + '/runs/' + updatedPlan.id, job => job.status === 'done')
    const updatedDraft = await nextRun('draft', updatedPlan.id)
    await awaitRun(base + '/runs/' + updatedDraft.id, job => job.status === 'done')
    assert.equal((await request(base + '/runs/' + updatedDraft.id + '/apply', { method: 'POST' })).result.body, '候选正文')
    const original = '保留开场\r\n  船停在原地。\r\n\r\n灯塔整夜发亮。\r\n保留结尾'
    await request(nextDoc, { method: 'PUT', value: { title: next.title, body: original, baseRev: 2, mutationId: randomUUID() } })
    async function nextRevision(rev) {
      const { result: job } = await request(nextDoc + '/runs', { method: 'POST', status: 202,
        value: { kind: 'revise', baseRev: rev, guidance: '逐段合并', mutationId: randomUUID() } })
      const path = base + '/runs/' + job.id
      assert.equal((await awaitRun(path, row => row.status === 'done')).output, revisedProse)
      return path + '/merge'
    }
    const merge = await nextRevision(3)
    const previewMerge = (await request(merge)).result
    assert.deepEqual(previewMerge.changes, [
      { line: 2, before: '  船停在原地。\r\n', after: '船已离港。\n' },
      { line: 4, before: '', after: '雾从海面升起。\n' },
      { line: 5, before: '保留结尾', after: '' },
    ])
    const selection = { plan: previewMerge.plan, picks: [1] }
    await request(merge, { method: 'POST', value: { ...selection, plan: 'wrong' }, status: 409 })
    await request(merge, { method: 'POST', value: { ...selection, picks: [1, 1] }, status: 400 })
    assert.equal((await request(nextDoc)).result.body, original)
    const applyOptions = { method: 'POST', value: selection }
    const [merged, replay] = await Promise.all([request(merge, applyOptions), request(merge, { ...applyOptions, cookie: b })])
    assert.deepEqual(merged.result, replay.result)
    assert.equal(merged.result.rev, 4)
    assert.equal(merged.result.body, original.replace('灯塔', '雾从海面升起。\n灯塔'))
    await request(merge, { method: 'POST', value: { ...selection, picks: [0] }, status: 409 })
    const revisions = (await request(nextDoc + '/history')).result
    assert.equal(revisions.find(item => item.rev === 3).body, original)
    assert.equal(revisions.find(item => item.rev === 4).body, merged.result.body)
    const staleRevision = await nextRevision(4)
    const stalePreview = (await request(staleRevision)).result
    await request(nextDoc, { method: 'PUT', cookie: b, value: { title: next.title, body: '另一设备继续写。', baseRev: 4, mutationId: randomUUID() } })
    await request(staleRevision, { method: 'POST', value: { plan: stalePreview.plan, picks: [0] }, status: 409 })
    assert.equal((await request(merge, applyOptions)).result.body, '另一设备继续写。')
    const hits = (await request(base + '/search?q=' + encodeURIComponent('码头'))).result
    assert.equal(hits[0].kind, 'blueprint')
    assert.match(hits[0].excerpt, /码头/)
    assert.deepEqual((await request('/api/projects/' + second.id + '/search?q=' + encodeURIComponent('码头'))).result, [])
    const { result: backup } = await request(base + '/backup')
    const { result: copy } = await request('/api/import', { method: 'POST', value: backup, status: 201 })
    assert.notEqual(copy.id, project.id)
    assert.equal((await request('/api/projects/' + copy.id + '/documents')).result.length, 6)
    assert.equal((await request('/api/projects/' + copy.id + '/references')).result.length, 2)
    assert.equal((await request('/api/projects/' + copy.id + '/semantic')).result.chunks, 0)
    const copiedBackup = (await request('/api/projects/' + copy.id + '/backup')).result
    const copiedReview = copiedBackup.runs.find(row => row.kind === 'review' && row.output === reviewResult.output)
    assert.deepEqual((await request('/api/projects/' + copy.id + '/runs/' + copiedReview.id)).result.reviewReport, reviewResult.reviewReport)
    const copiedDraft = copiedBackup.runs.find(row => row.outline_id && row.applied_rev)
    assert.notEqual(copiedDraft.outline_id, updatedPlan.id)
    assert.equal(copiedBackup.runs.find(row => row.id === copiedDraft.outline_id).kind, 'outline')
    const copiedThreads = (await request('/api/projects/' + copy.id + '/threads')).result
    assert.equal(copiedThreads[0].resolved, 2)
    assert.notEqual(copiedThreads[0].id, thread.id)
    const brokenBackup = structuredClone(backup)
    brokenBackup.documents[0].history.push(brokenBackup.documents[0].history[0])
    await request('/api/import', { method: 'POST', value: brokenBackup, status: 400 })
    await stop(server)
    server = await launch(directory, upstream.address().port)
    assert.equal((await request(base + '/semantic')).result.indexed, 2)
    assert.equal(JSON.parse((await readProjectEvent(server.base + base + '/events', b, cursor)).split('data: ')[1]).rev, 2)
    assert.equal((await request(doc)).result.body, save.body)
    assert.equal((await request('/api/projects')).result.length, 3)
    const snapshot = join(directory, 'release-snapshot.sqlite')
    assert.equal((await backupDatabase(join(directory, 'novels.sqlite'), snapshot)).projects, 3)
    const restoreDir = join(directory, 'recovered')
    const restoredDb = join(restoreDir, 'novels.sqlite')
    assert.equal((await restoreDatabase(createReadStream(snapshot), restoredDb)).projects, 3)
    assert.equal(verifyDatabase(restoredDb).schema, 7)
    await assert.rejects(restoreDatabase(createReadStream(snapshot), restoredDb), /目标已有数据库/)
    await stop(server)
    server = await launch(restoreDir, upstream.address().port)
    await request('/api/projects', { status: 401 })
    a = await login()
    assert.equal((await request(doc)).result.body, save.body)
  } finally {
    await stop(server)
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('opening an existing Web database migrates v1 and keeps chapter data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pagekin-web-migration-'))
  let store
  try {
    store = openStore(directory)
    const p = store.createProject('旧版本作品')
    const doc = store.addDocument(p.id, { kind: 'chapter', number: 1, title: '原章', body: '原文' })
    store.db.exec(`
      DROP TRIGGER document_created_event; DROP TRIGGER document_updated_event; DROP TABLE project_events; DROP TABLE narrative_threads;
      DROP TABLE reference_vectors;
      DROP TABLE chapter_imports; DROP TABLE reference_material;
      ALTER TABLE runs DROP COLUMN outline_id; ALTER TABLE runs DROP COLUMN reference_ids; PRAGMA user_version=1;
    `)
    store.db.close()
    store = undefined
    store = openStore(directory)
    assert.equal(store.document(p.id, doc.id).body, '原文')
    assert.equal(store.get('PRAGMA user_version').user_version, 7)
    assert.equal(store.addReference(p.id, { title: '资料', body: '参考文字' }).body, '参考文字')
  } finally { store?.db.close(); await rm(directory, { recursive: true, force: true }) }
})

test('manuscript splitting recognizes mixed headings, preserves preface, and skips fenced examples', () => {
  const source = '\uFEFF序言\r\n\r\n# 第十二章 雨夜\r\n  开始\r\n~~~txt\r\n第十三章 示例\r\n~~~\r\n## Chapter 14: The Port\r\n第二段\r\n第０１５章：返航\r\n最后一段'
  assert.deepEqual(splitManuscript(source, '原稿'), {
    detected: true, hasPreface: true, chapters: [
      { number: 12, title: '雨夜', body: '序言\n\n  开始\n~~~txt\n第十三章 示例\n~~~' },
      { number: 14, title: 'The Port', body: '第二段' },
      { number: 15, title: '返航', body: '最后一段' },
    ],
  })
  assert.deepEqual(splitManuscript('无章标题\n正文', '原稿').chapters,
    [{ number: null, title: '原稿', body: '无章标题\n正文' }])
})

test('desktop database migration preserves reopened text and authoritative final in a new copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pagekin-desktop-smoke-'))
  const source = join(directory, 'project.db')
  let server
  try {
    const db = new DatabaseSync(source)
    db.exec(`
      PRAGMA user_version=9;
      CREATE TABLE project_core (id TEXT,project_name TEXT, worldbuilding TEXT);
      INSERT INTO project_core VALUES ('main','海边','风暴常见');
      CREATE TABLE characters(name TEXT, appearance TEXT);
      INSERT INTO characters VALUES ('阿雨','红伞');
      CREATE TABLE blueprints(chapter_number INTEGER, title TEXT, purpose TEXT);
      INSERT INTO blueprints VALUES (1,'旧灯塔','铺设伏笔');
      CREATE TABLE contents(id INTEGER PRIMARY KEY,body TEXT);
      INSERT INTO contents VALUES (1,'初稿'),(2,'旧定稿'),(3,'重开的正文'),(4,'无效的旧来源'),(5,'删除稿');
      CREATE TABLE drafts_all(id INTEGER PRIMARY KEY,chapter_number INTEGER,version INTEGER,status TEXT,content_id INTEGER,source_dependencies TEXT);
      CREATE VIEW drafts AS SELECT * FROM drafts_all WHERE status IS NOT 'deleted';
      CREATE TABLE finalization_outbox(draft_id INTEGER,finalization_id TEXT,chapter_title TEXT,content_hash TEXT,content_snapshot TEXT);
    `)
    const add = db.prepare('INSERT INTO drafts_all VALUES (?,1,?,?,?,?)')
    add.run(1, 1, 'draft', 1, '[]')
    add.run(2, 2, 'finalized', 2, '[]')
    add.run(3, 3, 'revised', 3, JSON.stringify([{
      kind: 'finalized', chapterNumber: 1, draftId: 2, contentHash: hash('旧定稿'), finalizationId: 'final-a',
    }]))
    add.run(4, 4, 'draft', 4, JSON.stringify([{
      kind: 'finalized', chapterNumber: 1, draftId: 2, contentHash: hash('过期'), finalizationId: 'final-a',
    }]))
    add.run(5, 5, 'deleted', 5, '[]')
    db.prepare('INSERT INTO finalization_outbox VALUES (?,?,?,?,?)').run(2, 'final-a', '旧灯塔', hash('旧定稿'), '旧定稿')
    db.close()
    const before = await readFile(source)
    const payload = desktopCopy(source)
    assert.deepEqual(await readFile(source), before)
    assert.equal(payload.documents.length, 4)
    const chapter = payload.documents.find(doc => doc.kind === 'chapter')
    assert.equal(chapter.body, '重开的正文')
    assert.equal(chapter.rev, 5)
    assert.equal(chapter.history.length, 4)
    const store = openStore(join(directory, 'web'))
    try {
      const p = store.importBackup(payload)
      assert.equal(store.chapters(p.id, false)[0].body, '旧定稿')
      assert.equal(store.chapters(p.id, true)[0].body, '重开的正文')
    } finally { store.db.close() }
    await writeFile(source + '-wal', '')
    assert.throws(() => desktopCopy(source), /WAL/)
    server = await launch(join(directory, 'archive-web'), 1)
    const loggedIn = await fetch(server.base + '/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    })
    const cookie = loggedIn.headers.get('set-cookie').split(';')[0]
    const upload = data => fetch(server.base + '/api/import-desktop', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: data,
    })
    const tampered = await upload(storedDesktopArchive(before, '0'.repeat(64)))
    assert.equal(tampered.status, 422)
    assert.match((await tampered.json()).error, /完整性/)
    const uploaded = await upload(storedDesktopArchive(before))
    const copied = await uploaded.json()
    assert.equal(uploaded.status, 201, JSON.stringify(copied))
    const exported = await fetch(server.base + '/api/projects/' + copied.id + '/export', { headers: { Cookie: cookie } })
    assert.match(await exported.text(), /旧定稿/)
    const listing = await fetch(server.base + '/api/projects', { headers: { Cookie: cookie } })
    assert.equal((await listing.json()).length, 1)
  } finally {
    await stop(server)
    await rm(directory, { recursive: true, force: true })
  }
})
