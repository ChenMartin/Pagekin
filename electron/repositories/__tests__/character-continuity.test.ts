import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
import { getDesktopMigrationRegistry, CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { insertContinuityBaseline } from '../../migrations/m08-continuity-foundation'
import { SqliteSchemaAdapter } from '../../migrations/sqlite-schema-adapter'
import { migrateSchema } from '../../migrations/runner'
import { getProjectDb } from '../../database'
import { FinalizationRepository } from '../finalization-repository'
import { SummaryRepository } from '../summary-repository'
import { CharacterRosterRepository, commitCharacterIdentities, refreshCharacterIdentityProjection, type CharacterIdentityCommitRequest } from '../character-roster-repository'
import { CHARACTER_STATE_COLUMNS, readCharacterContinuityNodes } from '../character-continuity-repository'
import { commitAuthorCharacterRoster } from '../../services/character-roster-author'
import { latestNodesBefore } from '../../../src/shared/character-continuity'
import { CHARACTER_STATE_TEXT_FIELDS, type CharacterRosterEntry, type CharacterRosterCharacterState } from '../../../src/shared/character-roster'
import { parseFinalizedCharacterStateResponse } from '../../../src/shared/finalized-continuity'
import { registerAsReopenDraft } from '../../../test/helpers/reopened-draft'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
type Db = import('better-sqlite3').Database
const open: Db[] = []
afterEach(() => { for (const db of open.splice(0)) db.close(); vi.restoreAllMocks() })

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const scope = { projectId: '合成项目', epoch: '原会话' }
const prose = '🌙林岚走进北塔。周研留在旧站。'
const evidence = { start: 2, end: 9, text: prose.slice(2, 9) }

interface EventRow { event_id: string; subject_id: string; target_id: string | null; aspect: string; value: string; effective_chapter: number; provenance_json: string; draft_id: number | null; evidence_json: string }

function fixture() {
  const db = new Database(':memory:'); open.push(db)
  db.pragma('foreign_keys=ON')
  vi.mocked(getProjectDb).mockReturnValue(db)
  initializeLegacyBaselineSchema(db)
  db.exec("INSERT INTO characters(name,notes) VALUES('林岚','静态'),('周研','静态')")
  migrateSchema(new SqliteSchemaAdapter(db), getDesktopMigrationRegistry(), CURRENT_DESKTOP_SCHEMA_VERSION)
  db.exec("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','合成','zh-CN')")
  db.transaction(() => refreshCharacterIdentityProjection(db))()
  const id = (name: string) => db.prepare('SELECT character_id FROM characters WHERE name=?').pluck().get(name) as string
  const lin = id('林岚'), zhou = id('周研')
  let operations = 0

  const finalize = (draftId: number, chapter: number, content = prose, version = 1) => {
    db.prepare('INSERT OR IGNORE INTO blueprints(chapter_number,title) VALUES(?,?)').run(chapter, '合成章节')
    db.prepare('INSERT INTO contents(id,body) VALUES(?,?)').run(draftId, '尚未定稿')
    db.prepare("INSERT INTO drafts_all(id,chapter_number,version,status,content_id,word_count) VALUES(?,?,?,'draft',?,0)").run(draftId, chapter, version, draftId)
    registerAsReopenDraft(db, draftId)
    FinalizationRepository.commit({ finalizationId: `finalization-${draftId}`, draftId, chapterNumber: chapter, chapterTitle: '合成章节', content,
      contentHash: hash(content), contentRevision: 1, targetFileName: `${chapter}-${draftId}.txt` })
  }
  const context = (draftId: number) => SummaryRepository.readFinalizedCharacterContext(draftId, scope, db)
  const derive = (draftId: number, currentState: Record<string, string>, characterId = lin) => {
    const captured = context(draftId)
    return SummaryRepository.commitFinalizedCharacterStates(captured, parseFinalizedCharacterStateResponse(
      JSON.stringify({ updates: [{ characterId, currentState, evidence }] }), captured), db)
  }
  const saveNotes = (draftId: number, chapter: number) => {
    const captured = context(draftId)
    SummaryRepository.saveFinalizedContinuity({ draftId, chapterNumber: chapter, chapterNotes: '要点', facts: [], source: captured.source, projectionGeneration: captured.projectionGeneration }, db)
  }
  const accept = (draftId: number, operationId = `accept-${++operations}`) => {
    const summary = SummaryRepository.listPendingFinalizedCharacterStateCandidates(db).find(item => item.draftId === draftId)!
    const candidate = SummaryRepository.readPendingFinalizedCharacterStateCandidate(draftId, summary.candidateKey, db)
    return SummaryRepository.decideFinalizedCharacterStateCandidate({ draftId, candidateKey: candidate.candidateKey, characterId: candidate.characterId, field: candidate.field,
      expectedFieldRevision: candidate.expectedFieldRevision, expectedFieldValueHash: candidate.expectedFieldValueHash, operationId, decision: 'accept' }, db)
  }
  const save = (mutate: (entries: CharacterRosterEntry[]) => void) => {
    const read = CharacterRosterRepository.read(db), entries = structuredClone(read.entries)
    mutate(entries)
    return commitAuthorCharacterRoster(db, { operationId: `save-${++operations}`, schemaVersion: 1, intent: 'manual_edit',
      expectedRevision: read.revision, expectedIdentityRevision: read.identityRevision!, entries }, scope, () => {})
  }
  const setState = (entries: CharacterRosterEntry[], characterId: string, patch: Partial<CharacterRosterCharacterState>) => {
    const entry = entries.find(item => item.characterId === characterId)!
    entry.currentState = { location: '', powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '', updatedAtChapter: 1, ...entry.currentState, ...patch }
  }
  const setRelations = (entries: CharacterRosterEntry[], from: string, to: string, relations: string[]) => {
    entries.find(item => item.characterId === from)!.relationships = relations.map(relation => ({ target: '', targetCharacterId: to, relation }))
  }
  const events = () => db.prepare('SELECT * FROM character_continuity_events ORDER BY rowid').all() as EventRow[]
  const now = (chapter = Number.POSITIVE_INFINITY) => latestNodesBefore(readCharacterContinuityNodes(db), chapter)
  const column = (characterId: string, field: keyof typeof CHARACTER_STATE_COLUMNS) =>
    db.prepare(`SELECT ${CHARACTER_STATE_COLUMNS[field]} FROM characters WHERE character_id=?`).pluck().get(characterId) as string
  const assertFoldMatchesCurrent = () => {
    const folded = now()
    for (const characterId of db.prepare('SELECT character_id FROM characters WHERE retired=0').pluck().all() as string[])
      for (const field of CHARACTER_STATE_TEXT_FIELDS)
        expect([field, folded.states.find(node => node.subjectId === characterId && node.aspect === field)?.value ?? '']).toEqual([field, column(characterId, field) ?? ''])
    const currentRelations = (db.prepare(`SELECT r.source_character_id AS a,r.target_character_id AS b,r.relation AS c FROM character_relationships r
      JOIN characters x ON x.character_id=r.source_character_id JOIN characters y ON y.character_id=r.target_character_id WHERE x.retired=0 AND y.retired=0`).all() as { a: string; b: string; c: string }[])
      .map(row => JSON.stringify([row.a, row.b, row.c])).sort()
    expect(folded.relations.flatMap(pair => pair.lines.map(line => JSON.stringify([pair.subjectId, pair.targetId, line.value]))).sort()).toEqual(currentRelations)
  }
  return { db, lin, zhou, finalize, context, derive, saveNotes, accept, save, setState, setRelations, events, now, column, assertFoldMatchesCurrent }
}
const stateEvents = (f: ReturnType<typeof fixture>) => f.events().filter(event => event.aspect !== 'relation')
const relationEvents = (f: ReturnType<typeof fixture>) => f.events().filter(event => event.aspect === 'relation')
const failInserts = (db: Db) => db.exec("CREATE TRIGGER fail_node BEFORE INSERT ON character_continuity_events BEGIN SELECT RAISE(ABORT,'节点写入失败'); END")

describe('角色状态写入追加时间线节点', () => {
  it('定稿第 N 章的派生状态：节点生效章为 N，绑定该稿，证据随节点保存', () => {
    const f = fixture()
    f.finalize(1, 1); f.finalize(2, 2)
    f.derive(2, { location: '北塔' })
    const [event] = f.events()
    expect(f.events()).toHaveLength(1)
    expect(event).toMatchObject({ subject_id: f.lin, aspect: 'location', value: '北塔', effective_chapter: 2, draft_id: 2 })
    expect(JSON.parse(event.provenance_json)).toMatchObject({ kind: 'derived', source: { finalizationId: 'finalization-2', draftId: 2, chapterNumber: 2 } })
    expect(f.now().states[0].quote).toEqual(evidence)
  })

  it('作者手改状态：追加 author 节点，生效章为最大定稿章的下一章', () => {
    const f = fixture()
    f.finalize(1, 1); f.finalize(2, 2)
    f.save(entries => f.setState(entries, f.lin, { powerLevel: '筑基' }))
    expect(stateEvents(f)).toHaveLength(1)
    expect(stateEvents(f)[0]).toMatchObject({ aspect: 'powerLevel', value: '筑基', effective_chapter: 3, draft_id: null })
    expect(JSON.parse(stateEvents(f)[0].provenance_json).kind).toBe('author')
  })

  it('还没有定稿章时作者手改从第 1 章生效', () => {
    const f = fixture()
    f.save(entries => f.setState(entries, f.lin, { powerLevel: '凡人' }))
    expect(stateEvents(f)[0].effective_chapter).toBe(1)
  })

  it('作者把字段清空：节点值为空串，折叠后不再有这个字段', () => {
    const f = fixture()
    f.save(entries => f.setState(entries, f.lin, { powerLevel: '筑基' }))
    f.save(entries => f.setState(entries, f.lin, { powerLevel: '' }))
    expect(stateEvents(f).map(event => event.value)).toEqual(['筑基', ''])
    expect(f.now().states).toEqual([])
  })

  it('接受候选：追加 adopted 节点，生效章为候选来源章，不挂稿', () => {
    const f = fixture()
    f.save(entries => f.setState(entries, f.lin, { location: '作者地点' }))
    f.finalize(1, 1); f.saveNotes(1, 1)
    expect(f.derive(1, { location: '北塔' }).candidates).toHaveLength(1)
    expect(stateEvents(f)).toHaveLength(1)
    f.accept(1)
    const adopted = stateEvents(f)[1]
    expect(adopted).toMatchObject({ aspect: 'location', value: '北塔', effective_chapter: 1, draft_id: null })
    expect(JSON.parse(adopted.provenance_json)).toMatchObject({ kind: 'adopted', source: { finalizationId: 'finalization-1' } })
    expect(f.column(f.lin, 'location')).toBe('北塔')
    f.assertFoldMatchesCurrent()
  })

  it('拒绝候选不追加节点', () => {
    const f = fixture()
    f.save(entries => f.setState(entries, f.lin, { location: '作者地点' }))
    f.finalize(1, 1); f.saveNotes(1, 1)
    f.derive(1, { location: '北塔' })
    const before = f.events().length
    const summary = SummaryRepository.listPendingFinalizedCharacterStateCandidates(f.db)[0]
    const candidate = SummaryRepository.readPendingFinalizedCharacterStateCandidate(1, summary.candidateKey, f.db)
    SummaryRepository.decideFinalizedCharacterStateCandidate({ draftId: 1, candidateKey: candidate.candidateKey, characterId: candidate.characterId, field: candidate.field,
      expectedFieldRevision: candidate.expectedFieldRevision, expectedFieldValueHash: candidate.expectedFieldValueHash, operationId: '拒绝', decision: 'decline' }, f.db)
    expect(f.events()).toHaveLength(before)
  })

  it('接受来自较早章的候选时，节点不早于同字段已有节点，折叠仍等于当前值', () => {
    const f = fixture()
    f.finalize(1, 1); f.saveNotes(1, 1)
    f.save(entries => f.setState(entries, f.lin, { location: '作者地点' }))
    f.derive(1, { location: '北塔' })
    f.accept(1)
    expect(stateEvents(f).map(event => event.effective_chapter)).toEqual([2, 2])
    f.assertFoldMatchesCurrent()
  })
})

describe('关系写入追加时间线节点', () => {
  const relationIds = (f: ReturnType<typeof fixture>) => f.db.prepare('SELECT relationship_id FROM character_relationships ORDER BY relationship_id').pluck().all() as string[]

  it('新增、修改、删除各追加节点，删除的节点值为空并指明删的是哪一行', () => {
    const f = fixture()
    f.finalize(1, 1)
    f.save(entries => f.setRelations(entries, f.lin, f.zhou, ['盟友']))
    const [added] = relationEvents(f), firstId = relationIds(f)[0]
    expect(added).toMatchObject({ subject_id: f.lin, target_id: f.zhou, value: '盟友', effective_chapter: 2 })
    expect(JSON.parse(added.evidence_json).relationshipId).toBe(firstId)
    expect(JSON.parse(added.provenance_json).kind).toBe('author')

    f.save(entries => f.setRelations(entries, f.lin, f.zhou, ['死敌']))
    expect(relationEvents(f).map(event => event.value)).toEqual(['盟友', '', '死敌'])
    expect(JSON.parse(relationEvents(f)[1].evidence_json).relationshipId).toBe(firstId)
    expect(f.now().relations[0].lines.map(line => line.value)).toEqual(['死敌'])

    f.save(entries => f.setRelations(entries, f.lin, f.zhou, []))
    expect(relationEvents(f).map(event => event.value)).toEqual(['盟友', '', '死敌', ''])
    expect(f.now().relations).toEqual([])
  })

  it.each([
    ['author-edit', 'author'], ['confirm-identity', 'author'], ['adopt-generated', 'adopted'], ['adopt-import', 'adopted'],
  ] as const)('身份提交动作 %s 写入的关系节点来历为 %s', (action, kind) => {
    const f = fixture()
    const sourceKind = kind === 'author' ? { kind: 'author' as const } : { kind: 'generated' as const, modelRevision: 'a'.repeat(64) }
    const request: CharacterIdentityCommitRequest = {
      approval: { operationId: `批准-${action}`, expectedRevision: f.db.prepare("SELECT revision FROM character_identity_meta WHERE id='main'").pluck().get() as number, action,
        source: { ...sourceKind, source: { projectId: scope.projectId, epoch: scope.epoch, sourceId: '来源', revision: 0, contentHash: 'b'.repeat(64) } } as never },
      changes: [], creations: [], retireIds: [], resolutions: [], relationships: [{ sourceCharacterId: f.lin, targetCharacterId: f.zhou, relation: '师徒' }],
    }
    f.db.transaction(() => commitCharacterIdentities(f.db, request, () => true))()
    expect(JSON.parse(relationEvents(f)[0].provenance_json)).toEqual({ kind, operationId: `批准-${action}` })
  })

  it('整表保存只对真正变化的内容追加节点', () => {
    const f = fixture()
    f.save(entries => { f.setState(entries, f.lin, { location: '北塔' }); f.setRelations(entries, f.lin, f.zhou, ['盟友']) })
    const before = f.events().length
    f.save(() => {})
    f.save(entries => { entries.find(item => item.characterId === f.lin)!.notes = '只改静态档案' })
    expect(f.events()).toHaveLength(before)
    f.save(entries => f.setState(entries, f.lin, { powerLevel: '筑基' }))
    expect(f.events()).toHaveLength(before + 1)
    expect(f.events().at(-1)).toMatchObject({ aspect: 'powerLevel' })
  })

  it('新建角色的空状态不产生节点', () => {
    const f = fixture()
    f.save(entries => {
      entries.push({ characterId: 'draft:11111111-1111-4111-8111-111111111111', name: '新人', role: entries[0].role, gender: '', age: '', appearance: '', personality: '',
        background: '', abilities: '', motivation: '', arc: '', notes: '', relationships: [],
        currentState: { location: '', powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '', updatedAtChapter: 0 } })
    })
    expect(f.events()).toEqual([])
  })

  it('删除高章后，同一对角色另一条关系的删除节点不被钳到更晚的章', () => {
    const f = fixture()
    f.save(entries => f.setRelations(entries, f.lin, f.zhou, ['早结的盟']))
    f.finalize(1, 1); f.finalize(2, 2)
    f.save(entries => f.setRelations(entries, f.lin, f.zhou, ['早结的盟', '晚结的仇']))
    expect(relationEvents(f).map(event => event.effective_chapter)).toEqual([1, 3])
    f.db.prepare('DELETE FROM drafts_all WHERE id=2').run()
    f.save(entries => f.setRelations(entries, f.lin, f.zhou, ['晚结的仇']))
    expect(relationEvents(f).at(-1)).toMatchObject({ value: '', effective_chapter: 2 })
    expect(f.now(2).relations).toEqual([])
    expect(f.now(3).relations[0].lines.map(line => line.value)).toEqual(['晚结的仇'])
  })

  it('基线里同一对角色的冲突关系都读得到，删掉一条后只剩另一条', () => {
    const f = fixture()
    f.db.exec("INSERT INTO character_identity_approvals VALUES('op-1','h','{}'),('op-2','h','{}')")
    f.db.prepare('INSERT INTO character_relationships VALUES(?,?,?,?,?,?,?,?)').run('一', f.lin, f.zhou, '结盟', '林岚', '周研', '{}', 'op-1')
    f.db.prepare('INSERT INTO character_relationships VALUES(?,?,?,?,?,?,?,?)').run('二', f.lin, f.zhou, '死敌', '林岚', '周研', '{}', 'op-2')
    f.db.transaction(() => refreshCharacterIdentityProjection(f.db))()
    f.db.transaction(() => insertContinuityBaseline(f.db))()
    expect(f.now().relations[0]).toMatchObject({ conflict: true })
    expect(f.now().relations[0].lines).toHaveLength(2)
    f.save(entries => f.setRelations(entries, f.lin, f.zhou, ['死敌']))
    expect(f.now().relations[0]).toMatchObject({ conflict: false })
    expect(f.now().relations[0].lines.map(line => line.value)).toEqual(['死敌'])
    f.assertFoldMatchesCurrent()
  })
})

describe('时间线与当前值的不变式', () => {
  it('定稿、手改、接受候选、改关系、整表保存、删角色之后，折叠结果等于当前值', () => {
    const f = fixture()
    f.save(entries => { f.setState(entries, f.lin, { keyItems: '玉佩' }); f.setRelations(entries, f.lin, f.zhou, ['同门']) })
    f.assertFoldMatchesCurrent()
    f.finalize(1, 1); f.saveNotes(1, 1)
    f.derive(1, { location: '北塔', keyItems: '断剑' })
    f.derive(1, { mentalState: '警觉' }, f.zhou)
    f.assertFoldMatchesCurrent()
    f.accept(1)
    f.assertFoldMatchesCurrent()
    f.save(entries => { f.setState(entries, f.lin, { powerLevel: '筑基', location: '南港' }); f.setRelations(entries, f.lin, f.zhou, ['死敌', '债主']) })
    f.assertFoldMatchesCurrent()
    f.finalize(2, 2); f.saveNotes(2, 2)
    f.derive(2, { mentalState: '释然' }, f.zhou)
    f.save(() => {})
    f.save(entries => f.setRelations(entries, f.lin, f.zhou, ['债主']))
    f.assertFoldMatchesCurrent()
    f.save(entries => { entries.splice(entries.findIndex(item => item.characterId === f.zhou), 1); f.setRelations(entries, f.lin, f.zhou, []) })
    f.assertFoldMatchesCurrent()
  })

  it('读取时排除已退休角色的状态和指向他们的关系', () => {
    const f = fixture()
    f.save(entries => { f.setState(entries, f.zhou, { location: '旧站' }); f.setRelations(entries, f.lin, f.zhou, ['同门']) })
    f.save(entries => { entries.splice(entries.findIndex(item => item.characterId === f.zhou), 1); f.setRelations(entries, f.lin, f.zhou, []) })
    expect(f.now()).toEqual({ states: [], relations: [] })
  })
})

describe('节点与业务写入同事务', () => {
  it('节点写入失败时，派生状态回滚', () => {
    const f = fixture()
    f.finalize(1, 1)
    failInserts(f.db)
    expect(() => f.derive(1, { location: '北塔' })).toThrow('节点写入失败')
    expect(f.column(f.lin, 'location')).toBe('')
  })

  it('节点写入失败时，作者保存整体回滚', () => {
    const f = fixture(), revision = CharacterRosterRepository.read(f.db).revision
    failInserts(f.db)
    expect(() => f.save(entries => f.setState(entries, f.lin, { location: '北塔' }))).toThrow('节点写入失败')
    expect(f.column(f.lin, 'location')).toBe('')
    expect(CharacterRosterRepository.read(f.db).revision).toBe(revision)
  })

  it('节点写入失败时，关系增删回滚', () => {
    const f = fixture()
    f.save(entries => f.setRelations(entries, f.lin, f.zhou, ['盟友']))
    failInserts(f.db)
    expect(() => f.save(entries => f.setRelations(entries, f.lin, f.zhou, ['死敌']))).toThrow('节点写入失败')
    expect(f.db.prepare('SELECT relation FROM character_relationships').pluck().all()).toEqual(['盟友'])
  })

  it('节点写入失败时，接受候选回滚，候选仍待决定', () => {
    const f = fixture()
    f.save(entries => f.setState(entries, f.lin, { location: '作者地点' }))
    f.finalize(1, 1); f.saveNotes(1, 1)
    f.derive(1, { location: '北塔' })
    failInserts(f.db)
    expect(() => f.accept(1)).toThrow('节点写入失败')
    expect(f.column(f.lin, 'location')).toBe('作者地点')
    expect(SummaryRepository.listPendingFinalizedCharacterStateCandidates(f.db)).toHaveLength(1)
  })

  it('业务写入失败时不留节点', () => {
    const f = fixture()
    f.finalize(1, 1)
    f.db.exec(`CREATE TRIGGER fail_state BEFORE UPDATE OF cs_provenance ON characters BEGIN SELECT RAISE(ABORT,'业务写入失败'); END;
      CREATE TRIGGER fail_relation BEFORE INSERT ON character_relationships BEGIN SELECT RAISE(ABORT,'业务写入失败'); END;`)
    expect(() => f.derive(1, { location: '北塔' })).toThrow('业务写入失败')
    expect(() => f.save(entries => f.setRelations(entries, f.lin, f.zhou, ['盟友']))).toThrow('业务写入失败')
    expect(f.events()).toEqual([])
  })
})

describe('定稿后处理重试与重开替换', () => {
  it('同一次定稿的后处理跑两次，节点数不变', () => {
    const f = fixture()
    f.finalize(1, 1)
    f.derive(1, { location: '北塔', mentalState: '警觉' })
    const before = f.events().map(event => event.event_id)
    expect(f.derive(1, { location: '北塔', mentalState: '警觉' })).toMatchObject({ applied: 0 })
    expect(f.events().map(event => event.event_id)).toEqual(before)
  })

  it('重试时模型给出不同的值：当前值跟着变，折叠读到新值', () => {
    const f = fixture()
    f.finalize(1, 1)
    f.derive(1, { location: '北塔' })
    f.derive(1, { location: '南港' })
    expect(f.column(f.lin, 'location')).toBe('南港')
    f.assertFoldMatchesCurrent()
  })

  it('第 N 章被替换后读不到旧稿的派生节点，新稿节点和作者节点照常', () => {
    const f = fixture()
    f.finalize(1, 1)
    f.derive(1, { location: '北塔' })
    f.save(entries => f.setState(entries, f.lin, { powerLevel: '筑基' }))
    expect(f.now().states.map(node => node.value).sort()).toEqual(['北塔', '筑基'].sort())

    f.finalize(2, 1, `${prose}新定稿。`, 2)
    expect(f.now().states.map(node => node.value)).toEqual(['筑基'])
    expect(f.events().map(event => event.value).sort()).toEqual(['北塔', '筑基'].sort())

    f.derive(2, { location: '南港' })
    expect(f.now().states.map(node => node.value).sort()).toEqual(['南港', '筑基'].sort())
    expect(f.now().states.find(node => node.aspect === 'location')).toMatchObject({ draftId: 2, effectiveChapter: 1 })
  })

  it('不反写：节点不影响当前列', () => {
    const f = fixture()
    f.finalize(1, 1)
    f.derive(1, { location: '北塔' })
    f.finalize(2, 1, `${prose}新定稿。`, 2)
    expect(f.column(f.lin, 'location')).toBe('北塔')
  })
})
