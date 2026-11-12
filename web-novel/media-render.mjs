import { rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiError } from './input.mjs'
import { fileDigest } from './media-files.mjs'

const seconds = ms => (ms / 1000).toFixed(3)
const outputLimit = 128 * 1024 ** 2

function srtTime(ms) {
  return new Date(ms).toISOString().slice(11, 23).replace('.', ',')
}

export function subtitles(clips) {
  let offset = 0
  const lines = []
  for (const clip of clips) {
    const end = offset + clip.durationMs
    const caption = clip.caption.split(/\r\n|[\r\n]/u).map(line => line.trim().replace(/[<>\u0000]/gu, '')).filter(Boolean).join('\n')
    if (caption) lines.push(`${lines.length + 1}\n${srtTime(offset)} --> ${srtTime(end)}\n${caption}\n`)
    offset = end
  }
  return lines.join('\n')
}

export function openRenderer(store, files) {
  let current
  let working
  let stopping = false

  async function render(job, controller) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12 * 60_000)])
    const work = await files.stage()
    const { clips, narration, durationMs, width, height, fps } = job.manifest
    const invoke = args => files.execute('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-y', '-filter_threads', '1', ...args],
      { signal, timeout: 12 * 60_000 })
    try {
      const parts = []
      for (const [index, clip] of clips.entries()) {
        signal.throwIfAborted()
        const name = `clip-${index}.mp4`
        const args = files.inputArgs(clip.asset)
        if (clip.asset.type.startsWith('image/')) {
          args.splice(2, 0, '-loop', '1', '-framerate', String(fps))
          args[args.indexOf('-f') + 1] = 'image2'
          args.splice(args.indexOf('-i'), 0, '-c:v', clip.asset.type === 'image/png' ? 'png' : 'mjpeg')
        } else if (clip.startMs) args.unshift('-ss', seconds(clip.startMs))
        const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
        await invoke(['-threads', '1', ...args, '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1',
          '-vf', `${fit},setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=0.12,format=yuv420p`,
          '-frames:v', String(Math.round(clip.durationMs * fps / 1000)), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25',
          '-maxrate', '3M', '-bufsize', '6M', '-threads', '2', join(work, name)])
        parts.push(`file '${name}'`)
        store.progress(job.id, Math.floor((index + 1) * 90 / clips.length))
      }
      const list = join(work, 'segments.txt')
      const target = join(work, 'film.mp4')
      await writeFile(list, parts.join('\n') + '\n')
      const args = ['-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', list]
      if (narration) args.push('-threads', '1', '-ss', seconds(narration.startMs), ...files.inputArgs(narration.asset))
      const text = subtitles(clips)
      if (text) {
        const captions = join(work, 'captions.srt')
        await writeFile(captions, text)
        args.push('-protocol_whitelist', 'file', '-f', 'srt', '-i', captions)
      }
      args.push('-map', '0:v:0', '-c:v', 'copy')
      if (narration) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
        '-af', `volume=${narration.volume / 100},apad`, '-threads:a', '1')
      if (text) args.push('-map', `${narration ? 2 : 1}:s:0`, '-c:s', 'mov_text', '-disposition:s:0', 'default')
      await invoke([...args, '-map_metadata', '-1', '-t', seconds(durationMs), '-movflags', '+faststart', target])
      const info = await files.probe(target, 'video/mp4', signal)
      const visual = info.streams.find(stream => stream.codec_type === 'video')
      const duration = Number(visual?.duration) * 1000
      const { size: bytes } = await stat(target)
      if (!Number.isFinite(duration) || Math.abs(duration - durationMs) > 80 || visual.codec_name !== 'h264' ||
          visual.width !== width || visual.height !== height || !bytes || bytes > outputLimit ||
          (narration && !info.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac')) ||
          (text && !info.streams.some(stream => stream.codec_type === 'subtitle' && stream.codec_name === 'mov_text'))) {
        throw new Error('成片校验失败')
      }
      const sha = await fileDigest(target)
      signal.throwIfAborted()
      await files.publish(target, { sha, bytes }, store.checkQuota, () => {
        signal.throwIfAborted()
        store.finish(job.id, sha, bytes)
      })
    } finally { await rm(work, { recursive: true, force: true }) }
  }

  function kick() {
    if (working || stopping) return
    working = (async () => {
      if (!await files.available()) return
      while (!stopping) {
        const job = store.next()
        if (!job) break
        const controller = new AbortController()
        current = { id: job.id, controller }
        try { await render(job, controller) }
        catch (error) {
          const status = controller.signal.reason === 'shutdown' ? 'interrupted' : controller.signal.aborted ? 'cancelled' : 'failed'
          store.fail(job.id, status, status === 'interrupted' ? '服务停止，成片任务已中断' : status === 'cancelled' ? ''
            : error instanceof ApiError ? error.message : '媒体解码、渲染或成片校验失败')
        } finally { current = null }
      }
    })().catch(error => console.error('成片队列失败：', error.code ?? error.name)).finally(() => { working = null })
  }

  return { kick, cancel(id) { if (current?.id === id) current.controller.abort('cancel') },
    stop() { stopping = true; current?.controller.abort('shutdown'); return working } }
}
