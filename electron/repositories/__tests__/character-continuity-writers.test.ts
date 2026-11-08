import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WRITES = [
  /(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|DELETE\s+FROM|UPDATE)\s+character_relationships\b/iu,
  /DELETE\s+FROM\s+characters\b/iu,
  /(?:UPDATE\s+characters\s+SET|INSERT(?:\s+OR\s+\w+)?\s+INTO\s+characters\b)[^`";]{0,400}?(?:\bcs_(?:location|power_level|physical_state|mental_state|key_items|recent_events)\b|\$\{[^}]*\[)/isu,
]

/** 写 cs_* 值列或关系表的全部源文件。新增写入方必须走 character-continuity-repository，或在这里写明为什么不追加节点。 */
const REGISTERED_WRITERS: Readonly<Record<string, string>> = {
  'electron/repositories/character-continuity-repository.ts': '收口：写业务列并在同一事务追加节点',
  'electron/repositories/character-repository.ts': 'upsert/delete/updateState 在身份 schema 上抛 CHARACTER_ID_WRITE_REQUIRED，第 9 版的库走不到',
  'electron/repositories/character-roster-repository.ts': 'CharacterRosterRepository.commit 的整表回填同样先抛 CHARACTER_ID_WRITE_REQUIRED，第 9 版的库走不到',
  'electron/services/legacy-project-copy-import.ts': '旧版项目复制是整库导入，事务末尾由 insertContinuityBaseline 补基线节点',
  'electron/migrations/baseline-schema.ts': '迁移：只把哨兵 0 改成 NULL，不写值列',
}

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full)
    return entry.name.endsWith('.ts') ? [full.split(path.sep).join('/')] : []
  })
}

const isCharacterWrite = (text: string) => WRITES.some(pattern => pattern.test(text))

describe('角色状态与关系的写入方', () => {
  it.each([
    'insert into character_relationships values(?)',
    'delete from character_relationships where relationship_id=?',
    'delete from characters',
    'update characters set cs_location=? where character_id=?',
    'UPDATE characters SET ${columns[field]}=? WHERE character_id=?',
    'update characters set ${STATE_COLUMNS[field]}=?',
  ])('识别写入：%#', sql => expect(isCharacterWrite(sql)).toBe(true))

  it.each([
    'SELECT cs_location FROM characters',
    'UPDATE characters SET notes=? WHERE character_id=?',
    'UPDATE characters SET cs_provenance=? WHERE character_id=?',
    'UPDATE characters SET ${keys.join(",")}=?',
  ])('不误报：%#', sql => expect(isCharacterWrite(sql)).toBe(false))

  it('每个写入方都走收口函数或登记了不追加节点的理由', () => {
    const writers = sourceFiles('electron').filter(file => {
      return isCharacterWrite(fs.readFileSync(file, 'utf8'))
    })
    expect(writers.sort()).toEqual(Object.keys(REGISTERED_WRITERS).sort())
  })
})
