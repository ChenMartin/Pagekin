import type Database from 'better-sqlite3'
import type { MigrationImplementation, SchemaReader } from './registry'

/** 迁移是冻结的历史：取值清单写死在这里，不引用会继续演进的共享常量，否则指纹会漂。 */
const M08_STATE_COLUMNS = Object.freeze({
  location: 'cs_location',
  powerLevel: 'cs_power_level',
  physicalState: 'cs_physical_state',
  mentalState: 'cs_mental_state',
  keyItems: 'cs_key_items',
  recentEvents: 'cs_recent_events',
} as const)

export const M08_TABLES = Object.freeze([
  'character_continuity_events', 'blueprint_continuity_suggestions', 'narrative_thread_assignments',
] as const)
export const M08_EXEMPTION_COLUMNS = Object.freeze(['exemption_id', 'chapter_number', 'created_at'] as const)

const aspects = ['relation', ...Object.keys(M08_STATE_COLUMNS)].map(aspect => `'${aspect}'`).join(',')

// 角色会被整表删除后回填（手工保存名单），所以 subject_id、target_id 不挂外键，靠名字快照留住当时的称呼。
// 外键目标带引号，与 SQLite 改名时改写出的写法相同，表来回改名后 schema 文本不变。
const M08_CONTINUITY_FOUNDATION_SQL = `
CREATE TABLE character_continuity_events (
  event_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  target_id TEXT,
  target_name TEXT,
  aspect TEXT NOT NULL CHECK(aspect IN (${aspects})),
  value TEXT NOT NULL,
  effective_chapter INTEGER NOT NULL CHECK(effective_chapter >= 0),
  provenance_json TEXT NOT NULL CHECK(CASE WHEN json_valid(provenance_json)
    THEN COALESCE(json_extract(provenance_json, '$.kind') IN ('author','derived','adopted','legacy'), 0) ELSE 0 END),
  draft_id INTEGER REFERENCES "drafts_all"(id) ON DELETE CASCADE,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
  CHECK((aspect = 'relation') = (target_id IS NOT NULL)),
  CHECK((target_id IS NULL) = (target_name IS NULL))
);
CREATE INDEX idx_character_continuity_events_subject ON character_continuity_events(subject_id, aspect, effective_chapter);
CREATE INDEX idx_character_continuity_events_draft ON character_continuity_events(draft_id) WHERE draft_id IS NOT NULL;
CREATE TRIGGER character_continuity_events_append_only BEFORE UPDATE ON character_continuity_events
BEGIN SELECT RAISE(ABORT, 'CHARACTER_CONTINUITY_EVENT_APPEND_ONLY'); END;

CREATE TABLE consistency_exemptions_m08 (
  exemption_id INTEGER PRIMARY KEY,
  stable_fact_key TEXT NOT NULL,
  chapter_number INTEGER CHECK(chapter_number IS NULL OR chapter_number > 0),
  reason TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stable_fact_key, chapter_number)
);
INSERT INTO consistency_exemptions_m08(stable_fact_key, chapter_number, reason, revoked, created_at)
  SELECT stable_fact_key, NULL, reason, revoked, '' FROM consistency_exemptions ORDER BY stable_fact_key;
DROP TABLE consistency_exemptions;
ALTER TABLE consistency_exemptions_m08 RENAME TO consistency_exemptions;
-- SQLite 的 UNIQUE 把多个 NULL 视为互不相同，全书豁免（chapter_number 为空）的唯一性只能靠这个部分索引。
CREATE UNIQUE INDEX idx_consistency_exemptions_global ON consistency_exemptions(stable_fact_key) WHERE chapter_number IS NULL;

CREATE TABLE blueprint_continuity_suggestions (
  suggestion_id TEXT PRIMARY KEY,
  finalization_id TEXT NOT NULL REFERENCES "finalization_outbox_all"(finalization_id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL CHECK(chapter_number > 0),
  base_blueprint_hash TEXT NOT NULL,
  patch_json TEXT NOT NULL CHECK(json_valid(patch_json)),
  evidence_event_ids TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(evidence_event_ids) AND json_type(evidence_event_ids) = 'array'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','stale')),
  decided_at TEXT NOT NULL DEFAULT '',
  decision_receipt_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(decision_receipt_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK((status = 'pending') = (decided_at = ''))
);
CREATE INDEX idx_blueprint_continuity_suggestions_chapter ON blueprint_continuity_suggestions(chapter_number, status);
CREATE INDEX idx_blueprint_continuity_suggestions_finalization ON blueprint_continuity_suggestions(finalization_id);

CREATE TABLE narrative_thread_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES narrative_thread_plans(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL CHECK(chapter_number > 0),
  kind TEXT NOT NULL CHECK(kind IN ('advance','resolve')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plan_id, chapter_number)
);
`

const LEGACY_PROVENANCE = JSON.stringify({ kind: 'legacy' })

function parsedOrNull(raw: unknown): unknown {
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) as unknown } catch { return null }
}

function skip(reason: string, ids: Record<string, unknown>): void {
  console.warn('[M08] 跳过一个基线节点', { reason, ...ids })
}

/** 节点号由来源行确定，重复执行被 OR IGNORE 吸收；不写时间，恢复旧包时重试才得到相同的字节。 */
export function insertContinuityBaseline(db: Database.Database): void {
  const chapter = db.prepare("SELECT COALESCE(MAX(chapter_number), 0) FROM drafts WHERE status = 'finalized'").pluck().get() as number
  const insert = db.prepare(`INSERT OR IGNORE INTO character_continuity_events(
    event_id, subject_id, subject_name, target_id, target_name, aspect, value, effective_chapter, provenance_json, draft_id, evidence_json
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, '${LEGACY_PROVENANCE}', NULL, ?)`)

  const characters = db.prepare(`SELECT character_id, name, cs_provenance, ${Object.values(M08_STATE_COLUMNS).join(', ')}
    FROM characters ORDER BY character_id`).all() as Array<Record<string, unknown>>
  for (const row of characters) {
    const characterId = row.character_id
    if (typeof characterId !== 'string' || !characterId || typeof row.name !== 'string') {
      skip('character-identity', { characterId: typeof characterId === 'string' ? characterId : null })
      continue
    }
    const fieldProvenance = parsedOrNull(row.cs_provenance) as Record<string, unknown> | null
    for (const [aspect, column] of Object.entries(M08_STATE_COLUMNS)) {
      const value = row[column]
      if (value === null || value === '') continue
      if (typeof value !== 'string') { skip('state-value', { characterId, aspect }); continue }
      insert.run(`legacy:state:${characterId}:${aspect}`, characterId, row.name, null, null, aspect, value, chapter,
        JSON.stringify({ baseline: 'm08', fieldProvenance: fieldProvenance?.[aspect] ?? null }))
    }
  }

  const relationships = db.prepare(`SELECT r.relationship_id, r.source_character_id, r.target_character_id, r.relation,
      r.source_display_snapshot, r.target_display_snapshot,
      COUNT(*) OVER (PARTITION BY r.source_character_id, r.target_character_id) AS pair_rows
    FROM character_relationships r ORDER BY r.relationship_id`).all() as Array<Record<string, unknown>>
  for (const row of relationships) {
    if (typeof row.relation !== 'string' || !row.relation
      || typeof row.source_display_snapshot !== 'string' || typeof row.target_display_snapshot !== 'string') {
      skip('relationship-value', { relationshipId: row.relationship_id })
      continue
    }
    insert.run(`legacy:relation:${String(row.relationship_id)}`, row.source_character_id, row.source_display_snapshot,
      row.target_character_id, row.target_display_snapshot, 'relation', row.relation, chapter, JSON.stringify({
        baseline: 'm08', relationshipId: row.relationship_id,
        ...(Number(row.pair_rows) > 1 ? { baselineConflict: true } : {}),
      }))
  }
}

export function applyM08ContinuityFoundation(db: Database.Database): void {
  if (!db.inTransaction) throw new Error('M08_MIGRATION_TRANSACTION_REQUIRED')
  db.exec(M08_CONTINUITY_FOUNDATION_SQL)
  insertContinuityBaseline(db)
}

export function createM08Migration(deps: {
  database(reader: SchemaReader): Database.Database
  verifyKnownSchema(reader: SchemaReader): boolean
}): MigrationImplementation {
  return { id: 'M08', from: 8, to: 9, owner: 'continuity-foundation',
    migrate: reader => applyM08ContinuityFoundation(deps.database(reader)),
    verify: reader => deps.verifyKnownSchema(reader) }
}
