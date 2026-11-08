import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { initializeLegacyBaselineSchema } from '../baseline-schema'
import { getDesktopMigrationRegistry } from '../desktop-registry'
import { migrateSchema } from '../runner'
import { SqliteSchemaAdapter } from '../sqlite-schema-adapter'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')

const CHARACTERS = 500, TARGETS_PER_CHARACTER = 19
// 修后本机中位 394 ms、修前中位 5821 ms；4 秒给并行负载留约 10 倍余量，仍抓得住相关子查询那次退化
const OPEN_PROJECT_BUDGET_MS = 4_000

it('backfills 500 characters and 10,000 relationships within the project-open budget, flagging only repeated pairs', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys=ON')
    db.transaction(() => initializeLegacyBaselineSchema(db))()
    migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 8)
    const repeated = new Set<string>()
    db.transaction(() => {
      const character = db.prepare('INSERT INTO characters(character_id,name) VALUES(?,?)')
      for (let i = 0; i < CHARACTERS; i++) character.run(`c${i}`, `角色${i}`)
      db.prepare("INSERT INTO character_identity_approvals VALUES('approval','h','{}')").run()
      const relation = db.prepare("INSERT INTO character_relationships VALUES(?,?,?,?,?,?,'{}','approval')")
      const add = (id: string, from: number, to: number, value: string) =>
        relation.run(id, `c${from}`, `c${to}`, value, `角色${from}`, `角色${to}`)
      for (let from = 0; from < CHARACTERS; from++) {
        for (let step = 1; step <= TARGETS_PER_CHARACTER; step++) add(`r-${from}-${step}`, from, (from + step) % CHARACTERS, '同伴')
        add(`r-${from}-again`, from, (from + 1) % CHARACTERS, '宿敌')
        repeated.add(`r-${from}-1`).add(`r-${from}-again`)
      }
    })()

    const started = performance.now()
    migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), 9)
    const elapsed = performance.now() - started

    const nodes = db.prepare("SELECT evidence_json FROM character_continuity_events WHERE aspect='relation'").pluck().all() as string[]
    const evidence = nodes.map(raw => JSON.parse(raw) as { relationshipId: string, baselineConflict?: true })
    expect(evidence).toHaveLength(CHARACTERS * (TARGETS_PER_CHARACTER + 1))
    expect(new Set(evidence.filter(row => row.baselineConflict).map(row => row.relationshipId))).toEqual(repeated)
    expect(elapsed).toBeLessThan(OPEN_PROJECT_BUDGET_MS)
  } finally { db.close() }
}, 60_000)
