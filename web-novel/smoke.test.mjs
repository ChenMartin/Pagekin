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
  let lastPrompt = ''
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const part of req) chunks.push(part)
    upstreamCalls++
    lastPrompt = JSON.parse(Buffer.concat(chunks)).messages.at(-1).content
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"候选正文"}}]}\n\n')
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
    assert.match((await request('/')).result, /小说工作区/)
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
    const settings = await create({ kind: 'settings', title: '世界观', body: '港口常年起雾' })
    await create({ kind: 'character', title: '小舟', body: '船长' })
    await create({ kind: 'blueprint', number: 1, title: '寻找线索', body: '主角抵达码头' })
    const chapter = await create({ kind: 'chapter', number: 1, title: '抵达', body: '原稿' })
    const doc = docs + '/' + chapter.id
    const eventUrl = server.base + base + '/events'
    const initial = await readProjectEvent(eventUrl, b)
    assert.match(initial, /event: sync/)
    const cursor = /^id: (\d+)/.exec(initial)[1]
    await request('/api/projects/' + second.id + '/documents/' + chapter.id, { status: 404 })
    const save = { title: '抵达', body: '电脑上的稿', baseRev: 1, mutationId: randomUUID(), checkpoint: true }
    const receipt = (await request(doc, { method: 'PUT', value: save })).result
    assert.equal(receipt.rev, 2)
    const event = await readProjectEvent(eventUrl, b, cursor)
    assert.match(event, /event: document/)
    assert.deepEqual(JSON.parse(event.split('data: ')[1]), { id: chapter.id, rev: 2 })
    assert.deepEqual((await request(doc, { method: 'PUT', value: save, cookie: b })).result, receipt)
    await request(doc, { method: 'PUT', value: { ...save, body: '不同内容' }, status: 422 })
    const stale = await request(doc, { method: 'PUT', cookie: b, status: 409,
      value: { ...save, body: '手机旧稿', mutationId: randomUUID() } })
    assert.equal(stale.result.current.body, '电脑上的稿')
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
    await request(docs + '/' + settings.id, { method: 'PUT',
      value: { title: settings.title, body: '晴天', baseRev: 1, mutationId: randomUUID() } })
    await request(staleRun + '/apply', { method: 'POST', status: 409 })
    const review = await run('review', 2)
    await awaitRun(review, job => job.status === 'done')
    await request(review + '/apply', { method: 'POST', status: 422 })
    const revise = await run('revise', 2)
    assert.equal((await awaitRun(revise, job => job.status === 'done')).output, '候选正文')
    assert.equal((await request(doc)).result.body, '电脑上的稿')
    assert.equal((await request(revise + '/apply', { method: 'POST' })).result.rev, 3)
    assert.equal((await request(revise + '/apply', { method: 'POST' })).result.rev, 3)
    const paused = await run('draft', 3, 'hold')
    await awaitRun(paused, job => !!job.output)
    await request(paused + '/cancel', { method: 'POST' })
    assert.equal((await awaitRun(paused, job => job.status === 'cancelled')).output, '候选正文')
    await request(doc + '/status', { method: 'POST', value: { baseRev: 3, action: 'finalize' } })
    assert.match((await request(base + '/export')).result, /候选正文/)
    await request(doc, { method: 'PUT', status: 409, value: { ...save, baseRev: 4, mutationId: randomUUID() } })
    await request(doc + '/status', { method: 'POST', value: { baseRev: 4, action: 'reopen' } })
    await request(doc + '/history', { method: 'POST', value: { baseRev: 5, rev: 2 } })
    assert.equal((await request(doc)).result.body, '电脑上的稿')
    assert.match((await request(base + '/export')).result, /候选正文/)
    assert.doesNotMatch((await request(base + '/export')).result, /电脑上的稿/)
    assert.match((await request(base + '/export?drafts=1')).result, /电脑上的稿/)
    const next = await create({ kind: 'chapter', number: 2, title: '前往灯塔', body: '' })
    const nextJob = (await request(docs + '/' + next.id + '/runs', { method: 'POST', status: 202,
      value: { baseRev: 1, kind: 'draft', mutationId: randomUUID(), referenceIds: [chosen.id], referenceQuery: '灯塔建于' } })).result
    await awaitRun(base + '/runs/' + nextJob.id, job => job.status === 'done')
    assert.match(lastPrompt, /上一已定稿章节末尾：抵达\n候选正文/)
    assert.match(lastPrompt, /灯塔建于一百年前/)
    assert.match(lastPrompt, /灯塔里的旧钥匙/)
    assert.doesNotMatch(lastPrompt, /此条未选中/)
    const callsBeforePreview = upstreamCalls
    const context = (await request(docs + '/' + next.id + '/context', { method: 'POST',
      value: { kind: 'draft', baseRev: 1, referenceIds: [chosen.id], referenceQuery: '灯塔建于' } })).result
    assert.equal(context.messages.at(-1).content, lastPrompt)
    await request(base + '/threads/' + thread.id, { method: 'PUT',
      value: { ...plotThread, status: 'resolved', resolved: 2, baseRev: 1 } })
    await request(base + '/threads/' + thread.id, { method: 'PUT', status: 409,
      value: { ...plotThread, body: '另一台设备的旧稿', baseRev: 1 }, cookie: b })
    await request(base + '/runs/' + nextJob.id + '/apply', { method: 'POST', status: 409 })
    const large = await create({ kind: 'chapter', number: 3, title: '长稿', body: '正文'.repeat(5000) })
    await request(docs + '/' + large.id + '/runs', { method: 'POST', status: 422,
      value: { kind: 'revise', baseRev: 1, mutationId: randomUUID() } })
    assert.equal(upstreamCalls, callsBeforePreview)
    assert.deepEqual((await request(docs + '/' + large.id + '/runs')).result, [])
    const hits = (await request(base + '/search?q=' + encodeURIComponent('码头'))).result
    assert.equal(hits[0].kind, 'blueprint')
    assert.match(hits[0].excerpt, /码头/)
    assert.deepEqual((await request('/api/projects/' + second.id + '/search?q=' + encodeURIComponent('码头'))).result, [])
    const { result: backup } = await request(base + '/backup')
    const { result: copy } = await request('/api/import', { method: 'POST', value: backup, status: 201 })
    assert.notEqual(copy.id, project.id)
    assert.equal((await request('/api/projects/' + copy.id + '/documents')).result.length, 6)
    assert.equal((await request('/api/projects/' + copy.id + '/references')).result.length, 2)
    const copiedThreads = (await request('/api/projects/' + copy.id + '/threads')).result
    assert.equal(copiedThreads[0].resolved, 2)
    assert.notEqual(copiedThreads[0].id, thread.id)
    const brokenBackup = structuredClone(backup)
    brokenBackup.documents[0].history.push(brokenBackup.documents[0].history[0])
    await request('/api/import', { method: 'POST', value: brokenBackup, status: 400 })
    await stop(server)
    server = await launch(directory, upstream.address().port)
    assert.equal(JSON.parse((await readProjectEvent(server.base + base + '/events', b, cursor)).split('data: ')[1]).rev, 2)
    assert.equal((await request(doc)).result.body, '电脑上的稿')
    assert.equal((await request('/api/projects')).result.length, 3)
    const snapshot = join(directory, 'release-snapshot.sqlite')
    assert.equal((await backupDatabase(join(directory, 'novels.sqlite'), snapshot)).projects, 3)
    const restoreDir = join(directory, 'recovered')
    const restoredDb = join(restoreDir, 'novels.sqlite')
    assert.equal((await restoreDatabase(createReadStream(snapshot), restoredDb)).projects, 3)
    assert.equal(verifyDatabase(restoredDb).schema, 5)
    await assert.rejects(restoreDatabase(createReadStream(snapshot), restoredDb), /目标已有数据库/)
    await stop(server)
    server = await launch(restoreDir, upstream.address().port)
    await request('/api/projects', { status: 401 })
    a = await login()
    assert.equal((await request(doc)).result.body, '电脑上的稿')
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
      DROP TABLE chapter_imports; DROP TABLE reference_material;
      ALTER TABLE runs DROP COLUMN reference_ids; PRAGMA user_version=1;
    `)
    store.db.close()
    store = undefined
    store = openStore(directory)
    assert.equal(store.document(p.id, doc.id).body, '原文')
    assert.equal(store.get('PRAGMA user_version').user_version, 5)
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
