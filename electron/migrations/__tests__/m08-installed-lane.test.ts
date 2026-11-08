import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { CURRENT_DESKTOP_SCHEMA_VERSION, getDesktopMigrationRegistry } from '../desktop-registry'
import { insertContinuityBaseline } from '../m08-continuity-foundation'
import { createMigrationRegistry, type MigrationImplementation } from '../registry'
import { migrateSchema, verifySchema } from '../runner'
import { SqliteSchemaAdapter, sqliteSchemaFingerprint } from '../sqlite-schema-adapter'
import { sanitizePortableDatabase } from '../../services/project-archive-service'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
type Db = import('better-sqlite3').Database

const LIN = 'char-lin', SU = 'char-su', ZHOU = 'char-zhou'

function chapter(db: Db, number: number, status: 'finalized' | 'deleted' | 'draft'): number {
  const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES(?)').run(`第${number}章`).lastInsertRowid)
  const deletion = status === 'deleted' ? ['delete-op', 'finalized', '2026-11-08'] : ['', '', '']
  return Number(db.prepare(`INSERT INTO drafts_all(chapter_number,version,status,content_id,deletion_id,deleted_from_status,deleted_at)
    VALUES(?,1,?,?,?,?,?)`).run(number, status, contentId, ...deletion).lastInsertRowid)
}

function v8Project(): Db {
  const db = new Database(':memory:')
  db.pragma('foreign_keys=ON')
  db.transaction(() => initializeLegacyBaselineSchema(db))()
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
  for (const number of [1, 2, 3]) chapter(db, number, 'finalized')
  chapter(db, 4, 'deleted')
  chapter(db, 5, 'draft')
  const character = db.prepare(`INSERT INTO characters(character_id,name,retired,cs_location,cs_power_level,cs_physical_state,
    cs_mental_state,cs_key_items,cs_recent_events,cs_provenance) VALUES(?,?,?,?,?,?,?,?,?,?)`)
  character.run(LIN, '林澈', 0, '雨城北门', '', '左肩受伤', '', '旧车站车票', '', JSON.stringify({
    location: { kind: 'author', chapterNumber: 2 }, physicalState: { kind: 'legacy' } }))
  character.run(SU, '苏晚', 0, '南门', '', '', '', '', '', 'not json')
  character.run(ZHOU, '老周', 1, '', '', '', '', '', '离开雨城', '{}')
  db.prepare("INSERT INTO character_identity_approvals VALUES('approval-1','h','{}')").run()
  const relation = db.prepare("INSERT INTO character_relationships VALUES(?,?,?,?,?,?,'{\"kind\":\"author\"}','approval-1')")
  relation.run('rel-ally', LIN, SU, '盟友', '林澈', '苏晚')
  relation.run('rel-enemy', LIN, SU, '死敌', '林澈', '苏晚')
  relation.run('rel-senior', SU, LIN, '师姐', '苏晚', '林澈')
  db.prepare("INSERT INTO consistency_exemptions(stable_fact_key,reason,revoked) VALUES('death:老周','假死',0)").run()
  return db
}

const events = (db: Db) => db.prepare(`SELECT event_id,subject_id,subject_name,target_id,target_name,aspect,value,effective_chapter,
  provenance_json,draft_id,evidence_json FROM character_continuity_events ORDER BY event_id`).all() as Array<Record<string, unknown>>
const tableExists = (db: Db, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))

const legacy = JSON.stringify({ kind: 'legacy' })
const state = (id: string, name: string, aspect: string, value: string, fieldProvenance: unknown = null) => ({
  event_id: `legacy:state:${id}:${aspect}`, subject_id: id, subject_name: name, target_id: null, target_name: null, aspect, value,
  effective_chapter: 3, provenance_json: legacy, draft_id: null, evidence_json: JSON.stringify({ baseline: 'm08', fieldProvenance }),
})
const relationNode = (id: string, from: string, fromName: string, to: string, toName: string, value: string, conflict: boolean) => ({
  event_id: `legacy:relation:${id}`, subject_id: from, subject_name: fromName, target_id: to, target_name: toName, aspect: 'relation',
  value, effective_chapter: 3, provenance_json: legacy, draft_id: null, evidence_json: JSON.stringify({
    baseline: 'm08', relationshipId: id,
    ...(conflict ? { baselineConflict: true } : {}) }),
})

/** 生效章取最大的未删定稿章：第 4 章在回收站，所以是 3。 */
const EXPECTED_BASELINE = [
  relationNode('rel-ally', LIN, '林澈', SU, '苏晚', '盟友', true),
  relationNode('rel-enemy', LIN, '林澈', SU, '苏晚', '死敌', true),
  relationNode('rel-senior', SU, '苏晚', LIN, '林澈', '师姐', false),
  state(LIN, '林澈', 'keyItems', '旧车站车票'),
  state(LIN, '林澈', 'location', '雨城北门', { kind: 'author', chapterNumber: 2 }),
  state(LIN, '林澈', 'physicalState', '左肩受伤', { kind: 'legacy' }),
  state(SU, '苏晚', 'location', '南门'),
  state(ZHOU, '老周', 'recentEvents', '离开雨城'),
].sort((a, b) => a.event_id < b.event_id ? -1 : 1)

afterEach(() => { vi.restoreAllMocks() })

describe('installed M08 lane', () => {
  it('upgrades v8 to the recognized v9 schema with one legacy node per current state field and relationship', () => {
    const db = v8Project()
    try {
      const before = {
        characters: db.prepare('SELECT * FROM characters ORDER BY character_id').all(),
        relationships: db.prepare('SELECT * FROM character_relationships ORDER BY relationship_id').all(),
      }
      const result = migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      expect(CURRENT_DESKTOP_SCHEMA_VERSION).toBe(9)
      expect(result.completedSteps).toEqual(['M08'])
      expect(verifySchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9).version).toBe(9)
      expect(events(db)).toEqual(EXPECTED_BASELINE)
      expect(db.prepare('SELECT * FROM characters ORDER BY character_id').all()).toEqual(before.characters)
      expect(db.prepare('SELECT * FROM character_relationships ORDER BY relationship_id').all()).toEqual(before.relationships)
      expect(db.prepare('SELECT * FROM consistency_exemptions').all())
        .toEqual([{ exemption_id: 1, stable_fact_key: 'death:老周', chapter_number: null, reason: '假死', revoked: 0, created_at: '' }])
      expect(db.prepare('SELECT COUNT(*) FROM blueprint_continuity_suggestions').pluck().get()).toBe(0)
      expect(db.prepare('SELECT COUNT(*) FROM narrative_thread_assignments').pluck().get()).toBe(0)
    } finally { db.close() }
  })

  it('gives a new project the same v9 schema as an upgraded v8 project', () => {
    const upgraded = v8Project(), created = new Database(':memory:')
    try {
      migrateSchema(new SqliteSchemaAdapter(upgraded), getDesktopMigrationRegistry(), 9)
      created.pragma('foreign_keys=ON')
      created.transaction(() => initializeLegacyBaselineSchema(created))()
      migrateSchema(new SqliteSchemaAdapter(created), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
      expect(sqliteSchemaFingerprint(created)).toBe(sqliteSchemaFingerprint(upgraded))
      expect(events(created)).toEqual([])
    } finally { upgraded.close(); created.close() }
  })

  it('anchors the baseline at chapter 0 when nothing is finalized', () => {
    const db = new Database(':memory:')
    try {
      db.transaction(() => initializeLegacyBaselineSchema(db))()
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
      chapter(db, 1, 'draft')
      db.prepare("INSERT INTO characters(character_id,name,cs_location) VALUES('only','独行者','山口')").run()
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9)
      expect(events(db).map(row => [row.event_id, row.effective_chapter])).toEqual([['legacy:state:only:location', 0]])
    } finally { db.close() }
  })

  it('keeps relationship provenance, which export redacts, out of the baseline so archives cannot leak it', () => {
    const db = v8Project()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm08-redact-'))
    try {
      db.prepare('UPDATE character_relationships SET provenance_json=? WHERE relationship_id=?')
        .run(JSON.stringify({ kind: 'legacy', sourceKey: 'C:/Users/秘密/vela.db', token: 'tok-秘密' }), 'rel-ally')
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9)
      const file = path.join(dir, 'project.db')
      fs.writeFileSync(file, db.serialize())
      sanitizePortableDatabase(file)
      const exported = new Database(file, { readonly: true })
      try {
        expect(JSON.stringify(events(exported))).not.toContain('秘密')
        expect(events(exported)).toEqual(EXPECTED_BASELINE)
      } finally { exported.close() }
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('does not insert baseline nodes twice', () => {
    const db = v8Project()
    try {
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9)
      expect(migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9).completedSteps).toEqual([])
      db.transaction(() => insertContinuityBaseline(db))()
      expect(events(db)).toEqual(EXPECTED_BASELINE)
    } finally { db.close() }
  })

  it('skips only the node whose state cell is malformed, logs ids without values, and finishes the upgrade', () => {
    const db = v8Project()
    try {
      db.prepare('UPDATE characters SET cs_key_items=? WHERE character_id=?').run(Buffer.from('坏值'), LIN)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9)
      expect(events(db)).toEqual(EXPECTED_BASELINE.filter(row => row.event_id !== `legacy:state:${LIN}:keyItems`))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![1]).toEqual({ reason: 'state-value', characterId: LIN, aspect: 'keyItems' })
      expect(JSON.stringify(warn.mock.calls)).not.toContain('坏值')
    } finally { db.close() }
  })

  const sabotages: Array<[string, (step: MigrationImplementation) => MigrationImplementation, string]> = [
    ['verification fails', step => ({ ...step, verify: () => false }), 'MIGRATION_VERIFICATION_FAILED'],
    ['migration throws after the baseline was written', step => ({ ...step,
      migrate: db => { step.migrate(db); throw new Error('M08_INJECTED_FAILURE') } }), 'M08_INJECTED_FAILURE'],
  ]
  it.each(sabotages)('stays on v8 with nothing added when %s', (_label, sabotage, error) => {
    const db = v8Project()
    try {
      const registry = getDesktopMigrationRegistry(), before = sqliteSchemaFingerprint(db)
      const broken = createMigrationRegistry(registry.implementations.map(step => step.id === 'M08' ? sabotage(step) : step),
        registry.recognizedSchemas)
      expect(() => migrateSchema(new SqliteSchemaAdapter(db), broken, 9)).toThrow(error)
      expect(db.pragma('user_version', { simple: true })).toBe(8)
      expect(sqliteSchemaFingerprint(db)).toBe(before)
      expect(db.prepare('SELECT * FROM consistency_exemptions').all())
        .toEqual([{ stable_fact_key: 'death:老周', reason: '假死', revoked: 0 }])
      for (const table of ['character_continuity_events', 'blueprint_continuity_suggestions', 'narrative_thread_assignments']) {
        expect(tableExists(db, table), table).toBe(false)
      }
      expect(migrateSchema(new SqliteSchemaAdapter(db), registry, 9).completedSteps).toEqual(['M08'])
      expect(events(db)).toEqual(EXPECTED_BASELINE)
    } finally { db.close() }
  })
})

describe('M08 tables', () => {
  function v9(): Db {
    const db = v8Project()
    migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9)
    return db
  }
  const insertEvent = (db: Db, id: string, patch: Partial<Record<string, unknown>> = {}) => {
    const row = { event_id: id, subject_id: LIN, subject_name: '林澈', target_id: null, target_name: null, aspect: 'location',
      value: '北门', effective_chapter: 2, provenance_json: '{"kind":"author","effectiveChapter":2}', draft_id: null,
      evidence_json: '{}', ...patch }
    db.prepare(`INSERT INTO character_continuity_events(${Object.keys(row).join(',')})
      VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row))
  }

  it('keeps events append-only and drops a derived event with its permanently deleted draft', () => {
    const db = v9()
    try {
      expect(() => db.prepare("UPDATE character_continuity_events SET value='改' WHERE event_id=?").run(`legacy:state:${SU}:location`))
        .toThrow('CHARACTER_CONTINUITY_EVENT_APPEND_ONLY')
      const draftId = db.prepare('SELECT id FROM drafts WHERE chapter_number=3').pluck().get() as number
      insertEvent(db, 'derived-3', { provenance_json: '{"kind":"derived"}', draft_id: draftId, effective_chapter: 3 })
      db.prepare('DELETE FROM drafts_all WHERE id=?').run(draftId)
      expect(db.prepare("SELECT 1 FROM character_continuity_events WHERE event_id='derived-3'").get()).toBeUndefined()
      expect(events(db)).toEqual(EXPECTED_BASELINE)
    } finally { db.close() }
  })

  it.each([
    ['an unknown provenance kind', { provenance_json: '{"kind":"guess"}' }],
    ['provenance that is not JSON', { provenance_json: 'author' }],
    ['provenance without a kind', { provenance_json: '{}' }],
    ['a null provenance kind', { provenance_json: '{"kind":null}' }],
    ['an unknown aspect', { aspect: 'mood' }],
    ['a relation without a target', { aspect: 'relation' }],
    ['a state field with a target', { target_id: SU, target_name: '苏晚' }],
    ['a target without its name snapshot', { aspect: 'relation', target_id: SU }],
    ['a negative chapter', { effective_chapter: -1 }],
  ])('rejects an event with %s', (_label, patch) => {
    const db = v9()
    try { expect(() => insertEvent(db, 'bad', patch)).toThrow(/CHECK constraint failed/) } finally { db.close() }
  })

  it('keeps one assignment per plan and chapter and removes assignments with their plan', () => {
    const db = v9()
    try {
      const plan = Number(db.prepare("INSERT INTO narrative_thread_plans(title,type,target_start_chapter,target_end_chapter) VALUES('车票','foreshadow',1,4)")
        .run().lastInsertRowid)
      const assign = db.prepare('INSERT INTO narrative_thread_assignments(plan_id,chapter_number,kind,note) VALUES(?,?,?,?)')
      assign.run(plan, 5, 'resolve', '延到第 5 章')
      expect(() => assign.run(plan, 5, 'advance', '')).toThrow(/UNIQUE constraint failed/)
      expect(() => assign.run(plan, 6, 'abandon', '')).toThrow(/CHECK constraint failed/)
      db.prepare('DELETE FROM narrative_thread_plans WHERE id=?').run(plan)
      expect(db.prepare('SELECT COUNT(*) FROM narrative_thread_assignments').pluck().get()).toBe(0)
    } finally { db.close() }
  })

  it('ties a suggestion to its finalization and requires a decision time exactly when decided', () => {
    const db = v9()
    try {
      const draftId = db.prepare('SELECT id FROM drafts WHERE chapter_number=3').pluck().get() as number
      db.prepare(`INSERT INTO finalization_outbox_all(finalization_id,draft_id,chapter_number,content_hash,content_revision,content_snapshot,target_file_name)
        VALUES('final-3',?,3,?,1,'第3章','第3章.txt')`).run(draftId, 'h'.repeat(64))
      const suggest = db.prepare(`INSERT INTO blueprint_continuity_suggestions(suggestion_id,finalization_id,chapter_number,base_blueprint_hash,
        patch_json,evidence_event_ids,status,decided_at) VALUES(?,?,?,?,?,?,?,?)`)
      suggest.run('s-1', 'final-3', 7, 'b'.repeat(64), '{"purpose":"改"}', `["legacy:state:${SU}:location"]`, 'pending', '')
      expect(() => suggest.run('s-2', 'final-3', 7, 'b', '{}', '[]', 'accepted', '')).toThrow(/CHECK constraint failed/)
      expect(() => suggest.run('s-3', 'final-3', 7, 'b', '{}', '[]', 'pending', '2026-11-08')).toThrow(/CHECK constraint failed/)
      expect(() => suggest.run('s-4', 'final-3', 7, 'b', '{}', '{}', 'pending', '')).toThrow(/CHECK constraint failed/)
      expect(() => suggest.run('s-5', 'missing', 7, 'b', '{}', '[]', 'pending', '')).toThrow(/FOREIGN KEY constraint failed/)
      db.prepare('DELETE FROM finalization_outbox_all WHERE finalization_id=?').run('final-3')
      expect(db.prepare('SELECT COUNT(*) FROM blueprint_continuity_suggestions').pluck().get()).toBe(0)
    } finally { db.close() }
  })

  it('keeps one exemption per fact and scope, where a fact can be exempted globally and per chapter at once', () => {
    const db = v9()
    try {
      const exempt = db.prepare('INSERT INTO consistency_exemptions(stable_fact_key,chapter_number,reason) VALUES(?,?,?)')
      exempt.run('death:老周', 3, '第 3 章是回忆')
      exempt.run('death:老周', 5, '第 5 章是梦')
      expect(() => exempt.run('death:老周', null, '再存一行全局')).toThrow(/UNIQUE constraint failed/)
      expect(() => exempt.run('death:老周', 3, '同章第二行')).toThrow(/UNIQUE constraint failed/)
      expect(() => exempt.run('k0', 0, 'r')).toThrow(/CHECK constraint failed/)
      const stamped = expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      expect(db.prepare('SELECT stable_fact_key,chapter_number,reason,created_at FROM consistency_exemptions ORDER BY exemption_id').all())
        .toEqual([
          { stable_fact_key: 'death:老周', chapter_number: null, reason: '假死', created_at: '' },
          { stable_fact_key: 'death:老周', chapter_number: 3, reason: '第 3 章是回忆', created_at: stamped },
          { stable_fact_key: 'death:老周', chapter_number: 5, reason: '第 5 章是梦', created_at: stamped },
        ])
    } finally { db.close() }
  })
})
