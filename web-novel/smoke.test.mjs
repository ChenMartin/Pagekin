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
import { releaseVersion, schemaVersion } from './version.mjs'

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
  const batchPrompts = []
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
    const batchTitle = ['排队首章', '暂停演练', '被别处编辑', '失败演练', '最后一章', '取消演练']
      .find(title => lastPrompt.split('\n', 1)[0].endsWith('章：' + title))
    if (batchTitle) {
      batchPrompts.push({ title: batchTitle, text: lastPrompt })
      const attempt = batchPrompts.filter(row => row.title === batchTitle).length
      if (batchTitle === '失败演练' && attempt === 1) { res.writeHead(503).end(); return }
      const hold = (batchTitle === '暂停演练' && attempt === 1) || (batchTitle === '失败演练' && attempt === 2) || batchTitle === '取消演练'
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const content = (hold ? '部分候选 · ' : '完整候选 · ') + batchTitle + (batchTitle === '暂停演练' ? '。' : '')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n')
      if (!hold) res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const instruction = input.messages[0].content
    if (lastPrompt.includes('分段续跑试验')) {
      const anchor = '他带着写满名字的船票走到码头。'
      const second = '渡轮靠岸后，守门人认出了他的名字。'
      const continuing = instruction.includes('中断后续写')
      const last = continuing && lastPrompt.includes(second)
      const content = last ? second + '两人一同登上了甲板。' : continuing ? anchor + second + '远处' : '开头照常保留。' + anchor + '突然'
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: last ? 'stop' : 'length' }] }) + '\n\ndata: [DONE]\n\n')
      return
    }
    let output = '候选正文'
    if (instruction.includes('你是小说研究助手')) {
      const chapters = [...lastPrompt.matchAll(/【位置 (\d+) · /g)].map(([, position]) => ({
        position: Number(position), summary: '人物遇到选择', blueprint: '用后果推动转折',
      }))
      output = JSON.stringify({ structure: '因果推进', style: '短句交替', constraints: '用具体动作表现犹豫。', chapters })
      if (lastPrompt.includes('缺章演练')) output = JSON.stringify({ structure: '缺章', style: '短句', constraints: '使用动作', chapters: [] })
      if (lastPrompt.includes('【整书归纳】')) output = JSON.stringify({ structure: '首尾呼应', style: '短句交替', constraints: '用场景后果驱动结构。' })
    }
    if (instruction.includes('生成小说设定与架构')) output = '## 架构候选\n海港与失踪水手'
    if (instruction.includes('生成当前人物卡')) output = '## 人物候选\n希望找到水手'
    if (instruction.includes('生成当前章的章节蓝图')) output = '## 蓝图候选\n调查失踪的船票'
    if (instruction.includes('只返回替换片段')) output = '替换选中的文字。'
    if (instruction.includes('只返回插入的新文字')) output = '续写的文字。'
    if (instruction.includes('你是小说连载助手')) output = JSON.stringify({ changes: [
      { field: 'location', value: '船上', quote: '调查者登船。\n潮声阵阵。' },
      { field: 'physicalState', value: '保持站立', quote: '潮声阵阵。' },
      { field: 'keyItems', value: '旧地图', quote: '他拿起旧地图。' },
    ] })
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
    const castMember = await create({ kind: 'character', title: '小舟', body: '船长' })
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
    const activeRuns = (await request(base + '/runs?scope=active')).result
    assert.deepEqual(activeRuns.map(row => [row.id, row.document_id, row.status]), [[paused.split('/').at(-1), chapter.id, 'running']])
    assert.deepEqual((await request('/api/projects/' + second.id + '/runs?scope=active')).result, [])
    await request(base + '/runs?scope=unknown', { status: 400 })
    const recentRuns = (await request(base + '/runs?scope=history')).result
    assert.ok(recentRuns.some(row => row.id === review.split('/').at(-1)))
    assert.ok(recentRuns.every(row => row.status !== 'running' && !Object.hasOwn(row, 'output')))
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
    const txt = await request(base + '/export?format=txt&drafts=1')
    assert.match(txt.result, /第 1 章[\s\S]*电脑上的稿/)
    assert.doesNotMatch(txt.result, /^# /)
    const zip = await fetch(server.base + base + '/export?format=zip', { headers: { Cookie: a } })
    assert.equal(zip.status, 200)
    assert.equal(zip.headers.get('content-type'), 'application/zip')
    assert.match(zip.headers.get('content-disposition'), /filename="novel\.zip"; filename\*=UTF-8''/)
    const bytes = Buffer.from(await zip.arrayBuffer())
    const end = bytes.length - 22
    assert.equal(bytes.readUInt32LE(end), 0x06054b50)
    assert.equal(bytes.readUInt16LE(end + 10), 1)
    const entry = bytes.readUInt32LE(end + 16)
    assert.equal(bytes.readUInt32LE(entry), 0x02014b50)
    assert.equal(bytes.readUInt16LE(entry + 8), 0x800)
    assert.match(bytes.toString('utf8', entry + 46, end), /^00001-.*\.md$/)
    const local = bytes.readUInt32LE(entry + 42)
    assert.equal(bytes.readUInt32LE(local), 0x04034b50)
    const chapterText = bytes.subarray(local + 30 + bytes.readUInt16LE(local + 26), entry)
    assert.equal(crc32(chapterText), bytes.readUInt32LE(entry + 16))
    assert.match(chapterText.toString(), /候选正文/)
    assert.doesNotMatch(chapterText.toString(), /电脑上的稿/)
    await request(base + '/export?format=html', { status: 400 })
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
    assert.equal(verifyDatabase(restoredDb).schema, schemaVersion)
    await assert.rejects(restoreDatabase(createReadStream(snapshot), restoredDb), /目标已有数据库/)
    await stop(server)
    server = await launch(restoreDir, upstream.address().port)
    await request('/api/projects', { status: 401 })
    a = await login()
    b = await login()
    assert.equal((await request(doc)).result.body, save.body)

    const queue = '/api/projects/' + second.id + '/batches'
    const batchDocs = '/api/projects/' + second.id + '/documents'
    const batchChapters = []
    for (const [index, title] of ['排队首章', '暂停演练', '被别处编辑', '失败演练', '最后一章', '取消演练'].entries()) {
      const { result: chapter } = await request(batchDocs, { method: 'POST', status: 201,
        value: { kind: 'chapter', title, number: index + 3, body: index === 4 ? ' \r\n\t' : '' } })
      batchChapters.push({ id: chapter.id, baseRev: chapter.rev })
    }
    assert.deepEqual((await request(queue + '/eligible')).result.map(row => row.number), [3, 4, 5, 6, 7, 8])
    const queueValue = { chapters: batchChapters.slice(0, 5).reverse(), guidance: '每章保持人物一致', mutationId: randomUUID() }
    const { result: createdBatch } = await request(queue, { method: 'POST', status: 202, value: queueValue })
    const batchPath = queue + '/' + createdBatch.id
    const batchRuns = '/api/projects/' + second.id + '/runs/'
    async function awaitBatch(path, accept) {
      for (let tries = 0; tries < 90; tries++) {
        const { result } = await request(path)
        if (accept(result)) return result
        await delay(40)
      }
      assert.fail('batch did not reach expected state')
    }
    const duplicateBatch = await request(queue, { method: 'POST', status: 202, value: { ...queueValue, chapters: [...queueValue.chapters].reverse() } })
    assert.equal(duplicateBatch.result.id, createdBatch.id)
    await request(queue, { method: 'POST', status: 409, value: { ...queueValue, guidance: '不同的请求' } })
    await request(base + '/batches/' + createdBatch.id, { status: 404 })
    const firstPhase = await awaitBatch(batchPath, row => row.items[1].status === 'running' && batchPrompts.length >= 2)
    const pausedRun = firstPhase.items[1].run_id
    await awaitRun(batchRuns + pausedRun, row => !!row.output)
    assert.deepEqual(firstPhase.items.map(item => item.number), [3, 4, 5, 6, 7])
    assert.match(batchPrompts[1].text, /尚未定稿[\s\S]*完整候选 · 排队首章/)
    assert.match(batchPrompts[1].text, /每章保持人物一致/)
    await request(batchDocs + '/' + batchChapters[4].id + '/runs', { method: 'POST', status: 409,
      value: { kind: 'draft', baseRev: 1, mutationId: randomUUID() } })
    await request(batchPath + '/pause', { method: 'POST' })
    await awaitBatch(batchPath, row => row.status === 'paused' && row.items[1].status === 'interrupted')
    assert.match((await request(batchRuns + pausedRun)).result.output, /部分候选/)
    const batchSkills = '/api/projects/' + second.id + '/writing-skills'
    const { result: alteredStyle } = await request(batchSkills, { method: 'POST', status: 201,
      value: { mutationId: randomUUID(), title: '新风格', body: '保持简洁' } })
    await request(batchSkills + '/bindings', { method: 'PUT', value: { baseRev: 0, bindings: { draft: alteredStyle.id } } })
    await request(batchPath + '/resume', { method: 'POST', status: 409 })
    await request(batchSkills + '/bindings', { method: 'PUT', value: { baseRev: 1, bindings: {} } })
    await request(batchDocs + '/' + batchChapters[2].id, { method: 'PUT', cookie: b,
      value: { title: '被别处编辑', body: '作者自己的稿', baseRev: 1, mutationId: randomUUID() } })
    await request(batchPath + '/resume', { method: 'POST' })
    const failure = await awaitBatch(batchPath, row => row.status === 'paused' && row.items[3].status === 'failed')
    assert.equal(failure.items[0].run_id, firstPhase.items[0].run_id)
    assert.notEqual(failure.items[1].run_id, pausedRun)
    assert.match(batchPrompts[2].text, /【已保存候选末尾】[\s\S]*部分候选 · 暂停演练。/)
    assert.equal((await request(batchRuns + failure.items[1].run_id)).result.continued_from, pausedRun)
    assert.equal(failure.items[2].status, 'skipped')
    await request(batchPath + '/resume', { method: 'POST' })
    const beforeRestart = await awaitBatch(batchPath, row => row.items[3].status === 'running')
    await awaitRun(batchRuns + beforeRestart.items[3].run_id, row => !!row.output)
    const requestsBeforeRestart = batchPrompts.length
    await stop(server)
    server = await launch(restoreDir, upstream.address().port)
    const restarted = await awaitBatch(batchPath, row => row.status === 'paused' && row.items[3].status === 'interrupted')
    assert.equal(restarted.items[4].status, 'queued')
    assert.equal(batchPrompts.length, requestsBeforeRestart)
    await request(batchPath + '/resume', { method: 'POST' })
    const completed = await awaitBatch(batchPath, row => row.status === 'done')
    assert.deepEqual(completed.items.map(item => item.status), ['done', 'done', 'skipped', 'done', 'done'])
    assert.deepEqual(batchPrompts.map(row => row.title), ['排队首章', '暂停演练', '暂停演练', '失败演练', '失败演练', '失败演练', '最后一章'])
    assert.equal((await request(batchDocs + '/' + batchChapters[0].id)).result.body, '')
    assert.equal((await request(batchDocs + '/' + batchChapters[2].id)).result.body, '作者自己的稿')
    await request(batchDocs + '/' + batchChapters[0].id, { method: 'PUT',
      value: { title: '排队首章', body: '前文已改变', baseRev: 1, mutationId: randomUUID() } })
    await request(batchRuns + completed.items[1].run_id + '/apply', { method: 'POST', status: 409 })
    await request(batchRuns + completed.items[3].run_id + '/apply', { method: 'POST' })
    await request(batchRuns + completed.items[4].run_id + '/apply', { method: 'POST' })
    const cancelling = (await request(queue, { method: 'POST', status: 202,
      value: { chapters: [batchChapters[5]], mutationId: randomUUID() } })).result
    const cancellingPath = queue + '/' + cancelling.id
    await awaitBatch(cancellingPath, row => row.items[0].status === 'running')
    await request(cancellingPath + '/cancel', { method: 'POST' })
    await awaitBatch(cancellingPath, row => row.status === 'cancelled' && row.items[0].status === 'cancelled')

    const skillPath = base + '/writing-skills'
    const styleRequest = { mutationId: randomUUID(), title: '码头风格', body: '短句与可见动作。' }
    const { result: draftStyle } = await request(skillPath, { method: 'POST', value: styleRequest, status: 201 })
    assert.deepEqual((await request(skillPath, { method: 'POST', value: styleRequest, status: 201 })).result, draftStyle)
    await request(batchSkills + '/' + draftStyle.id, { status: 404 })
    const { result: outlineStyle } = await request(skillPath, { method: 'POST', status: 201,
      value: { mutationId: randomUUID(), title: '细纲风格', body: '先列本章阻力。' } })
    const binding = { baseRev: 0, bindings: { outline: outlineStyle.id, draft: draftStyle.id } }
    const { result: skillProfile } = await request(skillPath + '/bindings', { method: 'PUT', value: binding })
    assert.equal(skillProfile.rev, 1)
    assert.deepEqual((await request(skillPath + '/bindings', { method: 'PUT', value: binding })).result, skillProfile)
    await request(skillPath + '/bindings', { method: 'PUT', cookie: b, status: 409, value: { baseRev: 0, bindings: {} } })
    await request(skillPath + '/' + draftStyle.id, { method: 'DELETE', status: 409 })
    const reviewPreview = (await request(doc + '/context', { method: 'POST', value: { kind: 'review', baseRev: 6 } })).result
    assert.doesNotMatch(reviewPreview.messages.at(-1).content, /写作 Skill ·/)
    const skillOutline = await run('outline', 6)
    const { id: skillOutlineId } = await awaitRun(skillOutline, row => row.status === 'done')
    assert.match(lastPrompt, /先列本章阻力/)
    assert.doesNotMatch(lastPrompt, /短句与可见动作/)
    const skillDraft = { kind: 'draft', baseRev: 6, outlineId: skillOutlineId }
    const skillPreview = (await request(doc + '/context', { method: 'POST', value: skillDraft })).result
    assert.match(skillPreview.messages.at(-1).content, /短句与可见动作/)
    assert.doesNotMatch(skillPreview.messages.at(-1).content, /先列本章阻力/)
    const { result: styleJob } = await request(doc + '/runs', { method: 'POST', status: 202,
      value: { ...skillDraft, mutationId: randomUUID() } })
    await awaitRun(base + '/runs/' + styleJob.id, row => row.status === 'done')
    assert.equal(lastPrompt, skillPreview.messages.at(-1).content)
    await request(skillPath + '/bindings', { method: 'PUT', value: { baseRev: 1, bindings: { draft: draftStyle.id } } })
    await request(doc + '/context', { method: 'POST', value: skillDraft, status: 409 })
    await request(base + '/runs/' + styleJob.id + '/apply', { method: 'POST', status: 409 })
    const { result: skillBackup } = await request(base + '/backup')
    const { result: skillCopy } = await request('/api/import', { method: 'POST', status: 201, value: skillBackup })
    const newPath = '/api/projects/' + skillCopy.id + '/writing-skills'
    const { result: restoredSkills } = await request(newPath)
    assert.notEqual(restoredSkills.bindings.draft, draftStyle.id)
    assert.equal((await request(newPath + '/' + restoredSkills.bindings.draft)).result.body, draftStyle.body)
    await request(skillPath + '/' + outlineStyle.id, { method: 'DELETE' })

    const partial = await run('draft', 6, '分段续跑试验')
    const firstPiece = await awaitRun(partial, row => row.status === 'failed')
    assert.equal(firstPiece.canContinue, true)
    assert.equal(firstPiece.request_data, undefined)
    assert.match(firstPiece.output, /突然$/)
    const nextPieceValue = { mutationId: randomUUID() }
    const nextPieceOptions = { method: 'POST', status: 202, value: nextPieceValue }
    const nextPiece = (await request(partial + '/continue', nextPieceOptions)).result
    assert.equal(nextPiece.continued_from, firstPiece.id)
    assert.equal((await request(partial + '/continue', nextPieceOptions)).result.id, nextPiece.id)
    const nextPiecePath = base + '/runs/' + nextPiece.id
    const secondPiece = await awaitRun(nextPiecePath, row => row.status === 'failed')
    assert.equal(secondPiece.canContinue, true)
    assert.equal(secondPiece.output, '开头照常保留。他带着写满名字的船票走到码头。\n\n渡轮靠岸后，守门人认出了他的名字。远处')
    assert.match(lastPrompt, /短句与可见动作/)
    assert.match(lastPrompt, /【已保存候选末尾】[\s\S]*写满名字的船票/)
    const { result: finalPiece } = await request(nextPiecePath + '/continue', { method: 'POST', status: 202, value: { mutationId: randomUUID() } })
    const continued = await awaitRun(base + '/runs/' + finalPiece.id, row => row.status === 'done')
    assert.equal(continued.output, secondPiece.output.slice(0, -2) + '\n\n两人一同登上了甲板。')
    assert.equal((await request(doc)).result.body, save.body)
    const continuedBackup = (await request(base + '/backup')).result
    const continuedCopy = (await request('/api/import', { method: 'POST', status: 201, value: continuedBackup })).result
    const copiedChain = (await request('/api/projects/' + continuedCopy.id + '/backup')).result.runs
    const copiedChild = copiedChain.find(row => row.output === continued.output)
    assert.notEqual(copiedChild.continued_from, nextPiece.id)
    assert.equal(copiedChain.find(row => row.id === copiedChild.continued_from).output, secondPiece.output)
    await request(skillPath + '/bindings', { method: 'PUT', value: { baseRev: 2, bindings: {} } })
    await request(partial + '/continue', { method: 'POST', value: { mutationId: randomUUID() }, status: 409 })
    await request(base + '/runs/' + finalPiece.id + '/apply', { method: 'POST', status: 409 })

    const novel = await create({ kind: 'chapter', number: 14, title: '过渡码头', body: '小舟带着船票走到码头。' })
    const novelPath = docs + '/' + novel.id
    const finalNovel = (await request(novelPath + '/status', { method: 'POST', value: { action: 'finalize', baseRev: 1 } })).result
    const production = base + '/adaptations'
    const { result: available } = await request(production + '/eligible')
    assert.deepEqual(available.find(row => row.id === novel.id), { id: novel.id, number: 14, title: novel.title, rev: 2 })
    const createProduction = { method: 'POST', status: 201, value: { mutationId: randomUUID(), title: '夜航短剧', format: 'short', aspect: '9:16', seconds: 90 } }
    const { result: adaptation } = await request(production, createProduction)
    assert.equal((await request(production, createProduction)).result.id, adaptation.id)
    await request('/api/projects/' + second.id + '/adaptations/' + adaptation.id, { status: 404 })
    const episodeCollection = production + '/' + adaptation.id + '/episodes'
    const createEpisode = { mutationId: randomUUID(), title: '船票', season: 1, number: 1, sources: [{ id: novel.id, rev: finalNovel.rev }] }
    await request(episodeCollection, { method: 'POST', status: 400, value: { ...createEpisode, sources: [{ id: novel.id, rev: 1 }] } })
    const { result: episode } = await request(episodeCollection, { method: 'POST', status: 201, value: createEpisode })
    assert.equal((await request(episodeCollection, { method: 'POST', status: 201, value: createEpisode })).result.id, episode.id)
    await request(episodeCollection, { method: 'POST', status: 409, value: { ...createEpisode, mutationId: randomUUID() } })
    const ep = base + '/episodes/' + episode.id
    await request('/api/projects/' + second.id + '/episodes/' + episode.id, { status: 404 })
    const scene = { id: randomUUID(), title: '启航', interior: 'exterior', location: '码头', time: '夜', sourceIds: [novel.id], elements: [
      { id: randomUUID(), type: 'action', text: '汽笛拉响。' },
      { id: randomUUID(), type: 'dialogue', text: '准备开船。', characterId: castMember.id },
    ] }
    await request(ep + '/status', { method: 'POST', status: 422, value: { action: 'confirm', baseRev: 1, mutationId: randomUUID() } })
    const episodeSave = { mutationId: randomUUID(), baseRev: 1, title: '船票 · 第一集', scenes: [scene] }
    await request(ep, { method: 'PUT', status: 400, value: { ...episodeSave, scenes: [{ ...scene, sourceIds: [chapter.id] }] } })
    const opts = { method: 'PUT', value: episodeSave }
    const [firstSave, replaySave] = await Promise.all([request(ep, opts), request(ep, { ...opts, cookie: b })])
    assert.deepEqual(firstSave.result, replaySave.result)
    assert.equal(firstSave.result.rev, 2)
    assert.equal(firstSave.result.scenes[0].elements[1].speaker, '小舟')
    await request(ep, { method: 'PUT', status: 409, cookie: b, value: { ...episodeSave, title: '旧稿', mutationId: randomUUID() } })
    const confirm = { action: 'confirm', baseRev: 2, mutationId: randomUUID() }
    assert.equal((await request(ep + '/status', { method: 'POST', value: confirm })).result.status, 'confirmed')
    assert.equal((await request(ep + '/status', { method: 'POST', value: confirm })).result.rev, 3)
    await request(ep, { method: 'PUT', status: 409, value: { ...episodeSave, baseRev: 3, mutationId: randomUUID() } })
    assert.match((await request(ep + '/export')).result, /外景 · 码头 · 夜[\s\S]*\*\*小舟\*\*[\s\S]*准备开船。/)
    assert.equal((await request(ep + '/source?chapter=' + novel.id)).result.updated, false)
    await request(novelPath + '/status', { method: 'POST', value: { action: 'reopen', baseRev: 2 } })
    await request(novelPath, { method: 'PUT', value: { baseRev: 3, mutationId: randomUUID(), title: novel.title, body: '新稿从渡口开始。' } })
    assert.equal((await request(ep)).result.sources[0].updated, true)
    await request(novelPath + '/status', { method: 'POST', value: { action: 'finalize', baseRev: 4 } })
    const pinned = (await request(ep + '/source?chapter=' + novel.id)).result
    assert.equal(pinned.body, '小舟带着船票走到码头。')
    assert.equal(pinned.latestRev, 5)
    await request(ep + '/status', { method: 'POST', value: { action: 'reopen', baseRev: 3, mutationId: randomUUID() } })
    await request(ep, { method: 'PUT', value: { ...episodeSave, baseRev: 4, scenes: [], mutationId: randomUUID() } })
    const restored = (await request(ep + '/history', { method: 'POST', value: { rev: 3, baseRev: 5, mutationId: randomUUID() } })).result
    assert.equal(restored.rev, 6)
    assert.equal(restored.status, 'draft')
    assert.equal(restored.scenes[0].id, scene.id)
    assert.equal((await request(ep + '/history?rev=3')).result.scenes[0].elements[1].speaker, '小舟')
    const adaptationBackup = (await request(base + '/backup')).result
    const adaptationCopy = (await request('/api/import', { method: 'POST', status: 201, value: adaptationBackup })).result
    const copyPath = '/api/projects/' + adaptationCopy.id
    const [copiedAdaptation] = (await request(copyPath + '/adaptations')).result
    const [copiedEpisode] = (await request(copyPath + '/adaptations/' + copiedAdaptation.id)).result.episodes
    assert.notEqual(copiedEpisode.id, episode.id)
    const copied = (await request(copyPath + '/episodes/' + copiedEpisode.id)).result
    assert.notEqual(copied.sources[0].id, novel.id)
    assert.equal(copied.scenes[0].sourceIds[0], copied.sources[0].id)
    assert.notEqual(copied.scenes[0].elements[1].characterId, castMember.id)
    assert.equal((await request(copyPath + '/episodes/' + copiedEpisode.id + '/history')).result.length, 6)

    const planBase = (await request('/api/projects', { method: 'POST', status: 201, value: { title: '规划演练' } })).result
    const projectPath = '/api/projects/' + planBase.id
    const createPlanDoc = async value => (await request(projectPath + '/documents', { method: 'POST', status: 201, value })).result
    const startFor = async (target, value) => {
      const path = projectPath + '/documents/' + target.id
      const input = { baseRev: target.rev, mutationId: randomUUID(), ...value }
      const preview = (await request(path + '/context', { method: 'POST', value: input })).result
      const job = (await request(path + '/runs', { method: 'POST', status: 202, value: input })).result
      const jobPath = projectPath + '/runs/' + job.id
      const done = await awaitRun(jobPath, row => row.status === 'done')
      assert.equal(preview.messages.at(-1).content, lastPrompt)
      assert.equal((await request(path)).result.body, target.body)
      return { jobPath, done, prompt: lastPrompt }
    }
    const setting = await createPlanDoc({ kind: 'settings', title: '世界规则', body: '原有设定' })
    const person = await createPlanDoc({ kind: 'character', title: '调查者', body: '原有人物卡' })
    await createPlanDoc({ kind: 'blueprint', number: 1, title: '前章', body: '前章独有线索' })
    const blueprint = await createPlanDoc({ kind: 'blueprint', number: 2, title: '第二章蓝图', body: '' })
    for (const [target, text] of [[setting, '架构候选'], [person, '人物候选'], [blueprint, '蓝图候选']]) {
      const result = await startFor(target, { kind: 'plan', guidance: '作者的规划要求' })
      assert.match(result.done.output, new RegExp(text))
      assert.match(result.prompt, /作者的规划要求/)
      if (target === blueprint) assert.match(result.prompt, /前章独有线索/)
      assert.equal((await request(result.jobPath + '/apply', { method: 'POST' })).result.body, result.done.output)
    }
    const settingPath = projectPath + '/documents/' + setting.id
    for (const [section, title] of Object.entries({ premise: '故事前提', cast: '人物群像', world: '世界观', plot: '情节大纲' })) {
      const preview = (await request(settingPath + '/context', { method: 'POST',
        value: { kind: 'plan', baseRev: 2, planSection: section } })).result
      assert.ok(preview.messages[0].content.includes('本次只生成「' + title + '」模块'))
    }
    await request(settingPath + '/context', { method: 'POST', status: 400,
      value: { kind: 'plan', baseRev: 2, planSection: '__proto__' } })
    await request(projectPath + '/documents/' + person.id + '/context', { method: 'POST', status: 422,
      value: { kind: 'plan', baseRev: 2, planSection: 'world' } })
    const latestBlueprint = (await request(projectPath + '/documents/' + blueprint.id)).result
    const stalePlan = await startFor(latestBlueprint, { kind: 'plan' })
    await request(projectPath + '/documents/' + setting.id, { method: 'PUT', cookie: b,
      value: { title: setting.title, body: '改过世界规则', baseRev: 2, mutationId: randomUUID() } })
    await request(stalePlan.jobPath + '/apply', { method: 'POST', status: 409 })
    const goalsPath = projectPath + '/goals'
    assert.deepEqual((await request(goalsPath)).result, { goals: {}, rev: 0 })
    const goals = { genre: '历史悬疑', audience: '成年读者', language: '中文', chapters: 120, chapterWords: 2200 }
    const firstGoals = { goals, baseRev: 0 }
    await request(goalsPath, { method: 'PUT', status: 400, value: { ...firstGoals, goals: { chapters: 2.5 } } })
    const savedGoals = (await request(goalsPath, { method: 'PUT', value: firstGoals })).result
    assert.deepEqual(savedGoals, { goals, rev: 1 })
    assert.deepEqual((await request(goalsPath, { method: 'PUT', value: firstGoals })).result, savedGoals)
    await request(goalsPath, { method: 'PUT', cookie: b, status: 409, value: { ...firstGoals, goals: {} } })
    const plannedWithGoals = await startFor(latestBlueprint, { kind: 'plan' })
    assert.match(plannedWithGoals.prompt, /作品写作目标[\s\S]*目标总章数：120[\s\S]*目标单章字数：2200/)
    await request(goalsPath, { method: 'PUT', cookie: b, value: { goals: { ...goals, chapters: 121 }, baseRev: 1 } })
    await request(plannedWithGoals.jobPath + '/apply', { method: 'POST', status: 409 })
    const goalBackup = (await request(projectPath + '/backup')).result
    const copiedGoals = (await request('/api/import', { method: 'POST', value: goalBackup, status: 201 })).result
    assert.deepEqual((await request('/api/projects/' + copiedGoals.id + '/goals')).result, { goals: { ...goals, chapters: 121 }, rev: 1 })
    const prose = await createPlanDoc({ kind: 'chapter', number: 2, title: '正文选段', body: '同一句。\r\n同一句。\r\n结尾。' })
    const prosePath = projectPath + '/documents/' + prose.id
    await request(prosePath + '/context', { method: 'POST', status: 422, value: { kind: 'plan', baseRev: 1 } })
    await request(prosePath + '/context', { method: 'POST', status: 409, value: { kind: 'passage', baseRev: 1,
      passage: { mode: 'polish', start: 5, end: 9, quote: '错误的锚点' } } })
    const passageSelection = { start: 5, end: 9, quote: '同一句。' }
    const edited = await startFor(prose, { kind: 'passage', passage: { ...passageSelection, mode: 'polish' } })
    const editedText = '同一句。\r\n替换选中的文字。\r\n结尾。'
    assert.deepEqual((await request(edited.jobPath + '/candidate')).result, { current: prose.body, candidate: editedText })
    const newProse = (await request(edited.jobPath + '/apply', { method: 'POST' })).result
    assert.equal(newProse.body, editedText)
    const insertion = await startFor(newProse, { kind: 'passage', passage: { mode: 'continue', start: 0, end: 4, quote: '同一句。' } })
    assert.equal((await request(insertion.jobPath + '/candidate')).result.candidate, '同一句。\n\n续写的文字。\r\n替换选中的文字。\r\n结尾。')
    await request(prosePath, { method: 'PUT', cookie: b, value: { title: prose.title, body: '同一句。\r\n别处的新稿', baseRev: newProse.rev, mutationId: randomUUID() } })
    await request(insertion.jobPath + '/apply', { method: 'POST', status: 409 })
    const batchPlanValue = { mutationId: randomUUID(), blueprintRange: { start: 2, end: 5 }, guidance: '保持情节连续' }
    await request(projectPath + '/batches', { method: 'POST', status: 400,
      value: { ...batchPlanValue, blueprintRange: { start: 2, end: 22 } } })
    const planBatch = (await request(projectPath + '/batches', { method: 'POST', status: 202, value: batchPlanValue })).result
    assert.equal((await request(projectPath + '/batches', { method: 'POST', status: 202, value: batchPlanValue })).result.id, planBatch.id)
    const completedPlans = await awaitBatch(projectPath + '/batches/' + planBatch.id, row => row.status === 'done')
    assert.equal(completedPlans.operation, 'plan')
    assert.deepEqual(completedPlans.items.map(row => [row.number, row.status]), [[2, 'skipped'], [3, 'done'], [4, 'done'], [5, 'done']])
    assert.match(lastPrompt, /上一章待核对的蓝图候选/)
    assert.match(lastPrompt, /前章蓝图 · 第 2 章/)
    for (const item of completedPlans.items.filter(item => item.run_id)) {
      assert.equal((await request(projectPath + '/documents/' + item.id)).result.body, '')
      assert.match((await request(projectPath + '/runs/' + item.run_id + '/apply', { method: 'POST' })).result.body, /蓝图候选/)
    }
    const referencePath = projectPath + '/reference-novels'
    const originalDocs = (await request(projectPath + '/documents')).result
    const importedReference = { mutationId: randomUUID(), title: '对照作品', text: '# 第四章 参考起点\n\n参考角色雾海客。\n\n第八章 转折\n\n秘密岛屿。' }
    const book = (await request(referencePath, { method: 'POST', status: 201, value: importedReference })).result
    assert.deepEqual(book.chapters.map(row => [row.position, row.number, row.title]), [[1, 4, '参考起点'], [2, 8, '转折']])
    assert.equal((await request(referencePath, { method: 'POST', status: 201, value: importedReference })).result.id, book.id)
    await request(referencePath, { method: 'POST', status: 409, value: { ...importedReference, title: '不同书名' } })
    const bookPath = referencePath + '/' + book.id
    await request('/api/projects/' + second.id + '/reference-novels/' + book.id, { status: 404 })
    assert.match((await request(bookPath + '/chapter?position=2')).result.body, /秘密岛屿/)
    const refInput = { first: 1, last: 2, guidance: '参考文本研究', mutationId: randomUUID() }
    const refPreview = (await request(bookPath + '/context', { method: 'POST', value: refInput })).result
    assert.match(refPreview.messages[1].content, /参考角色雾海客/)
    const firstOnly = (await request(bookPath + '/context', { method: 'POST', value: { ...refInput, last: 1 } })).result
    assert.doesNotMatch(firstOnly.messages[1].content, /秘密岛屿/)
    await request(bookPath + '/context', { method: 'POST', status: 400, value: { ...refInput, last: 3 } })
    await request(bookPath + '/context', { method: 'POST', status: 422, value: { mode: 'synthesis' } })
    const hold = (await request(bookPath + '/analyze', { method: 'POST', status: 202,
      value: { ...refInput, guidance: 'hold', mutationId: randomUUID() } })).result
    const analysisPath = projectPath + '/reference-analysis/'
    await request(projectPath + '/documents/' + setting.id + '/runs', { method: 'POST', status: 409,
      value: { kind: 'plan', baseRev: 3, mutationId: randomUUID() } })
    await request('/api/projects/' + second.id + '/reference-analysis/' + hold.id + '/cancel', { method: 'POST', status: 404 })
    await request(analysisPath + hold.id + '/cancel', { method: 'POST' })
    await awaitRun(analysisPath + hold.id, row => row.status === 'cancelled')
    const invalid = (await request(bookPath + '/analyze', { method: 'POST', status: 202,
      value: { ...refInput, guidance: '缺章演练', mutationId: randomUUID() } })).result
    const failed = await awaitRun(analysisPath + invalid.id, row => row.status === 'failed')
    assert.match(failed.output, /缺章/)
    assert.equal(failed.report, undefined)
    const refJob = (await request(bookPath + '/analyze', { method: 'POST', status: 202, value: refInput })).result
    const report = (await awaitRun(analysisPath + refJob.id, row => row.status === 'done')).report
    assert.equal(lastPrompt, refPreview.messages[1].content)
    assert.deepEqual(report.chapters.map(row => row.position), [1, 2])
    assert.equal((await request(bookPath + '/analyze', { method: 'POST', status: 202, value: refInput })).result.id, refJob.id)
    assert.equal(report.constraints, '用具体动作表现犹豫。')
    const bookAfterAnalysis = (await request(bookPath)).result
    assert.deepEqual(bookAfterAnalysis.coverage, { completed: 2, next: null })
    const synthesisRequest = { mode: 'synthesis', mutationId: randomUUID() }
    const synthesisPreview = (await request(bookPath + '/context', { method: 'POST', value: synthesisRequest })).result
    assert.match(synthesisPreview.messages[1].content, /位置 1[\s\S]*位置 2/)
    assert.doesNotMatch(synthesisPreview.messages[1].content, /雾海客|秘密岛屿/)
    const synthesis = (await request(bookPath + '/analyze', { method: 'POST', status: 202, value: synthesisRequest })).result
    assert.deepEqual(synthesis.sources, [refJob.id])
    const synthesisReport = (await awaitRun(analysisPath + synthesis.id, row => row.status === 'done')).report
    assert.equal(synthesisReport.structure, '首尾呼应')
    assert.deepEqual((await request(projectPath + '/documents')).result, originalDocs)
    const novelContext = (await request(projectPath + '/documents/' + setting.id + '/context', { method: 'POST',
      value: { kind: 'plan', baseRev: 3 } })).result.messages.at(-1).content
    assert.doesNotMatch(novelContext, /雾海客|秘密岛屿|用具体动作表现犹豫/)
    const refBackup = (await request(projectPath + '/backup')).result
    const restoredReference = (await request('/api/import', { method: 'POST', status: 201, value: refBackup })).result
    const restoredPath = '/api/projects/' + restoredReference.id
    const [restoredBook] = (await request(restoredPath + '/reference-novels')).result
    assert.notEqual(restoredBook.id, book.id)
    const restoredJobs = (await request(restoredPath + '/reference-novels/' + restoredBook.id)).result.jobs
    const restoredJob = restoredJobs.find(row => row.status === 'done' && row.mode === 'range')
    assert.deepEqual((await request(restoredPath + '/reference-analysis/' + restoredJob.id)).result.report, report)
    const restoredSynthesis = restoredJobs.find(row => row.mode === 'synthesis')
    const restoredSynthesisJob = (await request(restoredPath + '/reference-analysis/' + restoredSynthesis.id)).result
    assert.deepEqual(restoredSynthesisJob.report, synthesisReport)
    assert.deepEqual(restoredSynthesisJob.sources, [restoredJob.id])

    const continuityPath = projectPath + '/continuity/' + person.id
    const partner = await createPlanDoc({ kind: 'character', title: '领航员', body: '人物关系测试对象' })
    const firstState = { chapter: 0, finalRev: 0, baseRev: 0, state: { location: '开篇在北岸' },
      relationships: [{ targetId: partner.id, relation: '同行者' }] }
    const baseline = (await request(continuityPath, { method: 'PUT', value: firstState })).result
    assert.equal(baseline.rev, 1)
    assert.deepEqual((await request(continuityPath, { method: 'PUT', value: firstState })).result, baseline)
    await request(continuityPath, { method: 'PUT', status: 409, cookie: b, value: { ...firstState, state: { location: '另一设备' } } })
    await request(continuityPath, { method: 'PUT', status: 400, value: { ...firstState, baseRev: 1,
      relationships: [{ targetId: person.id, relation: '自身' }] } })
    await request('/api/projects/' + second.id + '/continuity/' + person.id, { status: 404 })
    const anchor = await createPlanDoc({ kind: 'chapter', number: 7, title: '离开北岸', body: '调查者上船。' })
    const later = await createPlanDoc({ kind: 'chapter', number: 8, title: '抵达灯塔', body: '' })
    const anchorPath = projectPath + '/documents/' + anchor.id
    const laterPath = projectPath + '/documents/' + later.id
    const anchorState = { ...firstState, chapter: 7, finalRev: 2, state: { location: '定稿后在灯塔船上' } }
    await request(continuityPath, { method: 'PUT', status: 422, value: anchorState })
    await request(anchorPath + '/status', { method: 'POST', value: { action: 'finalize', baseRev: 1 } })
    const picker = (await request(projectPath + '/continuity')).result
    assert.equal(picker.finals.find(row => row.number === 7).rev, 2)
    assert.equal((await request(continuityPath + '?chapter=7')).result.previous.state.location, '开篇在北岸')
    await request(continuityPath, { method: 'PUT', value: anchorState })
    const relationshipsAtAnchor = (await request(projectPath + '/continuity/relationships?chapter=7')).result
    assert.deepEqual(relationshipsAtAnchor.records[0].relationships, [{ targetId: partner.id, name: partner.title, relation: '同行者' }])
    assert.equal(relationshipsAtAnchor.records[0].chapter, 7)
    const laterRun = await startFor(later, { kind: 'draft' })
    assert.match(laterRun.prompt, /定稿后在灯塔船上[\s\S]*领航员[\s\S]*同行者/)
    await request(anchorPath + '/status', { method: 'POST', value: { action: 'reopen', baseRev: 2 } })
    const anchorPreview = (await request(anchorPath + '/context', { method: 'POST', value: { kind: 'draft', baseRev: 3 } })).result
    assert.match(anchorPreview.messages[1].content, /开篇在北岸/)
    assert.doesNotMatch(anchorPreview.messages[1].content, /定稿后在灯塔船上/)
    const previewLater = async () => (await request(laterPath + '/context', { method: 'POST', value: { kind: 'draft', baseRev: 1 } })).result.messages[1].content
    assert.match(await previewLater(), /定稿后在灯塔船上/)
    await request(anchorPath + '/status', { method: 'POST', value: { action: 'finalize', baseRev: 3 } })
    await request(laterRun.jobPath + '/apply', { method: 'POST', status: 409 })
    await request(continuityPath, { method: 'PUT', status: 409, value: anchorState })
    assert.doesNotMatch(await previewLater(), /定稿后在灯塔船上/)
    const afterRefinal = (await request(continuityPath + '?chapter=7')).result
    assert.equal(afterRefinal.current, null)
    assert.equal(afterRefinal.history.find(row => row.finalRev === 2).active, 0)
    const archivedState = (await request(continuityPath + '/history?chapter=7&finalRev=2')).result
    assert.equal(archivedState.state.location, '定稿后在灯塔船上')
    const freshState = { ...anchorState, finalRev: 4, state: { location: '新定稿确认已在南岸' } }
    await request(continuityPath, { method: 'PUT', value: freshState })
    assert.match(await previewLater(), /新定稿确认已在南岸/)
    const latestBackup = (await request(projectPath + '/backup')).result
    const copiedContinuity = (await request('/api/import', { method: 'POST', status: 201, value: latestBackup })).result
    const copiedPath = '/api/projects/' + copiedContinuity.id
    const copiedRoster = (await request(copiedPath + '/continuity')).result
    const copiedPerson = copiedRoster.characters.find(row => row.title === person.title)
    const copiedPartner = copiedRoster.characters.find(row => row.title === partner.title)
    assert.notEqual(copiedPerson.id, person.id)
    const copiedState = (await request(copiedPath + '/continuity/' + copiedPerson.id + '?chapter=7')).result
    assert.deepEqual(copiedState.current.relationships, [{ targetId: copiedPartner.id, relation: '同行者' }])
    assert.equal(copiedState.history.filter(row => !row.active).length, 1)

    const evidenceDoc = await createPlanDoc({ kind: 'chapter', number: 9, title: '出海', body: '调查者登船。\r\n潮声阵阵。\r\n潮声阵阵。' })
    const evidenceDocPath = projectPath + '/documents/' + evidenceDoc.id
    const extractRequest = { kind: 'continuity', baseRev: 2, continuityCharacterId: person.id, mutationId: randomUUID() }
    await request(evidenceDocPath + '/context', { method: 'POST', status: 422, value: extractRequest })
    await request(evidenceDocPath + '/status', { method: 'POST', value: { action: 'finalize', baseRev: 1 } })
    await request(evidenceDocPath + '/status', { method: 'POST', value: { action: 'reopen', baseRev: 2 } })
    await request(evidenceDocPath, { method: 'PUT', value: {
      title: '出海', body: '重开草稿里的新情节。', baseRev: 3, mutationId: randomUUID(),
    } })
    const extractPreview = (await request(evidenceDocPath + '/context', { method: 'POST', value: extractRequest })).result
    assert.match(extractPreview.messages[1].content, /目标人物：调查者[\s\S]*新定稿确认已在南岸[\s\S]*调查者登船。/)
    assert.doesNotMatch(extractPreview.messages[1].content, /重开草稿里的新情节/)
    const extractJob = (await request(evidenceDocPath + '/runs', { method: 'POST', status: 202, value: extractRequest })).result
    const extractPath = projectPath + '/runs/' + extractJob.id
    const extracted = await awaitRun(extractPath, row => row.status === 'done')
    assert.equal(lastPrompt, extractPreview.messages[1].content)
    assert.equal(extracted.base_rev, 2)
    assert.equal(extracted.continuityCharacterId, person.id)
    assert.deepEqual(extracted.continuityReport.changes.map(change => change.evidence), ['verified', 'ambiguous', 'missing'])
    assert.equal((await request(evidenceDocPath + '/runs', { method: 'POST', status: 202, value: extractRequest })).result.id, extractJob.id)
    await request(extractPath + '/apply', { method: 'POST', status: 422 })
    const suggestions = (await request(continuityPath + '/suggestions?chapter=9&finalRev=2')).result
    assert.deepEqual(suggestions.map(row => row.id), [extractJob.id])
    assert.equal((await request(continuityPath + '?chapter=9')).result.current, null)
    const candidate = { chapter: 9, finalRev: 2, baseRev: 0, state: { location: '船上' }, relationships: [],
      picks: [{ field: 'location', runId: extractJob.id }] }
    await request(projectPath + '/continuity/' + partner.id, { method: 'PUT', value: candidate, status: 409 })
    await request(continuityPath, { method: 'PUT', status: 422, value: { ...candidate, state: { location: '其他地点' } } })
    await request(continuityPath, { method: 'PUT', status: 422, value: {
      ...candidate, state: { physicalState: '保持站立' }, picks: [{ field: 'physicalState', runId: extractJob.id }],
    } })
    const approved = (await request(continuityPath, { method: 'PUT', value: candidate })).result
    assert.deepEqual(approved.evidence, { location: '调查者登船。\n潮声阵阵。' })
    assert.deepEqual((await request(continuityPath, { method: 'PUT', value: candidate })).result, approved)
    const evidenceBackup = (await request(projectPath + '/backup')).result
    const restoredEvidence = (await request('/api/import', { method: 'POST', status: 201, value: evidenceBackup })).result
    const restoredEvidencePath = '/api/projects/' + restoredEvidence.id
    const restoredPeople = (await request(restoredEvidencePath + '/continuity')).result.characters
    const restoredId = restoredPeople.find(row => row.title === '调查者').id
    const restoredContinuityPath = restoredEvidencePath + '/continuity/' + restoredId
    assert.deepEqual((await request(restoredContinuityPath + '?chapter=9')).result.current.evidence, approved.evidence)
    const [restoredCandidate] = (await request(restoredContinuityPath + '/suggestions?chapter=9&finalRev=2')).result
    const restoredCandidateDetail = (await request(restoredEvidencePath + '/runs/' + restoredCandidate.id)).result
    assert.equal(restoredCandidateDetail.continuityCharacterId, restoredId)
    assert.deepEqual(restoredCandidateDetail.continuityReport, extracted.continuityReport)
    const manual = (await request(continuityPath, { method: 'PUT', value: {
      ...candidate, baseRev: approved.rev, state: { location: '作者另记在甲板' }, picks: [],
    } })).result
    assert.deepEqual(manual.evidence, {})
    await request(evidenceDocPath + '/status', { method: 'POST', value: { action: 'finalize', baseRev: 4 } })
    await request(continuityPath + '/suggestions?chapter=9&finalRev=2', { status: 409 })
    await request(continuityPath, { method: 'PUT', value: { ...candidate, finalRev: 5 }, status: 409 })
    assert.deepEqual((await request(continuityPath + '/suggestions?chapter=9&finalRev=5')).result, [])
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
      DROP TABLE character_continuity;
      DROP TABLE reference_analyses; DROP TABLE reference_novel_chapters; DROP TABLE reference_novels;
      DROP TABLE project_goals;
      DROP TABLE screenplay_receipts; DROP TABLE screenplay_history; DROP TABLE screenplay_episodes; DROP TABLE screenplay_adaptations;
      DROP TABLE writing_skill_profiles; DROP TABLE writing_skills;
      DROP TABLE writing_batch_items; DROP TABLE writing_batches;
      DROP TRIGGER document_created_event; DROP TRIGGER document_updated_event; DROP TABLE project_events; DROP TABLE narrative_threads;
      DROP TABLE reference_vectors;
      DROP TABLE chapter_imports; DROP TABLE reference_material;
      ALTER TABLE runs DROP COLUMN continued_from; ALTER TABLE runs DROP COLUMN request_data;
      ALTER TABLE runs DROP COLUMN outline_id; ALTER TABLE runs DROP COLUMN reference_ids; PRAGMA user_version=1;
    `)
    store.db.close()
    store = undefined
    store = openStore(directory)
    assert.equal(store.document(p.id, doc.id).body, '原文')
    assert.equal(store.get('PRAGMA user_version').user_version, schemaVersion)
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
      CREATE TABLE project_core (id TEXT,project_name TEXT,worldbuilding TEXT,genre TEXT,total_chapters INTEGER);
      INSERT INTO project_core VALUES ('main','海边','风暴常见','冒险',32);
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
    assert.deepEqual(payload.goals, { genre: '冒险', chapters: 32 })
    const chapter = payload.documents.find(doc => doc.kind === 'chapter')
    assert.equal(chapter.body, '重开的正文')
    assert.equal(chapter.rev, 5)
    assert.equal(chapter.history.length, 4)
    const store = openStore(join(directory, 'web'))
    try {
      const p = store.importBackup(payload)
      assert.deepEqual(store.projectGoals(p.id), { goals: payload.goals, rev: 1 })
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
