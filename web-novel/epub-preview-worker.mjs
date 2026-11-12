import { parentPort, workerData } from 'node:worker_threads'
import { extractEpubChapters, EpubExtractionError } from './epub-extraction.ts'
import { manuscriptBytes, manuscriptChapterLimit, splitManuscript } from './public/manuscript.mjs'

const errors = {
  EPUB_DRM_UNSUPPORTED: '此 EPUB 含有加密正文，请使用可正常读取的 EPUB 或文本文件',
  EPUB_EXPANSION_LIMIT: 'EPUB 解压后的阅读内容或文件条目过多，请分批导入',
  EPUB_INVALID_ARCHIVE: '无法读取 EPUB 的正文和阅读顺序，请检查文件是否完整',
}

async function preview(bytes) {
  const documents = await extractEpubChapters(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
    maxEntries: 6000, maxEntryBytes: 12_000_000, maxExtractedBytes: 20_000_000,
  })
  const chapters = []
  let hasPreface = false
  let size = 0
  for (const doc of documents) {
    const parsed = splitManuscript(doc.content.toWellFormed(), doc.title.slice(0, 160).toWellFormed())
    hasPreface ||= parsed.hasPreface
    for (const chapter of parsed.chapters) {
      if (!chapter.body.trim()) continue
      size += Buffer.byteLength(chapter.body)
      if (size > manuscriptBytes) throw new Error('EPUB 提取的正文超过 8 MB，请分批导入')
      if (chapter.body.length > 180_000) throw new Error('EPUB 有单章超过 180,000 字符，请先拆分该章')
      chapters.push(chapter)
      if (chapters.length > manuscriptChapterLimit) throw new Error('EPUB 超过 500 章，请分批导入')
    }
  }
  if (!chapters.length) throw new Error('EPUB 没有可导入的正文')
  return { chapters, detected: true, hasPreface }
}

try {
  parentPort.postMessage({ parsed: await preview(workerData) })
} catch (error) {
  parentPort.postMessage({ error: error instanceof EpubExtractionError ? errors[error.code] : error.message })
}
