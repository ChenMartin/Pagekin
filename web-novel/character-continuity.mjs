import { ApiError, object, revision, string } from './input.mjs'
import { characterStateFields, characterStateLimit, relationshipLimit, relationshipTextLimit } from './public/character-state.mjs'
import { continuityQuoteLimit } from './continuity-report.mjs'
import { lineEndings, quoteEvidence } from './review-report.mjs'

export const continuitySchema = `
  CREATE TABLE character_continuity (
    character_id TEXT NOT NULL REFERENCES documents(id),
    chapter_number INTEGER NOT NULL CHECK(chapter_number BETWEEN 0 AND 99999),
    source_id TEXT, final_rev INTEGER NOT NULL,
    state TEXT NOT NULL, relationships TEXT NOT NULL, rev INTEGER NOT NULL, updated TEXT NOT NULL,
    CHECK((chapter_number=0 AND source_id IS NULL AND final_rev=0) OR
      (chapter_number>0 AND source_id IS NOT NULL AND final_rev>0)),
    PRIMARY KEY(character_id,chapter_number,final_rev),
    FOREIGN KEY(source_id,final_rev) REFERENCES history(document_id,rev)
  );
`

const effective = `(c.chapter_number=0 OR c.final_rev=(SELECT MAX(h.rev) FROM history h
  WHERE h.document_id=c.source_id AND h.status='final'))`

function chapterNumber(value) {
  if (!Number.isInteger(value) || value < 0 || value > 99999) throw new ApiError(400, '人物状态的章号无效')
  return value
}

const decode = row => row ? {
  chapter: row.chapter_number, finalRev: row.final_rev, rev: row.rev, updated: row.updated,
  state: JSON.parse(row.state), relationships: JSON.parse(row.relationships), evidence: JSON.parse(row.evidence),
} : null

export function characterContinuity({ get, all, run, tx, now, document, candidateEvidence }) {
  function character(pid, id) {
    const row = document(pid, id)
    if (row.kind !== 'character') throw new ApiError(404, '人物卡不存在')
    return row
  }

  function roster(pid) {
    const characters = all("SELECT id,title FROM documents WHERE project_id=? AND kind='character' ORDER BY title,id", pid)
    const finals = all(`SELECT d.number,h.title,h.rev FROM documents d JOIN history h
      ON h.document_id=d.id AND h.rev=(SELECT MAX(f.rev) FROM history f WHERE f.document_id=d.id AND f.status='final')
      WHERE d.project_id=? AND d.kind='chapter' ORDER BY d.number`, pid)
    return { characters, finals }
  }

  function head(pid, chapter) {
    if (!chapter) return { id: null, number: 0, rev: 0, title: '开篇状态' }
    const row = get(`SELECT d.id,d.number,h.rev,h.title FROM documents d JOIN history h ON h.document_id=d.id
      WHERE d.project_id=? AND d.kind='chapter' AND d.number=? AND h.status='final' ORDER BY h.rev DESC LIMIT 1`, pid, chapter)
    if (!row) throw new ApiError(422, '请先定稿该章再记录章末状态')
    return row
  }

  function snapshot(id, chapter, finalRev) {
    return get('SELECT * FROM character_continuity WHERE character_id=? AND chapter_number=? AND final_rev=?', id, chapter, finalRev)
  }

  function latest(id, before) {
    return get(`SELECT c.* FROM character_continuity c WHERE c.character_id=? AND c.chapter_number<? AND ${effective}
      ORDER BY c.chapter_number DESC LIMIT 1`, id, before)
  }

  function detail(pid, id, value) {
    character(pid, id)
    const chapter = chapterNumber(value)
    const source = head(pid, chapter)
    const history = all(`SELECT c.chapter_number chapter,c.final_rev finalRev,c.rev,c.updated,${effective} active
      FROM character_continuity c WHERE c.character_id=? ORDER BY c.chapter_number DESC,c.final_rev DESC LIMIT 100`, id)
    return { source, current: decode(snapshot(id, chapter, source.rev)), previous: decode(latest(id, chapter)), history }
  }

  function archived(pid, id, chapter, finalRev) {
    character(pid, id)
    const row = snapshot(id, chapterNumber(chapter), finalRev)
    if (!row) throw new ApiError(404, '人物状态记录不存在')
    return decode(row)
  }

  function normalize(pid, id, value) {
    const state = object(value.state)
    if (Object.keys(state).some(key => !Object.hasOwn(characterStateFields, key))) throw new ApiError(400, '人物状态字段无效')
    const values = Object.fromEntries(Object.keys(characterStateFields).map(key => [key, string(state[key] ?? '', characterStateLimit).trim()]))
    if (!Array.isArray(value.relationships) || value.relationships.length > relationshipLimit) throw new ApiError(400, '每个人物最多记录 20 条关系')
    const relationships = value.relationships.map(entry => {
      const targetId = string(object(entry).targetId, 80, true)
      character(pid, targetId)
      return { targetId, relation: string(entry.relation, relationshipTextLimit, true).trim() }
    }).sort((left, right) => left.targetId.localeCompare(right.targetId))
    if (relationships.some(entry => entry.targetId === id) ||
        new Set(relationships.map(entry => entry.targetId)).size !== relationships.length) {
      throw new ApiError(400, '关系必须指向不同的其他人物')
    }
    return [JSON.stringify(values), JSON.stringify(relationships)]
  }

  function save(pid, id, value) {
    const chapter = chapterNumber(object(value).chapter)
    if (!Number.isSafeInteger(value.baseRev) || value.baseRev < 0 || !Number.isSafeInteger(value.finalRev) || value.finalRev < 0) {
      throw new ApiError(400, '人物状态版本无效')
    }
    return tx(() => {
      character(pid, id)
      const source = head(pid, chapter)
      if (source.rev !== value.finalRev) throw new ApiError(409, '该章已有新的定稿，请重新核对后记录人物状态', { finalRev: source.rev })
      const [state, relationships] = normalize(pid, id, value)
      const current = snapshot(id, chapter, source.rev)
      const nextState = JSON.parse(state)
      const chosen = candidateEvidence(pid, id, source, nextState, value.picks ?? [])
      const previous = decode(current)
      const evidence = JSON.stringify(Object.fromEntries(Object.keys(characterStateFields).flatMap(field => {
        const quote = chosen[field] ?? (previous?.state[field] === nextState[field] ? previous?.evidence[field] : undefined)
        return quote ? [[field, quote]] : []
      })))
      if (current?.state === state && current.relationships === relationships && current.evidence === evidence) return previous
      if ((current?.rev ?? 0) !== value.baseRev) throw new ApiError(409, '另一设备已修改这份人物状态', { current: decode(current) })
      run(`INSERT INTO character_continuity (character_id,chapter_number,source_id,final_rev,state,relationships,rev,updated,evidence)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(character_id,chapter_number,final_rev) DO UPDATE
        SET state=excluded.state,relationships=excluded.relationships,rev=excluded.rev,updated=excluded.updated,evidence=excluded.evidence`,
      id, chapter, source.id, source.rev, state, relationships, value.baseRev + 1, now(), evidence)
      return decode(snapshot(id, chapter, source.rev))
    })
  }

  function context(pid, ids, before) {
    if (!ids.length) return []
    const rows = all(`WITH choices AS (SELECT c.*,ROW_NUMBER() OVER (PARTITION BY character_id ORDER BY chapter_number DESC) rn
        FROM character_continuity c WHERE c.character_id IN (${ids.map(() => '?').join(',')})
        AND c.chapter_number<? AND ${effective})
      SELECT * FROM choices WHERE rn=1 ORDER BY chapter_number DESC,character_id`, ...ids, before)
    if (!rows.length) return []
    const names = new Map(all("SELECT id,title FROM documents WHERE project_id=? AND kind='character'", pid).map(row => [row.id, row.title]))
    return rows.map(row => {
      const data = decode(row)
      return { id: row.character_id, name: names.get(row.character_id), chapter: data.chapter, finalRev: data.finalRev, rev: data.rev,
        state: data.state, relationships: data.relationships.map(entry => ({ ...entry, name: names.get(entry.targetId) })) }
    })
  }

  function relationshipsAt(pid, value) {
    const source = head(pid, chapterNumber(value))
    const characters = all("SELECT id FROM documents WHERE project_id=? AND kind='character'", pid)
    const records = context(pid, characters.map(row => row.id), source.number + 1)
    return { source, records: records.filter(row => row.relationships.length).map(({ id, name, chapter, relationships }) => (
      { id, name, chapter, relationships }
    )) }
  }

  function backup(pid) {
    return all(`SELECT c.* FROM character_continuity c JOIN documents d ON d.id=c.character_id
      WHERE d.project_id=? ORDER BY c.character_id,c.chapter_number,c.final_rev`, pid)
      .map(row => ({ characterId: row.character_id, sourceId: row.source_id, ...decode(row) }))
  }

  function importBackup(pid, value, mapping) {
    if (!Array.isArray(value) || value.length > 20000) throw new ApiError(400, '备份中的人物连载记录无效')
    for (const entry of value) {
      const id = mapping.get(object(entry).characterId)
      const chapter = chapterNumber(entry.chapter)
      const source = entry.sourceId === null ? null : mapping.get(entry.sourceId)
      if (!id || (chapter === 0 && (source !== null || entry.finalRev !== 0)) ||
          (chapter !== 0 && (!source || !get(`SELECT 1 FROM history h JOIN documents d ON d.id=h.document_id
            WHERE d.id=? AND d.kind='chapter' AND d.number=? AND h.rev=? AND h.status='final'`, source, chapter, revision(entry.finalRev))))) {
        throw new ApiError(400, '备份中的人物连载来源无效')
      }
      character(pid, id)
      if (!Array.isArray(entry.relationships) || snapshot(id, chapter, entry.finalRev)) throw new ApiError(400, '备份中的人物记录重复或关系无效')
      const [state, links] = normalize(pid, id, {
        state: entry.state, relationships: entry.relationships.map(link => ({ targetId: mapping.get(object(link).targetId), relation: link.relation })),
      })
      const evidence = object(entry.evidence ?? {})
      const keys = Object.keys(evidence)
      const saved = JSON.parse(state)
      const body = keys.length && source ? lineEndings(get('SELECT body FROM history WHERE document_id=? AND rev=?', source, entry.finalRev).body) : undefined
      if (keys.some(field => !Object.hasOwn(characterStateFields, field) || !saved[field] ||
          typeof evidence[field] !== 'string' || !evidence[field].trim() || evidence[field].length > continuityQuoteLimit ||
          quoteEvidence(body, evidence[field]) !== 'verified')) throw new ApiError(400, '备份中的人物状态引文无效')
      const orderedEvidence = Object.fromEntries(Object.keys(characterStateFields).filter(field => evidence[field]).map(field => [field, evidence[field]]))
      run(`INSERT INTO character_continuity (character_id,chapter_number,source_id,final_rev,state,relationships,rev,updated,evidence)
        VALUES (?,?,?,?,?,?,?,?,?)`, id, chapter, source, entry.finalRev,
      state, links, revision(entry.rev), string(entry.updated, 50, true), JSON.stringify(orderedEvidence))
    }
  }

  return { character, head, roster, detail, archived, save, context, relationshipsAt, backup, importBackup }
}
