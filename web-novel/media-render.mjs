import { rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiError } from './input.mjs'
import { fileDigest } from './media-files.mjs'

const seconds = ms => (ms / 1000).toFixed(3)
const outputLimit = 128 * 1024 ** 2

function srtTime(ms) {
  return new Date(ms).toISOString().slice(11, 23).replace('.', ',')
}

function timelineCues({ clips, subtitleCues }) {
  if (subtitleCues != null) return subtitleCues
  let offset = 0
  return clips.map(clip => {
    const end = offset + clip.durationMs
    const cue = { startMs: offset, endMs: end, text: clip.caption }
    offset = end
    return cue
  })
}

function srt(cues) {
  const lines = []
  for (const cue of cues) {
    const caption = cue.text.split(/\r\n|[\r\n]/u).map(line => line.trim().replace(/[<>\u0000]/gu, '')).filter(Boolean).join('\n')
    if (caption) lines.push(`${lines.length + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${caption}\n`)
  }
  return lines.join('\n')
}

export const subtitles = manifest => srt(timelineCues(manifest))

function clipSubtitles(cues, offset, duration) {
  const end = offset + duration
  return srt(cues.filter(cue => cue.endMs > offset && cue.startMs < end).map(cue => ({
    startMs: Math.max(0, cue.startMs - offset), endMs: Math.min(duration, cue.endMs - offset),
    text: cue.text.replace(/\\/gu, '＼').replace(/\{/gu, '｛').replace(/\}/gu, '｝'),
  })))
}

function pictureFilter(motion, width, height, fps, frames) {
  if (!motion || motion === 'none') {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},tpad=stop_mode=clone:stop_duration=0.12`
  }
  const progress = `on/${frames - 1}`
  const zoom = { 'zoom-in': `1+0.15*${progress}`, 'zoom-out': `1.15-0.15*${progress}`, 'pan-left': '1.15', 'pan-right': '1.15' }[motion]
  const horizontal = { 'pan-left': `1-${progress}`, 'pan-right': progress }[motion] ?? '0.5'
  // Crop before scaling so a very tall or wide image cannot cause a huge intermediate frame.
  const crop = `crop=w='max(1,min(iw,trunc(ih*${width}/${height})))':h='max(1,min(ih,trunc(iw*${height}/${width})))':exact=1`
  return `${crop},scale=${width * 2}:${height * 2},setsar=1,zoompan=z='${zoom}':x='(iw-iw/zoom)*(${horizontal})':y='(ih-ih/zoom)/2':d=${frames}:s=${width}x${height}:fps=${fps}`
}

function mixAudio(args, files, clips, durationMs) {
  const chains = []
  const labels = []
  for (const [index, clip] of clips.entries()) {
    args.push('-threads', '1', '-ss', seconds(clip.startMs), ...files.inputArgs(clip.asset))
    const filters = [`atrim=duration=${seconds(clip.durationMs)}`, 'asetpts=PTS-STARTPTS', 'aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo', `volume=${clip.volume / 100}`]
    if (clip.fadeInMs) filters.push(`afade=t=in:d=${seconds(clip.fadeInMs)}`)
    if (clip.fadeOutMs) filters.push(`afade=t=out:st=${seconds(clip.durationMs - clip.fadeOutMs)}:d=${seconds(clip.fadeOutMs)}`)
    const label = `[a${index}]`
    labels.push(label)
    const source = `[${index + 1}:a:0]${filters.join(',')}`
    if (clip.offsetMs) {
      // Generate silence as the graph reads it, so late clips do not allocate large delay buffers.
      chains.push(`${source}[sound${index}]`, `anullsrc=r=48000:cl=stereo:d=${seconds(clip.offsetMs)}[silence${index}]`,
        `[silence${index}][sound${index}]concat=n=2:v=0:a=1${label}`)
    } else chains.push(source + label)
  }
  chains.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0,alimiter=limit=0.95:level=0:latency=1,apad=whole_dur=${seconds(durationMs)}[mix]`)
  return chains.join(';')
}

export function openRenderer(store, files) {
  let current
  let working
  let stopping = false

  async function render(job, controller) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12 * 60_000)])
    const work = await files.stage()
    const { clips, narration, audioClips = [], subtitleOutput = 'soft', durationMs, width, height, fps } = job.manifest
    const invoke = args => files.execute('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-y',
      '-filter_threads', '1', '-filter_complex_threads', '1', ...args], { signal, cwd: work, timeout: 12 * 60_000 })
    try {
      const cues = timelineCues(job.manifest)
      const text = srt(cues)
      const burn = text && subtitleOutput === 'burn'
      const soft = text && subtitleOutput !== 'burn'
      if (burn && !await files.canBurnSubtitles()) throw new ApiError(422, '当前 FFmpeg 不支持烧录字幕，请切换为内嵌字幕')
      const parts = []
      let offset = 0
      for (const [index, clip] of clips.entries()) {
        signal.throwIfAborted()
        const name = `clip-${index}.mp4`
        const args = files.inputArgs(clip.asset)
        if (clip.asset.type.startsWith('image/')) {
          if (!clip.motion || clip.motion === 'none') args.splice(2, 0, '-loop', '1')
          args.splice(2, 0, '-framerate', String(fps))
          args[args.indexOf('-f') + 1] = 'image2'
          args.splice(args.indexOf('-i'), 0, '-c:v', clip.asset.type === 'image/png' ? 'png' : 'mjpeg')
        } else if (clip.startMs) args.unshift('-ss', seconds(clip.startMs))
        const frames = Math.round(clip.durationMs * fps / 1000)
        const filter = [pictureFilter(clip.motion, width, height, fps, frames)]
        const captions = burn && clipSubtitles(cues, offset, clip.durationMs)
        if (captions) {
          const file = `captions-${index}.srt`
          await writeFile(join(work, file), captions)
          filter.push(`subtitles=${file}:force_style='FontName=Noto Sans CJK SC,FontSize=18,Outline=1.6,Shadow=0,MarginV=18'`)
        }
        filter.push('format=yuv420p')
        await invoke(['-threads', '1', ...args, '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1',
          '-vf', filter.join(','), '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25',
          '-maxrate', '3M', '-bufsize', '6M', '-threads', '2', join(work, name)])
        parts.push(`file '${name}'`)
        offset += clip.durationMs
        store.progress(job.id, Math.floor((index + 1) * 90 / clips.length))
      }
      const list = join(work, 'segments.txt')
      const target = join(work, 'film.mp4')
      await writeFile(list, parts.join('\n') + '\n')
      const args = ['-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', list]
      const mix = audioClips.length ? mixAudio(args, files, narration ? [
        { ...narration, durationMs, offsetMs: 0 }, ...audioClips,
      ] : audioClips, durationMs) : null
      if (narration && !mix) args.push('-threads', '1', '-ss', seconds(narration.startMs), ...files.inputArgs(narration.asset))
      const audio = narration || mix
      const subtitleIndex = audioClips.length + Number(!!narration) + 1
      if (soft) {
        const captions = join(work, 'captions.srt')
        await writeFile(captions, text)
        args.push('-protocol_whitelist', 'file', '-f', 'srt', '-i', captions)
      }
      args.push('-map', '0:v:0', '-c:v', 'copy')
      if (mix) args.push('-filter_complex', mix, '-map', '[mix]')
      else if (narration) args.push('-map', '1:a:0', '-af', `volume=${narration.volume / 100},apad`)
      if (audio) args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-threads:a', '1')
      if (soft) args.push('-map', `${subtitleIndex}:s:0`, '-c:s', 'mov_text', '-disposition:s:0', 'default')
      await invoke([...args, '-map_metadata', '-1', '-t', seconds(durationMs), '-movflags', '+faststart', target])
      const info = await files.probe(target, 'video/mp4', signal)
      const visual = info.streams.find(stream => stream.codec_type === 'video')
      const duration = Number(visual?.duration) * 1000
      const { size: bytes } = await stat(target)
      if (!Number.isFinite(duration) || Math.abs(duration - durationMs) > 80 || visual.codec_name !== 'h264' ||
          visual.width !== width || visual.height !== height || !bytes || bytes > outputLimit ||
          (audio && !info.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac')) ||
          (soft && !info.streams.some(stream => stream.codec_type === 'subtitle' && stream.codec_name === 'mov_text'))) {
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
