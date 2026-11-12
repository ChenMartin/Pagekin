import { ApiError, object, revision, string } from './input.mjs'
import { lineEndings, quoteEvidence } from './review-report.mjs'
import { approaches, projectFields, chapterFields, methodCards } from './public/workbench-fields.mjs'

export const workbenchSchema = `
  CREATE TABLE novel_workbench (
    project_id TEXT PRIMARY KEY REFERENCES projects(id), data TEXT NOT NULL, rev INTEGER NOT NULL
  );
  CREATE TABLE chapter_workbench (
    project_id TEXT NOT NULL REFERENCES projects(id), number INTEGER NOT NULL, data TEXT NOT NULL, rev INTEGER NOT NULL,
    PRIMARY KEY(project_id,number)
  );
`

function fields(value, definitions, extras) {
  object(value)
  const allowed = new Set([...definitions.map(([key]) => key), ...extras])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new ApiError(400, '创作工作台字段无效')
  return Object.fromEntries(definitions.flatMap(([key, , max]) => {
    const text = string(value[key] ?? '', max).trim()
    return text ? [[key, text]] : []
  }))
}

export function openNovelWorkbench({ get, all, run, project }) {
  const readProject = pid => get('SELECT data,rev FROM novel_workbench WHERE project_id=?', pid)
  const readChapter = (pid, number) => get('SELECT data,rev FROM chapter_workbench WHERE project_id=? AND number=?', pid, number)
  const decode = row => row ? { data: JSON.parse(row.data), rev: row.rev } : { data: {}, rev: 0 }

  function save(row, value, data, write, current = row) {
    if (!Number.isSafeInteger(value.baseRev) || value.baseRev < 0) throw new ApiError(400, '创作工作台版本无效')
    const encoded = JSON.stringify(data)
    if (encoded === JSON.stringify(row.data)) return current
    if (row.rev !== value.baseRev) throw new ApiError(409, '另一设备已保存工作台，请核对最新内容', current)
    write(encoded, row.rev + 1)
    return { data, rev: row.rev + 1 }
  }

  function saveProject(pid, value) {
    project(pid)
    const data = fields(object(value).data, projectFields, ['approach'])
    const approach = value.data.approach
    if (approach != null && approach !== '') {
      if (typeof approach !== 'string' || !Object.hasOwn(approaches, approach)) throw new ApiError(400, '创作方式无效')
      data.approach = approach
    }
    return save(decode(readProject(pid)), value, data, (encoded, rev) => run(`INSERT INTO novel_workbench VALUES (?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET data=excluded.data,rev=excluded.rev`, pid, encoded, rev))
  }

  function finalSource(pid, id) {
    return get(`SELECT d.id,d.number,h.title,h.rev FROM documents d JOIN history h ON h.document_id=d.id
      WHERE d.project_id=? AND d.id=? AND d.kind='chapter' AND h.status='final' ORDER BY h.rev DESC LIMIT 1`, pid, id)
  }

  function evidenceState(pid, data) {
    return (data.evidence ?? []).map(entry => {
      const source = finalSource(pid, entry.id)
      return { ...entry, number: source?.number, title: source?.title, currentRev: source?.rev, stale: source?.rev !== entry.rev }
    })
  }

  function chapter(pid, number) {
    if (!Number.isSafeInteger(number) || !get("SELECT id FROM documents WHERE project_id=? AND number=? AND kind IN ('chapter','blueprint') LIMIT 1", pid, number)) {
      throw new ApiError(404, '本章工作台不存在')
    }
    const current = decode(readChapter(pid, number))
    return { ...current, evidence: evidenceState(pid, current.data) }
  }

  function earlierFinals(pid, number) {
    return all(`SELECT d.id,d.number,h.title,h.rev FROM documents d JOIN history h ON h.document_id=d.id AND h.rev=(
      SELECT MAX(f.rev) FROM history f WHERE f.document_id=d.id AND f.status='final')
      WHERE d.project_id=? AND d.kind='chapter' AND d.number<? ORDER BY d.number DESC`, pid, number)
  }

  function saveChapter(pid, number, value, importing = false) {
    const current = chapter(pid, number)
    const data = fields(object(value).data, chapterFields, ['methods', 'evidence'])
    const methods = value.data.methods ?? []
    if (!Array.isArray(methods) || methods.length > 2 || new Set(methods).size !== methods.length ||
        methods.some(key => typeof key !== 'string' || !Object.hasOwn(methodCards, key))) throw new ApiError(400, '每章最多选择两个写作方法')
    if (methods.length) data.methods = methods
    const entries = value.data.evidence ?? []
    if (!Array.isArray(entries) || entries.length > 3) throw new ApiError(400, '每章最多引用三处定稿证据')
    if (entries.length) data.evidence = entries.map(entry => {
      const id = string(object(entry).id, 80, true)
      const rev = revision(entry.rev)
      const quote = lineEndings(string(entry.quote, 240, true).trim())
      const source = finalSource(pid, id)
      const kept = current.data.evidence?.some(old => old.id === id && old.rev === rev && old.quote === quote)
      if (!source || source.number >= number || (!importing && !kept && source.rev !== rev)) {
        throw new ApiError(409, '请选择当前章之前的最新定稿')
      }
      const version = get("SELECT body FROM history WHERE document_id=? AND rev=? AND status='final'", id, rev)
      if (!version || quoteEvidence(lineEndings(version.body), quote) !== 'verified') throw new ApiError(422, '定稿引句须在指定版本中唯一出现')
      return { id, rev, quote }
    })
    if (new Set((data.evidence ?? []).map(row => JSON.stringify(row))).size !== entries.length) throw new ApiError(400, '定稿引句重复')
    const saved = save(current, value, data, (encoded, rev) => run(`INSERT INTO chapter_workbench VALUES (?,?,?,?)
      ON CONFLICT(project_id,number) DO UPDATE SET data=excluded.data,rev=excluded.rev`, pid, number, encoded, rev), current)
    return { ...saved, evidence: evidenceState(pid, saved.data) }
  }

  function context(pid, number) {
    const { unresolved, next, ...brief } = decode(readProject(pid)).data
    const { evidence, ...task } = number == null ? {} : decode(readChapter(pid, number)).data
    const sources = evidenceState(pid, { evidence })
    return Object.keys(brief).length || Object.keys(task).length || sources.length ? { brief, task, sources } : null
  }

  function backup(pid) {
    const brief = decode(readProject(pid)).data
    const chapters = all('SELECT number,data FROM chapter_workbench WHERE project_id=? ORDER BY number', pid)
      .map(({ number, data }) => ({ number, data: JSON.parse(data) }))
    return Object.keys(brief).length || chapters.length ? { brief, chapters } : undefined
  }

  function restore(pid, value, mapping) {
    const { brief, chapters } = object(value)
    if (!Array.isArray(chapters) || chapters.length > 3000 || new Set(chapters.map(row => object(row).number)).size !== chapters.length) {
      throw new ApiError(400, '备份中的工作台无效')
    }
    saveProject(pid, { baseRev: 0, data: brief })
    for (const row of chapters) {
      const data = { ...object(row.data) }
      if (Array.isArray(data.evidence)) data.evidence = data.evidence.map(entry => ({ ...object(entry), id: mapping.get(entry.id) }))
      saveChapter(pid, row.number, { baseRev: 0, data }, true)
    }
  }

  return { project: pid => { project(pid); return decode(readProject(pid)) }, saveProject, chapter, saveChapter, earlierFinals, context, backup, restore }
}
