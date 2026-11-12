import { ApiError, object, revision, string } from './input.mjs'

export const storyboardSchema = `
  CREATE TABLE storyboard_history (
    episode_id TEXT NOT NULL REFERENCES screenplay_episodes(id) ON DELETE CASCADE,
    rev INTEGER NOT NULL, script_rev INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','confirmed')),
    shots TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(episode_id,rev),
    FOREIGN KEY(episode_id,script_rev) REFERENCES screenplay_history(episode_id,rev)
  );
  CREATE TABLE storyboard_receipts (
    episode_id TEXT NOT NULL, mutation TEXT NOT NULL, fingerprint TEXT NOT NULL, rev INTEGER NOT NULL,
    PRIMARY KEY(episode_id,mutation), FOREIGN KEY(episode_id,rev) REFERENCES storyboard_history(episode_id,rev) ON DELETE CASCADE
  );
`

export const shotSizes = { wide: '全景', full: '全身', medium: '中景', close: '近景', detail: '特写' }
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu
const sceneCast = scene => new Set(scene.elements.map(item => item.characterId).filter(Boolean))

export function openStoryboard({ get, all, run, tx, hash, now, screenplay }) {
  const latest = id => get('SELECT * FROM storyboard_history WHERE episode_id=? ORDER BY rev DESC LIMIT 1', id)
  const at = (id, rev) => get('SELECT * FROM storyboard_history WHERE episode_id=? AND rev=?', id, rev)

  function view(pid, episode, row) {
    const current = episode.status === 'confirmed' ? episode.rev : null
    const scriptRev = row?.script_rev ?? current
    const scenes = scriptRev === null ? [] : scriptRev === current ? episode.scenes : screenplay.version(pid, episode.id, scriptRev).scenes
    const targets = new Map(episode.scenes.map(scene => [scene.id, scene]))
    const changed = row && current !== scriptRev ? scenes.filter(scene => JSON.stringify(scene) !== JSON.stringify(targets.get(scene.id)))
      .map(scene => scene.id) : []
    return { episodeId: episode.id, title: episode.title, rev: row?.rev ?? 0, scriptRev, currentScriptRev: current,
      stale: !!row && scriptRev !== current, status: row?.status ?? 'draft', shots: row ? JSON.parse(row.shots) : [],
      updated: row?.updated ?? null, scenes, changed, removed: scenes.filter(scene => !targets.has(scene.id)).map(scene => scene.id) }
  }

  function detail(pid, id, rev) {
    const episode = screenplay.episode(pid, id)
    const row = rev === undefined ? latest(id) : at(id, revision(rev))
    if (rev !== undefined && !row) throw new ApiError(404, '分镜历史版本不存在')
    return view(pid, episode, row)
  }

  function parseShots(shots, scenes, confirmed = false) {
    if (!Array.isArray(shots) || shots.length > 300) throw new ApiError(400, '每集最多 300 个镜头')
    const ids = new Set()
    const casts = new Map(scenes.map(scene => [scene.id, sceneCast(scene)]))
    const byScene = new Set()
    const checked = shots.map(item => {
      object(item)
      if (typeof item.id !== 'string' || !uuid.test(item.id) || ids.has(item.id) || !casts.has(item.sceneId) ||
          typeof item.size !== 'string' || !Object.hasOwn(shotSizes, item.size) || !Number.isInteger(item.durationMs) || item.durationMs < 250 || item.durationMs > 180_000) {
        throw new ApiError(400, '镜头编号、场次、景别或时长无效')
      }
      const characters = item.characterIds ?? []
      const cast = casts.get(item.sceneId)
      if (!Array.isArray(characters) || new Set(characters).size !== characters.length || characters.some(id => !cast.has(id))) {
        throw new ApiError(400, '镜头人物须来自所属场次')
      }
      ids.add(item.id)
      byScene.add(item.sceneId)
      return { id: item.id, sceneId: item.sceneId, size: item.size, durationMs: item.durationMs,
        visual: string(item.visual, 2000, confirmed).trim(), camera: string(item.camera ?? '', 200).trim(),
        movement: string(item.movement ?? '', 200).trim(), dialogue: string(item.dialogue ?? '', 1500).trim(),
        prompt: string(item.prompt ?? '', 3000).trim(), characterIds: characters }
    })
    if (confirmed && scenes.some(scene => !byScene.has(scene.id))) throw new ApiError(422, '确认前请为每个场次填写镜头')
    return string(JSON.stringify(checked), 180_000)
  }

  function append(id, scriptRev, status, shots, rev, updated = now()) {
    run('INSERT INTO storyboard_history VALUES (?,?,?,?,?,?)', id, rev, scriptRev, status, shots, updated)
    return at(id, rev)
  }

  function currentEpisode(pid, id, rev) {
    const episode = screenplay.episode(pid, id)
    if (episode.status !== 'confirmed' || episode.rev !== revision(rev)) throw new ApiError(409, '剧本已更新，请使用当前已确认版本')
    return episode
  }

  function match(row, baseRev) {
    if (!Number.isSafeInteger(baseRev) || baseRev < 0) throw new ApiError(400, '分镜版本无效')
    if ((row?.rev ?? 0) !== baseRev) throw new ApiError(409, 'NAS 上已有新的分镜版本')
  }

  function change(pid, id, value) {
    object(value)
    const mutation = value.mutationId
    if (typeof mutation !== 'string' || !uuid.test(mutation)) throw new ApiError(400, '分镜保存编号无效')
    const fingerprint = hash(JSON.stringify(value))
    return tx(() => {
      const episode = screenplay.episode(pid, id)
      const receipt = get('SELECT * FROM storyboard_receipts WHERE episode_id=? AND mutation=?', id, mutation)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ApiError(409, '分镜保存编号已被使用')
        return view(pid, episode, at(id, receipt.rev))
      }
      currentEpisode(pid, id, value.scriptRev)
      const old = latest(id)
      match(old, value.baseRev)
      let status = 'draft'
      let shots
      if (value.action === 'rebase' && old && old.script_rev !== episode.rev) {
        const casts = new Map(episode.scenes.map(scene => [scene.id, sceneCast(scene)]))
        const prior = JSON.parse(old.shots)
        if (prior.some(shot => !casts.has(shot.sceneId)) && value.dropRemoved !== true) {
          throw new ApiError(422, '请确认移除已删除场次的镜头，旧版本仍可查阅')
        }
        shots = prior.filter(shot => casts.has(shot.sceneId)).map(shot => ({ ...shot,
          characterIds: shot.characterIds.filter(id => casts.get(shot.sceneId).has(id)) }))
      } else {
        if (old && old.script_rev !== episode.rev) throw new ApiError(409, '请先复核并更新分镜来源')
        if (value.action === 'reopen' && old?.status === 'confirmed') shots = JSON.parse(old.shots)
        else {
          if (old?.status === 'confirmed') throw new ApiError(409, '请先重开已确认的分镜')
          if (value.action === 'save') shots = value.shots
          else if (value.action === 'confirm' && old) { shots = JSON.parse(old.shots); status = 'confirmed' }
          else if (value.action === 'restore') {
            const prior = at(id, revision(value.rev))
            if (!prior || prior.script_rev !== episode.rev) throw new ApiError(422, '请选择与当前剧本关联的分镜历史版本')
            shots = JSON.parse(prior.shots)
          } else throw new ApiError(400, '分镜操作无效')
        }
      }
      const content = parseShots(shots, episode.scenes, status === 'confirmed')
      const row = old && old.script_rev === episode.rev && old.status === status && old.shots === content ? old
        : append(id, episode.rev, status, content, (old?.rev ?? 0) + 1)
      run('INSERT INTO storyboard_receipts VALUES (?,?,?,?)', id, mutation, fingerprint, row.rev)
      return view(pid, episode, row)
    })
  }

  function sceneInput(pid, id, scriptRev, baseRev, sceneId) {
    const episode = currentEpisode(pid, id, scriptRev)
    const old = latest(id)
    match(old, baseRev)
    if (old && (old.status === 'confirmed' || old.script_rev !== scriptRev)) throw new ApiError(409, '请先重开分镜或复核来源')
    const scene = episode.scenes.find(row => row.id === sceneId)
    if (!scene) throw new ApiError(404, '场次不存在')
    return { episode, scene, old }
  }

  function adoptShots(pid, id, request, shots) {
    const { episode, scene, old } = sceneInput(pid, id, request.scriptRev, request.baseRev, request.sceneId)
    const others = old ? JSON.parse(old.shots).filter(shot => shot.sceneId !== scene.id) : []
    const content = parseShots([...others, ...shots], episode.scenes)
    return view(pid, episode, append(id, episode.rev, 'draft', content, (old?.rev ?? 0) + 1))
  }

  function history(pid, id) {
    screenplay.episode(pid, id)
    return all('SELECT rev,script_rev,status,updated FROM storyboard_history WHERE episode_id=? ORDER BY rev DESC LIMIT 100', id)
  }

  function backup(id) {
    return all('SELECT rev,script_rev,status,shots,updated FROM storyboard_history WHERE episode_id=? ORDER BY rev', id)
      .map(row => ({ ...row, shots: JSON.parse(row.shots) }))
  }

  function importBackup(pid, id, rows, mapping) {
    if (!Array.isArray(rows) || rows.length > 3000) throw new ApiError(400, '备份中的分镜历史无效')
    let last = 0
    for (const row of rows) {
      object(row)
      if (revision(row.rev) !== last + 1 || !['draft', 'confirmed'].includes(row.status) || !Array.isArray(row.shots)) {
        throw new ApiError(400, '备份中的分镜版本无效')
      }
      const script = screenplay.version(pid, id, row.script_rev)
      if (script.status !== 'confirmed') throw new ApiError(400, '备份中的分镜来源须为已确认剧本')
      const shots = row.shots.map(item => {
        object(item)
        if (!Array.isArray(item.characterIds)) throw new ApiError(400, '备份中的镜头人物无效')
        return { ...item, characterIds: item.characterIds.map(character => mapping.get(character)) }
      })
      append(id, row.script_rev, row.status, parseShots(shots, script.scenes, row.status === 'confirmed'), row.rev,
        string(row.updated, 50, true))
      last = row.rev
    }
  }

  function exportMarkdown(pid, id, rev) {
    const board = detail(pid, id, rev)
    const text = [`# ${board.title} · 分镜`, `分镜 v${board.rev} · 剧本 v${board.scriptRev ?? '—'}`]
    for (const scene of board.scenes) {
      text.push(`## ${scene.title}`)
      board.shots.filter(shot => shot.sceneId === scene.id).forEach((shot, index) => {
        text.push(`### ${index + 1}. ${shotSizes[shot.size]} · ${shot.durationMs / 1000} 秒`, shot.visual,
          ...[shot.camera && '机位：' + shot.camera, shot.movement && '运镜：' + shot.movement,
            shot.dialogue && '对白：' + shot.dialogue, shot.prompt && '提示词：' + shot.prompt].filter(Boolean))
      })
    }
    return text.join('\n\n') + '\n'
  }

  return { detail, change, sceneInput, adoptShots, parseShots, history, backup, importBackup, exportMarkdown }
}
