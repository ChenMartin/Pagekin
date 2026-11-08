import type { CharacterStateTextField } from './character-roster'
import type { FinalizedCharacterEvidence, FinalizedSourceIdentity } from './finalized-continuity'

/** 节点的来历，与 character_continuity_events.provenance_json 的 kind 一一对应。 */
export type ContinuityProvenance =
  | { kind: 'author'; operationId: string }
  | { kind: 'derived'; source: FinalizedSourceIdentity }
  | { kind: 'adopted'; operationId: string; source?: FinalizedSourceIdentity }
  | { kind: 'legacy' }

interface ContinuityNodeBase {
  eventId: string
  subjectId: string
  subjectName: string
  /** 空串表示已清除。 */
  value: string
  effectiveChapter: number
  provenance: ContinuityProvenance
  draftId: number | null
  /** 同一系列内的写入次序。基线节点没有记录，按 0 算。 */
  seq: number
  quote: FinalizedCharacterEvidence | null
}
export interface CharacterStateNode extends ContinuityNodeBase { aspect: CharacterStateTextField }
export interface CharacterRelationNode extends ContinuityNodeBase {
  aspect: 'relation'
  targetId: string
  targetName: string
  relationshipId: string
}
export type ContinuityNode = CharacterStateNode | CharacterRelationNode

/** 同一对角色在某一章仍然有效的全部关系。多于一条时 conflict 为真，交给读者判断，不替作者选。 */
export interface CharacterRelationPair {
  subjectId: string
  targetId: string
  lines: CharacterRelationNode[]
  conflict: boolean
}
export interface LatestContinuityNodes {
  states: CharacterStateNode[]
  relations: CharacterRelationPair[]
}

const authorDecided = (provenance: ContinuityProvenance) => provenance.kind === 'author' || provenance.kind === 'adopted'

/** 作者定的值「自第 N 章起」生效；派生值和基线是第 N 章写完后的状态，重写第 N 章时还不存在。 */
const visibleWhileWriting = (node: ContinuityNode, chapter: number) =>
  authorDecided(node.provenance) ? node.effectiveChapter <= chapter : node.effectiveChapter < chapter

function newer(candidate: ContinuityNode, current: ContinuityNode): boolean {
  if (candidate.effectiveChapter !== current.effectiveChapter) return candidate.effectiveChapter > current.effectiveChapter
  const [left, right] = [authorDecided(candidate.provenance), authorDecided(current.provenance)]
  return left !== right ? left : candidate.seq > current.seq
}

/** 状态每角色每字段一个系列；关系每一行一个系列，同一对角色的多行互不覆盖。 */
const seriesKey = (node: ContinuityNode) =>
  node.aspect === 'relation' ? `relation:${node.relationshipId}` : `state:${JSON.stringify([node.subjectId, node.aspect])}`

/**
 * 写第 chapter 章时已经生效的最新节点。传 Infinity 得到当前值。
 * nodes 应来自只含有效节点的读取（派生节点的稿仍是定稿，见 ADR-0024、ADR-0025）。
 */
export function latestNodesBefore(nodes: readonly ContinuityNode[], chapter: number, ids?: readonly string[]): LatestContinuityNodes {
  const wanted = ids && new Set(ids)
  const latest = new Map<string, ContinuityNode>()
  for (const node of nodes) {
    if (wanted && !wanted.has(node.subjectId) || !visibleWhileWriting(node, chapter)) continue
    const key = seriesKey(node), current = latest.get(key)
    if (!current || newer(node, current)) latest.set(key, node)
  }
  const states: CharacterStateNode[] = []
  const pairs = new Map<string, CharacterRelationPair>()
  for (const node of latest.values()) {
    if (node.value === '') continue
    if (node.aspect !== 'relation') { states.push(node); continue }
    const key = JSON.stringify([node.subjectId, node.targetId])
    const pair = pairs.get(key) ?? { subjectId: node.subjectId, targetId: node.targetId, lines: [], conflict: false }
    pair.lines.push(node)
    pair.conflict = pair.lines.length > 1
    pairs.set(key, pair)
  }
  return { states, relations: [...pairs.values()] }
}
