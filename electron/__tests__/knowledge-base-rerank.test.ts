import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'
import { closeProjectDatabase } from '../database'
import { captureWritingKnowledgeSnapshot, importText } from '../knowledge-base'
import { captureGenerationKnowledge, verifyGenerationKnowledge } from '../services/generation-knowledge-source'
import { getProjectDataRoot } from '../services/project-data-locator'
import { closeConnection } from '../vector-store'
import type { RerankConfig } from '../../src/shared/rerank-config'

const MODEL = { provider: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '', modelName: 'BAAI/bge-m3' }
const RERANK: RerankConfig = {
  kind: 'explicit', profileId: 'rerank',
  endpoint: { baseUrl: 'https://rerank.example/v1', apiKey: 'sk-fake-rerank', modelName: 'my-reranker' },
}
const PASSAGES = Array.from({ length: 7 }, (_, index) => `第${index + 1}段：林岚在旧港核对潮位表，记下第${index + 1}次涨潮。`)

let projectPath = ''
const fetchMock = vi.fn()

beforeAll(() => { fs.mkdirSync(path.resolve('.runtime/.cache'), { recursive: true }) })

beforeEach(async () => {
  projectPath = fs.mkdtempSync(path.join(path.resolve('.runtime/.cache'), 'ai-novel-kb-rerank-'))
  openCanonicalProjectFixture(projectPath)
  for (const [index, text] of PASSAGES.entries()) {
    await expect(importText(text, `第${index + 1}章.md`, projectPath, 'openai', MODEL, { mode: 'fts-only' })).resolves.toMatchObject({ success: true })
  }
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  closeProjectDatabase()
  closeConnection(projectPath)
  fs.rmSync(projectPath, { recursive: true, force: true })
})

const masterTopFive = async () => (await captureGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), query: '潮位' })).items

describe('writing knowledge snapshot ranking', () => {
  it('keeps the same five passages in the same order when rerank is not configured', async () => {
    const expected = await masterTopFive()
    const snapshot = await captureWritingKnowledgeSnapshot('潮位', projectPath, null, [], { kind: 'none', reason: 'not-configured' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(snapshot).toMatchObject({ version: 1, topK: 5, state: 'stored' })
    expect(snapshot.items.map(item => item.chunkId)).toEqual(expected.map(item => item.chunkId))
    snapshot.items.forEach((item, index) => expect(item).toMatchObject(expected[index]!))
  })

  it('reranks 40 recalled candidates outside the source gate and freezes the final five with their ranks', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const { documents, top_n } = JSON.parse(String(init.body)) as { documents: string[]; top_n: number }
      const scored = documents.map((text, index) => ({ index, relevance_score: Number(/第(\d+)段/u.exec(text)![1]) }))
      return new Response(JSON.stringify({ results: scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, top_n) }))
    })
    const snapshot = await captureWritingKnowledgeSnapshot('潮位', projectPath, null, [], RERANK)

    const [, init] = fetchMock.mock.calls[0]!
    expect([...(JSON.parse(String(init.body)) as { documents: string[] }).documents].sort()).toEqual([...PASSAGES].sort())
    expect(snapshot).toMatchObject({ version: 1, topK: 5, state: 'stored', ranking: { method: 'rerank', candidateCount: 7 } })
    expect(snapshot.items.map(item => [item.rank, item.text])).toEqual([7, 6, 5, 4, 3].map((n, index) => [index + 1, PASSAGES[n - 1]]))
    await expect(verifyGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), snapshot })).resolves.toBeUndefined()
  })

  it('falls back to the original five when the rerank request fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }))
    const expected = await masterTopFive()
    const snapshot = await captureWritingKnowledgeSnapshot('潮位', projectPath, null, [], RERANK)

    expect(snapshot.ranking).toEqual({ method: 'original', candidateCount: 7, reason: 'http-error' })
    expect(snapshot.items.map(item => [item.rank, item.chunkId])).toEqual(expected.map((item, index) => [index + 1, item.chunkId]))
    await expect(verifyGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), snapshot })).resolves.toBeUndefined()
  })

  it('rejects a frozen snapshot whose ranks do not match the item order', async () => {
    const snapshot = await captureWritingKnowledgeSnapshot('潮位', projectPath, null, [], { kind: 'none', reason: 'not-configured' })
    const [first, second, ...rest] = snapshot.items
    const swapped = { ...snapshot, items: [{ ...second!, rank: 1 }, { ...first!, rank: 1 }, ...rest] }

    await expect(verifyGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), snapshot: swapped }))
      .rejects.toThrow('GENERATION_KNOWLEDGE_INVALID_SNAPSHOT')
  })

  it('still verifies a snapshot frozen before items carried ranks', async () => {
    const legacy = await captureGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), query: '潮位', topK: 5 })
    await expect(verifyGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), snapshot: legacy })).resolves.toBeUndefined()
  })
})
