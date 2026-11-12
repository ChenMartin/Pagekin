import { ApiError, object, revision, string } from './input.mjs'

export const mediaSchema = `
  CREATE TABLE media_assets (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), sha TEXT NOT NULL,
    name TEXT NOT NULL, type TEXT NOT NULL, bytes INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
    width INTEGER, height INTEGER, created TEXT NOT NULL, UNIQUE(project_id,sha)
  );
  CREATE TABLE media_timelines (
    episode_id TEXT NOT NULL REFERENCES screenplay_episodes(id), rev INTEGER NOT NULL, board_rev INTEGER NOT NULL,
    content TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(episode_id,rev),
    FOREIGN KEY(episode_id,board_rev) REFERENCES storyboard_history(episode_id,rev)
  );
  CREATE TABLE media_timeline_receipts (
    episode_id TEXT NOT NULL, mutation TEXT NOT NULL, fingerprint TEXT NOT NULL, rev INTEGER NOT NULL,
    PRIMARY KEY(episode_id,mutation), FOREIGN KEY(episode_id,rev) REFERENCES media_timelines(episode_id,rev)
  );
  CREATE TABLE media_renders (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), episode_id TEXT NOT NULL,
    timeline_rev INTEGER NOT NULL, manifest TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0, sha TEXT, bytes INTEGER, error TEXT NOT NULL DEFAULT '', created TEXT NOT NULL,
    FOREIGN KEY(episode_id,timeline_rev) REFERENCES media_timelines(episode_id,rev)
  );
  CREATE INDEX media_render_queue ON media_renders(status,created);
`

export const maxUploadBytes = 64 * 1024 ** 2
export const maxFilmMs = 180_000
export const frameMs = 40
const maxAudioClips = 24
const maxSubtitleCues = 200
const audioTracks = new Set(['voice', 'music', 'effects'])
const imageMotions = new Set(['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right'])
const mediaQuota = 2 * 1024 ** 3
const sizes = { '9:16': [540, 960], '16:9': [960, 540], '1:1': [720, 720] }
const jobFields = 'id,episode_id,timeline_rev,status,progress,sha,bytes,error,created'
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu

export function mediaId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ApiError(400, '媒体操作编号无效')
  return value
}

function count(value, minimum, maximum, message) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ApiError(400, message)
  return value
}

function clipFor(shot) {
  return { shotId: shot.id, assetId: null, startMs: 0, durationMs: Math.max(280, Math.round(shot.durationMs / frameMs) * frameMs),
    caption: (shot.dialogue || '').slice(0, 500), motion: 'none' }
}

function contentWithDefaults(content) {
  return { clips: content.clips.map(clip => ({ ...clip, motion: clip.motion ?? 'none' })), narration: content.narration ?? null,
    audioClips: content.audioClips ?? [], subtitleCues: content.subtitleCues ?? null, subtitleOutput: content.subtitleOutput ?? 'soft' }
}

function parseSubtitles(value) {
  if (value == null) return null
  if (!Array.isArray(value) || value.length > maxSubtitleCues) throw new ApiError(400, '最多保存 200 条独立字幕')
  const cues = value.map(item => {
    object(item)
    const startMs = count(item.startMs, 0, maxFilmMs - frameMs, '字幕起点无效')
    const endMs = count(item.endMs, startMs + frameMs, maxFilmMs, '字幕结束时间无效')
    if (startMs % frameMs || endMs % frameMs) throw new ApiError(422, '字幕时间须对齐 40 毫秒帧')
    return { startMs, endMs, text: string(item.text, 500, true).trim() }
  }).sort((a, b) => a.startMs - b.startMs)
  if (cues.some((cue, index) => index > 0 && cue.startMs < cues[index - 1].endMs)) throw new ApiError(422, '独立字幕时间不能重叠')
  return cues
}

export function openMediaStore({ get, all, run, tx, hash, now, screenplay, storyboard }) {
  const assets = pid => all('SELECT * FROM media_assets WHERE project_id=? ORDER BY created DESC,id', pid)
  function asset(pid, id) {
    const row = get('SELECT * FROM media_assets WHERE project_id=? AND id=?', pid, id)
    if (!row) throw new ApiError(404, '素材不存在')
    return row
  }

  function checkQuota(sha, bytes) {
    const used = get(`SELECT COALESCE(SUM(bytes),0) size,COUNT(*) FILTER (WHERE sha=?) existing FROM (
      SELECT sha,bytes FROM media_assets UNION SELECT sha,bytes FROM media_renders WHERE sha IS NOT NULL
      UNION SELECT sha,bytes FROM media_generation_variants)`, sha)
    if (!used.existing && used.size + bytes > mediaQuota) throw new ApiError(422, '媒体存储已达到 2 GiB 上限')
  }

  function registerAsset(pid, id, file) {
    return tx(() => insertAsset(pid, id, file))
  }

  function insertAsset(pid, id, file) {
    const existing = get('SELECT * FROM media_assets WHERE id=?', id)
    if (existing && (existing.sha !== file.sha || existing.project_id !== pid)) throw new ApiError(409, '素材上传编号已使用')
    if (existing) return existing
    const same = get('SELECT * FROM media_assets WHERE project_id=? AND sha=?', pid, file.sha)
    if (same) return same
    if (get('SELECT COUNT(*) n FROM media_assets WHERE project_id=?', pid).n >= 300) throw new ApiError(422, '每部作品最多保存 300 份素材')
    checkQuota(file.sha, file.bytes)
    run('INSERT INTO media_assets VALUES (?,?,?,?,?,?,?,?,?,?)', id, pid, file.sha, file.name, file.type, file.bytes,
      file.durationMs, file.width, file.height, now())
    return asset(pid, id)
  }

  const latest = id => get('SELECT * FROM media_timelines WHERE episode_id=? ORDER BY rev DESC LIMIT 1', id)
  const at = (id, rev) => get('SELECT * FROM media_timelines WHERE episode_id=? AND rev=?', id, rev)

  function boardContext(pid, id) {
    const episode = screenplay.episode(pid, id)
    const board = storyboard.detail(pid, id)
    return { title: episode.title, ...board, current: board.status === 'confirmed' && !board.stale ? board.rev : null }
  }

  function defaultClips(board) {
    return board.scenes.flatMap(scene => board.shots.filter(shot => shot.sceneId === scene.id).map(clipFor))
  }

  function view(pid, id, board, row) {
    const boardRev = row?.board_rev ?? board.current
    const source = boardRev && board.rev !== boardRev ? storyboard.detail(pid, id, boardRev) : board
    const content = contentWithDefaults(row ? JSON.parse(row.content) : { clips: board.current ? defaultClips(board) : [] })
    return { id, title: board.title, rev: row?.rev ?? 0, boardRev, currentBoardRev: board.current,
      stale: !!row && boardRev !== board.current, ...content,
      shots: source.shots.map(shot => ({ id: shot.id, visual: shot.visual, prompt: shot.prompt, clip: clipFor(shot) })) }
  }

  function timeline(pid, id) {
    return view(pid, id, boardContext(pid, id), latest(id))
  }

  function parseAudio(pid, items) {
    if (!Array.isArray(items) || items.length > maxAudioClips) throw new ApiError(400, '最多保存 24 个音频片段')
    return items.map(item => {
      object(item)
      if (!audioTracks.has(item.track)) throw new ApiError(400, '音频轨道无效')
      const source = asset(pid, mediaId(item.assetId))
      if (!source.type.startsWith('audio/')) throw new ApiError(422, '音频轨需要音频素材')
      const startMs = count(item.startMs, 0, source.duration_ms - 100, '音频起点超出素材时长')
      const durationMs = count(item.durationMs, 100, Math.min(maxFilmMs, source.duration_ms - startMs), '音频片段须至少 0.1 秒且在素材时长内')
      const offsetMs = count(item.offsetMs, 0, maxFilmMs - durationMs, '音频位置超出 180 秒时间线')
      const volume = count(item.volume, 0, 200, '音频音量应在 0–200% 之间')
      const fadeInMs = count(item.fadeInMs ?? 0, 0, durationMs, '音频淡入时长无效')
      const fadeOutMs = count(item.fadeOutMs ?? 0, 0, durationMs - fadeInMs, '音频淡出时长无效')
      return { track: item.track, assetId: source.id, startMs, durationMs, offsetMs, volume, fadeInMs, fadeOutMs }
    })
  }

  function parseContent(pid, value, board) {
    const allowed = new Set(board.shots.map(shot => shot.id))
    const seen = new Set()
    if (!Array.isArray(value.clips) || value.clips.length > 300) throw new ApiError(400, '时间线镜头无效')
    const clips = value.clips.map(item => {
      object(item)
      if (!allowed.has(item.shotId) || seen.has(item.shotId)) throw new ApiError(400, '镜头须来自此分镜且只使用一次')
      seen.add(item.shotId)
      const assetId = item.assetId == null ? null : mediaId(item.assetId)
      const source = assetId ? asset(pid, assetId) : null
      const startMs = count(item.startMs, 0, 600_000, '片段起点无效')
      const durationMs = count(item.durationMs, 280, maxFilmMs, '单镜时长应在 0.28–180 秒之间')
      if (durationMs % frameMs || (source?.type === 'video/mp4' ? startMs + durationMs > source.duration_ms : startMs !== 0) ||
          source?.type.startsWith('audio/')) throw new ApiError(422, '画面范围超出素材时长或未对齐 40 毫秒帧')
      const motion = item.motion ?? 'none'
      if (!imageMotions.has(motion) || (motion !== 'none' && !source?.type.startsWith('image/'))) {
        throw new ApiError(422, '画面运动须使用静帧素材')
      }
      return { shotId: item.shotId, assetId, startMs, durationMs, caption: string(item.caption ?? '', 500).trim(), motion }
    })
    let narration = null
    if (value.narration != null) {
      const input = object(value.narration)
      const voice = asset(pid, mediaId(input.assetId))
      if (!voice.type.startsWith('audio/')) throw new ApiError(422, '配音轨需要音频素材')
      narration = { assetId: voice.id, startMs: count(input.startMs, 0, voice.duration_ms - 1, '配音起点超出素材时长'),
        volume: count(input.volume, 0, 200, '配音音量应在 0–200% 之间') }
    }
    const audioClips = parseAudio(pid, value.audioClips ?? [])
    const subtitleCues = parseSubtitles(value.subtitleCues)
    const subtitleOutput = value.subtitleOutput ?? 'soft'
    if (subtitleOutput !== 'soft' && subtitleOutput !== 'burn') throw new ApiError(400, '字幕输出方式无效')
    return { clips, narration, audioClips, subtitleCues, subtitleOutput }
  }

  function change(pid, id, value) {
    object(value)
    const mutation = mediaId(value.mutationId)
    const baseRev = count(value.baseRev, 0, Number.MAX_SAFE_INTEGER, '时间线版本无效')
    const boardRev = revision(value.boardRev)
    const fingerprint = hash(JSON.stringify(value))
    return tx(() => {
      const board = boardContext(pid, id)
      const receipt = get('SELECT * FROM media_timeline_receipts WHERE episode_id=? AND mutation=?', id, mutation)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ApiError(409, '时间线请求编号已使用')
        return view(pid, id, board, at(id, receipt.rev))
      }
      const previous = latest(id)
      if (board.current !== boardRev || (previous?.rev ?? 0) !== baseRev) throw new ApiError(409, '分镜或时间线已更新，请重新读取')
      const prior = previous && contentWithDefaults(JSON.parse(previous.content))
      let content
      if (value.action === 'rebase' && previous && previous.board_rev !== boardRev) {
        const retained = new Map(prior.clips.map(clip => [clip.shotId, clip]))
        content = { ...prior, clips: defaultClips(board).map(clip => retained.get(clip.shotId) ?? clip) }
      } else {
        if (value.action !== 'save' || (previous && previous.board_rev !== boardRev)) throw new ApiError(409, '请先复核并更新分镜来源')
        content = { audioClips: prior?.audioClips, subtitleCues: prior?.subtitleCues, subtitleOutput: prior?.subtitleOutput, ...value }
        if (prior && Array.isArray(value.clips)) {
          const retained = new Map(prior.clips.map(clip => [clip.shotId, clip]))
          content.clips = value.clips.map(clip => {
            object(clip)
            const old = retained.get(clip.shotId)
            return old && old.assetId === clip.assetId ? { motion: old.motion, ...clip } : clip
          })
        }
      }
      const payload = JSON.stringify(parseContent(pid, content, board))
      const rev = previous?.board_rev === boardRev && JSON.stringify(prior) === payload ? previous.rev : baseRev + 1
      if (rev !== previous?.rev) run('INSERT INTO media_timelines VALUES (?,?,?,?,?)', id, rev, boardRev, payload, now())
      run('INSERT INTO media_timeline_receipts VALUES (?,?,?,?)', id, mutation, fingerprint, rev)
      return view(pid, id, board, at(id, rev))
    })
  }

  function render(pid, id) {
    const row = get(`SELECT ${jobFields} FROM media_renders WHERE project_id=? AND id=?`, pid, id)
    if (!row) throw new ApiError(404, '成片任务不存在')
    return row
  }

  function manifest(pid, id) {
    render(pid, id)
    return JSON.parse(get('SELECT manifest FROM media_renders WHERE id=?', id).manifest)
  }

  function renders(pid, episodeId) {
    screenplay.episode(pid, episodeId)
    return all(`SELECT ${jobFields} FROM media_renders WHERE project_id=? AND episode_id=? ORDER BY rowid DESC LIMIT 50`, pid, episodeId)
  }

  function enqueue(pid, episodeId, value) {
    object(value)
    const id = mediaId(value.mutationId)
    const fingerprint = hash(JSON.stringify([episodeId, value.rev ?? null, value.retryOf ?? null]))
    return tx(() => {
      const episode = screenplay.episode(pid, episodeId)
      const prior = get('SELECT project_id,fingerprint FROM media_renders WHERE id=?', id)
      if (prior) {
        if (prior.project_id !== pid || prior.fingerprint !== fingerprint) throw new ApiError(409, '成片任务编号已使用')
        return render(pid, id)
      }
      if (get("SELECT COUNT(*) n FROM media_renders WHERE status IN ('queued','running')").n >= 10) throw new ApiError(422, '成片队列最多等待 10 个任务')
      let frozen, rev
      if (value.retryOf != null) {
        const source = render(pid, mediaId(value.retryOf))
        if (source.episode_id !== episodeId || !['failed', 'cancelled', 'interrupted'].includes(source.status)) {
          throw new ApiError(422, '请选择本集可重试的任务')
        }
        rev = source.timeline_rev
        frozen = manifest(pid, source.id)
      } else {
        rev = revision(value.rev)
        const board = boardContext(pid, episodeId)
        const row = latest(episodeId)
        if (!row || row.rev !== rev || row.board_rev !== board.current) throw new ApiError(409, '请保存当前分镜对应的时间线')
        const { clips, narration, audioClips, subtitleCues, subtitleOutput } = contentWithDefaults(JSON.parse(row.content))
        const durationMs = clips.reduce((sum, item) => sum + item.durationMs, 0)
        if (!clips.length || clips.length > 120 || durationMs > maxFilmMs || clips.some(clip => !clip.assetId)) {
          throw new ApiError(422, '成片须含 1–120 个已关联素材的片段，且总长不超过 180 秒')
        }
        if (audioClips.some(item => item.offsetMs + item.durationMs > durationMs) || subtitleCues?.some(cue => cue.endMs > durationMs)) {
          throw new ApiError(422, '请将音频片段和独立字幕调整到成片时长内')
        }
        const [width, height] = sizes[screenplay.details(pid, episode.adaptation_id).aspect]
        frozen = { width, height, durationMs, boardRev: row.board_rev, fps: 25, version: 2, subtitleCues, subtitleOutput,
          clips: clips.map(clip => ({ ...clip, asset: asset(pid, clip.assetId) })),
          narration: narration ? { ...narration, asset: asset(pid, narration.assetId) } : null,
          audioClips: audioClips.map(item => ({ ...item, asset: asset(pid, item.assetId) })) }
      }
      run(`INSERT INTO media_renders (id,project_id,episode_id,timeline_rev,manifest,fingerprint,status,created)
        VALUES (?,?,?,?,?,?,'queued',?)`, id, pid, episodeId, rev, JSON.stringify(frozen), fingerprint, now())
      return render(pid, id)
    })
  }

  function next() {
    return tx(() => {
      const row = get("SELECT id,manifest FROM media_renders WHERE status='queued' ORDER BY rowid LIMIT 1")
      if (!row) return null
      run("UPDATE media_renders SET status='running' WHERE id=?", row.id)
      return { id: row.id, manifest: JSON.parse(row.manifest) }
    })
  }

  function cancel(pid, id) {
    const job = render(pid, id)
    if (job.status === 'queued') run("UPDATE media_renders SET status='cancelled' WHERE id=?", id)
    return render(pid, id)
  }

  const progress = (id, value) => run("UPDATE media_renders SET progress=? WHERE id=? AND status='running'", value, id)
  const fail = (id, status, error) => run("UPDATE media_renders SET status=?,error=? WHERE id=? AND status='running'", status, error, id)
  function finish(id, sha, bytes) {
    checkQuota(sha, bytes)
    run("UPDATE media_renders SET status='done',progress=100,sha=?,bytes=? WHERE id=? AND status='running'", sha, bytes, id)
  }

  return { assets, asset, checkQuota, registerAsset, insertAsset, timeline, change, renders, render, manifest, enqueue, next, cancel, progress, fail, finish }
}
