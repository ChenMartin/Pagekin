import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ApiError, object, string } from './input.mjs'

export const modelProfileSchema = `
  CREATE TABLE model_preference (id INTEGER PRIMARY KEY CHECK(id=1), profile_id TEXT NOT NULL, rev INTEGER NOT NULL);
  ALTER TABLE runs ADD COLUMN model_ref TEXT;
  ALTER TABLE writing_batches ADD COLUMN model_ref TEXT;
  ALTER TABLE reference_analyses ADD COLUMN model_ref TEXT;
  ALTER TABLE reference_batches ADD COLUMN model_ref TEXT;
`
export const modelStageSchema = `
  CREATE TABLE model_stage_preferences (id INTEGER PRIMARY KEY CHECK(id=1), selections TEXT NOT NULL, rev INTEGER NOT NULL);
`
const stages = ['planning', 'draft', 'review', 'revision', 'continuity']
export function writingStage(kind, passageMode) {
  if (kind === 'plan' || kind === 'outline' || kind === 'infer') return 'planning'
  if (kind === 'passage') return passageMode === 'continue' ? 'draft' : 'revision'
  return kind === 'revise' ? 'revision' : stages.includes(kind) ? kind : null
}

const profileId = /^[a-zA-Z0-9_-]{1,40}$/
export function importedModelRef(value) {
  if (value == null) return null
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,40}:[a-f0-9]{64}$/.test(value)) throw new ApiError(400, '备份中的模型预设引用无效')
  return value
}

function budget(value) {
  if (!Number.isInteger(value) || value < 4000 || value > 250_000) throw new Error('模型上下文字符预算应为 4000–250000 的整数')
  return value
}

function configured(raw, fallbackBudget) {
  object(raw)
  const id = raw.id
  if (typeof id !== 'string' || !profileId.test(id)) throw new Error('模型预设 ID 无效')
  const label = string(raw.label, 80, true).trim()
  const model = string(raw.model, 200, true).trim()
  const key = string(raw.apiKey ?? '', 4096)
  const base = string(raw.baseUrl, 2048, true).trim()
  let endpoint
  try { endpoint = new URL(base.replace(/\/+$/, '') + '/chat/completions') }
  catch { throw new Error('模型预设地址无效') }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || (key && endpoint.protocol !== 'https:')) {
    throw new Error('模型预设地址无效。配置 API Key 时请使用 HTTPS')
  }
  const contextLimit = budget(raw.contextChars ?? fallbackBudget)
  const ref = id + ':' + createHash('sha256').update(JSON.stringify([endpoint.href, model, contextLimit])).digest('hex')
  return { id, label, model, key, endpoint, contextLimit, ref }
}

export function openModelProfiles({ get, run, tx }, env = process.env) {
  const defaultBudget = budget(Number(env.LLM_CONTEXT_CHARS || '64000'))
  const profiles = new Map()
  const legacy = (env.LLM_MODEL || '').trim() ? configured({
    id: 'environment', label: 'Compose 环境变量', model: env.LLM_MODEL,
    apiKey: env.LLM_API_KEY || '', baseUrl: env.LLM_BASE_URL || 'https://api.openai.com/v1',
  }, defaultBudget) : null
  if (legacy) profiles.set(legacy.id, legacy)
  if (env.LLM_PROFILES_FILE && env.LLM_PROFILES_JSON) throw new Error('请选择一种模型预设配置来源')
  if (env.LLM_PROFILES_FILE || env.LLM_PROFILES_JSON) {
    let entries
    try { entries = JSON.parse(env.LLM_PROFILES_FILE ? readFileSync(env.LLM_PROFILES_FILE, 'utf8').replace(/^\uFEFF/u, '') : env.LLM_PROFILES_JSON) }
    catch { throw new Error('无法读取模型预设 JSON') }
    if (!Array.isArray(entries) || entries.length > 32) throw new Error('模型预设须为最多 32 项的 JSON 数组')
    for (const raw of entries) {
      const profile = configured(raw, defaultBudget)
      if (profile.id === 'environment' || profiles.has(profile.id)) throw new Error('模型预设 ID 重复或已保留')
      profiles.set(profile.id, profile)
    }
  }
  const first = profiles.keys().next().value ?? null
  const stored = () => get('SELECT profile_id,rev FROM model_preference WHERE id=1')
  const storedStages = () => get('SELECT selections,rev FROM model_stage_preferences WHERE id=1')
  const selections = row => row ? JSON.parse(row.selections) : {}
  const current = stage => {
    const chosen = stage && selections(storedStages())[stage]
    return profiles.get(chosen) ?? profiles.get(stored()?.profile_id ?? first) ?? null
  }
  const summary = ({ id, label, model, contextLimit }) => ({ id, label, model, contextLimit })

  function list() {
    const saved = stored()
    const stageRow = storedStages()
    const activeId = saved?.profile_id ?? first
    const selected = selections(stageRow)
    return { activeId, rev: saved?.rev ?? 0, stageRev: stageRow?.rev ?? 0,
      stages: Object.fromEntries(stages.map(stage => [stage, profiles.has(selected[stage]) ? selected[stage] : null])),
      available: profiles.has(activeId), profiles: [...profiles.values()].map(summary) }
  }

  function select(value) {
    const { id, baseRev } = object(value)
    if (!profiles.has(id) || !Number.isSafeInteger(baseRev) || baseRev < 0) throw new ApiError(400, '请选择有效的模型预设')
    const saved = list()
    if (saved.activeId === id) return saved
    if (saved.rev !== baseRev) throw new ApiError(409, '另一设备已切换模型预设，请重新核对', saved)
    run(`INSERT INTO model_preference VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id,rev=excluded.rev`,
      id, baseRev + 1)
    return list()
  }

  function selectStages(value) {
    const { baseRev, stages: input } = object(value)
    object(input)
    if (!Number.isSafeInteger(baseRev) || baseRev < 0 || Object.keys(input).some(key => !stages.includes(key))) {
      throw new ApiError(400, '分工模型设置无效')
    }
    return tx(() => {
      const saved = list()
      const next = { ...saved.stages, ...input }
      if (Object.values(next).some(id => id !== null && !profiles.has(id))) throw new ApiError(400, '请选择有效的模型预设')
      if (JSON.stringify(next) === JSON.stringify(saved.stages)) return saved
      if (baseRev !== saved.stageRev) throw new ApiError(409, '另一设备已更改分工模型，请重新读取', saved)
      run(`INSERT INTO model_stage_preferences VALUES (1,?,?)
        ON CONFLICT(id) DO UPDATE SET selections=excluded.selections,rev=excluded.rev`, JSON.stringify(next), baseRev + 1)
      return list()
    })
  }

  function required(id, stage) {
    const profile = id == null ? current(stage) : profiles.get(id)
    if (!profile) throw new ApiError(422, '请选择可用的写作模型预设')
    return profile
  }

  function pinned(ref) {
    if (ref == null && legacy) return legacy
    const profile = typeof ref === 'string' ? profiles.get(ref.split(':', 1)[0]) : null
    if (!profile || profile.ref !== ref) throw new ApiError(409, '原模型预设已变更或不可用，请恢复原配置或新建任务')
    return profile
  }

  let testing = false
  async function diagnose(value) {
    const profile = profiles.get(object(value).id)
    if (!profile) throw new ApiError(404, '模型预设不存在')
    if (testing) throw new ApiError(409, '已有模型连接测试进行中')
    testing = true
    const started = Date.now()
    const signal = AbortSignal.timeout(8000)
    let reader
    try {
      const response = await fetchChat(profile, [{ role: 'user', content: 'Reply with OK.' }], signal)
      if (!response.ok) {
        await response.body?.cancel()
        throw new ApiError(502, '模型测试失败（HTTP ' + response.status + '）')
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
        await response.body?.cancel()
        throw new ApiError(502, '模型未返回预期的流式响应')
      }
      reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let pending = ''
      let size = 0
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > 64_000) throw new ApiError(502, '模型测试响应超过读取上限')
        const lines = (pending + part.value).split('\n')
        pending = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const text = line.slice(5).trim()
          if (!text || text === '[DONE]') continue
          let event
          try { event = JSON.parse(text) } catch { throw new ApiError(502, '模型返回了无效的流式数据') }
          if (event.error) throw new ApiError(502, '模型服务返回了流式错误')
          const delta = event.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.trim()) return { ok: true, elapsedMs: Date.now() - started }
        }
      }
      throw new ApiError(502, '模型测试未收到正文')
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, signal.aborted ? '模型连接测试超时' : '无法连接模型，请检查地址、网络和证书')
    } finally {
      try { await reader?.cancel() } catch { /* Request already closed. */ }
      testing = false
    }
  }
  return { list, select, selectStages, required, current, pinned, diagnose, defaultBudget }
}

export function fetchChat({ endpoint, key, model }, messages, signal) {
  return fetch(endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: JSON.stringify({ model, messages, stream: true }),
  })
}
