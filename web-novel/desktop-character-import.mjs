const stateColumns = {
  location: 'cs_location', powerLevel: 'cs_power_level', physicalState: 'cs_physical_state',
  mentalState: 'cs_mental_state', keyItems: 'cs_key_items', recentEvents: 'cs_recent_events',
}

const knownKinds = ['author', 'adopted', 'derived', 'legacy']
const readObject = text => {
  try { return JSON.parse(text) ?? {} } catch { return {} }
}
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)
const validChapter = value => Number.isInteger(value) && value >= 0 && value <= 99999

export function desktopCharacterEvents(db, characters, chapters, hash) {
  const people = new Map(characters.filter(({ row }) => row.character_id).map(person => [person.row.character_id, person]))
  const drafts = new Map()
  let lastFinal = 0
  for (const [number, rows] of chapters) {
    for (const row of rows) drafts.set(row.id, row)
    if (rows.some(row => row.status === 'finalized')) lastFinal = Math.max(lastFinal, number)
  }

  function convert(row, suppliedSubject, suppliedTarget) {
    const subject = suppliedSubject ?? people.get(row.subject_id)
    const target = suppliedTarget ?? people.get(row.target_id)
    const provenance = readObject(row.provenance_json)
    const evidence = readObject(row.evidence_json)
    const kind = knownKinds.includes(provenance.kind) ? provenance.kind : 'legacy'
    const relation = row.aspect === 'relation'
    const binding = provenance.source ?? evidence.fieldProvenance?.source
    const bound = kind === 'derived' || row.draft_id != null || evidence.fieldProvenance?.kind === 'derived'
    const draft = drafts.get(row.draft_id ?? binding?.draftId)
    const source = draft && binding && draft.id === binding.draftId && draft.chapter_number === binding.chapterNumber &&
      !!draft.finalization_id && draft.finalization_id === binding.finalizationId && hash(draft.body) === binding.contentHash ? draft : null
    const quote = evidence.quote
    const validQuote = source && Number.isSafeInteger(quote?.start) && Number.isSafeInteger(quote?.end) &&
      quote.start >= 0 && quote.end > quote.start && quote.end <= source.body.length &&
      source.body.slice(quote.start, quote.end) === quote.text
    return {
      eventId: row.event_id, characterId: subject?.id ?? null, characterName: row.subject_name,
      targetId: relation ? target?.id ?? null : null, targetName: relation ? row.target_name : null,
      field: row.aspect, value: row.value, chapter: row.effective_chapter, kind,
      series: relation ? evidence.relationshipId || row.event_id : row.aspect,
      seq: Number.isSafeInteger(evidence.seq) && evidence.seq >= 0 ? evidence.seq : 0,
      sourceId: source ? 'chapter-' + source.chapter_number : null, sourceRev: source?.version ?? null,
      quote: validQuote ? quote.text : null, bound,
      eligible: Boolean(subject && !subject.row.retired && (!relation || (target && !target.row.retired && subject.id !== target.id)) &&
        (!bound || source?.status === 'finalized')),
    }
  }

  if (hasTable(db, 'character_continuity_events')) {
    return db.prepare(`SELECT event_id,subject_id,subject_name,target_id,target_name,aspect,value,effective_chapter,
      provenance_json,draft_id,evidence_json FROM character_continuity_events ORDER BY event_id`).all().map(row => convert(row))
  }

  const events = []
  for (const person of characters) {
    const { id, row } = person
    const provenance = readObject(row.cs_provenance)
    for (const [aspect, column] of Object.entries(stateColumns)) {
      const value = row[column]
      if (typeof value !== 'string' || !value.trim()) continue
      const field = provenance[aspect]
      const chapter = Math.max(lastFinal, validChapter(row.cs_updated_at_chapter) ? row.cs_updated_at_chapter : 0)
      events.push(convert({ event_id: 'legacy:state:' + id + ':' + aspect, subject_name: row.name,
        aspect, value, effective_chapter: chapter, provenance_json: '{"kind":"legacy"}',
        evidence_json: JSON.stringify({ fieldProvenance: field }) }, person))
    }
  }
  if (hasTable(db, 'character_relationships')) {
    for (const row of db.prepare(`SELECT relationship_id,source_character_id,target_character_id,relation,
      source_display_snapshot,target_display_snapshot FROM character_relationships ORDER BY relationship_id`).iterate()) {
      events.push(convert({ event_id: 'legacy:relation:' + row.relationship_id,
        subject_id: row.source_character_id, subject_name: row.source_display_snapshot,
        target_id: row.target_character_id, target_name: row.target_display_snapshot, aspect: 'relation', value: row.relation,
        effective_chapter: lastFinal, provenance_json: '{"kind":"legacy"}',
        evidence_json: JSON.stringify({ relationshipId: row.relationship_id }) }))
    }
  }
  return events
}
