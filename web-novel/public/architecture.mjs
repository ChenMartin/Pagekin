export const architectureSections = {
  premise: {
    title: '故事前提',
    headings: ['一句话故事', '主角与行动目标', '阻力与代价', '主题与阅读期待'],
    instruction: '围绕主角、触发事件、目标、主要阻力、失败代价与核心阅读期待，写成可检验的故事前提。',
  },
  cast: {
    title: '人物群像',
    headings: ['核心人物', '阵营与关系', '冲突与人物弧光'],
    instruction: '梳理人物群像、阵营、相互依赖和主要矛盾，说明各核心人物推动情节的方式。沿用已有人物卡身份。',
  },
  world: {
    title: '世界观',
    headings: ['时空与环境', '社会与组织', '规则、限制与代价', '日常与冲突'],
    instruction: '组织故事背景、社会与组织、世界规则、限制和代价。优先写会直接影响人物行动与情节的设定。',
  },
  plot: {
    title: '情节大纲',
    headings: ['起点与导火索', '冲突升级与转折', '高潮与结局', '主要线索与回收'],
    instruction: '按因果链组织开篇、冲突升级、主要转折、高潮和结局，注明重要伏笔与计划回收。把未发生的事件标为规划。',
  },
}

function markdownHeadings(body) {
  const matches = []
  let fence = ''
  for (const line of body.matchAll(/^([^\r\n]*)(?:\r?\n|$)/gmu)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line[1])
    if (marker && (!fence || (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()))) {
      fence = fence ? '' : marker[1]
      continue
    }
    if (fence) continue
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/u.exec(line[1])
    if (heading) matches.push({ title: heading[2], level: heading[1].length, start: line.index, end: line.index + line[0].length })
  }
  return matches
}

export function splitArchitecture(body, headings) {
  const matches = markdownHeadings(body).filter(heading => heading.level === 2 && headings.includes(heading.title))
  const fields = matches.slice(-headings.length)
  if (fields.length !== headings.length || fields.some((field, index) => field.title !== headings[index])) return null
  return { preamble: body.slice(0, fields[0].start), values: fields.map((field, index) =>
    body.slice(field.end, fields[index + 1]?.start).replace(/^\r?\n|(?:\r?\n)+$/gu, '')) }
}

const blueprintNoteFields = new Map([
  ['作者指导', 'guidance'], ['作者微操指导', 'guidance'], ['author guidance', 'guidance'],
  ['章节要点', 'notes'], ['chapter notes', 'notes'],
])

function blueprintNotes(body) {
  const headings = markdownHeadings(body)
  const notes = new Map()
  for (const [index, heading] of headings.entries()) {
    const key = blueprintNoteFields.get(heading.title.toLowerCase())
    if (!key || notes.has(key)) continue
    let next = index + 1
    while (headings[next]?.level > heading.level) next++
    const end = headings[next]?.start ?? body.length
    notes.set(key, { start: heading.start, end, empty: !body.slice(heading.end, end).trim(), section: body.slice(heading.start, end).trimEnd() })
  }
  return notes
}

export function preserveBlueprintNotes(original, candidate) {
  const before = blueprintNotes(original)
  const after = blueprintNotes(candidate)
  const replacements = []
  const additions = []
  for (const [key, item] of before) {
    if (item.empty) continue
    const proposed = after.get(key)
    if (!proposed) additions.push(item.section)
    else if (proposed.empty) replacements.push({ ...proposed, section: item.section })
  }
  let result = candidate
  for (const { start, end, section } of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, start) + section + '\n\n' + result.slice(end)
  }
  return additions.length ? [result.trimEnd(), ...additions].join('\n\n') + '\n' : result
}

export function joinArchitecture(preamble, headings, values = []) {
  const separator = !preamble || preamble.endsWith('\n\n') ? '' : preamble.endsWith('\n') ? '\n' : '\n\n'
  return preamble + separator + headings.map((heading, index) => '## ' + heading + '\n\n' + (values[index] ?? '')).join('\n\n') + '\n'
}
