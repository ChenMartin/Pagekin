import { ApiError, object, revision, string } from './input.mjs'
import { characterStateFields } from './public/character-state.mjs'

export const desktopContinuitySchema = `
  CREATE TABLE desktop_character_events (
    project_id TEXT NOT NULL REFERENCES projects(id), event_id TEXT NOT NULL,
    character_id TEXT REFERENCES documents(id), character_name TEXT NOT NULL,
    target_id TEXT REFERENCES documents(id), target_name TEXT,
    field TEXT NOT NULL, value TEXT NOT NULL, chapter INTEGER NOT NULL, kind TEXT NOT NULL,
    series TEXT NOT NULL, seq INTEGER NOT NULL,
    source_id TEXT, source_rev INTEGER, quote TEXT, bound INTEGER NOT NULL, eligible INTEGER NOT NULL,
    PRIMARY KEY(project_id,event_id),
    FOREIGN KEY(source_id,source_rev) REFERENCES history(document_id,rev)
  );
  CREATE INDEX desktop_character_events_person ON desktop_character_events(project_id,character_id,chapter);
`

const kinds = ['author', 'adopted', 'derived', 'legacy']
const isDecided = "e.kind IN ('author','adopted')"
const available = `(e.eligible=1 AND (e.bound=0 OR e.source_rev=(SELECT MAX(h.rev) FROM history h
  WHERE h.document_id=e.source_id AND h.status='final')))`
const columns = `e.event_id eventId,e.character_id characterId,e.character_name characterName,e.target_id targetId,
  e.target_name targetName,e.field,e.value,e.chapter,e.kind,e.series,e.seq,e.source_id sourceId,e.source_rev sourceRev,
  e.quote,e.bound,e.eligible`
const bounds = (value, limit) => Number.isSafeInteger(value) && value >= 0 && value <= limit

export function desktopContinuity({ get, all, run, document }) {
  function hasHistory(pid) {
    return Boolean(get('SELECT 1 FROM desktop_character_events WHERE project_id=? LIMIT 1', pid))
  }

  function history(pid, id, offset) {
    if (!bounds(offset, 50_000)) throw new ApiError(400, '桌面人物历史页码无效')
    const filters = ['e.project_id=?']
    const args = [pid]
    if (id === 'unlinked') filters.push('e.character_id IS NULL')
    else if (id) {
      if (document(pid, id).kind !== 'character') throw new ApiError(404, '人物卡不存在')
      filters.push('e.character_id=?')
      args.push(id)
    }
    const rows = all(`SELECT ${columns},${available} active,d.number sourceChapter FROM desktop_character_events e
      LEFT JOIN documents d ON d.id=e.source_id WHERE ${filters.join(' AND ')}
      ORDER BY e.chapter DESC,e.seq DESC,e.event_id LIMIT 51 OFFSET ?`, ...args, offset)
    return { rows: rows.slice(0, 50), more: rows.length > 50 }
  }

  function merge(pid, ids, before, native, names) {
    if (!ids.length) return native
    const events = all(`WITH visible AS (
      SELECT e.*,e.chapter+CASE WHEN ${isDecided} THEN 0 ELSE 1 END starts,
        ROW_NUMBER() OVER (PARTITION BY e.character_id,e.field,e.series
          ORDER BY e.chapter DESC,(${isDecided}) DESC,e.seq DESC,e.event_id) rank
      FROM desktop_character_events e WHERE e.project_id=? AND e.character_id IN (${ids.map(() => '?').join(',')})
        AND e.chapter+CASE WHEN ${isDecided} THEN 0 ELSE 1 END<=? AND ${available})
      SELECT * FROM visible WHERE rank=1 ORDER BY character_id,event_id`, pid, ...ids, before)
    if (!events.length) return native
    const result = new Map(native.map(row => [row.id, row]))
    const grouped = new Map()
    for (const event of events) {
      if (!grouped.has(event.character_id)) grouped.set(event.character_id, [])
      grouped.get(event.character_id).push(event)
    }
    for (const [id, group] of grouped) {
      const base = result.get(id)
      const changes = base ? group.filter(row => row.starts > base.chapter + 1) : group
      if (!changes.length) continue
      const state = { ...base?.state }
      const relationships = new Map(base?.relationships.map(row => [row.targetId, row]))
      const touchedTargets = new Set()
      for (const event of changes) {
        if (event.field === 'relation') touchedTargets.add(event.target_id)
        else state[event.field] = event.value
      }
      const linesByTarget = new Map()
      for (const row of group) {
        if (!touchedTargets.has(row.target_id) || !row.value.trim()) continue
        if (!linesByTarget.has(row.target_id)) linesByTarget.set(row.target_id, [])
        linesByTarget.get(row.target_id).push(row.value)
      }
      for (const targetId of touchedTargets) {
        const lines = linesByTarget.get(targetId)
        if (lines) relationships.set(targetId, { targetId, name: names.get(targetId), relation: lines.join('\n') })
        else relationships.delete(targetId)
      }
      const chapter = Math.max(base?.chapter ?? 0, ...changes.map(row => row.starts - 1))
      result.set(id, { id, name: names.get(id), chapter, finalRev: base?.finalRev ?? 0, rev: base?.rev ?? 0,
        state, relationships: [...relationships.values()], desktopEvents: changes.map(row => row.event_id) })
    }
    return [...result.values()].sort((left, right) => right.chapter - left.chapter || left.id.localeCompare(right.id))
  }

  function backup(pid) {
    return all(`SELECT ${columns} FROM desktop_character_events e WHERE e.project_id=? ORDER BY e.event_id`, pid)
      .map(row => ({ ...row, eligible: Boolean(row.eligible), bound: Boolean(row.bound) }))
  }

  function importBackup(pid, rows, mapping) {
    if (!Array.isArray(rows) || rows.length > 50_000) throw new ApiError(400, '备份中的桌面人物历史无效')
    const seen = new Set()
    const person = key => {
      if (key === null) return null
      const id = mapping.get(key)
      if (!id || document(pid, id).kind !== 'character') throw new ApiError(400, '桌面人物历史引用了无效人物')
      return id
    }
    for (const row of rows) {
      object(row)
      const eventId = string(row.eventId, 1000, true)
      const field = row.field
      const relation = field === 'relation'
      const characterId = person(row.characterId)
      const targetId = person(row.targetId)
      if (seen.has(eventId) || (typeof field !== 'string' || (!relation && !Object.hasOwn(characterStateFields, field))) ||
          !kinds.includes(row.kind) || !bounds(row.chapter, 99_999) || !bounds(row.seq, Number.MAX_SAFE_INTEGER) ||
          typeof row.bound !== 'boolean' || typeof row.eligible !== 'boolean' || (row.kind === 'derived' && !row.bound) ||
          (!relation && (targetId !== null || row.targetName !== null)) ||
          (row.eligible && (!characterId || (relation && (!targetId || targetId === characterId))))) {
        throw new ApiError(400, '备份中的桌面人物历史记录无效')
      }
      const sourceId = row.sourceId === null ? null : mapping.get(row.sourceId)
      const sourceRev = row.sourceRev === null ? null : revision(row.sourceRev)
      const quote = row.quote === null ? null : string(row.quote, 180_000, true)
      if ((sourceId == null) !== (sourceRev === null) || (row.sourceId !== null && !sourceId) ||
          (sourceRev === null && (quote || row.eligible && row.bound))) {
        throw new ApiError(400, '桌面人物历史的正文来源无效')
      }
      if (sourceId) {
        const snapshot = get('SELECT h.body FROM history h JOIN documents d ON d.id=h.document_id WHERE d.kind=\'chapter\' AND h.document_id=? AND h.rev=?',
          sourceId, sourceRev)
        if (!snapshot || (quote && !snapshot.body.includes(quote))) throw new ApiError(400, '桌面人物历史引文与来源不一致')
      }
      const value = string(row.value, 180_000)
      const series = string(row.series, 1000, true)
      if (!relation && series !== field) throw new ApiError(400, '桌面人物状态字段的历史序列无效')
      run(`INSERT INTO desktop_character_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        pid, eventId, characterId, string(row.characterName, 160), targetId, relation ? string(row.targetName, 160) : null,
        field, value, row.chapter, row.kind, series, row.seq, sourceId, sourceRev, quote, Number(row.bound), Number(row.eligible))
      seen.add(eventId)
    }
  }

  return { hasHistory, history, merge, backup, importBackup }
}
