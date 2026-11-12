import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { ApiError } from './input.mjs'
import { maxUploadBytes } from './media-store.mjs'

const exec = promisify(execFile)
const digest = /^[a-f0-9]{64}$/u
const formatByType = { 'image/png': 'png_pipe', 'image/jpeg': 'jpeg_pipe', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'video/mp4': 'mov' }

export function blobPath(directory, sha) {
  if (typeof sha !== 'string' || !digest.test(sha)) throw new Error('无效的媒体文件摘要')
  return resolve(directory, 'media', 'blobs', sha)
}

export async function fileDigest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function detect(header) {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return 'image/jpeg'
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav'
  if (header.toString('ascii', 0, 3) === 'ID3' || (header[0] === 255 && (header[1] & 224) === 224)) return 'audio/mpeg'
  if (header.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4'
  throw new ApiError(415, '请选择 PNG、JPEG、MP4、WAV 或 MP3 文件')
}

export function openMediaFiles(directory, enabled) {
  const blobs = resolve(directory, 'media', 'blobs')
  const staging = resolve(directory, 'media', 'staging')
  let publishing = Promise.resolve()
  let checking

  async function execute(program, args, { signal, timeout = 60_000 } = {}) {
    const env = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
    return exec(program, args, { env, signal, timeout, maxBuffer: 192_000, windowsHide: true })
  }

  function available() {
    if (!enabled) return Promise.resolve(false)
    checking ??= Promise.all([execute('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 4000 }),
      execute('ffprobe', ['-version'], { timeout: 4000 })]).then(([{ stdout }]) => /\blibx264\b/u.test(stdout), () => false)
    return checking
  }

  async function stage() {
    await mkdir(staging, { recursive: true, mode: 0o700 })
    return mkdtemp(join(staging, 'stage-'))
  }

  async function probe(path, type, signal) {
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-f', formatByType[type],
      '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,duration', '-of', 'json', path],
    { signal, timeout: 8000 })
    return JSON.parse(stdout)
  }

  async function receive(req, path) {
    return ingest(req.iterator({ destroyOnReturn: false }), path, Number(req.headers['content-length']), { overflow: () => req.resume() })
  }

  async function ingest(source, path, declared, { signal, overflow } = {}) {
    if (Number.isFinite(declared) && (declared > maxUploadBytes || declared < 1)) throw new ApiError(413, '单个素材须为 1 字节至 64 MiB')
    const hash = createHash('sha256')
    let bytes = 0
    const file = createWriteStream(path, { flags: 'wx', mode: 0o600 })
    // Keep the HTTP response writable when a chunked upload exceeds the limit.
    async function* checked() {
      for await (const chunk of source) {
        bytes += chunk.length
        if (bytes > maxUploadBytes) { overflow?.(); throw new ApiError(413, '单个素材最多 64 MiB') }
        hash.update(chunk)
        yield chunk
      }
    }
    await pipeline(checked(), file, { signal })
    if (!bytes) throw new ApiError(400, '素材为空')
    const fd = await open(path, 'r')
    const header = Buffer.alloc(12)
    try { await fd.read(header) } finally { await fd.close() }
    const type = detect(header)
    let data
    try { data = await probe(path, type, signal) }
    catch { throw new ApiError(422, '素材损坏或无法读取') }
    const visual = data.streams?.find(stream => stream.codec_type === 'video')
    const audio = data.streams?.find(stream => stream.codec_type === 'audio')
    const image = type.startsWith('image/')
    const sound = type.startsWith('audio/')
    const stream = sound ? audio : visual
    const durationMs = image ? 0 : Math.floor(Number(stream?.duration ?? data.format?.duration) * 1000)
    if (!stream || (!image && (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 600_000)) ||
        (!sound && (!Number.isInteger(visual.width) || !Number.isInteger(visual.height) || visual.width < 1 || visual.height < 1 ||
          visual.width * visual.height > 4096 * 4096 || Math.max(visual.width, visual.height) > 8192)) ||
        (type === 'video/mp4' && visual.codec_name !== 'h264')) throw new ApiError(422, '素材须为可读图片、十分钟以内的音频或 H.264 MP4')
    if (image) {
      try {
        await execute('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-threads', '1', '-protocol_whitelist', 'file',
          '-f', formatByType[type], '-i', path, '-frames:v', '1', '-f', 'null', '-'], { signal, timeout: 8000 })
      } catch { throw new ApiError(422, '素材损坏或无法读取') }
    }
    return { type, sha: hash.digest('hex'), bytes, durationMs, width: sound ? null : visual.width, height: sound ? null : visual.height }
  }

  function publish(path, file, check, commit) {
    const next = publishing.then(async () => {
      check(file.sha, file.bytes)
      const target = blobPath(directory, file.sha)
      await mkdir(blobs, { recursive: true, mode: 0o700 })
      let linked = false
      try { await link(path, target); linked = true }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        const existing = await lstat(target)
        if (!existing.isFile() || existing.size !== file.bytes) throw new Error('媒体文件存储不一致')
      }
      try { return commit() }
      catch (error) { if (linked) await rm(target, { force: true }); throw error }
    })
    publishing = next.catch(() => {})
    return next
  }

  function inputArgs(file) {
    return ['-protocol_whitelist', 'file', '-f', formatByType[file.type], '-i', blobPath(directory, file.sha)]
  }

  return { available, stage, receive, ingest, publish, probe, inputArgs, execute }
}

export async function sendMedia(req, res, directory, file, attachment) {
  const path = blobPath(directory, file.sha)
  const data = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') throw new ApiError(404, '媒体文件缺失，请从备份恢复')
    throw error
  })
  if (!data.isFile() || data.size !== file.bytes) throw new ApiError(404, '媒体文件损坏，请从备份恢复')
  let start = 0, end = data.size - 1, status = 200
  if (req.headers.range) {
    const range = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range)
    const first = range?.[1], last = range?.[2]
    start = first ? Number(first) : Math.max(0, data.size - Number(last))
    end = first && last ? Math.min(end, Number(last)) : end
    if (!range || (!first && !last) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= data.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${data.size}` }).end()
      return
    }
    status = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${data.size}`)
  }
  if (attachment) res.setHeader('Content-Disposition', `attachment; filename="${attachment}"`)
  res.writeHead(status, { 'Accept-Ranges': 'bytes', 'Content-Type': file.type, 'Content-Length': end - start + 1 })
  if (req.method === 'HEAD') return res.end()
  await pipeline(createReadStream(path, { start, end }), res)
}
