import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenAIProvider } from '../openai-provider'
import type { LLMGenerateOptions } from '../provider.interface'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import samples from './provider-context-length-samples.json'

type IpcHandler = (...args: unknown[]) => Promise<unknown>
const ipc = vi.hoisted(() => new Map<string, IpcHandler>())

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN' },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => { ipc.set(channel, handler) } },
}))
vi.mock('../../utils/config-utils', () => ({
  MODELS_CONFIG_PATH: 'models.json',
  GLOBAL_CONFIG_PATH: 'config.json',
  DEFAULT_GLOBAL_CONFIG: { proxy: { enabled: false } },
  readJsonFile: (_path: string, fallback: unknown) => fallback,
  tryReadJsonFile: () => ({ status: 'missing' }),
  writeJsonFile: vi.fn(),
}))
vi.mock('../../database', () => ({ getCurrentProjectPath: () => null }))
vi.mock('../../repositories/llm-repository', () => ({ LLMHistoryRepository: { logCall: vi.fn() } }))
vi.mock('../../services/project-access', () => ({ projectAccess: { assertCurrentProjectContext: vi.fn() } }))

import { registerLLMController } from '../../controllers/llm-controller'

type OutputField = 'max_tokens' | 'max_completion_tokens'
interface WireRequest { url: string; headers: IncomingHttpHeaders; raw: string; body: Record<string, unknown> }
interface WireReply { status: number; body: string }

const servers: Server[] = []
let upstreamSerial = 0

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
    server.closeAllConnections()
    server.close(resolve)
  })))
})

async function upstream(reply: (request: WireRequest, index: number) => WireReply) {
  const requests: WireRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const request = { url: req.url ?? '', headers: req.headers, raw, body: JSON.parse(raw) as Record<string, unknown> }
      requests.push(request)
      const { status, body } = reply(request, requests.length - 1)
      res.writeHead(status, { 'Content-Type': status === 200 && request.body.stream ? 'text/event-stream' : 'application/json' })
      res.end(body)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { requests, baseUrl: `http://127.0.0.1:${port}/relay-${++upstreamSerial}/v1` }
}

const relayModel = (baseUrl: string, modelName = 'gpt-6.1'): ModelProfile => ({ id: 'relay', name: '中转站', provider: 'custom', protocol: 'openai',
  modelName, apiKey: 'sk-relay-key', baseUrl, temperature: 0.7, maxTokens: 4096, purposes: ['generation'] })

const other = (field: OutputField): OutputField => field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'

const fieldRejection = (field: OutputField) => JSON.stringify({ error: {
  message: `Unsupported parameter: '${field}' is not supported with this model. Use '${other(field)}' instead.`,
  type: 'invalid_request_error', param: field, code: 'unsupported_parameter' } })

function success(request: WireRequest): WireReply {
  return { status: 200, body: request.body.stream
    ? 'data: {"choices":[{"delta":{"content":"正文"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    : JSON.stringify({ choices: [{ message: { content: '正文' }, finish_reason: 'stop' }] }) }
}

const refusing = (field: OutputField) => (request: WireRequest): WireReply =>
  field in request.body ? { status: 400, body: fieldRejection(field) } : success(request)

const outputField = (request: WireRequest): OutputField[] =>
  (['max_tokens', 'max_completion_tokens'] as const).filter(field => field in request.body)

const messages = [{ role: 'user', content: '写正文' }]
const options = (extra: Partial<LLMGenerateOptions> = {}): LLMGenerateOptions => ({ temperature: 0.7, maxTokens: 512, ...extra })

async function stream(model: ModelProfile, extra: Partial<LLMGenerateOptions> = {}, signal = new AbortController().signal) {
  const onDone = vi.fn(), onError = vi.fn()
  await new OpenAIProvider().generateStream(model, messages, { ...options(extra), signal, visibleOnly: true, onChunk: vi.fn(), onDone, onError })
  return { onDone, onError }
}

describe('中转站拒收当前输出上限字段时换字段重发一次', () => {
  it('非流式：max_tokens 被拒后换 max_completion_tokens，作者拿到正文', async () => {
    const relay = await upstream(refusing('max_tokens'))
    const result = await new OpenAIProvider().generate(relayModel(relay.baseUrl), messages, options())
    expect(result).toMatchObject({ success: true, content: '正文' })
    expect(relay.requests.map(outputField)).toEqual([['max_tokens'], ['max_completion_tokens']])
    expect(relay.requests[1].body.max_completion_tokens).toBe(512)
  })

  it('流式：max_tokens 被拒后换 max_completion_tokens，作者看不到错误', async () => {
    const relay = await upstream(refusing('max_tokens'))
    const { onDone, onError } = await stream(relayModel(relay.baseUrl))
    expect(onError).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith('正文', undefined, 'stop')
    expect(relay.requests.map(outputField)).toEqual([['max_tokens'], ['max_completion_tokens']])
    expect(relay.requests[1].body.max_completion_tokens).toBe(512)
  })

  it('测试连接经真实 Provider 走同一条路，不再报这个 400', async () => {
    registerLLMController()
    const relay = await upstream(refusing('max_tokens'))
    await expect(ipc.get('llm:test-connection')!({}, relayModel(relay.baseUrl))).resolves.toEqual({ success: true, error: undefined })
    expect(relay.requests.map(outputField)).toEqual([['max_tokens'], ['max_completion_tokens']])
  })

  it('反方向：max_completion_tokens 被拒后换回 max_tokens', async () => {
    const relay = await upstream(refusing('max_completion_tokens'))
    const { onDone, onError } = await stream(relayModel(relay.baseUrl), { outputTokenParameter: 'max_completion_tokens' })
    expect(onError).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith('正文', undefined, 'stop')
    expect(relay.requests.map(outputField)).toEqual([['max_completion_tokens'], ['max_tokens']])
    expect(relay.requests[1].body.max_tokens).toBe(512)
  })

  it.each([
    ['只有 param 和文案，没有错误码', 'max_tokens', { message: 'max_tokens is not supported by this deployment', param: 'max_tokens', code: null }],
    ['没有 param，只有错误码和文案', 'max_tokens', { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: null, code: 'unsupported_parameter' }],
    ['未知参数写法', 'max_completion_tokens', { message: 'Unrecognized request argument supplied: max_completion_tokens', param: null, code: null }],
  ] as const)('错误体变体（%s）也算明确拒收', async (_name, field, error) => {
    const relay = await upstream(request => field in request.body ? { status: 400, body: JSON.stringify({ error }) } : success(request))
    const sent = field === 'max_tokens' ? {} : { outputTokenParameter: 'max_completion_tokens' as const }
    expect(await new OpenAIProvider().generate(relayModel(relay.baseUrl), messages, options(sent))).toMatchObject({ success: true })
    expect(relay.requests.map(outputField)).toEqual([[field], [other(field)]])
  })

  it('两个字段都被拒时只重发一次，报第二次的真实错误', async () => {
    const relay = await upstream(request => ({ status: 400, body: fieldRejection(outputField(request)[0]) }))
    const result = await new OpenAIProvider().generate(relayModel(relay.baseUrl), messages, options())
    expect(relay.requests.map(outputField)).toEqual([['max_tokens'], ['max_completion_tokens']])
    expect(result).toMatchObject({ success: false, error: 'LLM_REQUEST_FAILED',
      httpFailure: { status: 400, body: fieldRejection('max_completion_tokens') } })

    const streamed = await upstream(request => ({ status: 400, body: fieldRejection(outputField(request)[0]) }))
    const { onError } = await stream(relayModel(streamed.baseUrl))
    expect(streamed.requests).toHaveLength(2)
    expect(onError.mock.calls[0][0]).toBe('LLM_REQUEST_FAILED')
  })

  it('换字段后遇到别的错误，报第二次的错误且不记住这个字段', async () => {
    const quota = JSON.stringify({ error: { message: 'quota exceeded', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } })
    const relay = await upstream((request, index) => index === 0 ? refusing('max_tokens')(request) : { status: 429, body: quota })
    const model = relayModel(relay.baseUrl)
    expect(await new OpenAIProvider().generate(model, messages, options())).toMatchObject({ httpFailure: { status: 429, body: quota } })
    await new OpenAIProvider().generate(model, messages, options())
    expect(relay.requests.map(outputField)).toEqual([['max_tokens'], ['max_completion_tokens'], ['max_tokens']])
  })

  it('换字段成功后，同端点同模型不再先发必败请求；别的模型和别的端点照常试探', async () => {
    const relay = await upstream(refusing('max_tokens'))
    const model = relayModel(relay.baseUrl)
    await new OpenAIProvider().generate(model, messages, options())
    await new OpenAIProvider().generate(model, messages, options())
    await stream(model)
    expect(relay.requests.map(outputField)).toEqual([['max_tokens'], ['max_completion_tokens'], ['max_completion_tokens'], ['max_completion_tokens']])

    await new OpenAIProvider().generate(relayModel(relay.baseUrl, 'gpt-5.6'), messages, options())
    expect(relay.requests.slice(4).map(outputField)).toEqual([['max_tokens'], ['max_completion_tokens']])

    const elsewhere = await upstream(refusing('max_tokens'))
    await new OpenAIProvider().generate(relayModel(elsewhere.baseUrl), messages, options())
    expect(elsewhere.requests.map(outputField)).toEqual([['max_tokens'], ['max_completion_tokens']])
  })

  it('记住的字段之后被拒时，再换一次回来', async () => {
    let refused: OutputField = 'max_tokens'
    const relay = await upstream(request => refusing(refused)(request))
    const model = relayModel(relay.baseUrl)
    await new OpenAIProvider().generate(model, messages, options())
    refused = 'max_completion_tokens'
    expect(await new OpenAIProvider().generate(model, messages, options())).toMatchObject({ success: true })
    expect(relay.requests.map(outputField)).toEqual([['max_tokens'], ['max_completion_tokens'], ['max_completion_tokens'], ['max_tokens']])
  })

  it.each(['generate', 'stream'] as const)('%s：读完错误体后已取消，不发第二次并按取消报告', async mode => {
    const relay = await upstream(refusing('max_tokens'))
    const controller = new AbortController()
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const response = await realFetch(...args)
      const text = await response.text()
      controller.abort()
      return new Response(text, { status: response.status })
    })
    const model = relayModel(relay.baseUrl)
    if (mode === 'stream') {
      const { onError } = await stream(model, {}, controller.signal)
      expect(onError.mock.calls[0][0]).toBe('LLM_CANCELLED')
    } else {
      const result = await new OpenAIProvider().generate(model, messages, options({ signal: controller.signal }))
      expect(result).toMatchObject({ success: false, error: expect.stringContaining('AbortError') })
    }
    expect(relay.requests).toHaveLength(1)
  })

  it('第二次请求的地址和请求头与第一次相同，凭据只发往原端点', async () => {
    const relay = await upstream(refusing('max_tokens'))
    await new OpenAIProvider().generate(relayModel(relay.baseUrl), messages, options())
    const [first, second] = relay.requests
    expect(second.url).toMatch(/\/v1\/chat\/completions$/u)
    expect(second.url).toBe(first.url)
    expect(first.headers.authorization).toBe('Bearer sk-relay-key')
    const exceptBodyLength = (headers: IncomingHttpHeaders) => Object.entries(headers).filter(([name]) => name !== 'content-length')
    expect(exceptBodyLength(second.headers)).toEqual(exceptBodyLength(first.headers))
  })

  it('opencode Go 的会话标识在重发时不变', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => JSON.parse(String(init.body)).max_tokens !== undefined
      ? new Response(fieldRejection('max_tokens'), { status: 400 })
      : new Response(JSON.stringify({ choices: [{ message: { content: '正文' }, finish_reason: 'stop' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await new OpenAIProvider().generate({ ...relayModel('https://opencode.ai/zen/go/v1'), modelName: 'gpt-636-session' }, messages, options())
    const [[firstUrl, first], [secondUrl, second]] = fetchMock.mock.calls
    expect(secondUrl).toBe(firstUrl)
    expect((first.headers as Record<string, string>)['x-opencode-session']).toBeTruthy()
    expect(second.headers).toEqual(first.headers)
  })
})

describe('其他失败不重发，错误与原来相同', () => {
  const error = (fields: Record<string, unknown>) => JSON.stringify({ error: { type: 'invalid_request_error', param: null, code: null, ...fields } })
  const rejected400s: Array<[string, string]> = [
    ['模型名错误', error({ message: 'The model `gpt-6.1` does not exist', param: 'model', code: 'model_not_found' })],
    ['Key 错误', error({ message: 'Incorrect API key provided', code: 'invalid_api_key' })],
    ['内容过长', JSON.stringify(samples.deepseek)],
    ['其他参数不支持', error({ message: "Unsupported parameter: 'temperature' is not supported with this model.", param: 'temperature', code: 'unsupported_parameter' })],
    ['字段值过大', error({ message: 'max_tokens is too large: 100000. This model\'s maximum value is 4096.', param: 'max_tokens' })],
    ['字段值超范围', error({ message: "Invalid 'max_tokens': integer above maximum value. Expected a value <= 4096, but got 100000 instead.", param: 'max_tokens', code: 'integer_above_max_value' })],
    ['字段值非法', error({ message: 'Invalid value for max_tokens', param: 'max_tokens', code: 'invalid_value' })],
    ['字段的值不被支持', error({ message: 'Unsupported value for max_tokens: maximum is 4096', param: 'max_tokens', code: 'invalid_value' })],
    ['字段的值不被支持，没有错误码', error({ message: 'Unsupported value for max_tokens' })],
    ['错误码是值错误，文案笼统', error({ message: 'max_tokens is not supported', param: 'max_tokens', code: 'invalid_value' })],
    ['上游只把另一字段当作替代写法', error({ message: "Unsupported parameter: 'max_completion_tokens' is not supported. Use 'max_tokens' instead.", code: 'unsupported_parameter' })],
    ['错误体不是 JSON', '<html>bad request</html>'],
  ]

  it.each(rejected400s)('非流式 400（%s）只发一次，错误体原样返回', async (_name, body) => {
    const relay = await upstream(() => ({ status: 400, body }))
    const result = await new OpenAIProvider().generate(relayModel(relay.baseUrl), messages, options())
    expect(relay.requests).toHaveLength(1)
    expect(result).toEqual({ success: false, content: '', finishReason: 'error', error: 'LLM_REQUEST_FAILED', httpFailure: { status: 400, body } })
  })

  it.each(rejected400s)('流式 400（%s）只发一次', async (name, body) => {
    const relay = await upstream(() => ({ status: 400, body }))
    const { onError } = await stream(relayModel(relay.baseUrl))
    expect(relay.requests).toHaveLength(1)
    expect(onError.mock.calls[0][0]).toBe(name === '内容过长' ? 'LLM_CONTEXT_LENGTH_EXCEEDED' : 'LLM_REQUEST_FAILED')
  })

  it('错误体命中字段但状态不是 400 时不重发', async () => {
    const relay = await upstream(() => ({ status: 422, body: fieldRejection('max_tokens') }))
    expect(await new OpenAIProvider().generate(relayModel(relay.baseUrl), messages, options()))
      .toMatchObject({ httpFailure: { status: 422, body: fieldRejection('max_tokens') } })
    expect(relay.requests).toHaveLength(1)
  })

  it('错误体的字段不是当前发送的字段时不重发', async () => {
    const relay = await upstream(() => ({ status: 400, body: fieldRejection('max_completion_tokens') }))
    await new OpenAIProvider().generate(relayModel(relay.baseUrl), messages, options())
    expect(relay.requests).toHaveLength(1)
  })
})

describe('接受当前字段的端点，请求次数和请求体不变', () => {
  it('中转站接受 max_tokens：非流式一次请求，请求体逐字节不变', async () => {
    const relay = await upstream(success)
    await new OpenAIProvider().generate(relayModel(relay.baseUrl, 'gpt-4.1'), messages, options())
    expect(relay.requests.map(request => request.raw)).toEqual([
      '{"model":"gpt-4.1","messages":[{"role":"user","content":"写正文"}],"max_tokens":512,"stream":false,"temperature":0.7}',
    ])
  })

  it('中转站接受 max_tokens：流式一次请求，请求体逐字节不变', async () => {
    const relay = await upstream(success)
    await stream(relayModel(relay.baseUrl, 'gpt-4.1'))
    expect(relay.requests.map(request => request.raw)).toEqual([
      '{"model":"gpt-4.1","messages":[{"role":"user","content":"写正文"}],"max_tokens":512,"stream":true,"temperature":0.7,"stream_options":{"include_usage":true}}',
    ])
  })

  it('官方 api.openai.com：一次请求，字段和请求体逐字节不变', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '正文' }, finish_reason: 'stop' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await new OpenAIProvider().generate({ ...relayModel('https://api.openai.com/v1', 'o3'), provider: 'openai' }, messages,
      options({ outputTokenParameter: 'max_completion_tokens' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions')
    expect(fetchMock.mock.calls[0][1].body).toBe('{"model":"o3","messages":[{"role":"user","content":"写正文"}],"max_completion_tokens":512,"stream":false,"temperature":0.7}')
  })
})
