import type { RerankUnavailableReason } from './rerank-config'

/** 产品判断第 9 条：召回 40 段，写稿取 5 段，固定不做配置项。 */
export const RERANK_CANDIDATE_COUNT = 40
export const WRITING_KNOWLEDGE_COUNT = 5

export type RerankFailure = 'timeout' | 'request-failed' | 'http-error' | 'invalid-response'

export type KnowledgeRankingFallback =
  | RerankUnavailableReason
  | RerankFailure
  | 'no-candidates'
  | 'top-k-exceeds-candidates'

/** 一次检索的排序方式。不记端点和 Key。 */
export type KnowledgeRanking =
  | { method: 'rerank'; candidateCount: number }
  | { method: 'original'; candidateCount: number; reason: KnowledgeRankingFallback }
