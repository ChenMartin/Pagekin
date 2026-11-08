import { describe, expect, it } from 'vitest'
import { characterTimeline, latestNodesBefore, resolveStateEffectiveChapter, type CharacterRelationNode, type CharacterStateNode, type ContinuityProvenance } from '../character-continuity'

const author: ContinuityProvenance = { kind: 'author', operationId: '作者保存' }
const adopted: ContinuityProvenance = { kind: 'adopted', operationId: '接受候选' }
const legacy: ContinuityProvenance = { kind: 'legacy' }
const derived: ContinuityProvenance = { kind: 'derived', source: { finalizationId: '定稿', draftId: 1, chapterNumber: 3, contentHash: 'h', contentRevision: 1 } as never }

let order = 0
function state(value: string, effectiveChapter: number, provenance: ContinuityProvenance, subjectId = '甲'): CharacterStateNode {
  order += 1
  return { eventId: `s${order}`, subjectId, subjectName: subjectId, aspect: 'location', value, effectiveChapter, provenance, draftId: null, seq: order, quote: null }
}
function relation(relationshipId: string, value: string, effectiveChapter: number, provenance: ContinuityProvenance = author, seq = ++order): CharacterRelationNode {
  return { eventId: `r${seq}`, subjectId: '甲', subjectName: '甲', targetId: '乙', targetName: '乙', aspect: 'relation', relationshipId, value, effectiveChapter, provenance, draftId: null, seq, quote: null }
}
const values = (nodes: Parameters<typeof latestNodesBefore>[0], chapter: number, ids?: string[]) =>
  latestNodesBefore(nodes, chapter, ids).states.map(node => node.value)

describe('latestNodesBefore', () => {
  it('作者节点从生效章起可见，早一章看不到', () => {
    const nodes = [state('北塔', 6, author)]
    expect(values(nodes, 5)).toEqual([])
    expect(values(nodes, 6)).toEqual(['北塔'])
    expect(values(nodes, 7)).toEqual(['北塔'])
  })

  it.each([['派生', derived], ['基线', legacy]] as const)('%s节点是那一章写完后的状态，重写同一章时看不到', (_name, provenance) => {
    const nodes = [state('旧站', 3, provenance)]
    expect(values(nodes, 3)).toEqual([])
    expect(values(nodes, 4)).toEqual(['旧站'])
  })

  it('没有节点时结果为空', () => {
    expect(latestNodesBefore([], 9)).toEqual({ states: [], relations: [] })
  })

  it('较晚的章覆盖较早的章，与输入顺序无关', () => {
    const late = state('南港', 5, derived), early = state('北塔', 2, derived)
    expect(values([late, early], 9)).toEqual(['南港'])
    expect(values([early, late], 4)).toEqual(['北塔'])
  })

  it.each([['作者', author], ['采用', adopted]] as const)('同章同键时%s优先于后写入的派生节点', (_name, provenance) => {
    const decided = state('作者定的', 4, provenance), machine = state('模型推的', 4, derived)
    expect(machine.seq).toBeGreaterThan(decided.seq)
    expect(values([decided, machine], 5)).toEqual(['作者定的'])
  })

  it('同章同来历时后写入的优先', () => {
    expect(values([state('第一次', 4, author), state('第二次', 4, author)], 4)).toEqual(['第二次'])
    expect(values([state('基线', 4, legacy), state('重跑定稿', 4, derived)], 5)).toEqual(['重跑定稿'])
  })

  it('清除后结果里没有这个字段，也不回退到更早的值', () => {
    const nodes = [state('北塔', 2, author), state('', 4, author)]
    expect(values(nodes, 3)).toEqual(['北塔'])
    expect(values(nodes, 5)).toEqual([])
  })

  it('基线节点可作为起点，被之后的节点覆盖', () => {
    const nodes = [state('基线值', 0, legacy), state('后来的', 3, derived)]
    expect(values(nodes, 1)).toEqual(['基线值'])
    expect(values(nodes, 4)).toEqual(['后来的'])
  })

  it('按角色筛选，不传时返回全部', () => {
    const nodes = [state('甲地', 1, author, '甲'), state('丙地', 1, author, '丙')]
    expect(values(nodes, 2, ['丙'])).toEqual(['丙地'])
    expect(values(nodes, 2)).toHaveLength(2)
  })

  it('同一对角色的两条基线关系都保留并标冲突', () => {
    const result = latestNodesBefore([relation('一', '结盟', 3, legacy, 0), relation('二', '死敌', 3, legacy, 0)], 4)
    expect(result.relations).toHaveLength(1)
    expect(result.relations[0]).toMatchObject({ subjectId: '甲', targetId: '乙', conflict: true })
    expect(result.relations[0].lines.map(line => line.value).sort()).toEqual(['死敌', '结盟'].sort())
  })

  it('删掉一条后另一条还在，冲突解除', () => {
    const result = latestNodesBefore([relation('一', '结盟', 3, legacy, 0), relation('二', '死敌', 3, legacy, 0), relation('一', '', 5)], 6)
    expect(result.relations).toHaveLength(1)
    expect(result.relations[0].conflict).toBe(false)
    expect(result.relations[0].lines.map(line => line.value)).toEqual(['死敌'])
  })

  it('一对角色的关系全部删除后这一对不再出现，删除前的章仍能读到', () => {
    const nodes = [relation('一', '结盟', 1), relation('一', '', 4)]
    expect(latestNodesBefore(nodes, 5).relations).toEqual([])
    expect(latestNodesBefore(nodes, 3).relations[0].lines[0].value).toBe('结盟')
  })
})

describe('characterTimeline', () => {
  const rows = (nodes: Parameters<typeof characterTimeline>[0]) =>
    characterTimeline(nodes).map(group => [group.chapter, group.changes.map(change => [change.node.aspect, change.value, change.source, change.removed])])

  it('按章倒序，来历分作者设定、定稿记录、升级前已有三种', () => {
    expect(rows([state('旧站', 0, legacy), state('北塔', 2, derived), state('南港', 5, author), state('码头', 7, adopted)])).toEqual([
      [7, [['location', '码头', 'author', false]]],
      [5, [['location', '南港', 'author', false]]],
      [2, [['location', '北塔', 'finalized', false]]],
      [0, [['location', '旧站', 'legacy', false]]],
    ])
  })

  it('同一章同一字段连改几次只留最终生效的一条，作者优先于派生', () => {
    expect(rows([state('初稿', 3, author), state('定稿', 3, author)])).toEqual([[3, [['location', '定稿', 'author', false]]]])
    expect(rows([state('作者值', 3, author), state('派生值', 3, derived)])).toEqual([[3, [['location', '作者值', 'author', false]]]])
  })

  it('解除关系带出被解除的那一条，清除字段标为已去掉，都不是空白', () => {
    const changes = characterTimeline([relation('r1', '盟友', 1), relation('r1', '', 4), state('北塔', 1, author), state('', 4, author)])
    expect(changes.find(group => group.chapter === 4)!.changes.map(change => [change.node.aspect, change.removed, change.value])).toEqual([
      ['location', true, '北塔'],
      ['relation', true, '盟友'],
    ])
  })

  it('同一对角色的多条关系各占一行', () => {
    const [group] = characterTimeline([relation('r1', '盟友', 2), relation('r2', '死敌', 2)])
    expect(group.changes.map(change => change.value).sort()).toEqual(['死敌', '盟友'])
  })

  it('没有节点时没有分组', () => {
    expect(characterTimeline([])).toEqual([])
  })
})

describe('resolveStateEffectiveChapter', () => {
  const range = { next: 6, last: 40 }
  it.each([[1, 1], [6, 6], [40, 40]])('范围内的章号 %s 照用', (requested, expected) => {
    expect(resolveStateEffectiveChapter(requested, range)).toBe(expected)
  })
  it.each([[undefined], [0], [-3], [1.5], [41], ['7'], [Number.NaN], [null]])('%s 不合法，退回下一章', requested => {
    expect(resolveStateEffectiveChapter(requested, range)).toBe(6)
  })
})
