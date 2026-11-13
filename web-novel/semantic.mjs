import { ApiError, hash, object, string } from './store.mjs'

const chunkLimit = 2048
const jobLimit = 128
const batchSize = 8
const maxDimensions = 4096

function chunks(text) {
  const ranges = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + 800, text.length)
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end - 1)
      if (boundary > start + 500) end = boundary + 1
      if (/[\uDC00-\uDFFF]/u.test(text[end])) end--
    }
    if (text.slice(start, end).trim()) ranges.push({ start, end })
    if (end === text.length) break
    start = end - 120
    if (/[\uDC00-\uDFFF]/u.test(text[start])) start--
  }
  return ranges
}

function unitVector(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > maxDimensions ||
      values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new ApiError(502, '语义模型返回了无效向量')
  }
  const norm = Math.hypot(...values)
  if (!Number.isFinite(norm) || norm === 0) throw new ApiError(502, '语义模型返回了无效向量')
  return Float32Array.from(values, value => value / norm)
}

async function responseJson(response) {
  const parts = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > 2_000_000) throw new ApiError(502, '语义模型响应过大')
    parts.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(parts, length).toString('utf8')) }
  catch { throw new ApiError(502, '语义模型返回了无效响应') }
}

function packed(vector) {
  const bytes = Buffer.alloc(vector.length * 4)
  for (let i = 0; i < vector.length; i++) bytes.writeFloatLE(vector[i], i * 4)
  return bytes
}

function similarity(query, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let sum = 0
  for (let i = 0; i < query.length; i++) sum += query[i] * view.getFloat32(i * 4, true)
  return sum
}

export function openSemantic(storage, env = process.env) {
  const model = (env.EMBEDDING_MODEL || '').trim()
  if (!model) return null
  const base = (env.EMBEDDING_BASE_URL || '').trim()
  const key = env.EMBEDDING_API_KEY || ''
  let endpoint
  try { endpoint = new URL(base.replace(/\/+$/, '') + '/embeddings') }
  catch { throw new Error('启用语义检索需要设置 EMBEDDING_BASE_URL') }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || (key && endpoint.protocol !== 'https:')) {
    throw new Error('语义模型地址无效。配置 API Key 时请使用 HTTPS')
  }
  const profile = hash(JSON.stringify([endpoint.href, model, 'paragraph-800-120-v1']))
  const lifetime = new AbortController()
  let latest
  let searching = false

  async function embed(input) {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)])
    try {
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        body: JSON.stringify({ model, input, encoding_format: 'float' }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new ApiError(502, '语义模型请求失败（HTTP ' + response.status + '）')
      }
      const payload = await responseJson(response)
      if (!Array.isArray(payload?.data) || payload.data.length !== input.length) throw new ApiError(502, '语义模型返回的片段数不匹配')
      const result = Array(input.length)
      for (const row of payload.data) {
        if (!Number.isInteger(row?.index) || row.index < 0 || row.index >= result.length || result[row.index]) {
          throw new ApiError(502, '语义模型返回了无效的片段编号')
        }
        result[row.index] = unitVector(row.embedding)
      }
      const dimensions = storage.get('SELECT dimensions FROM reference_vectors WHERE profile=? LIMIT 1', profile)?.dimensions ?? result[0].length
      if (result.some(vector => vector.length !== dimensions)) throw new ApiError(502, '语义模型的向量维度与已有索引不一致')
      return result
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(502, '无法连接语义模型或请求超时')
    }
  }

  function status(pid) {
    const count = storage.get('SELECT count(*) n FROM reference_material WHERE project_id=?', pid).n
    const vectorState = storage.get(`
      SELECT coalesce(sum(v.parts),0) chunks, coalesce(sum(v.parts=v.total),0) indexed_count
      FROM (
        SELECT count(*) parts,max(total_parts) total FROM reference_vectors v
        JOIN reference_material r ON r.id=v.reference_id WHERE r.project_id=? AND v.profile=? GROUP BY r.id
      ) v`, pid, profile)
    const job = latest?.pid === pid && (latest.state !== 'complete' || vectorState.indexed_count === count)
      ? latest : undefined
    return { count, chunks: vectorState.chunks, indexed: vectorState.indexed_count,
      state: job?.state ?? 'idle', message: job?.message ?? '',
      capacity: chunkLimit, batchLimit: jobLimit }
  }

  async function build(pid, job) {
    try {
      const before = status(pid)
      let remaining = Math.min(jobLimit, chunkLimit - before.chunks)
      const references = storage.all(`
        SELECT r.id FROM reference_material r WHERE r.project_id=? AND NOT EXISTS (
          SELECT 1 FROM reference_vectors v WHERE v.profile=? AND v.reference_id=r.id
          GROUP BY v.reference_id HAVING count(*)=max(v.total_parts)
        ) ORDER BY r.created,r.id`, pid, profile)
      for (const { id } of references) {
        if (remaining <= 0) break
        const reference = storage.reference(pid, id)
        const ranges = chunks(reference.body)
        const have = new Set(storage.all('SELECT part FROM reference_vectors WHERE profile=? AND reference_id=?', profile, id).map(row => row.part))
        const missing = ranges.map((range, part) => ({ ...range, part })).filter(range => !have.has(range.part)).slice(0, remaining)
        for (let offset = 0; offset < missing.length; offset += batchSize) {
          const batch = missing.slice(offset, offset + batchSize)
          const vectors = await embed(batch.map(({ start, end }) => reference.body.slice(start, end)))
          lifetime.signal.throwIfAborted()
          storage.tx(() => {
            storage.run('DELETE FROM reference_vectors WHERE reference_id=? AND profile<>?', id, profile)
            for (const [i, { part, start, end }] of batch.entries()) {
              storage.run('INSERT INTO reference_vectors VALUES (?,?,?,?,?,?,?,?)',
                profile, id, part, ranges.length, start, end, vectors[i].length, packed(vectors[i]))
            }
          })
          remaining -= batch.length
        }
      }
      const result = status(pid)
      job.state = result.indexed === result.count ? 'complete' : result.chunks >= chunkLimit ? 'capacity' : 'partial'
      job.message = { complete: '当前参考资料已索引', capacity: '已达到本作品的索引片段上限', partial: '本批完成，可继续索引剩余资料' }[job.state]
    } catch (error) {
      job.state = 'failed'
      job.message = error instanceof ApiError ? error.message : '索引未完成，已保存成功的批次'
    }
  }

  function start(pid) {
    if (latest?.state === 'running') {
      if (latest.pid === pid) return status(pid)
      throw new ApiError(409, '另一部作品正在建立索引，请稍后再试')
    }
    const job = latest = { pid, state: 'running', message: '' }
    void build(pid, job)
    return status(pid)
  }

  async function search(pid, value) {
    const query = string(object(value).q, 400, true).trim()
    if (!status(pid).chunks) throw new ApiError(422, '请先为本作品建立语义索引')
    if (searching) throw new ApiError(429, '已有语义查询正在执行，请稍后再试')
    searching = true
    try {
      const [vector] = await embed([query])
      lifetime.signal.throwIfAborted()
      const best = []
      const statement = storage.db.prepare(`
        SELECT v.reference_id id, v.start_offset start, v.end_offset end, v.vector
        FROM reference_vectors v JOIN reference_material r ON r.id=v.reference_id
        WHERE v.profile=? AND r.project_id=? AND v.dimensions=? ORDER BY v.reference_id,v.part LIMIT ?`)
      for (const row of statement.iterate(profile, pid, vector.length, chunkLimit)) {
        if (row.vector.byteLength !== vector.length * 4) continue
        const score = similarity(vector, row.vector)
        if (!Number.isFinite(score) || score <= 0 || (best.length === 10 && score <= best.at(-1).score)) continue
        best.push({ id: row.id, start: row.start, end: row.end, score })
        best.sort((a, b) => b.score - a.score)
        if (best.length > 10) best.pop()
      }
      return best.map(({ id, start, end }) => {
        const reference = storage.reference(pid, id)
        return { id, start, end, title: reference.title, excerpt: reference.body.slice(start, end) }
      })
    } finally { searching = false }
  }

  let diagnosing = false
  async function diagnose() {
    if (diagnosing) throw new ApiError(409, '已有语义模型连接测试进行中')
    diagnosing = true
    const started = Date.now()
    try {
      const [vector] = await embed(['Pagekin connection test.'])
      return { ok: true, elapsedMs: Date.now() - started, dimensions: vector.length }
    } finally { diagnosing = false }
  }
  return { model, status, start, search, diagnose, close: () => lifetime.abort() }
}
