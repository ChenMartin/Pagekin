import { RERANK_CANDIDATE_COUNT, type KnowledgeRanking, type KnowledgeRankingFallback, type RerankFailure } from '../src/shared/knowledge-ranking'
import type { RerankConfig, RerankEndpoint } from '../src/shared/rerank-config'

const RERANK_TIMEOUT_MS = 10_000

class RerankError extends Error {
  constructor(readonly reason: RerankFailure) {
    super(`RERANK_${reason}`)
  }
}

function rerankUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return base.endsWith('/rerank') ? base : `${base}/rerank`
}

/** Jina/Cohere 兼容的 results[].{index, relevance_score}，按分数从高到低返回候选下标。 */
function parseOrder(body: unknown, documentCount: number, topN: number): number[] {
  const results = (body as { results?: unknown } | null)?.results
  if (!Array.isArray(results) || results.length !== topN) throw new RerankError('invalid-response')
  const seen = new Set<number>()
  const scored = results.map((result: { index?: unknown; relevance_score?: unknown } | null) => {
    const index = result?.index, score = result?.relevance_score
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= documentCount || seen.has(index)
      || typeof score !== 'number' || !Number.isFinite(score)) throw new RerankError('invalid-response')
    seen.add(index)
    return { index, score }
  })
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.index)
}

const isTimeout = (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError'

async function requestOrder(query: string, documents: string[], endpoint: RerankEndpoint, topN: number): Promise<number[]> {
  let body: unknown
  try {
    const response = await fetch(rerankUrl(endpoint.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}) },
      body: JSON.stringify({ model: endpoint.modelName, query, documents, top_n: topN }),
      // 跳转后的主机作者没有确认过，Key 不能跟过去。
      redirect: 'error',
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    })
    if (!response.ok) throw new RerankError('http-error')
    body = await response.json().catch((error: unknown) => { throw isTimeout(error) ? error : new RerankError('invalid-response') })
  } catch (error) {
    if (error instanceof RerankError) throw error
    throw new RerankError(isTimeout(error) ? 'timeout' : 'request-failed')
  }
  return parseOrder(body, documents.length, topN)
}

export function rerankRecallCount(config: RerankConfig, limit: number): number {
  return config.kind !== 'none' && limit >= 1 && limit <= RERANK_CANDIDATE_COUNT ? RERANK_CANDIDATE_COUNT : limit
}

export async function rankPassages<T extends { text: string }>(query: string, candidates: readonly T[], config: RerankConfig, limit: number):
  Promise<{ items: T[]; ranking: KnowledgeRanking }> {
  const original = (reason: KnowledgeRankingFallback) =>
    ({ items: candidates.slice(0, limit), ranking: { method: 'original', candidateCount: candidates.length, reason } as const })
  if (config.kind === 'none') return original(config.reason)
  if (limit > RERANK_CANDIDATE_COUNT) return original('top-k-exceeds-candidates')
  if (!candidates.length || limit < 1) return original('no-candidates')
  try {
    const order = await requestOrder(query, candidates.map(item => item.text), config.endpoint, Math.min(limit, candidates.length))
    return { items: order.map(index => candidates[index]!), ranking: { method: 'rerank', candidateCount: candidates.length } }
  } catch (error) {
    if (!(error instanceof RerankError)) throw error
    console.warn(`[AI Novel Rerank] 重排未生效，按原顺序取材：${error.reason}（候选 ${candidates.length} 段）`)
    return original(error.reason)
  }
}
