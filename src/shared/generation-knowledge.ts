import type { KnowledgeRanking } from './knowledge-ranking'

/** Main-issued source snapshot. No external paths, embedding credentials or endpoint metadata. */
export interface GenerationKnowledgeItem {
  revision: number
  chunkId: string; documentId: string; chunkIndex: number; text: string; fileName: string; score: number
  corpusKind: 'reference' | 'project-knowledge' | 'unknown'
  contentHash: string; documentChunkCount: number; documentChunkSetHash: string
  /** 最终排名，从 1 起，等于数组下标加 1，材料组装重排后仍能取回检索顺序。升级前冻结的快照没有这个字段。 */
  rank?: number
}
export interface GenerationKnowledgeSnapshot {
  version: 1
  state: 'empty' | 'stored'
  storageState: 'absent' | 'empty' | 'present'
  query: string; topK: number
  canonicalRevision: number | null; documentsRevision: number | null
  items: GenerationKnowledgeItem[]
  ranking?: KnowledgeRanking
}
