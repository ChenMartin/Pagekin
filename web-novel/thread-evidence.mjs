import { ApiError, object, revision, string } from './input.mjs'

export const threadEvidenceSchema = `
  CREATE TABLE thread_evidence (
    thread_id TEXT NOT NULL REFERENCES narrative_threads(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK(phase IN ('planted','resolved')),
    document_id TEXT NOT NULL, rev INTEGER NOT NULL, start INTEGER NOT NULL, quote TEXT NOT NULL,
    PRIMARY KEY(thread_id,phase), FOREIGN KEY(document_id,rev) REFERENCES history(document_id,rev) ON DELETE CASCADE
  );
`

const phases = ['planted', 'resolved']

export function openThreadEvidence({ all, get, run, tx, thread, finalized, now }) {
  const records = id => all('SELECT phase,document_id,rev,start,quote FROM thread_evidence WHERE thread_id=? ORDER BY phase', id)
  const source = (pid, number) => number === null ? null : finalized(pid, number) ?? null

  function inspect(pid, id, phase, query) {
    if (!phases.includes(phase)) throw new ApiError(400, '引文阶段无效')
    const row = thread(pid, id)
    const latest = source(pid, row[phase])
    const record = records(id).find(item => item.phase === phase) ?? null
    const quote = string(query ?? '', 500).trim()
    const matches = []
    if (latest && quote) {
      for (let offset = 0; matches.length < 10;) {
        const start = latest.body.indexOf(quote, offset)
        if (start === -1) break
        matches.push({ start, quote, before: latest.body.slice(Math.max(0, start - 70), start),
          after: latest.body.slice(start + quote.length, start + quote.length + 70) })
        offset = start + quote.length
      }
    }
    return { threadRev: row.rev, chapter: row[phase], evidence: record,
      current: Boolean(record && record.document_id === latest?.id && record.rev === latest.rev),
      source: latest ? { id: latest.id, number: latest.number, title: latest.title, rev: latest.rev } : null, matches }
  }

  function validate(snapshot, value) {
    const start = value.start
    const quote = string(value.quote, 500, true)
    if (!Number.isSafeInteger(start) || start < 0 || !quote.trim() || !snapshot.body.startsWith(quote, start)) {
      throw new ApiError(422, '引文与该定稿位置不一致')
    }
    return { start, quote }
  }

  function write(id, phase, snapshot, value) {
    const { start, quote } = validate(snapshot, value)
    run(`INSERT INTO thread_evidence (thread_id,phase,document_id,rev,start,quote) VALUES (?,?,?,?,?,?)
      ON CONFLICT(thread_id,phase) DO UPDATE SET document_id=excluded.document_id,rev=excluded.rev,start=excluded.start,quote=excluded.quote`,
    id, phase, snapshot.id, snapshot.rev, start, quote)
  }

  function change(pid, id, value) {
    object(value)
    const phase = value.phase
    if (!phases.includes(phase)) throw new ApiError(400, '引文阶段无效')
    return tx(() => {
      const row = thread(pid, id)
      if (row.rev !== revision(value.baseRev)) throw new ApiError(409, '线索已更新，请重新核对定稿')
      if (value.remove === true) run('DELETE FROM thread_evidence WHERE thread_id=? AND phase=?', id, phase)
      else {
        const latest = source(pid, row[phase])
        if (!latest || latest.id !== value.documentId || latest.rev !== revision(value.sourceRev)) {
          throw new ApiError(409, '该章已有新定稿或章号已变化，请重新查找引文')
        }
        write(id, phase, latest, value)
      }
      run('UPDATE narrative_threads SET rev=rev+1,updated=? WHERE id=?', now(), id)
      return inspect(pid, id, phase, '')
    })
  }

  function importBackup(pid, id, entries, mapping) {
    if (!Array.isArray(entries) || entries.length > phases.length) throw new ApiError(400, '备份中的线索引文无效')
    const seen = new Set()
    for (const value of entries) {
      object(value)
      const { phase } = value
      const docId = mapping.get(value.document_id)
      const rev = revision(value.rev)
      if (!phases.includes(phase) || !docId || seen.has(phase)) throw new ApiError(400, '备份中的线索引文来源无效')
      seen.add(phase)
      const snapshot = get(`SELECT d.id,h.rev,h.body FROM documents d JOIN history h ON h.document_id=d.id
        WHERE d.project_id=? AND d.kind='chapter' AND d.id=? AND h.rev=? AND h.status='final'`, pid, docId, rev)
      if (!snapshot) throw new ApiError(400, '备份中的线索引文定稿不存在')
      write(id, phase, snapshot, value)
    }
  }
  return { records, inspect, change, importBackup }
}
