import { ApiError } from './input.mjs'

const pageSize = 30
const finalExists = "EXISTS(SELECT 1 FROM history h WHERE h.document_id=d.id AND h.status='final')"

export function novelProgress({ all, get }, pid, target, requested) {
  if (!Number.isInteger(requested) || requested < 1 || requested > 99_999) throw new ApiError(400, '请输入 1–99999 的起始章号')
  const counts = get(`SELECT COUNT(*) FILTER (WHERE kind='blueprint') blueprints,
    COUNT(*) FILTER (WHERE kind='chapter') chapters, COALESCE(MAX(number),0) highest,
    COUNT(*) FILTER (WHERE kind='chapter' AND status='final') locked
    FROM documents WHERE project_id=? AND kind IN ('chapter','blueprint')`, pid)
  const finalized = all(`SELECT d.number FROM documents d WHERE d.project_id=? AND d.kind='chapter' AND ${finalExists}
    ORDER BY d.number`, pid).map(row => row.number)
  const finalNumbers = new Set(finalized)
  const lastFinal = finalized.at(-1) ?? 0
  let nextDraft = 1
  for (const number of finalized) {
    if (number !== nextDraft) break
    nextDraft++
  }

  const threads = all(`SELECT id,title,kind,status,planted,due,resolved FROM narrative_threads
    WHERE project_id=? AND status<>'archived' ORDER BY title,id`, pid)
  const limit = threads.reduce((max, row) => Math.max(max, row.planted ?? 0, row.due ?? 0, row.resolved ?? 0),
    Math.max(1, counts.highest, target ?? 0))
  const first = Math.min(requested, limit)
  const last = Math.min(limit, first + pageSize - 1)
  const chapters = Array.from({ length: last - first + 1 }, (_, index) => ({
    number: first + index, blueprint: null, prose: null, milestones: [],
  }))
  const rowFor = number => chapters[number - first]
  const docs = all(`SELECT d.id,d.kind,d.number,d.title,d.status,
    length(trim(d.body,char(9,10,13,32,160,12288,65279)))>0 hasText
    FROM documents d WHERE d.project_id=? AND d.kind IN ('chapter','blueprint') AND d.number BETWEEN ? AND ?
    ORDER BY d.number,d.kind`, pid, first, last)
  for (const doc of docs) {
    const row = rowFor(doc.number)
    if (doc.kind === 'blueprint') row.blueprint = { id: doc.id, title: doc.title, hasText: Boolean(doc.hasText) }
    else row.prose = { id: doc.id, title: doc.title, status: doc.status,
      hasText: Boolean(doc.hasText), hasFinal: finalNumbers.has(doc.number) }
  }

  const warnings = []
  for (const thread of threads) {
    const { id, title, kind, status, planted, due, resolved } = thread
    const identity = { id, title, kind, status }
    for (const [type, number] of [['planted', planted], ['due', due], ['resolved', resolved]]) {
      if (number !== null) rowFor(number)?.milestones.push({ ...identity, type })
    }
    if (status === 'planned' && finalNumbers.has(planted)) {
      warnings.push({ ...identity, number: planted, code: 'plant-confirm' })
    }
    if ((status === 'planned' || status === 'open') && due !== null && due <= lastFinal) {
      warnings.push({ ...identity, number: due, code: finalNumbers.has(due) ? 'due-final' : 'due-passed' })
    }
    if (status === 'resolved' && resolved !== null && !finalNumbers.has(resolved)) {
      warnings.push({ ...identity, number: resolved, code: 'resolve-unfinalized' })
    }
  }
  warnings.sort((left, right) => left.number - right.number || left.code.localeCompare(right.code))
  return {
    first, last, limit, previous: first > 1 ? Math.max(1, first - pageSize) : null,
    next: last < limit ? last + 1 : null, nextDraft: nextDraft <= limit ? nextDraft : null, target,
    counts: { blueprints: counts.blueprints, chapters: counts.chapters, finalized: finalized.length, reopened: finalized.length - counts.locked },
    chapters, warnings: warnings.slice(0, 50), warningCount: warnings.length,
  }
}
