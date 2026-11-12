export const manuscriptBytes = 8_000_000
export const manuscriptRequestBytes = 12_000_000
export const manuscriptChapterLimit = 500

export async function readManuscript(file, title, previewEpub) {
  if (file.size > manuscriptBytes) throw new Error('文件超过 8 MB，请分批导入')
  if (/\.epub$/iu.test(file.name)) return { parsed: await previewEpub(file) }
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) }
  catch { throw new Error('请使用 UTF-8 的 TXT、Markdown 或 EPUB 文件') }
  return { text, parsed: splitManuscript(text, title) }
}

const digits = new Map(Array.from('零一二三四五六七八九', (char, value) => [char, value]))
digits.set('〇', 0)
digits.set('两', 2)
digits.set('兩', 2)
const units = new Map([['十', 10], ['百', 100], ['千', 1000], ['万', 10000], ['萬', 10000]])

function ordinal(text) {
  if (/^\d+$/.test(text)) return Number(text)
  if (Array.from(text).every(char => digits.has(char))) {
    return Number(Array.from(text, char => digits.get(char)).join(''))
  }
  let total = 0
  let section = 0
  let digit = 0
  let lastUnit = 10000
  for (const char of text) {
    if (digits.has(char)) { digit = digits.get(char); continue }
    const unit = units.get(char)
    if (unit === 10000 && !total) {
      total = (section + digit || 1) * 10000
      section = digit = 0
      lastUnit = 10000
    } else if (unit < lastUnit) {
      section += (digit || 1) * unit
      digit = 0
      lastUnit = unit
    } else return NaN
  }
  return total + section + digit
}

function heading(line) {
  if (line.length > 240) return null
  const trimmed = line.trim()
  const plain = /^#{1,6}[ \t]+/.test(trimmed)
    ? trimmed.replace(/^#{1,6}[ \t]+/, '').replace(/[ \t]+#+$/, '')
    : trimmed
  const match = /^第\s*([零〇一二两兩三四五六七八九十百千万萬0-9０-９]+)\s*章(.*)$/u.exec(plain)
    ?? /^chapter[ \t]+([0-9０-９]+)(?=$|[ \t:：.·—–-])(.*)$/iu.exec(plain)
  if (!match) return null
  const number = ordinal(match[1].normalize('NFKC'))
  const title = (match[2].replace(/^[\s:：.·—–-]+/u, '').trim() || plain).slice(0, 160)
  return { number: Number.isInteger(number) && number > 0 && number <= 99999 ? number : null, title }
}

function bodyBetween(text, start, end) {
  return text.slice(start, end).replace(/^\n+|\n+$/g, '')
}

export function splitManuscript(source, fallbackTitle) {
  const text = source.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n')
  if (!text.trim()) throw new Error('文件中没有可导入的文字')
  const chapters = []
  let fence
  let active
  let preface = ''
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(start, end)
    const delimiter = /^ {0,3}(\x60{3,}|~{3,})(.*)$/u.exec(line)
    if (delimiter) {
      const run = delimiter[1]
      if (!fence) fence = run
      else if (run[0] === fence[0] && run.length >= fence.length && !delimiter[2].trim()) fence = undefined
    } else if (!fence) {
      const found = heading(line)
      if (found) {
        if (!active) preface = bodyBetween(text, 0, start)
        else active.body = bodyBetween(text, active.start, start)
        active = { ...found, start: end + 1, body: '' }
        chapters.push(active)
        if (chapters.length > manuscriptChapterLimit) throw new Error('识别到超过 500 章，请分批导入')
      }
    }
    start = end + 1
  }
  if (!active) return { chapters: [{ number: null, title: fallbackTitle, body: text }], detected: false, hasPreface: false }
  active.body = bodyBetween(text, active.start, text.length)
  if (preface.trim()) chapters[0].body = [preface, chapters[0].body].filter(Boolean).join('\n\n')
  return {
    chapters: chapters.map(({ number, title, body }) => ({ number, title, body })),
    detected: true,
    hasPreface: Boolean(preface.trim()),
  }
}
