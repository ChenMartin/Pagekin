import { BUILTIN_PRESETS } from './provider-presets'

export interface RerankEndpoint {
  baseUrl: string
  apiKey: string
  modelName: string
}

export type RerankUnavailableReason =
  | 'not-configured'
  | 'embedding-not-siliconflow'
  | 'auto-reuse-not-enabled'
  | 'profile-missing'
  | 'profile-not-rerank'

export type RerankConfig =
  | { kind: 'none'; reason: RerankUnavailableReason }
  | { kind: 'explicit'; profileId: string; endpoint: RerankEndpoint }
  | { kind: 'reuse-embedding'; endpoint: RerankEndpoint }

interface StoredProfile {
  id: string
  purposes?: readonly string[]
  modelName?: string
  baseUrl?: string
  apiKey?: string
}

interface EmbeddingEndpoint {
  provider: string
  baseUrl: string
  apiKey: string
}

export interface RerankConfigInput {
  defaultRerankModelId: unknown
  models: readonly StoredProfile[]
  embedding: EmbeddingEndpoint | null
  autoReuseEmbedding?: boolean
}

// 参考评估没证明重排能提升写作质量（#632），暂不自动借检索档案重排；正式评估通过后再改为 true。
const AUTO_REUSE_EMBEDDING = false

const SILICONFLOW = BUILTIN_PRESETS.find(preset => preset.provider === 'siliconflow')!
const SILICONFLOW_HOSTS = new Set([SILICONFLOW.baseUrl, ...(SILICONFLOW.budgetCapabilityBaseUrls ?? [])].map(url => new URL(url).hostname))

function parseUrl(url: string): URL | null {
  try {
    return new URL(url.trim())
  } catch {
    return null
  }
}

// 只看 provider 不够：作者可能把硅基流动档案的地址改成了代理、http 或别的端口，Key 不能跟着去那里。
// URL 会把 https 的 :443 规范成空端口。
function isSiliconflowEndpoint(embedding: EmbeddingEndpoint): boolean {
  const url = parseUrl(embedding.baseUrl)
  return embedding.provider === SILICONFLOW.provider
    && url?.protocol === 'https:'
    && url.port === ''
    && SILICONFLOW_HOSTS.has(url.hostname)
}

/** 显式选了重排档案就只用它；否则只有硅基流动检索档案可以把同一端点和 Key 借给重排。 */
export function resolveRerankConfig({ defaultRerankModelId, models, embedding, autoReuseEmbedding = AUTO_REUSE_EMBEDDING }: RerankConfigInput): RerankConfig {
  if (typeof defaultRerankModelId === 'string' && defaultRerankModelId) {
    const profile = models.find(model => model.id === defaultRerankModelId)
    if (!profile) return { kind: 'none', reason: 'profile-missing' }
    if (!profile.purposes?.includes('rerank')) return { kind: 'none', reason: 'profile-not-rerank' }
    return {
      kind: 'explicit',
      profileId: profile.id,
      endpoint: { baseUrl: profile.baseUrl ?? '', apiKey: profile.apiKey ?? '', modelName: profile.modelName ?? '' },
    }
  }
  if (!embedding) return { kind: 'none', reason: 'not-configured' }
  if (!isSiliconflowEndpoint(embedding)) return { kind: 'none', reason: 'embedding-not-siliconflow' }
  if (!autoReuseEmbedding) return { kind: 'none', reason: 'auto-reuse-not-enabled' }
  return {
    kind: 'reuse-embedding',
    endpoint: { baseUrl: embedding.baseUrl, apiKey: embedding.apiKey, modelName: SILICONFLOW.rerankModels![0]! },
  }
}
