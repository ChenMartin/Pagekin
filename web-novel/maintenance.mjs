import { DatabaseSync, backup } from 'node:sqlite'
import { createWriteStream } from 'node:fs'
import { access, chmod, link, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { schemaVersion } from './version.mjs'

export function verifyDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF')
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version < 1 || version > schemaVersion ||
        db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name IN ('projects','documents','sessions')").get().n !== 3) {
      throw new Error('不是此版本可读取的 Web 小说数据库')
    }
    if (db.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error('数据库完整性检查失败')
    }
    return { schema: version, projects: db.prepare('SELECT count(*) n FROM projects').get().n }
  } finally { db.close() }
}

async function stageFile(destination, action) {
  const parent = dirname(destination)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const stage = await mkdtemp(join(parent, '.pagekin-snapshot-'))
  try {
    const path = join(stage, basename(destination))
    const verified = await action(path)
    await chmod(path, 0o600)
    // Publish atomically and refuse to replace an existing backup or database.
    await link(path, destination)
    return verified
  } finally { await rm(stage, { recursive: true, force: true }) }
}

function clearSessions(path) {
  const db = new DatabaseSync(path, { allowExtension: false })
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; DELETE FROM sessions;')
  } finally { db.close() }
}

export async function backupDatabase(source, destination, { omitSessions = false } = {}) {
  const db = new DatabaseSync(source, { readOnly: true, allowExtension: false })
  try {
    return await stageFile(destination, async path => {
      await backup(db, path)
      if (omitSessions) clearSessions(path)
      return verifyDatabase(path)
    })
  } finally { db.close() }
}

export async function restoreDatabase(sourceStream, destination) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { await access(destination + suffix) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw new Error('目标已有数据库或日志。请使用新的数据卷恢复')
  }
  return stageFile(destination, async path => {
    await pipeline(sourceStream, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
    const verified = verifyDatabase(path)
    clearSessions(path)
    return verified
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , action, path] = process.argv
  const data = process.env.APP_DATA_DIR || fileURLToPath(new URL('./data', import.meta.url))
  const database = join(data, 'novels.sqlite')
  try {
    if (action === 'backup' && path) console.log(JSON.stringify(await backupDatabase(database, resolve(path))))
    else if (action === 'verify' && path) console.log(JSON.stringify(verifyDatabase(resolve(path))))
    else if (action === 'restore' && !path) console.log(JSON.stringify(await restoreDatabase(process.stdin, database)))
    else throw new Error('用法：node maintenance.mjs backup <目标文件> | verify <文件> | restore < 备份.sqlite')
  } catch (error) {
    console.error(error.code === 'EEXIST' ? '目标文件已经存在' : error.message)
    process.exitCode = 1
  }
}
