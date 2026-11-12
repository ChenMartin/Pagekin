import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiError } from './input.mjs'
import { backupDatabase } from './maintenance.mjs'

export const webdavBackupSchema = `
  CREATE TABLE webdav_backup (
    id INTEGER PRIMARY KEY CHECK(id=1), target TEXT NOT NULL,
    attempted INTEGER NOT NULL, succeeded INTEGER, file TEXT, size INTEGER, error TEXT NOT NULL
  );
`

const hour = 3_600_000
const retry = 15 * 60_000

function configuration(env) {
  if (!env.WEBDAV_BACKUP_URL) return null
  let endpoint
  try { endpoint = new URL(env.WEBDAV_BACKUP_URL) }
  catch { throw new Error('WEBDAV_BACKUP_URL 无效') }
  const username = env.WEBDAV_BACKUP_USERNAME || ''
  const password = env.WEBDAV_BACKUP_PASSWORD_FILE
    ? readFileSync(env.WEBDAV_BACKUP_PASSWORD_FILE, 'utf8').replace(/\r?\n$/u, '')
    : env.WEBDAV_BACKUP_PASSWORD || ''
  const anonymousLoopback = !username && !password && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && anonymousLoopback)) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      Boolean(username) !== Boolean(password) || username.includes(':')) {
    throw new Error('WebDAV 备份需要有效的 HTTPS 目录地址和成对配置的用户名、密码')
  }
  if (!endpoint.pathname.endsWith('/')) endpoint.pathname += '/'
  const hours = Number(env.WEBDAV_BACKUP_INTERVAL_HOURS || '24')
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 720) throw new Error('WebDAV 备份间隔须为 1–720 小时')
  const headers = username ? { Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') } : {}
  return { endpoint, headers, hours, target: createHash('sha256').update(endpoint.href).digest('hex') }
}

export function openWebDavBackup({ get, run }, directory, env = process.env, now = Date.now) {
  let config
  let configError = ''
  try { config = configuration(env) }
  catch (error) { configError = error.code ? '无法读取 WebDAV 密码文件' : error.message }
  let working = null
  let timer
  const lifetime = new AbortController()
  const saved = () => config ? get('SELECT * FROM webdav_backup WHERE id=1 AND target=?', config.target) : null
  function status() {
    const state = saved()
    const next = !config ? null : Math.max(
      state?.error ? state.attempted + retry : 0,
      state?.succeeded ? state.succeeded + config.hours * hour : 0,
    )
    return { enabled: Boolean(config), configError, running: Boolean(working), intervalHours: config?.hours ?? null,
      next: next === null ? null : next || now(), attempted: state?.attempted ?? null, succeeded: state?.succeeded ?? null,
      file: state?.file ?? null, size: state?.size ?? null, error: state?.error ?? '' }
  }

  async function request(method, url, signal, options = {}) {
    const response = await fetch(url, {
      method, redirect: 'error', signal, ...options, headers: { ...config.headers, ...options.headers },
    })
    await response.body?.cancel()
    if (!response.ok || response.status === 207) throw new ApiError(502, `WebDAV ${method} 失败（HTTP ${response.status}）`)
  }

  async function upload(attempted) {
    const filename = 'pagekin-' + new Date(attempted).toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID() + '.sqlite'
    const target = new URL(filename, config.endpoint)
    const partial = new URL(filename + '.partial', config.endpoint)
    let stage
    let pending = false
    let size
    let error = ''
    try {
      stage = await mkdtemp(join(directory, '.webdav-'))
      const path = join(stage, 'snapshot.sqlite')
      await backupDatabase(join(directory, 'novels.sqlite'), path, { omitSessions: true })
      size = (await stat(path)).size
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15 * 60_000)])
      pending = true
      const stream = createReadStream(path)
      try {
        await request('PUT', partial, signal, { body: stream, duplex: 'half', headers: {
          'Content-Type': 'application/vnd.sqlite3', 'Content-Length': String(size), 'If-None-Match': '*',
        } })
      } finally { stream.destroy() }
      await request('MOVE', partial, signal, { headers: { Destination: target.href, Overwrite: 'F' } })
      pending = false
    } catch (failure) {
      error = failure instanceof ApiError ? failure.message : lifetime.signal.aborted ? '服务停止，备份已中断' : '备份失败，请检查磁盘和 WebDAV 连接'
    } finally {
      if (pending && !lifetime.signal.aborted) {
        await request('DELETE', partial, AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)])).catch(() => {})
      }
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {})
    }
    const previous = saved()
    run(`INSERT INTO webdav_backup (id,target,attempted,succeeded,file,size,error) VALUES (1,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET target=excluded.target,attempted=excluded.attempted,succeeded=excluded.succeeded,
      file=excluded.file,size=excluded.size,error=excluded.error`, config.target, attempted,
    error ? previous?.succeeded ?? null : now(), error ? previous?.file ?? null : filename,
    error ? previous?.size ?? null : size, error)
  }

  function start() {
    if (!config || lifetime.signal.aborted) throw new ApiError(422, configError || '请先在 NAS 配置 WebDAV 备份')
    if (working) return status()
    working = upload(now()).catch(() => console.error('无法保存 WebDAV 备份结果')).finally(() => { working = null })
    return status()
  }

  function schedule() {
    if (!config || timer) return
    timer = setInterval(() => {
      if (!working && status().next <= now()) start()
    }, 60_000)
    timer.unref()
  }

  return { status, start, schedule, close() { clearInterval(timer); lifetime.abort(); return working } }
}
