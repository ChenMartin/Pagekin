import { describe, expect, it } from 'vitest'

import { resolveRerankConfig } from '../rerank-config'

const siliconflowEmbedding = { provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-fake-embedding' }
const explicitProfile = {
  id: 'rerank-1', purposes: ['rerank'], provider: 'custom', modelName: 'my-reranker',
  baseUrl: 'https://rerank.example/v1', apiKey: 'sk-fake-rerank',
}

describe('resolveRerankConfig', () => {
  it('does not rerank when nothing is configured', () => {
    expect(resolveRerankConfig({ defaultRerankModelId: undefined, models: [], embedding: null }))
      .toEqual({ kind: 'none', reason: 'not-configured' })
  })

  it('does not rerank when retrieval uses a provider other than SiliconFlow', () => {
    const embedding = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-fake-openai' }
    expect(resolveRerankConfig({ defaultRerankModelId: null, models: [], embedding }))
      .toEqual({ kind: 'none', reason: 'embedding-not-siliconflow' })
  })

  // 默认关闭自动复用的原因见 src/shared/rerank-config.ts 的 AUTO_REUSE_EMBEDDING（#632）。
  it('does not yet reuse the SiliconFlow retrieval profile for rerank by default', () => {
    expect(resolveRerankConfig({ defaultRerankModelId: null, models: [], embedding: siliconflowEmbedding }))
      .toEqual({ kind: 'none', reason: 'auto-reuse-not-enabled' })
  })

  it.each(['https://api.siliconflow.cn/v1', 'https://api.siliconflow.com/v1'])(
    'reuses the SiliconFlow retrieval endpoint and key at %s with the default rerank model',
    (baseUrl) => {
      const embedding = { ...siliconflowEmbedding, baseUrl }
      expect(resolveRerankConfig({ defaultRerankModelId: null, models: [], embedding, autoReuseEmbedding: true })).toEqual({
        kind: 'reuse-embedding',
        endpoint: { baseUrl, apiKey: 'sk-fake-embedding', modelName: 'BAAI/bge-reranker-v2-m3' },
      })
    },
  )

  it('never hands the retrieval key to another host when the profile still says SiliconFlow', () => {
    for (const baseUrl of ['https://proxy.example/v1', 'https://api.siliconflow.cn.evil.example/v1', 'not a url']) {
      expect(resolveRerankConfig({ defaultRerankModelId: null, models: [], embedding: { ...siliconflowEmbedding, baseUrl } }))
        .toEqual({ kind: 'none', reason: 'embedding-not-siliconflow' })
    }
  })

  it.each([
    'http://api.siliconflow.cn/v1',
    'https://api.siliconflow.cn:8443/v1',
    'https://api.siliconflow.com:80/v1',
  ])('never hands the retrieval key to the SiliconFlow host over a non-registered scheme or port: %s', (baseUrl) => {
    expect(resolveRerankConfig({ defaultRerankModelId: null, models: [], embedding: { ...siliconflowEmbedding, baseUrl } }))
      .toEqual({ kind: 'none', reason: 'embedding-not-siliconflow' })
  })

  it('still reuses the registered endpoint when the default port is written out', () => {
    const baseUrl = 'https://api.siliconflow.cn:443/v1'
    expect(resolveRerankConfig({ defaultRerankModelId: null, models: [], embedding: { ...siliconflowEmbedding, baseUrl }, autoReuseEmbedding: true }))
      .toEqual({ kind: 'reuse-embedding', endpoint: { baseUrl, apiKey: 'sk-fake-embedding', modelName: 'BAAI/bge-reranker-v2-m3' } })
  })

  it('does not reuse a SiliconFlow host saved under another provider', () => {
    expect(resolveRerankConfig({ defaultRerankModelId: null, models: [], embedding: { ...siliconflowEmbedding, provider: 'custom' } }))
      .toEqual({ kind: 'none', reason: 'embedding-not-siliconflow' })
  })

  it('uses only the explicit rerank profile endpoint and key, even beside a SiliconFlow retrieval model', () => {
    expect(resolveRerankConfig({ defaultRerankModelId: 'rerank-1', models: [explicitProfile], embedding: siliconflowEmbedding }))
      .toEqual({
        kind: 'explicit',
        profileId: 'rerank-1',
        endpoint: { baseUrl: 'https://rerank.example/v1', apiKey: 'sk-fake-rerank', modelName: 'my-reranker' },
      })
  })

  it('does not fall back to reuse when the explicit rerank profile is gone', () => {
    expect(resolveRerankConfig({ defaultRerankModelId: 'deleted', models: [explicitProfile], embedding: siliconflowEmbedding }))
      .toEqual({ kind: 'none', reason: 'profile-missing' })
  })

  it('does not rerank with an explicit profile that lacks the rerank purpose', () => {
    const legacy = { ...explicitProfile, purposes: undefined }
    const generation = { ...explicitProfile, purposes: ['generation'] }
    for (const profile of [legacy, generation]) {
      expect(resolveRerankConfig({ defaultRerankModelId: 'rerank-1', models: [profile], embedding: siliconflowEmbedding }))
        .toEqual({ kind: 'none', reason: 'profile-not-rerank' })
    }
  })

  it('treats a non-string stored id as no explicit choice', () => {
    expect(resolveRerankConfig({ defaultRerankModelId: 42, models: [explicitProfile], embedding: siliconflowEmbedding, autoReuseEmbedding: true }))
      .toMatchObject({ kind: 'reuse-embedding' })
  })
})
