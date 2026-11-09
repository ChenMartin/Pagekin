import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { crc32 } from 'node:zlib'
import { desktopCopy } from './desktop-copy.mjs'
import { hash } from './store.mjs'

export const archiveLimit = 48_000_000
const decoder = new TextDecoder('utf-8', { fatal: true })

function requireArchive(condition) {
  if (!condition) throw new Error('归档格式或完整性校验失败，请使用 Pagekin 桌面版重新导出')
}

// Pagekin's portable writer uses stored entries, a plain ZIP end record, and
// signed data descriptors for payload entries. Interpret that specific layout.
function readArchive(bytes) {
  requireArchive(bytes.length >= 22 && bytes.length <= archiveLimit)
  const end = bytes.length - 22
  const count = bytes.readUInt16LE(end + 10)
  const central = bytes.readUInt32LE(end + 16)
  requireArchive(bytes.readUInt32LE(end) === 0x06054b50 &&
    bytes.readUInt32LE(end + 4) === 0 && bytes.readUInt16LE(end + 8) === count &&
    bytes.readUInt16LE(end + 20) === 0 && count >= 2 && count <= 8193 &&
    central + bytes.readUInt32LE(end + 12) === end)
  const files = new Map()
  const names = new Set()
  let cursor = central
  let local = 0
  for (let i = 0; i < count; i++) {
    requireArchive(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50)
    const flags = bytes.readUInt16LE(cursor + 8)
    const checksum = bytes.readUInt32LE(cursor + 16)
    const size = bytes.readUInt32LE(cursor + 24)
    const nameSize = bytes.readUInt16LE(cursor + 28)
    const centralNext = cursor + 46 + nameSize
    requireArchive(flags === (i === 0 ? 0x800 : 0x808) && bytes.readUInt16LE(cursor + 10) === 0 &&
      bytes.readUInt32LE(cursor + 20) === size && bytes.readUInt32LE(cursor + 30) === 0 &&
      bytes.readUInt16LE(cursor + 34) === 0 && (bytes.readUInt32LE(cursor + 38) >>> 28) === 8 &&
      bytes.readUInt32LE(cursor + 42) === local && centralNext <= end &&
      nameSize > 0 && nameSize <= 1024 && local + 30 + nameSize <= central)
    const encodedName = bytes.subarray(cursor + 46, centralNext)
    const name = decoder.decode(encodedName)
    const key = name.normalize('NFC').toLowerCase()
    requireArchive(!names.has(key) && !/[\\:\u0000-\u001f]/u.test(name) &&
      name.split('/').every(part => part && part !== '.' && part !== '..'))
    names.add(key)
    requireArchive(bytes.readUInt32LE(local) === 0x04034b50 && bytes.readUInt16LE(local + 6) === flags &&
      bytes.readUInt16LE(local + 8) === 0 && bytes.readUInt16LE(local + 26) === nameSize &&
      bytes.readUInt16LE(local + 28) === 0 && encodedName.equals(bytes.subarray(local + 30, local + 30 + nameSize)))
    const headerOffset = local
    const start = local + 30 + nameSize
    const stop = start + size
    local = stop + (i === 0 ? 0 : 16)
    requireArchive(local <= central)
    if (i === 0) {
      requireArchive(name === 'manifest.json' && size <= 4_000_000 && bytes.readUInt32LE(headerOffset + 14) === checksum &&
        bytes.readUInt32LE(headerOffset + 18) === size && bytes.readUInt32LE(headerOffset + 22) === size)
    } else {
      requireArchive(bytes.readUInt32LE(stop) === 0x08074b50 && bytes.readUInt32LE(stop + 4) === checksum &&
        bytes.readUInt32LE(stop + 8) === size && bytes.readUInt32LE(stop + 12) === size)
    }
    const content = bytes.subarray(start, stop)
    requireArchive(crc32(content) === checksum)
    files.set(name, content)
    cursor = centralNext
  }
  requireArchive(cursor === end && local === central)
  return files
}

export function convertArchive(bytes, directory) {
  const files = readArchive(bytes)
  let manifest
  try { manifest = JSON.parse(decoder.decode(files.get('manifest.json'))) } catch { requireArchive(false) }
  requireArchive(manifest?.formatVersion === 1 && [7, 8, 9].includes(manifest.sourceSchemaVersion) &&
    Array.isArray(manifest.entries) && manifest.entries.length === files.size - 1)
  const expected = new Set(['manifest.json'])
  let total = 0
  for (const entry of manifest.entries) {
    const content = files.get(entry?.path)
    requireArchive(content && !expected.has(entry.path) && content.length === entry.byteSize && hash(content) === entry.sha256)
    expected.add(entry.path)
    total += content.length
  }
  const database = files.get('project.db')
  requireArchive(database && manifest.entries.some(entry => entry.path === 'project.db' && entry.disposition === 'portable-database') &&
    manifest.declaredUncompressedBytes === total && manifest.declaredCompressedBytes === total &&
    database.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) &&
    database.length >= 100 && database.readUInt32BE(60) === manifest.sourceSchemaVersion)
  const file = join(directory, 'project.db')
  writeFileSync(file, database, { flag: 'wx', mode: 0o600 })
  const converted = JSON.stringify(desktopCopy(file, directory))
  if (Buffer.byteLength(converted) > 24_000_000) throw new Error('归档转换结果超过 Web 作品的 24 MB 上限')
  return converted
}

if (parentPort && workerData) {
  try {
    const { bytes, directory } = workerData
    parentPort.postMessage({ converted: convertArchive(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), directory) })
  } catch (error) {
    parentPort.postMessage({ error: error.code ? '无法读取归档中的桌面数据库' : error.message })
  }
}
