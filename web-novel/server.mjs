import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { ApiError, hash, object, openStore, outlineMaxChars } from './store.mjs'
import { archiveLimit } from './desktop-archive.mjs'
import { manuscriptRequestBytes } from './public/manuscript.mjs'
import { writingMessages } from './writing-context.mjs'
import { releaseVersion } from './version.mjs'
import { openSemantic } from './semantic.mjs'
import { continuationAddition } from './continuation.mjs'
import { manuscriptExport } from './manuscript-export.mjs'

const password = process.env.APP_PASSWORD_FILE
  ? readFileSync(process.env.APP_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '')
  : process.env.APP_PASSWORD ?? ''
if (password.length < 12 || password.length > 512) throw new Error('APP_PASSWORD 需为 12–512 个字符')
const passwordHash = hash(password)
const safeCookie = process.env.APP_SECURE_COOKIE !== '0'
const origin = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : ''
const storage = openStore(process.env.APP_DATA_DIR || fileURLToPath(new URL('./data', import.meta.url)))
const semantic = openSemantic(storage)
const sessionSeconds = 7 * 86400
const attempts = new Map()
const active = new Map()
const batchWorkers = new Set()
const eventClients = new Set()
let archiveImporting = false
let stopping = false
const model = process.env.LLM_MODEL || ''
const contextLimit = Number(process.env.LLM_CONTEXT_CHARS || '64000')
if (!Number.isInteger(contextLimit) || contextLimit < 4000 || contextLimit > 250000) {
  throw new Error('LLM_CONTEXT_CHARS 应为 4000–250000 的整数')
}
const prepareMessages = (kind, context) => writingMessages(kind, context, contextLimit)
const key = process.env.LLM_API_KEY || ''
const endpoint = model ? new URL((process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions') : null
if (endpoint && (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash || (key && endpoint.protocol !== 'https:'))) {
  throw new Error('模型地址无效。配置 API Key 时请使用 HTTPS')
}

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/manuscript.mjs', ['manuscript.mjs', 'text/javascript']],
  ['/novel-goals.mjs', ['novel-goals.mjs', 'text/javascript']],
  ['/screenplay-ui.mjs', ['screenplay-ui.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
].map(([path, [file, type]]) => [path, [readFileSync(new URL(`./public/${file}`, import.meta.url)), type]]))
const editorBundle = new URL('./public/editor.bundle.mjs', import.meta.url)
const enhancedEditor = process.env.APP_EDITOR !== 'plain' && existsSync(editorBundle)
if (enhancedEditor) {
  files.set('/editor.bundle.mjs', [readFileSync(editorBundle), 'text/javascript'])
  files.set('/editor.notices.txt', [readFileSync(new URL('./public/editor.notices.txt', import.meta.url)), 'text/plain'])
}
const csp = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"

function headers(res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', csp)
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readBytes(req, limit) {
  const chunks = []
  let length = 0
  if (Number(req.headers['content-length']) > limit) throw new ApiError(413, '请求过大')
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length
    if (length > limit) { req.resume(); throw new ApiError(413, '请求过大') }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}

async function body(req, limit = 1_200_000) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new ApiError(415, '需要 JSON 请求')
  const bytes = await readBytes(req, limit)
  try { return object(JSON.parse(bytes.toString('utf8'))) }
  catch { throw new ApiError(400, '请求格式无效') }
}

async function importArchive(req, res) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw new ApiError(415, '请选择桌面 .ainovel 归档')
  if (archiveImporting) throw new ApiError(409, '已有桌面归档正在导入')
  archiveImporting = true
  let directory, worker, timer
  try {
    const bytes = Uint8Array.from(await readBytes(req, archiveLimit))
    directory = await mkdtemp(join(tmpdir(), 'pagekin-web-archive-'))
    worker = new Worker(new URL('./desktop-archive.mjs', import.meta.url), {
      workerData: { bytes, directory }, transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    })
    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', () => reject(new ApiError(422, '无法解析桌面归档')))
      worker.once('exit', () => reject(new ApiError(422, '归档解析任务已退出')))
      timer = setTimeout(() => reject(new ApiError(422, '归档解析超时')), 30_000)
    })
    if (result.error) throw new ApiError(422, result.error)
    if (req.aborted || res.destroyed) throw new ApiError(400, '导入连接已中断')
    return storage.importBackup(JSON.parse(result.converted))
  } finally {
    clearTimeout(timer)
    try {
      await worker?.terminate()
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => console.error('无法清理归档临时目录'))
    } finally { archiveImporting = false }
  }
}

function sessionKey(req) {
  const cookie = /(?:^|;\s*)pagekin_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')
  return cookie ? hash(passwordHash + cookie[1]) : ''
}

function cookie(res, token, ttl) {
  res.setHeader('Set-Cookie', `pagekin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}${safeCookie ? '; Secure' : ''}`)
}

function verifyOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, '禁止跨站请求')
  if (!req.headers.origin) return
  let allowed = origin
  if (!allowed) {
    const scheme = req.socket.encrypted ? 'https' : 'http'
    allowed = `${scheme}://${req.headers.host}`
  }
  if (req.headers.origin !== allowed) throw new ApiError(403, '访问地址与服务配置不一致')
}

function writeEvent(client, id, name, data) {
  client.cursor = id
  if (!client.res.write(`id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`)) client.res.end()
}

function catchUp(client, head) {
  if (client.cursor === null || client.cursor > head || client.cursor < head - 4096) {
    writeEvent(client, head, 'sync', {})
    return
  }
  if (client.cursor === head) return
  const rows = storage.projectEvents(client.pid, client.cursor)
  for (const row of rows) {
    if (client.res.writableEnded) return
    writeEvent(client, row.cursor, 'document', { id: row.document_id, rev: row.revision })
  }
  // Advance across other projects without exposing their document details.
  if (rows.length < 128 && !client.res.writableEnded && client.cursor < head) writeEvent(client, head, 'cursor', {})
}

function subscribe(req, res, pid, token) {
  verifyOrigin(req)
  if (eventClients.size >= 16) throw new ApiError(429, '同步连接过多，请关闭不使用的标签页')
  const supplied = req.headers['last-event-id']
  const cursor = typeof supplied === 'string' && /^\d{1,16}$/.test(supplied) ? Number(supplied) : null
  const client = { res, pid, token, cursor, nextHeartbeat: Date.now() + 15_000 }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  eventClients.add(client)
  res.on('close', () => eventClients.delete(client))
  catchUp(client, storage.eventHead())
}

let lastPrune = 0
function deliverEvents() {
  const head = storage.eventHead()
  if (head - lastPrune >= 256) {
    storage.pruneEvents(head)
    lastPrune = head
  }
  const stamp = Date.now()
  for (const client of eventClients) {
    if (client.res.destroyed || client.res.writableEnded) continue
    if (stamp >= client.nextHeartbeat) {
      if (!storage.get('SELECT 1 FROM sessions WHERE token_hash=? AND expires>?', client.token, stamp)) {
        client.res.end()
        continue
      }
      client.nextHeartbeat = stamp + 15_000
      if (!client.res.write(': heartbeat\n\n')) { client.res.end(); continue }
    }
    catchUp(client, head)
  }
}
const eventTimer = setInterval(() => {
  try { deliverEvents() }
  catch { console.error('暂时无法分发作品更新，下次重试') }
}, 900)
eventTimer.unref()

function login(req, res, value) {
  const client = req.socket.remoteAddress
  const stamp = Date.now()
  for (const [id, record] of attempts) if (record.until <= stamp) attempts.delete(id)
  if (attempts.size >= 2048 && !attempts.has(client)) throw new ApiError(429, '登录请求过多，请稍后再试')
  const record = attempts.get(client) ?? { failures: 0, until: stamp + 60_000 }
  if (record.failures >= 8) throw new ApiError(429, '尝试次数过多，请稍后再试')
  const valueHash = typeof value.password === 'string' && value.password.length <= 512 ? hash(value.password) : ''
  if (!valueHash || !timingSafeEqual(Buffer.from(valueHash), Buffer.from(passwordHash))) {
    record.failures++
    attempts.set(client, record)
    throw new ApiError(401, '密码错误')
  }
  attempts.delete(client)
  const token = randomBytes(32).toString('hex')
  storage.run('DELETE FROM sessions WHERE expires<=? OR token_hash=?', stamp, sessionKey(req))
  storage.run('INSERT INTO sessions VALUES (?,?)', hash(passwordHash + token), stamp + sessionSeconds * 1000)
  cookie(res, token, sessionSeconds)
  json(res, { ok: true })
}

function providerError(status) {
  return `模型服务返回 HTTP ${status}，请检查模型配置、额度与上下文长度`
}

async function generate(job, messages, prefix = '') {
  const controller = new AbortController()
  active.set(job.id, controller)
  let raw = ''
  let lastWrite = 0
  let status = 'failed'
  let error = '生成失败，请检查模型配置或网络'
  const visible = () => {
    const output = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').replace(/<\/?think>/gi, '')
      .replace(/<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i, '')
    if (!prefix) return output
    const addition = continuationAddition(prefix, output)
    return addition ? prefix + '\n\n' + addition : prefix
  }
  const timeout = setTimeout(() => controller.abort('timeout'), 8 * 60_000)
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages, stream: true }),
    })
    if (!response.ok) {
      error = providerError(response.status)
      await response.body?.cancel()
      throw new Error(error)
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      error = '模型服务没有返回预期的流式响应'
      await response.body?.cancel()
      throw new Error(error)
    }
    let pending = ''
    let finish
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      pending += chunk
      let index
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index).trimEnd()
        pending = pending.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') { finish ??= 'stop'; continue }
        const event = JSON.parse(payload)
        if (event.error) throw new Error('模型流式输出失败')
        const choice = event.choices?.[0]
        const delta = choice?.delta?.content
        if (typeof delta === 'string') raw += delta
        if (choice?.finish_reason) finish = choice.finish_reason
        if (raw.length > 180_000) {
          raw = raw.slice(0, 180_000)
          error = '输出超过限制，已保留收到的内容'
          throw new Error(error)
        }
        if (Date.now() - lastWrite >= 650) {
          storage.run("UPDATE runs SET output=? WHERE id=? AND status='running'", visible().slice(0, 180_000), job.id)
          lastWrite = Date.now()
        }
      }
      if (pending.length > 1_000_000) throw new Error('模型响应格式无效')
    }
    const output = visible()
    if (!output.slice(prefix.length).trim()) error = prefix ? '模型没有返回新的续写内容' : '模型没有返回可用内容'
    else if (output.length > 180_000) error = '合并后的候选超过限制，已保留收到的内容'
    else if (job.kind === 'outline' && output.length > outlineMaxChars) error = '生成细纲过长，请缩短要求后重新生成'
    else if (finish === 'stop') { status = 'done'; error = '' }
    else error = '模型输出未正常完成，已保留收到的内容'
  } catch {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      status = reason === 'cancelled' ? 'cancelled' : ['paused', 'shutdown'].includes(reason) ? 'interrupted' : 'failed'
      error = reason === 'timeout' ? '模型响应超时' : reason === 'shutdown' ? '服务停止'
        : reason === 'paused' ? '批次已暂停，保留已收到的内容' : '已取消'
    }
  } finally {
    clearTimeout(timeout)
    active.delete(job.id)
    storage.run('UPDATE runs SET status=?,error=?,output=? WHERE id=?', status, error, visible().slice(0, 180_000), job.id)
  }
  return status
}

function runBatch(id) {
  if (batchWorkers.has(id) || stopping) return
  batchWorkers.add(id)
  const work = async () => {
    while (!stopping) {
      const next = storage.nextBatchRun(id, prepareMessages)
      if (!next) return
      const status = await generate(next.job, next.messages, next.prefix)
      if (status !== 'done') {
        storage.pauseBatch(id, stopping ? '服务停止，待手动继续' : '当前章节未完成，可以继续重试')
        return
      }
    }
  }
  void work().catch(error => {
    console.error('批量写作执行失败：', error.code ?? error.name)
    try { storage.pauseBatch(id, '批量任务处理失败，请检查存储后继续') }
    catch { console.error('无法记录批次状态') }
  }).finally(() => batchWorkers.delete(id))
}

async function route(req, res) {
  headers(res)
  const url = new URL(req.url, 'http://localhost')
  const method = req.method
  const path = url.pathname
  if (method === 'GET' && path === '/healthz') return json(res, { ok: storage.get('SELECT 1 ok').ok === 1, version: releaseVersion })
  const file = method === 'GET' && files.get(path)
  if (file) {
    let bytes = file[0]
    if (path === '/' && enhancedEditor) {
      const nonce = randomBytes(18).toString('base64')
      res.setHeader('Content-Security-Policy', csp + "; style-src 'self' 'nonce-" + nonce + "'")
      bytes = bytes.toString('utf8').replace('__PAGEKIN_STYLE_NONCE__', nonce)
    }
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` })
    return res.end(bytes)
  }
  if (method !== 'GET') verifyOrigin(req)
  if (method === 'POST' && path === '/api/session') return login(req, res, await body(req, 4096))
  const token = sessionKey(req)
  if (!storage.get('SELECT 1 FROM sessions WHERE token_hash=? AND expires>?', token, Date.now())) {
    throw new ApiError(401, '请登录')
  }
  if (method === 'DELETE' && path === '/api/session') {
    storage.run('DELETE FROM sessions WHERE token_hash=?', token)
    for (const client of eventClients) if (client.token === token) client.res.end()
    cookie(res, '', 0)
    return json(res, { ok: true })
  }
  if (method === 'GET' && path === '/api/session') return json(res, {
    model: !!model, version: releaseVersion, enhancedEditor, semanticSearch: !!semantic,
  })
  if (path === '/api/projects' && method === 'GET') {
    return json(res, storage.all('SELECT * FROM projects ORDER BY created DESC'))
  }
  if (path === '/api/projects' && method === 'POST') {
    const value = await body(req)
    return json(res, storage.createProject(value.title), 201)
  }
  if (path === '/api/import' && method === 'POST') {
    return json(res, storage.importBackup(await body(req, 24_000_000)), 201)
  }
  if (path === '/api/import-desktop' && method === 'POST') {
    return json(res, await importArchive(req, res), 201)
  }
  const [, api, projects, pid, resource, id, action, extra] = path.split('/')
  if (api !== 'api' || projects !== 'projects' || !pid || extra !== undefined) throw new ApiError(404, '接口不存在')
  storage.project(pid)
  if (resource === 'goals' && id === undefined) {
    if (method === 'GET') return json(res, storage.projectGoals(pid))
    if (method === 'PUT') return json(res, storage.saveProjectGoals(pid, await body(req, 8192)))
  }
  const screenplay = storage.screenplay
  if (resource === 'adaptations') {
    if (method === 'GET' && action === undefined) {
      if (id === 'eligible') return json(res, screenplay.eligible(pid))
      return json(res, id ? screenplay.details(pid, id) : screenplay.list(pid))
    }
    if (method === 'POST' && id === undefined) return json(res, screenplay.create(pid, await body(req, 4096)), 201)
    if (method === 'POST' && id && action === 'episodes') return json(res, screenplay.createEpisode(pid, id, await body(req, 8192)), 201)
  }
  if (resource === 'episodes' && id) {
    if (method === 'GET' && action === undefined) return json(res, screenplay.episode(pid, id))
    if (method === 'PUT' && action === undefined) return json(res, screenplay.changeEpisode(pid, id, await body(req), 'save'))
    if (method === 'GET' && action === 'source') return json(res, screenplay.episodeSource(pid, id, url.searchParams.get('chapter')))
    if (method === 'GET' && action === 'history') {
      const rev = url.searchParams.get('rev')
      return json(res, rev === null ? screenplay.history(pid, id) : screenplay.version(pid, id, Number(rev)))
    }
    if (method === 'POST' && action === 'history') return json(res, screenplay.changeEpisode(pid, id, await body(req, 4096), 'restore'))
    if (method === 'POST' && action === 'status') {
      const value = await body(req, 4096)
      if (!['confirm', 'reopen'].includes(value.action)) throw new ApiError(400, '剧本操作无效')
      return json(res, screenplay.changeEpisode(pid, id, value, value.action))
    }
    if (method === 'GET' && action === 'export') {
      const text = screenplay.exportEpisode(pid, id)
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="screenplay.md"' })
      return res.end(text)
    }
  }
  if (resource === 'writing-skills' && action === undefined) {
    if (method === 'GET') return json(res, id ? storage.writingSkill(pid, id) : storage.listSkills(pid))
    if (method === 'POST' && id === undefined) return json(res, storage.installSkill(pid, await body(req, 50_000)), 201)
    if (method === 'PUT' && id === 'bindings') return json(res, storage.bindSkills(pid, await body(req, 4096)))
    if (method === 'DELETE' && id) return json(res, storage.deleteSkill(pid, id))
  }
  if (resource === 'batches') {
    if (method === 'GET' && id === 'eligible' && action === undefined) return json(res, storage.batchChapters(pid))
    if (method === 'GET' && action === undefined) return json(res, id ? storage.getBatch(pid, id) : storage.listBatches(pid))
    if (method === 'POST' && id === undefined) {
      if (!endpoint) throw new ApiError(422, '管理员尚未配置模型')
      const batch = storage.createBatch(pid, await body(req, 32_000))
      if (batch.status === 'running') runBatch(batch.id)
      return json(res, storage.getBatch(pid, batch.id), 202)
    }
    if (method === 'POST' && id && ['pause', 'resume', 'cancel'].includes(action)) {
      if (action === 'resume' && !endpoint) throw new ApiError(422, '管理员尚未配置模型')
      const batch = storage.changeBatch(pid, id, action)
      if (batch.status === 'running') runBatch(id)
      if (['pause', 'cancel'].includes(action)) {
        for (const item of batch.items.filter(item => item.status === 'running')) {
          active.get(item.run_id)?.abort(action === 'pause' ? 'paused' : 'cancelled')
        }
      }
      return json(res, storage.getBatch(pid, id))
    }
  }
  if (resource === 'semantic' && action === undefined) {
    if (!semantic) throw new ApiError(422, '管理员尚未配置语义模型')
    if (method === 'GET' && id === undefined) return json(res, semantic.status(pid))
    if (method === 'POST' && id === 'index') return json(res, semantic.start(pid), 202)
    if (method === 'POST' && id === 'search') return json(res, await semantic.search(pid, await body(req, 4096)))
  }
  if (method === 'PATCH' && resource === undefined) return json(res, storage.renameProject(pid, await body(req)))
  if (method === 'GET' && id === undefined && resource === 'events') return subscribe(req, res, pid, token)
  if (resource === 'threads' && action === undefined) {
    if (method === 'GET' && id === undefined) return json(res, storage.threads(pid))
    if (method === 'POST' && id === undefined) return json(res, storage.saveThread(pid, null, await body(req)), 201)
    if (method === 'PUT' && id) return json(res, storage.saveThread(pid, id, await body(req)))
  }
  if (method === 'POST' && id === undefined && resource === 'chapter-imports') {
    return json(res, storage.importChapters(pid, await body(req, manuscriptRequestBytes)), 201)
  }
  if (method === 'GET' && id === undefined && resource === 'search') {
    return json(res, storage.search(pid, url.searchParams.get('q')))
  }
  if (resource === 'references') {
    if (method === 'GET' && id === undefined) {
      return json(res, storage.all('SELECT id,title,created FROM reference_material WHERE project_id=? ORDER BY created DESC,id', pid))
    }
    if (method === 'GET' && id && action === undefined) return json(res, storage.reference(pid, id))
    if (method === 'POST' && id === undefined) return json(res, storage.addReference(pid, await body(req)), 201)
  }
  if (resource === 'documents') {
    if (method === 'GET' && id === undefined) return json(res, storage.all(`
      SELECT id,kind,number,title,rev,status,updated FROM documents WHERE project_id=? ORDER BY kind,number,created`, pid))
    if (method === 'POST' && id === undefined) {
      const value = await body(req)
      return json(res, storage.tx(() => storage.addDocument(pid, value)), 201)
    }
    if (id && action === undefined && method === 'GET') return json(res, storage.document(pid, id))
    if (id && action === undefined && method === 'PUT') return json(res, storage.save(pid, id, await body(req)))
    if (id && action === 'status' && method === 'POST') return json(res, storage.transition(pid, id, await body(req)))
    if (id && action === 'history' && method === 'GET') return json(res, storage.history(pid, id))
    if (id && action === 'history' && method === 'POST') return json(res, storage.restore(pid, id, await body(req)))
    if (id && action === 'runs' && method === 'GET') {
      storage.document(pid, id)
      return json(res, storage.all('SELECT id,kind,status,created FROM runs WHERE document_id=? ORDER BY created DESC LIMIT 50', id))
    }
    if (id && action === 'runs' && method === 'POST') {
      if (!endpoint) throw new ApiError(422, '管理员尚未配置模型')
      const value = await body(req)
      const { job, messages } = storage.startRun(pid, id, value, prepareMessages)
      if (messages) void generate(job, messages).catch(() => console.error('无法记录任务结果'))
      return json(res, storage.runDetail(pid, job.id), 202)
    }
    if (id && action === 'context' && method === 'POST') {
      const messages = storage.previewRun(pid, id, await body(req), prepareMessages)
      return json(res, { messages, limit: contextLimit })
    }
  }
  if (resource === 'runs' && method === 'GET' && id === undefined) {
    const scope = url.searchParams.get('scope') ?? 'active'
    if (!['active', 'history'].includes(scope)) throw new ApiError(400, '任务筛选无效')
    const statusFilter = scope === 'active' ? "r.status='running'" : "r.status<>'running'"
    return json(res, storage.all(`
      SELECT r.id,r.kind,r.status,r.created,r.applied_rev,r.error,r.document_id,d.title,d.number
      FROM documents d JOIN runs r ON r.document_id=d.id
      WHERE d.project_id=? AND ${statusFilter}
      ORDER BY r.created DESC,r.id DESC LIMIT 50`, pid))
  }
  if (resource === 'runs' && id) {
    if (method === 'GET' && action === undefined) return json(res, storage.runDetail(pid, id))
    if (method === 'GET' && action === 'candidate') return json(res, storage.previewPassage(pid, id))
    if (method === 'POST' && action === 'continue') {
      if (!endpoint) throw new ApiError(422, '管理员尚未配置模型')
      const { job, messages, prefix } = storage.continueRun(pid, id, await body(req, 4096), prepareMessages)
      if (messages) void generate(job, messages, prefix).catch(() => console.error('无法记录续写结果'))
      return json(res, storage.runDetail(pid, job.id), 202)
    }
    if (method === 'POST' && action === 'cancel') {
      storage.getRun(pid, id)
      active.get(id)?.abort('cancelled')
      return json(res, { ok: true })
    }
    if (method === 'POST' && action === 'apply') return json(res, storage.applyRun(pid, id))
    if (action === 'merge' && method === 'GET') return json(res, storage.previewRevision(pid, id))
    if (action === 'merge' && method === 'POST') return json(res, storage.applyRevision(pid, id, await body(req)))
  }
  if (method === 'GET' && id === undefined && resource === 'backup') {
    res.setHeader('Content-Disposition', 'attachment; filename="pagekin-backup.json"')
    return json(res, storage.backup(pid))
  }
  if (method === 'GET' && id === undefined && resource === 'export') {
    const { title } = storage.project(pid)
    const chapters = storage.chapters(pid, url.searchParams.get('drafts') === '1')
    const exported = manuscriptExport(title, chapters, url.searchParams.get('format') ?? 'md')
    res.writeHead(200, { 'Content-Type': exported.type, 'Content-Disposition': exported.disposition })
    return res.end(exported.data)
  }
  throw new ApiError(404, '接口不存在')
}

const server = createServer({ requestTimeout: 60_000 }, (req, res) => {
  route(req, res).catch(error => {
    if (res.headersSent) { res.destroy(); return }
    if (error instanceof ApiError) return json(res, { error: error.message, current: error.details }, error.status)
    console.error('请求失败：', error.code ?? error.name)
    json(res, { error: '服务处理失败，请检查存储空间或稍后重试' }, 500)
  })
})
server.listen(Number(process.env.PORT || '3100'), process.env.APP_HOST || '127.0.0.1',
  () => console.log(`Pagekin Web listening on ${JSON.stringify(server.address())}`))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true
    semantic?.close()
    clearInterval(eventTimer)
    for (const client of eventClients) client.res.end()
    for (const controller of active.values()) controller.abort('shutdown')
    server.close(() => {
      const deadline = Date.now() + 5000
      const wait = setInterval(() => {
        if ((active.size || batchWorkers.size) && Date.now() < deadline) return
        clearInterval(wait)
        storage.db.close()
      }, 50)
    })
  })
}
