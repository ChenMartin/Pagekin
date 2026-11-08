import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rankPassages } from '../rerank'
import type { RerankConfig } from '../../src/shared/rerank-config'

const passages = ['甲', '乙', '丙', '丁', '戊', '己', '庚'].map(text => ({ text, id: text }))
const explicit: RerankConfig = {
  kind: 'explicit', profileId: 'rerank',
  endpoint: { baseUrl: 'https://rerank.example/v1/', apiKey: 'sk-fake-rerank', modelName: 'my-reranker' },
}
const reuse: RerankConfig = {
  kind: 'reuse-embedding',
  endpoint: { baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-fake-embedding', modelName: 'BAAI/bge-reranker-v2-m3' },
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const results = (pairs: [number, number][]) => ({ results: pairs.map(([index, relevance_score]) => ({ index, relevance_score })) })

function stubFetch(response: () => Response | Promise<Response>) {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => response())
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const servers: Server[] = []
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = []
  const server = createServer((req, res) => { hits.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`); handler(req, res) })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, hits }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

describe('rankPassages', () => {
  it('sends no rerank request when rerank is not configured and keeps the original order', async () => {
    const fetchMock = stubFetch(() => json(results([])))
    const ranked = await rankPassages('查询', passages, { kind: 'none', reason: 'not-configured' }, 5)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ranked).toEqual({ items: passages.slice(0, 5), ranking: { method: 'original', candidateCount: 7, reason: 'not-configured' } })
  })

  it('sends the query and every candidate only to the resolved endpoint with its own key and orders by relevance', async () => {
    const fetchMock = stubFetch(() => json(results([[6, 0.2], [2, 0.9], [0, 0.5], [4, 0.1], [3, 0.7]])))
    const ranked = await rankPassages('查询', passages, explicit, 5)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://rerank.example/v1/rerank')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-fake-rerank')
    expect(JSON.parse(String(init.body))).toEqual({ model: 'my-reranker', query: '查询', documents: passages.map(item => item.text), top_n: 5 })
    expect(ranked).toEqual({ items: ['丙', '丁', '甲', '庚', '戊'].map(text => ({ text, id: text })), ranking: { method: 'rerank', candidateCount: 7 } })
  })

  it('reuses the SiliconFlow retrieval endpoint and key for the default rerank model', async () => {
    const fetchMock = stubFetch(() => json(results([[1, 0.9], [0, 0.1]])))
    await rankPassages('查询', passages.slice(0, 2), reuse, 5)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.siliconflow.cn/v1/rerank')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-fake-embedding')
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'BAAI/bge-reranker-v2-m3', top_n: 2 })
  })

  it('sends no authorization header to a keyless local rerank service', async () => {
    const fetchMock = stubFetch(() => json(results([[0, 0.9]])))
    await rankPassages('查询', passages.slice(0, 1), { ...explicit, endpoint: { ...explicit.endpoint, baseUrl: 'http://127.0.0.1:8080/v1/rerank', apiKey: '' } }, 5)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:8080/v1/rerank')
    expect(new Headers(init.headers).has('authorization')).toBe(false)
  })

  it.each([
    ['an index out of range', () => json(results([[0, 0.9], [7, 0.8], [1, 0.7], [2, 0.6], [3, 0.5]])), 'invalid-response'],
    ['a duplicated index', () => json(results([[0, 0.9], [0, 0.8], [1, 0.7], [2, 0.6], [3, 0.5]])), 'invalid-response'],
    ['a non-finite score', () => new Response('{"results":[{"index":0,"relevance_score":1e999},{"index":1,"relevance_score":0.5},{"index":2,"relevance_score":0.4},{"index":3,"relevance_score":0.3},{"index":4,"relevance_score":0.2}]}'), 'invalid-response'],
    ['a string score', () => json({ results: [0, 1, 2, 3, 4].map(index => ({ index, relevance_score: '0.5' })) }), 'invalid-response'],
    ['fewer results than requested', () => json(results([[0, 0.9], [1, 0.8]])), 'invalid-response'],
    ['a body without results', () => json({ data: [] }), 'invalid-response'],
    ['a body that is not JSON', () => new Response('<html>'), 'invalid-response'],
    ['an HTTP error', () => json({ message: 'bad key' }, 401), 'http-error'],
    ['a deadline that expired', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 'timeout'],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed')), 'request-failed'],
  ])('falls back to the original order and logs only the reason for %s', async (_name, response, reason) => {
    stubFetch(response)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ranked = await rankPassages('秘密查询', passages, explicit, 5)

    expect(ranked).toEqual({ items: passages.slice(0, 5), ranking: { method: 'original', candidateCount: 7, reason } })
    expect(warn).toHaveBeenCalledTimes(1)
    const line = warn.mock.calls[0]!.join(' ')
    expect(line).toContain(reason)
    for (const secret of ['sk-fake-rerank', 'rerank.example', '秘密查询', '甲']) expect(line).not.toContain(secret)
  })

  it('does not follow a redirect, so the key never reaches the redirect target', async () => {
    const target = await listen((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(results([[1, 0.9], [0, 0.1]]))) })
    const configured = await listen((_req, res) => { res.writeHead(302, { Location: `${target.url}/v1/rerank` }); res.end() })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const ranked = await rankPassages('查询', passages.slice(0, 2), { ...explicit, endpoint: { ...explicit.endpoint, baseUrl: `${configured.url}/v1` } }, 5)

    expect(configured.hits).toEqual(['POST /v1/rerank Bearer sk-fake-rerank'])
    expect(target.hits).toEqual([])
    expect(ranked.ranking).toEqual({ method: 'original', candidateCount: 2, reason: 'request-failed' })
  })

  it('sends nothing when there are no candidates', async () => {
    const fetchMock = stubFetch(() => json(results([])))
    expect(await rankPassages('查询', [], explicit, 5)).toEqual({ items: [], ranking: { method: 'original', candidateCount: 0, reason: 'no-candidates' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the original order without a request when the caller asks for more than the 40 candidates', async () => {
    const fetchMock = stubFetch(() => json(results([])))
    const ranked = await rankPassages('查询', passages, explicit, 41)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(ranked).toEqual({ items: passages, ranking: { method: 'original', candidateCount: 7, reason: 'top-k-exceeds-candidates' } })
  })
})
