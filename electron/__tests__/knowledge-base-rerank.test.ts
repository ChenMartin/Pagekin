import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openCanonicalProjectFixture } from '../../test/helpers/canonical-project-fixture'
import { closeProjectDatabase } from '../database'
import { captureWritingKnowledgeSnapshot, importText, listDocuments, readDocumentCopy, saveDocumentCopy } from '../knowledge-base'
import { captureGenerationKnowledge, verifyGenerationKnowledge } from '../services/generation-knowledge-source'
import { getProjectDataRoot } from '../services/project-data-locator'
import { closeConnection, getConnection } from '../vector-store'
import { resolveRerankConfig, type RerankConfig } from '../../src/shared/rerank-config'

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

  // 默认关闭自动复用的原因见 src/shared/rerank-config.ts 的 AUTO_REUSE_EMBEDDING（#632）。
  it('keeps the same five passages without a rerank request when only a SiliconFlow retrieval profile is saved', async () => {
    const expected = await masterTopFive()
    const config = resolveRerankConfig({ defaultRerankModelId: undefined, models: [], embedding: { ...MODEL, apiKey: 'sk-fake-embedding' } })
    const snapshot = await captureWritingKnowledgeSnapshot('潮位', projectPath, null, [], config)

    expect(fetchMock).not.toHaveBeenCalled()
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

  it('recalls at most 40 candidates for the reranker', async () => {
    const extra = Array.from({ length: 38 }, (_, index) => `第${index + 8}段：潮位表又添一行。${'记'.repeat(300)}`).join('\n\n')
    await expect(importText(extra, '补充.md', projectPath, 'openai', MODEL, { mode: 'fts-only' })).resolves.toMatchObject({ success: true, chunkCount: 38 })
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const { top_n } = JSON.parse(String(init.body)) as { top_n: number }
      return new Response(JSON.stringify({ results: Array.from({ length: top_n }, (_, index) => ({ index, relevance_score: 1 - index / 10 })) }))
    })
    const snapshot = await captureWritingKnowledgeSnapshot('潮位', projectPath, null, [], RERANK)

    expect((JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as { documents: string[] }).documents).toHaveLength(40)
    expect(snapshot.ranking).toEqual({ method: 'rerank', candidateCount: 40 })
    expect(snapshot.items).toHaveLength(5)
  })

  it('freezes the reranked five even when a candidate the reranker dropped belongs to a damaged document', async () => {
    const damaged = await importText(`残卷：潮位表的旧抄本。${'旧'.repeat(700)}`, '残卷.md', projectPath, 'openai', MODEL, { mode: 'fts-only' })
    const chunks = await (await getConnection(projectPath)).openTable('chunks')
    await chunks.delete(`\`docId\` = '${damaged.docId}' AND \`chunkIndex\` = 1`)
    chunks.close()
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const { documents, top_n } = JSON.parse(String(init.body)) as { documents: string[]; top_n: number }
      const scored = documents.map((text, index) => ({ index, relevance_score: Number(/第(\d+)段/u.exec(text)?.[1] ?? 0) }))
      return new Response(JSON.stringify({ results: scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, top_n) }))
    })
    const snapshot = await captureWritingKnowledgeSnapshot('潮位', projectPath, null, [], RERANK)

    expect(snapshot.ranking).toEqual({ method: 'rerank', candidateCount: 8 })
    expect(snapshot.items.map(item => item.text)).toEqual([7, 6, 5, 4, 3].map(n => PASSAGES[n - 1]))
    await expect(verifyGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), snapshot })).resolves.toBeUndefined()
  })

  it('takes the original five from the new source when the knowledge base changes during the rerank request', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      await importText('第99段：潮位表被人改过。', '第99章.md', projectPath, 'openai', MODEL, { mode: 'fts-only' })
      const { top_n } = JSON.parse(String(init.body)) as { top_n: number }
      return new Response(JSON.stringify({ results: Array.from({ length: top_n }, (_, index) => ({ index, relevance_score: 1 - index / 10 })) }))
    })
    const snapshot = await captureWritingKnowledgeSnapshot('潮位', projectPath, null, [], RERANK)
    const expected = await masterTopFive()

    expect(snapshot.ranking).toEqual({ method: 'original', candidateCount: expected.length, reason: 'source-changed' })
    expect(snapshot.items.map(item => item.chunkId)).toEqual(expected.map(item => item.chunkId))
    await expect(verifyGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), snapshot })).resolves.toBeUndefined()
  })

  it('takes the original five when the author saves a selected document copy during the rerank request', async () => {
    const top = (await listDocuments(projectPath)).find(doc => doc.fileName === '第7章.md')!
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const opened = await readDocumentCopy(top.id, projectPath)
      await expect(saveDocumentCopy(top.id, '第7段：潮位表被作者改写。', opened.contentHash!, projectPath)).resolves.toEqual({ success: true })
      const { documents, top_n } = JSON.parse(String(init.body)) as { documents: string[]; top_n: number }
      const scored = documents.map((text, index) => ({ index, relevance_score: Number(/第(\d+)段/u.exec(text)![1]) }))
      return new Response(JSON.stringify({ results: scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, top_n) }))
    })
    const snapshot = await captureWritingKnowledgeSnapshot('潮位', projectPath, null, [], RERANK)
    const expected = await masterTopFive()

    expect(snapshot.ranking).toEqual({ method: 'original', candidateCount: 5, reason: 'source-changed' })
    expect(snapshot.items.map(item => [item.rank, item.chunkId])).toEqual(expected.map((item, index) => [index + 1, item.chunkId]))
    expect(snapshot.items.map(item => item.documentId)).not.toContain(top.id)
    await expect(verifyGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), snapshot })).resolves.toBeUndefined()
  })

  it('still fails when the reranker selects a passage from a damaged document', async () => {
    const damaged = await importText(`残卷：潮位表的旧抄本。${'旧'.repeat(700)}`, '残卷.md', projectPath, 'openai', MODEL, { mode: 'fts-only' })
    const chunks = await (await getConnection(projectPath)).openTable('chunks')
    await chunks.delete(`\`docId\` = '${damaged.docId}' AND \`chunkIndex\` = 1`)
    chunks.close()
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const { documents, top_n } = JSON.parse(String(init.body)) as { documents: string[]; top_n: number }
      const scored = documents.map((text, index) => ({ index, relevance_score: Number(/第(\d+)段/u.exec(text)?.[1] ?? 100) }))
      return new Response(JSON.stringify({ results: scored.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, top_n) }))
    })

    await expect(captureWritingKnowledgeSnapshot('潮位 涨潮', projectPath, null, [], RERANK)).rejects.toThrow('GENERATION_KNOWLEDGE_DOCUMENT_INCOMPLETE')
    expect((await captureGenerationKnowledge({ projectStorageRoot: getProjectDataRoot(projectPath), query: '潮位 涨潮' })).items).toHaveLength(5)
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
