import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiError } from './input.mjs'
import { ReplicateHttpError, replicatePredictionId } from './replicate.mjs'

const acceptedTypes = { image: 'image/', video: 'video/', speech: 'audio/' }
const verifiedVersion = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : null

function outputUrls(manifest, prediction) {
  const output = manifest.outputField ? prediction.output?.[manifest.outputField] : prediction.output
  const values = Array.isArray(output) ? output : [output]
  if (!values.length || values.length > 4 || values.some(value => typeof value !== 'string' || value.length > 4096)) {
    throw new ApiError(422, '供应商未返回 1–4 个可回收的文件')
  }
  return values
}

export function openGeneration(store, media, files, provider, { now = Date.now, pollMs = 5000 } = {}) {
  const stop = new AbortController()
  let working
  let timer
  const configured = () => provider.capabilities.configured && !stop.signal.aborted

  async function canRun() {
    return configured() && await files.available()
  }

  async function retrieve(job, prediction) {
    const urls = outputUrls(job.manifest, prediction)
    const done = new Set(store.variants(job.id).map(row => row.ordinal))
    for (let index = 0; index < urls.length; index++) {
      stop.signal.throwIfAborted()
      if (done.has(index + 1)) continue
      const stage = await files.stage()
      let response
      try {
        const path = join(stage, 'candidate')
        const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(90_000)])
        response = await provider.download(urls[index], signal)
        const length = response.headers.get('content-length')
        const file = await files.ingest(response.body, path, length === null ? undefined : Number(length), { signal })
        if (!file.type.startsWith(acceptedTypes[job.kind])) throw new ApiError(422, '生成文件与所选类型不匹配')
        signal.throwIfAborted()
        await files.publish(path, file, media.checkQuota, () => store.addVariant(job.id, index + 1, file))
      } finally {
        await response?.body?.cancel().catch(() => {})
        await rm(stage, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  async function submit(job) {
    try {
      const result = await provider.submit(job.manifest, stop.signal)
      const id = replicatePredictionId(result.id)
      store.external(job.id, id, verifiedVersion(result.version))
    } catch (error) {
      if (error instanceof ReplicateHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        store.settle(job.id, 'failed', `供应商拒绝提交（HTTP ${error.status}）`)
      } else store.settle(job.id, 'unknown', '提交结果待核对。请检查供应商任务并关联编号。')
    }
  }

  async function poll(job) {
    let prediction
    let cancellationFailed = false
    if (store.consumeCancel(job.id)) {
      try { prediction = await provider.cancel(job.external_id, stop.signal) }
      catch { cancellationFailed = true }
    }
    try {
      prediction ??= await provider.get(job.external_id, stop.signal)
      if (prediction.id !== job.external_id || !['starting', 'processing', 'succeeded', 'failed', 'canceled', 'aborted'].includes(prediction.status)) {
        throw new Error('unexpected provider result')
      }
    } catch (error) {
      if (stop.signal.aborted) return
      const terminal = error instanceof ReplicateHttpError && [401, 403, 404].includes(error.status)
      const message = terminal ? `暂时无法查询供应商任务（HTTP ${error.status}）` : '供应商查询失败，可用原编号继续查询'
      if (terminal || job.failures >= 7) store.settle(job.id, 'poll_paused', message)
      else store.wait(job.id, now() + Math.min(60_000, pollMs * 2 ** job.failures), job.failures + 1, message)
      return
    }
    if (prediction.status === 'succeeded') {
      try {
        await retrieve(job, prediction)
        store.settle(job.id, 'ready')
      } catch (error) {
        if (stop.signal.aborted) return
        const message = error instanceof ApiError ? error.message : '结果下载或保存失败，可用原编号重新回收'
        store.settle(job.id, 'recover', message)
      }
    } else if (['canceled', 'aborted'].includes(prediction.status)) store.settle(job.id, 'cancelled')
    else if (prediction.status === 'failed') store.settle(job.id, 'failed', '供应商任务失败')
    else store.wait(job.id, now() + pollMs, 0, cancellationFailed ? '取消请求暂未确认，供应商仍在处理' : '')
  }

  function kick() {
    if (working || !configured()) return
    working = (async () => {
      if (!await canRun()) return
      while (configured()) {
        const job = store.claim(now())
        if (!job) break
        if (job.state === 'queued') await submit(job)
        else await poll(job)
      }
    })().catch(error => console.error('媒体生成队列失败：', error.code ?? error.name)).finally(() => { working = null })
  }

  async function link(pid, id, externalId) {
    if (!await canRun()) throw new ApiError(503, '请先启用媒体环境并配置 Replicate')
    const current = store.detail(pid, id)
    if (current.state !== 'unknown') throw new ApiError(409, '此任务已有明确提交状态')
    const reference = replicatePredictionId(externalId)
    let result
    try { result = await provider.get(reference, stop.signal) }
    catch { throw new ApiError(502, '无法读取供应商任务，请核对账号和编号') }
    const { model, version, input } = current.manifest
    if (result.id !== reference || result.model !== model || (version && version !== result.version) ||
        !result.input || !Object.entries(input).every(([key, value]) => Object.hasOwn(result.input, key) && result.input[key] === value)) {
      throw new ApiError(422, '供应商任务的模型或输入与原请求不一致')
    }
    const linked = store.linked(pid, id, reference, verifiedVersion(result.version))
    kick()
    return linked
  }

  return { kick, canRun, link, start() {
    if (configured() && !timer) { timer = setInterval(kick, 1500); timer.unref() }
    kick()
  }, close() { clearInterval(timer); stop.abort(); return working } }
}
