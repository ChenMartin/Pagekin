import { randomUUID } from 'node:crypto'
import { ApiError, object, revision, string } from './input.mjs'

const formats = { short: '短剧', comic: '漫剧' }
const interiors = { interior: '内景', exterior: '外景', mixed: '内外景' }
const elements = { action: '动作', dialogue: '对白', parenthetical: '括注', transition: '转场', caption: '字幕', note: '注释' }
const episodeLimit = 300
const sceneLimit = 80
const elementLimit = 60
const uuid = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new ApiError(400, '编号无效')
  return value
}

function integer(value, min, max, message) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ApiError(400, message)
  return value
}

function adaptationInput(value) {
  object(value)
  if (typeof value.format !== 'string' || !Object.hasOwn(formats, value.format) || !['9:16', '16:9', '1:1'].includes(value.aspect)) {
    throw new ApiError(400, '改编类型或画幅无效')
  }
  return { title: string(value.title, 160, true).trim(), format: value.format, aspect: value.aspect,
    seconds: integer(value.seconds, 15, 1800, '目标时长应在 15–1800 秒之间') }
}

function editionInput(value) {
  object(value)
  return { season: integer(value.season, 1, 99, '季号应在 1–99 之间'),
    number: integer(value.number, 1, 9999, '集号应在 1–9999 之间'), title: string(value.title, 160, true).trim() }
}

export function screenplayStore({ get, all, run, tx, hash, now }) {
  function list(pid) {
    return all(`SELECT a.*,COUNT(e.id) episodes FROM screenplay_adaptations a LEFT JOIN screenplay_episodes e ON e.adaptation_id=a.id
      WHERE a.project_id=? GROUP BY a.id ORDER BY a.created DESC,a.id`, pid)
  }

  function adaptation(pid, id) {
    const row = get('SELECT * FROM screenplay_adaptations WHERE project_id=? AND id=?', pid, id)
    if (!row) throw new ApiError(404, '改编项目不存在')
    return row
  }

  function details(pid, id) {
    return { ...adaptation(pid, id), episodes: all(`SELECT id,season,number,title,status,rev FROM screenplay_episodes
      WHERE adaptation_id=? ORDER BY season,number`, id) }
  }

  function insertAdaptation(pid, id, { title, format, aspect, seconds }) {
    run('INSERT INTO screenplay_adaptations VALUES (?,?,?,?,?,?,?)', id, pid, title, format, aspect, seconds, now())
  }

  function create(pid, value) {
    const input = adaptationInput(value)
    const id = uuid(value.mutationId)
    return tx(() => {
      const old = get('SELECT * FROM screenplay_adaptations WHERE id=?', id)
      if (old) {
        if (old.project_id !== pid || Object.entries(input).some(([key, field]) => old[key] !== field)) throw new ApiError(409, '改编项目编号已被使用')
        return old
      }
      if (get('SELECT count(*) n FROM screenplay_adaptations WHERE project_id=?', pid).n >= 40) throw new ApiError(422, '每部小说最多创建 40 个改编项目')
      insertAdaptation(pid, id, input)
      return adaptation(pid, id)
    })
  }

  function eligible(pid) {
    return all(`SELECT d.id,d.number,h.rev,h.title FROM documents d JOIN history h ON h.document_id=d.id AND h.rev=(
      SELECT MAX(f.rev) FROM history f WHERE f.document_id=d.id AND f.status='final')
      WHERE d.project_id=? AND d.kind='chapter' ORDER BY d.number`, pid)
  }

  function source(pid, { id, rev }) {
    const row = get(`SELECT d.id,d.number,h.rev,h.title,h.body,
        (SELECT MAX(f.rev) FROM history f WHERE f.document_id=d.id AND f.status='final') latestRev,
        (d.title<>h.title OR d.body<>h.body) differs
      FROM documents d JOIN history h ON h.document_id=d.id
      WHERE d.project_id=? AND d.id=? AND d.kind='chapter' AND h.rev=? AND h.status='final'`, pid, id, rev)
    if (!row) throw new ApiError(400, '改编来源必须是本作品中已有的小说定稿版本')
    const { differs, ...snapshot } = row
    return { ...snapshot, updated: row.latestRev !== row.rev || Boolean(differs) }
  }

  function parseSources(pid, value) {
    if (!Array.isArray(value) || !value.length || value.length > 20) throw new ApiError(400, '请选择 1–20 章小说定稿')
    const sources = value.map(entry => {
      object(entry)
      return { id: uuid(entry.id), rev: revision(entry.rev) }
    })
    if (new Set(sources.map(entry => entry.id)).size !== sources.length) throw new ApiError(400, '每章只能选择一个定稿版本')
    return sources.map(entry => source(pid, entry)).sort((a, b) => a.number - b.number).map(({ id, rev }) => ({ id, rev }))
  }

  function rowFor(pid, id) {
    const row = get(`SELECT e.* FROM screenplay_episodes e JOIN screenplay_adaptations a ON a.id=e.adaptation_id
      WHERE a.project_id=? AND e.id=?`, pid, id)
    if (!row) throw new ApiError(404, '剧本集不存在')
    return row
  }

  function episodeView(pid, row) {
    const { create_hash, ...episode } = row
    return { ...episode, scenes: JSON.parse(row.scenes), sources: JSON.parse(row.sources).map(entry => {
      const { body, ...summary } = source(pid, entry)
      return summary
    }) }
  }

  function episode(pid, id) {
    return episodeView(pid, rowFor(pid, id))
  }

  function episodeSource(pid, id, chapterId) {
    const entry = JSON.parse(rowFor(pid, id).sources).find(item => item.id === chapterId)
    if (!entry) throw new ApiError(404, '该章未关联此集剧本')
    return source(pid, entry)
  }

  function checkpoint(row) {
    run('INSERT INTO screenplay_history VALUES (?,?,?,?,?,?)', row.id, row.rev, row.title, row.scenes, row.status, row.updated)
  }

  function insertEpisode(adaptationId, id, number, season, sources, fingerprint, current) {
    if (get('SELECT 1 FROM screenplay_episodes WHERE adaptation_id=? AND season=? AND number=?', adaptationId, season, number)) {
      throw new ApiError(409, '该季已存在此集号')
    }
    run('INSERT INTO screenplay_episodes VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, adaptationId, season, number, JSON.stringify(sources), fingerprint,
      current.title, current.scenes, current.rev, current.status, current.updated)
  }

  function createEpisode(pid, adaptationId, value) {
    const { title, season, number } = editionInput(value)
    const id = uuid(value.mutationId)
    return tx(() => {
      adaptation(pid, adaptationId)
      const sources = parseSources(pid, value.sources)
      const fingerprint = hash(JSON.stringify([adaptationId, season, number, title, sources]))
      const old = get('SELECT * FROM screenplay_episodes WHERE id=?', id)
      if (old) {
        if (old.create_hash !== fingerprint) throw new ApiError(409, '剧本集编号已被使用')
        return episodeView(pid, old)
      }
      if (get('SELECT count(*) n FROM screenplay_episodes WHERE adaptation_id=?', adaptationId).n >= episodeLimit) throw new ApiError(422, '每个改编项目最多 300 集')
      const current = { id, title, scenes: '[]', rev: 1, status: 'draft', updated: now() }
      insertEpisode(adaptationId, id, number, season, sources, fingerprint, current)
      checkpoint(current)
      return episode(pid, id)
    })
  }

  function parseScenes(pid, value, sources) {
    if (!Array.isArray(value) || value.length > sceneLimit) throw new ApiError(400, '每集最多 80 个场次')
    const chapterIds = new Set(sources.map(entry => entry.id))
    const ids = new Set()
    const cast = new Map()
    function unique(value) {
      const id = uuid(value)
      if (ids.has(id)) throw new ApiError(400, '场次或元素编号重复')
      ids.add(id)
      return id
    }
    const scenes = value.map(scene => {
      object(scene)
      if (typeof scene.interior !== 'string' || !Object.hasOwn(interiors, scene.interior) || !Array.isArray(scene.elements) || scene.elements.length > elementLimit ||
          !Array.isArray(scene.sourceIds) || scene.sourceIds.some(id => !chapterIds.has(id)) ||
          new Set(scene.sourceIds).size !== scene.sourceIds.length) throw new ApiError(400, '场次格式、剧本元素数量或来源无效')
      return { id: unique(scene.id), title: string(scene.title, 160).trim(), location: string(scene.location, 120).trim(),
        time: string(scene.time, 80).trim(), interior: scene.interior, sourceIds: scene.sourceIds,
        elements: scene.elements.map(item => {
          object(item)
          if (typeof item.type !== 'string' || !Object.hasOwn(elements, item.type)) throw new ApiError(400, '剧本元素类型无效')
          const id = unique(item.id)
          const text = string(item.text, 6000)
          if (item.type !== 'dialogue') return { id, type: item.type, text }
          const characterId = item.characterId == null ? null : uuid(item.characterId)
          let speaker = string(item.speaker ?? '', 160).trim()
          if (characterId) {
            if (!cast.has(characterId)) {
              const card = get("SELECT title FROM documents WHERE project_id=? AND id=? AND kind='character'", pid, characterId)
              if (!card) throw new ApiError(400, '对白引用的人物卡不属于本作品')
              cast.set(characterId, card.title)
            }
            speaker ||= cast.get(characterId)
          }
          return { id, type: item.type, text, speaker, characterId }
        }) }
    })
    return string(JSON.stringify(scenes), 180_000)
  }

  function checkConfirmation(scenes) {
    const rows = JSON.parse(scenes)
    if (!rows.length || rows.some(scene => !scene.title || !scene.location || !scene.time || !scene.elements.length ||
      scene.elements.some(item => !item.text.trim() || (item.type === 'dialogue' && !item.speaker)))) {
      throw new ApiError(422, '确认前请填写每场的标题、地点、时间和剧本内容，为对白填写说话人')
    }
  }

  function history(pid, id) {
    rowFor(pid, id)
    return all('SELECT rev,title,status,updated FROM screenplay_history WHERE episode_id=? ORDER BY rev DESC', id)
  }

  function version(pid, id, rev) {
    rowFor(pid, id)
    const row = get('SELECT rev,title,scenes,status,updated FROM screenplay_history WHERE episode_id=? AND rev=?', id, revision(rev))
    if (!row) throw new ApiError(404, '剧本历史版本不存在')
    return { ...row, scenes: JSON.parse(row.scenes) }
  }

  function changeEpisode(pid, id, value, operation) {
    object(value)
    const baseRev = revision(value.baseRev)
    const mutation = uuid(value.mutationId)
    const fingerprint = hash(JSON.stringify([operation, value]))
    return tx(() => {
      const current = rowFor(pid, id)
      const receipt = get('SELECT fingerprint,rev FROM screenplay_receipts WHERE episode_id=? AND mutation=?', id, mutation)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ApiError(409, '该保存请求编号已被使用')
        const saved = get('SELECT rev,title,scenes,status,updated FROM screenplay_history WHERE episode_id=? AND rev=?', id, receipt.rev)
        return episodeView(pid, { ...current, ...saved })
      }
      if (current.rev !== baseRev) throw new ApiError(409, 'NAS 上已有新的剧本版本', episodeView(pid, current))
      const next = { ...current }
      if (operation === 'reopen') {
        if (current.status !== 'confirmed') throw new ApiError(422, '只有已确认的剧本可以重开')
        next.status = 'draft'
      } else {
        if (current.status !== 'draft') throw new ApiError(409, '请先重开已确认的剧本', episodeView(pid, current))
        if (operation === 'save') {
          next.title = string(value.title, 160, true).trim()
          next.scenes = parseScenes(pid, value.scenes, JSON.parse(current.sources))
        } else if (operation === 'confirm') {
          checkConfirmation(current.scenes)
          next.status = 'confirmed'
        } else if (operation === 'restore') {
          const old = get('SELECT title,scenes FROM screenplay_history WHERE episode_id=? AND rev=?', id, revision(value.rev))
          if (!old) throw new ApiError(404, '剧本历史版本不存在')
          Object.assign(next, old)
        } else throw new ApiError(400, '剧本操作无效')
      }
      if (next.title !== current.title || next.scenes !== current.scenes || next.status !== current.status) {
        next.rev++
        next.updated = now()
        run('UPDATE screenplay_episodes SET title=?,scenes=?,status=?,rev=?,updated=? WHERE id=?', next.title, next.scenes, next.status, next.rev, next.updated, id)
        checkpoint(next)
      }
      run('INSERT INTO screenplay_receipts VALUES (?,?,?,?)', id, mutation, fingerprint, next.rev)
      return episodeView(pid, next)
    })
  }

  function exportEpisode(pid, id) {
    const data = episode(pid, id)
    const info = adaptation(pid, data.adaptation_id)
    const text = [`# ${data.title}`, `第 ${data.season} 季 · 第 ${data.number} 集 · ${formats[info.format]} · ${info.aspect} · ${info.seconds} 秒`,
      `${data.status === 'confirmed' ? '已确认' : '草稿'} · v${data.rev}`,
      '小说来源：' + data.sources.map(entry => `第 ${entry.number} 章 ${entry.title} v${entry.rev}`).join('、')]
    data.scenes.forEach((scene, i) => {
      text.push(`## ${i + 1}. ${scene.title || '未命名场次'}`, [interiors[scene.interior], scene.location, scene.time].filter(Boolean).join(' · '))
      for (const item of scene.elements) text.push(item.type === 'dialogue' ? `**${item.speaker || '未填说话人'}**\n\n${item.text}`
        : item.type === 'action' ? item.text : `${elements[item.type]} · ${item.text}`)
    })
    return text.join('\n\n') + '\n'
  }

  function backup(pid) {
    return list(pid).map(({ id, title, format, aspect, seconds }) => ({ title, format, aspect, seconds,
      episodes: all(`SELECT id,season,number,sources,title,scenes,rev,status,updated FROM screenplay_episodes
        WHERE adaptation_id=? ORDER BY season,number`, id).map(({ id, ...row }) => ({ ...row, sources: JSON.parse(row.sources),
        scenes: JSON.parse(row.scenes), history: all(`SELECT rev,title,scenes,status,updated FROM screenplay_history
          WHERE episode_id=? ORDER BY rev DESC`, id).map(snapshot => ({ ...snapshot, scenes: JSON.parse(snapshot.scenes) })) })) }))
  }

  function importBackup(pid, value, mapping) {
    if (!Array.isArray(value) || value.length > 40) throw new ApiError(400, '备份中的改编项目列表无效')
    const remap = id => {
      if (!mapping.has(id)) throw new ApiError(400, '备份中的改编来源或人物卡不存在')
      return mapping.get(id)
    }
    for (const entry of value) {
      const input = adaptationInput(entry)
      if (!Array.isArray(entry.episodes) || entry.episodes.length > episodeLimit) throw new ApiError(400, '备份中的剧本集列表无效')
      const adaptationId = randomUUID()
      insertAdaptation(pid, adaptationId, input)
      for (const original of entry.episodes) {
        const { season, number } = editionInput(original)
        const id = randomUUID()
        if (!Array.isArray(original.sources) || !Array.isArray(original.history)) throw new ApiError(400, '剧本备份来源或历史无效')
        const sources = parseSources(pid, original.sources.map(entry => ({ ...object(entry), id: remap(entry.id) })))
        function snapshot(row) {
          object(row)
          if (!['draft', 'confirmed'].includes(row.status) || !Array.isArray(row.scenes)) throw new ApiError(400, '剧本备份版本无效')
          const scenes = parseScenes(pid, row.scenes.map(scene => {
            object(scene)
            if (!Array.isArray(scene.sourceIds) || !Array.isArray(scene.elements)) throw new ApiError(400, '剧本备份场次无效')
            return { ...scene, sourceIds: scene.sourceIds.map(remap), elements: scene.elements.map(item => {
              object(item)
              return item.characterId == null ? item : { ...item, characterId: remap(item.characterId) }
            }) }
          }), sources)
          if (row.status === 'confirmed') checkConfirmation(scenes)
          return { id, rev: revision(row.rev), title: string(row.title, 160, true).trim(), status: row.status, scenes,
            updated: string(row.updated, 50, true) }
        }
        const current = snapshot(original)
        insertEpisode(adaptationId, id, number, season, sources, '', current)
        const seen = new Set()
        for (const entry of original.history) {
          const row = snapshot(entry)
          if (seen.has(row.rev) || row.rev > current.rev || (row.rev === current.rev && JSON.stringify(row) !== JSON.stringify(current))) {
            throw new ApiError(400, '剧本备份历史与当前版本不一致')
          }
          seen.add(row.rev)
          checkpoint(row)
        }
        if (!seen.has(current.rev)) throw new ApiError(400, '剧本备份缺少当前版本')
      }
    }
  }

  return { list, details, create, eligible, createEpisode, episode, episodeSource, changeEpisode, history, version, exportEpisode, backup, importBackup }
}
