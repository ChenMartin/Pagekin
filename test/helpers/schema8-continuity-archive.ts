import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'

/**
 * db03cf70（schema 8）导出的真实便携包。林澈、苏晚、已退场的老周带当前状态，
 * 林澈→苏晚同时有「盟友」「死敌」，苏晚→林澈「师姐」；第 1–3 章定稿，第 4 章是草稿。
 */
export const SCHEMA8_CONTINUITY_ARCHIVE = path.resolve('test/fixtures/portable/schema8-continuity-baseline.ainovel')

const LIN = '66666666-6666-4666-8666-666666666661'
const SU = '66666666-6666-4666-8666-666666666662'
const ZHOU = '66666666-6666-4666-8666-666666666663'

/** 包里每个非空状态字段、每条关系各一个 legacy 节点，生效章都是最大定稿章 3。 */
export const SCHEMA8_EXPECTED_BASELINE = [
  ['legacy:relation:relation-ally', LIN, SU, 'relation', '盟友', true],
  ['legacy:relation:relation-enemy', LIN, SU, 'relation', '死敌', true],
  ['legacy:relation:relation-senior', SU, LIN, 'relation', '师姐', false],
  [`legacy:state:${LIN}:keyItems`, LIN, null, 'keyItems', '旧车站车票', false],
  [`legacy:state:${LIN}:location`, LIN, null, 'location', '雨城北门', false],
  [`legacy:state:${LIN}:physicalState`, LIN, null, 'physicalState', '左肩受伤', false],
  [`legacy:state:${SU}:location`, SU, null, 'location', '南门', false],
  [`legacy:state:${ZHOU}:recentEvents`, ZHOU, null, 'recentEvents', '离开雨城', false],
].map(([eventId, subjectId, targetId, aspect, value, conflict]) => ({
  eventId, subjectId, targetId, aspect, value, effectiveChapter: 3, provenance: { kind: 'legacy' }, conflict,
}))

export function continuityBaseline(db: BetterSqlite3.Database) {
  return (db.prepare(`SELECT event_id,subject_id,target_id,aspect,value,effective_chapter,provenance_json,evidence_json
    FROM character_continuity_events ORDER BY event_id`).all() as Array<Record<string, string | number | null>>).map(row => ({
    eventId: row.event_id, subjectId: row.subject_id, targetId: row.target_id, aspect: row.aspect, value: row.value,
    effectiveChapter: row.effective_chapter, provenance: JSON.parse(String(row.provenance_json)) as unknown,
    conflict: (JSON.parse(String(row.evidence_json)) as { baselineConflict?: boolean }).baselineConflict === true,
  }))
}
