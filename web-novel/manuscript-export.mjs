import { crc32 } from 'node:zlib'
import { ApiError } from './input.mjs'

const zipLimit = 64 * 1024 * 1024

function filename(title) {
  const safe = title.toWellFormed().replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').trim()
  const name = [...safe].slice(0, 48).join('').replace(/[. ]+$/, '') || 'novel'
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? '_' + name : name
}

const chapterTitle = row => `第 ${row.number} 章　${row.title}`

function markdownZip(chapters) {
  if (chapters.length > 65535) throw new ApiError(413, '分章 ZIP 最多包含 65535 章，请导出合并版')
  const files = []
  const index = []
  let offset = 0
  let indexSize = 0
  for (const row of chapters) {
    const ordinal = String(row.number).padStart(5, '0')
    const name = Buffer.from(`${ordinal}-${filename(row.title)}.md`)
    const content = Buffer.from(`# ${chapterTitle(row)}\n\n${row.body}`)
    const size = 30 + name.length + content.length
    indexSize += 46 + name.length
    if (offset + size + indexSize + 22 > zipLimit) {
      throw new ApiError(413, '分章 ZIP 超过 64 MiB，请导出合并版')
    }
    const checksum = crc32(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6) // UTF-8 filenames
    local.writeUInt16LE(0x21, 12) // DOS date 1980-01-01
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    files.push(local, name, content)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(20, 4) // ZIP version used to create the entry
    local.copy(entry, 6, 4, 28)
    entry.writeUInt32LE(offset, 42)
    index.push(entry, name)
    offset += size
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(chapters.length, 8)
  end.writeUInt16LE(chapters.length, 10)
  end.writeUInt32LE(indexSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...files, ...index, end], offset + indexSize + end.length)
}

export function manuscriptExport(title, chapters, format) {
  const name = filename(title)
  const attachment = (extension, type, data) => {
    const encoded = encodeURIComponent(name + '.' + extension)
      .replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
    return {
      type, data,
      disposition: `attachment; filename="novel.${extension}"; filename*=UTF-8''${encoded}`,
    }
  }
  if (format === 'zip') return attachment('zip', 'application/zip', markdownZip(chapters))
  if (format === 'txt') {
    const content = [title, ...chapters.map(row => `${chapterTitle(row)}\n\n${row.body}`)].join('\n\n')
    return attachment('txt', 'text/plain; charset=utf-8', content)
  }
  if (format === 'md') {
    const content = [`# ${title}`, ...chapters.map(row => `## ${chapterTitle(row)}\n\n${row.body}`)].join('\n\n')
    return attachment('md', 'text/markdown; charset=utf-8', content)
  }
  throw new ApiError(400, '正文导出格式无效')
}
