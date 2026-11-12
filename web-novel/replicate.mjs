import { readFileSync } from 'node:fs'
import { ApiError, object, string } from './input.mjs'

const defaultModels = {
  image: { model: 'black-forest-labs/flux-schnell', aspectField: 'aspect_ratio', defaults: { output_format: 'png', num_outputs: 1 } },
  video: { model: 'minimax/video-01' },
  speech: { model: 'minimax/speech-02-turbo', defaults: { voice_id: 'Wise_Woman', audio_format: 'mp3' } },
}
const inputName = /^(?!__proto__$|constructor$|prototype$)[a-zA-Z][a-zA-Z0-9_]{0,79}$/u
const modelName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u
const versionId = /^[a-f0-9]{64}$/u
const predictionId = /^[a-zA-Z0-9]{8,80}$/u

export function replicatePredictionId(value) {
  if (typeof value !== 'string' || !predictionId.test(value)) throw new ApiError(400, '供应商任务编号无效')
  return value
}

export class ReplicateHttpError extends Error {
  constructor(status) { super(`Replicate HTTP ${status}`); this.status = status }
}

function configuration(env) {
  const token = (env.REPLICATE_API_TOKEN_FILE ? readFileSync(env.REPLICATE_API_TOKEN_FILE, 'utf8') : env.REPLICATE_API_TOKEN ?? '').trim()
  if (token && (!/^[\x21-\x7e]{8,300}$/u.test(token))) throw new Error('invalid token')
  const entries = env.PAGEKIN_GENERATION_JSON ? object(JSON.parse(env.PAGEKIN_GENERATION_JSON)) : defaultModels
  const models = {}
  for (const [kind, value] of Object.entries(entries)) {
    object(value)
    if (!Object.hasOwn(defaultModels, kind) || typeof value.model !== 'string' || !modelName.test(value.model) ||
        (value.version != null && (typeof value.version !== 'string' || !versionId.test(value.version)))) throw new Error('invalid model')
    const promptField = value.promptField ?? (kind === 'speech' ? 'text' : 'prompt')
    const aspectField = value.aspectField ?? null
    const outputField = value.outputField ?? null
    for (const field of [promptField, aspectField, outputField].filter(item => item !== null)) {
      if (typeof field !== 'string' || !inputName.test(field)) throw new Error('invalid model field')
    }
    if (aspectField === promptField) throw new Error('overlapping model fields')
    const defaults = object(value.defaults ?? {})
    if (Object.entries(defaults).some(([field, parameter]) => !inputName.test(field) ||
      !['string', 'number', 'boolean'].includes(typeof parameter) || (typeof parameter === 'number' && !Number.isFinite(parameter))) ||
      JSON.stringify(defaults).length > 8000) throw new Error('invalid model options')
    models[kind] = { model: value.model, version: value.version ?? null, promptField, aspectField, outputField, defaults }
  }
  return { token, models }
}

async function readJson(response) {
  if (!response.ok) {
    await response.body?.cancel()
    throw new ReplicateHttpError(response.status)
  }
  const chunks = []
  let size = 0
  for await (const part of response.body) {
    size += part.byteLength
    if (size > 1_000_000) throw new Error('provider response too large')
    chunks.push(part)
  }
  return object(JSON.parse(Buffer.concat(chunks)))
}

export function openReplicate(env = process.env, fetcher = fetch) {
  let config
  let invalid = false
  try { config = configuration(env) }
  catch { invalid = true; config = { token: '', models: {} } }
  const models = Object.fromEntries(Object.entries(config.models).map(([kind, { model }]) => [kind, model]))

  async function call(path, method, input, signal) {
    const response = await fetcher('https://api.replicate.com/v1/' + path, { method, redirect: 'error',
      headers: { Authorization: 'Bearer ' + config.token, Accept: 'application/json',
        ...(input ? { 'Content-Type': 'application/json', 'Cancel-After': '20m' } : {}) },
      body: input ? JSON.stringify(input) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    })
    return readJson(response)
  }

  function prepare(kind, value, aspect) {
    const model = Object.hasOwn(config.models, kind) ? config.models[kind] : undefined
    if (!config.token || !model) throw new ApiError(503, '请在 NAS 配置对应的媒体生成模型')
    const prompt = string(value, 3000, true).trim()
    const input = { ...model.defaults, ...(model.aspectField ? { [model.aspectField]: aspect } : {}), [model.promptField]: prompt }
    return { model: model.model, version: model.version, outputField: model.outputField, input }
  }

  function submit(manifest, signal) {
    const { model, version, input } = manifest
    return version ? call('predictions', 'POST', { version: `${model}:${version}`, input }, signal)
      : call(`models/${model}/predictions`, 'POST', { input }, signal)
  }

  async function download(value, signal) {
    const url = new URL(value)
    if (url.protocol !== 'https:' || (url.hostname !== 'replicate.delivery' && !url.hostname.endsWith('.replicate.delivery')) ||
        url.username || url.password || url.port) throw new ApiError(422, '供应商输出地址不在允许范围')
    const response = await fetcher(url, { redirect: 'error', signal })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new ReplicateHttpError(response.status)
    }
    return response
  }

  return { capabilities: { configured: !!config.token, invalid, models }, prepare, submit, download,
    get: (id, signal) => call('predictions/' + replicatePredictionId(id), 'GET', null, signal),
    cancel: (id, signal) => call('predictions/' + replicatePredictionId(id) + '/cancel', 'POST', null, signal) }
}
