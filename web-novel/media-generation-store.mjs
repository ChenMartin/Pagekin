import { randomUUID } from 'node:crypto'
import { ApiError, object, revision, string } from './input.mjs'
import { mediaId } from './media-store.mjs'

export const mediaGenerationSchema = `
  CREATE TABLE media_generations (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    episode_id TEXT NOT NULL REFERENCES screenplay_episodes(id), kind TEXT NOT NULL CHECK(kind IN ('image','video','speech')),
    manifest TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, external_id TEXT UNIQUE, external_version TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, updated TEXT NOT NULL
  );
  CREATE INDEX media_generation_queue ON media_generations(state,next_at);
  CREATE INDEX media_generation_episode ON media_generations(project_id,episode_id,created);
  CREATE TABLE media_generation_variants (
    job_id TEXT NOT NULL REFERENCES media_generations(id), ordinal INTEGER NOT NULL, sha TEXT NOT NULL,
    type TEXT NOT NULL, bytes INTEGER NOT NULL, duration_ms INTEGER NOT NULL, width INTEGER, height INTEGER,
    adopted_asset_id TEXT REFERENCES media_assets(id), PRIMARY KEY(job_id,ordinal)
  );
`

const active = "state IN ('queued','submitting','waiting')"
const taskFields = 'id,episode_id,kind,state,external_id,external_version,cancel_requested,error,created,updated'
const kinds = ['image', 'video', 'speech']
const labels = { image: '生成图像', video: '生成视频', speech: '生成配音' }

export function openGenerationStore({ get, all, run, tx, hash, now, screenplay, media }) {
  function raw(pid, id) {
    const row = get('SELECT * FROM media_generations WHERE project_id=? AND id=?', pid, id)
    if (!row) throw new ApiError(404, '媒体生成任务不存在')
    return row
  }

  function variants(id) {
    return all('SELECT * FROM media_generation_variants WHERE job_id=? ORDER BY ordinal', id)
  }

  function detail(pid, id) {
    const { project_id, fingerprint, next_at, failures, manifest, ...task } = raw(pid, id)
    return { ...task, manifest: JSON.parse(manifest), variants: variants(id) }
  }

  function list(pid, episodeId) {
    screenplay.episode(pid, episodeId)
    return all(`SELECT ${taskFields} FROM media_generations WHERE project_id=? AND episode_id=? ORDER BY rowid DESC LIMIT 50`, pid, episodeId)
  }

  function prepare(pid, id, value, provider) {
    object(value)
    if (!kinds.includes(value.kind)) throw new ApiError(400, '媒体生成类型无效')
    const episode = screenplay.episode(pid, id)
    const timeline = media.timeline(pid, id)
    const boardRev = revision(value.boardRev)
    if (timeline.currentBoardRev !== boardRev || timeline.stale || timeline.rev !== value.timelineRev) {
      throw new ApiError(409, '分镜或时间线已更新，请重新预览')
    }
    const shotId = value.shotId == null ? null : mediaId(value.shotId)
    if ((value.kind !== 'speech' && !shotId) || (shotId && !timeline.shots.some(shot => shot.id === shotId))) {
      throw new ApiError(400, '请选择当前分镜中的镜头')
    }
    const aspect = screenplay.details(pid, episode.adaptation_id).aspect
    const manifest = { kind: value.kind, boardRev, timelineRev: timeline.rev, shotId,
      ...provider.prepare(value.kind, value.prompt, aspect) }
    return { manifest, approval: hash(JSON.stringify(manifest)) }
  }

  function ensureCapacity() {
    if (get(`SELECT COUNT(*) n FROM media_generations WHERE ${active}`).n >= 6) throw new ApiError(429, '媒体生成队列最多同时处理 6 个任务')
  }

  function enqueue(pid, episodeId, value, provider) {
    const id = mediaId(object(value).mutationId)
    const fingerprint = hash(JSON.stringify([episodeId, value.kind, value.boardRev, value.timelineRev, value.shotId ?? null, value.prompt, value.approval]))
    return tx(() => {
      const previous = get('SELECT project_id,fingerprint FROM media_generations WHERE id=?', id)
      if (previous) {
        if (previous.project_id !== pid || previous.fingerprint !== fingerprint) throw new ApiError(409, '媒体生成编号已使用')
        return detail(pid, id)
      }
      const { manifest, approval } = prepare(pid, episodeId, value, provider)
      if (approval !== value.approval) throw new ApiError(409, '媒体生成输入已变更，请重新预览确认')
      ensureCapacity()
      const timestamp = now()
      run(`INSERT INTO media_generations (id,project_id,episode_id,kind,manifest,fingerprint,state,created,updated)
        VALUES (?,?,?,?,?,?,'queued',?,?)`, id, pid, episodeId, value.kind, JSON.stringify(manifest), fingerprint, timestamp, timestamp)
      return detail(pid, id)
    })
  }

  function claim(time) {
    return tx(() => {
      const row = get(`SELECT * FROM media_generations WHERE state IN ('waiting','queued') AND next_at<=?
        ORDER BY CASE WHEN cancel_requested=1 THEN 0 WHEN state='waiting' THEN 1 ELSE 2 END,next_at,rowid LIMIT 1`, time)
      if (!row) return null
      if (row.state === 'queued') run("UPDATE media_generations SET state='submitting',updated=? WHERE id=?", now(), row.id)
      return { ...row, manifest: JSON.parse(row.manifest) }
    })
  }

  function external(id, externalId, version) {
    run(`UPDATE media_generations SET external_id=?,external_version=?,state='waiting',next_at=0,failures=0,error='',updated=?
      WHERE id=?`, externalId, version, now(), id)
  }

  function linked(pid, id, externalId, version) {
    return tx(() => {
      if (raw(pid, id).state !== 'unknown') throw new ApiError(409, '此任务已有明确提交状态')
      if (get('SELECT id FROM media_generations WHERE external_id=?', externalId)) throw new ApiError(409, '供应商编号已关联其他任务')
      ensureCapacity()
      external(id, externalId, version)
      return detail(pid, id)
    })
  }

  function settle(id, state, error = '') {
    run(`UPDATE media_generations SET state=?,error=?,cancel_requested=CASE WHEN ?='unknown' THEN cancel_requested ELSE 0 END,
      updated=? WHERE id=?`, state, error, state, now(), id)
  }

  function wait(id, next, failures = 0, error = '') {
    run('UPDATE media_generations SET next_at=?,failures=?,error=?,updated=? WHERE id=?', next, failures, error, now(), id)
  }

  function cancel(pid, id) {
    return tx(() => {
      const row = raw(pid, id)
      if (row.state === 'queued') settle(id, 'cancelled')
      else if (['waiting', 'submitting'].includes(row.state)) {
        run('UPDATE media_generations SET cancel_requested=1,next_at=0,updated=? WHERE id=?', now(), id)
      }
      return detail(pid, id)
    })
  }

  function consumeCancel(id) {
    return !!run('UPDATE media_generations SET cancel_requested=0,updated=? WHERE id=? AND cancel_requested=1', now(), id).changes
  }

  function resume(pid, id) {
    return tx(() => {
      const row = raw(pid, id)
      if (!row.external_id || !['recover', 'poll_paused'].includes(row.state)) throw new ApiError(422, '此任务当前无法重新回收')
      ensureCapacity()
      external(id, row.external_id, row.external_version)
      return detail(pid, id)
    })
  }

  function variant(pid, id, ordinal) {
    raw(pid, id)
    const row = get('SELECT * FROM media_generation_variants WHERE job_id=? AND ordinal=?', id, revision(ordinal))
    if (!row) throw new ApiError(404, '生成素材不存在')
    return row
  }

  function addVariant(id, ordinal, file) {
    run(`INSERT INTO media_generation_variants (job_id,ordinal,sha,type,bytes,duration_ms,width,height)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(job_id,ordinal) DO NOTHING`, id, ordinal, file.sha, file.type, file.bytes, file.durationMs, file.width, file.height)
  }

  function adopt(pid, id, ordinal, value) {
    object(value)
    return tx(() => {
      const task = raw(pid, id)
      const row = variant(pid, id, ordinal)
      if (row.adopted_asset_id) return media.asset(pid, row.adopted_asset_id)
      const name = string(value.name ?? `${labels[task.kind]} ${task.id.slice(0, 8)}-${ordinal}`, 160, true).trim()
      const asset = media.insertAsset(pid, randomUUID(), { ...row, name, durationMs: row.duration_ms })
      run('UPDATE media_generation_variants SET adopted_asset_id=? WHERE job_id=? AND ordinal=?', asset.id, id, ordinal)
      return asset
    })
  }

  return { detail, list, prepare, enqueue, claim, external, linked, settle, wait, cancel, consumeCancel, resume, variants, variant, addVariant, adopt }
}
