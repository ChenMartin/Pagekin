import { ui } from './locale.mjs'
import { mediaGenerationWorkspace } from './media-generation-ui.mjs'

const statuses = { queued: '等待渲染', running: '正在渲染', done: '成片已就绪', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
const ms = input => Math.round(input.valueAsNumber * 1000)

function node(tag, text = '') {
  const element = document.createElement(tag)
  element.textContent = text
  return element
}

function field(text, input) {
  const label = node('label', ui(text))
  label.append(input)
  return label
}

export function mediaWorkspace({ api, dialog, actionButton, localTransaction, uuid, isCurrent }) {
  const generation = mediaGenerationWorkspace({ api, dialog, actionButton, uuid, isCurrent })
  let active
  const modal = () => document.getElementById('dialog')
  const visible = (state, panel = state.panel) => panel?.isConnected && modal().open && isCurrent(state.pid)
  const projectPath = pid => `/projects/${pid}`
  const assetPath = state => projectPath(state.pid) + '/media-assets'
  const jobPath = (state, id) => projectPath(state.pid) + '/media-renders/' + id

  async function open(pid, id, back) {
    const path = `${projectPath(pid)}/episodes/${id}`
    const [base, assets, capability, drafts] = await Promise.all([api(path + '/timeline'), api(projectPath(pid) + '/media-assets'),
      api('/media-capabilities'), localTransaction('readonly', store => store.index('document').getAll(id)).catch(() => [])])
    if (!isCurrent(pid)) return
    const recovery = drafts.filter(row => row.scope === 'timeline' && (row.baseRev !== base.rev ||
      JSON.stringify(row.clips) !== JSON.stringify(base.clips) || JSON.stringify(row.narration) !== JSON.stringify(base.narration)))
      .sort((a, b) => b.updated - a.updated)
    render({ pid, id, path, back, base, assets, capability, recovery, key: 'timeline:' + uuid(),
      clips: structuredClone(base.clips), narration: structuredClone(base.narration), selected: 0, dirty: false })
  }

  function paint(state) {
    state.status.textContent = [state.base.rev ? ui('时间线 v$1', state.base.rev) : ui('新时间线'),
      state.base.boardRev && ui('分镜 v$1', state.base.boardRev), state.base.stale && ui('分镜来源待复核'),
      state.dirty && ui(state.localOk === true ? '本机草稿' : state.localOk === false ? '本机保存失败' : '本机草稿保存中')].filter(Boolean).join(' · ')
    if (state.total) state.total.textContent = ui('$1 段 · $2 秒', state.clips.length,
      state.clips.reduce((sum, clip) => sum + (clip.durationMs || 0), 0) / 1000)
    if (state.editor) state.editor.disabled = state.busy
    for (const button of state.recoverButtons ?? []) button.disabled = state.dirty || state.busy
    if (state.launch) state.launch.disabled = state.busy || state.dirty || !state.base.rev || !state.capability.available
    if (visible(state) && state.editable) document.getElementById('dialog-submit').hidden = !state.dirty
  }

  function persist(state) {
    const record = { scope: 'timeline', key: state.key, document: state.id, baseRev: state.base.rev, boardRev: state.base.boardRev,
      clips: structuredClone(state.clips), narration: structuredClone(state.narration), updated: Date.now() }
    const writing = localTransaction('readwrite', store => state.dirty ? store.put(record) : store.delete(record.key)).then(() => true, () => false)
    state.writing = writing
    void writing.then(ok => { if (state.writing === writing) { state.localOk = ok; paint(state) } })
    return writing
  }

  function edit(state, redraw = false) {
    state.dirty = true
    state.localOk = null
    void persist(state)
    if (redraw) render(state)
    else paint(state)
  }

  async function canLeave(state) {
    if (!state?.dirty || await state.writing || await persist(state)) return true
    state.error.textContent = ui('无法保存本机草稿。请先保存到 NAS，或复制当前编辑内容。')
    return false
  }

  window.addEventListener('beforeunload', event => {
    if (visible(active ?? {}) && active.dirty && !active.localOk) { event.preventDefault(); event.returnValue = '' }
  })
  modal().addEventListener('cancel', event => {
    const state = active
    if (!visible(state ?? {}) || !state.dirty || state.localOk) return
    event.preventDefault()
    void canLeave(state).then(ok => { if (ok && visible(state)) modal().close() })
  })

  async function save(state, action) {
    if (state.busy || (action === 'save' && !state.dirty)) return
    const value = { action, baseRev: state.base.rev, boardRev: state.base.currentBoardRev,
      ...(action === 'save' ? { clips: state.clips, narration: state.narration } : {}) }
    const key = JSON.stringify(value)
    if (state.pending?.key !== key) state.pending = { key, id: uuid() }
    const panel = state.panel
    state.busy = true
    state.error.textContent = ''
    paint(state)
    try {
      state.base = await api(state.path + '/timeline', 'PUT', { ...value, mutationId: state.pending.id })
      state.clips = structuredClone(state.base.clips)
      state.narration = structuredClone(state.base.narration)
      state.dirty = false
      state.pending = null
      await persist(state)
      if (state.recovered) {
        const record = state.recovered
        await localTransaction('readwrite', store => {
          const request = store.get(record.key)
          request.onsuccess = () => { if (request.result?.updated === record.updated) store.delete(record.key) }
          return request
        }).catch(() => {})
        state.recovery = state.recovery.filter(row => row.key !== record.key)
        state.recovered = null
      }
    } catch (error) { state.error.textContent = error.message }
    finally {
      state.busy = false
      if (visible(state, panel) && !state.dirty && !state.error.textContent) render(state)
      else paint(state)
    }
  }

  function preview(state, asset) {
    const item = node(asset.type.startsWith('image/') ? 'img' : asset.type.startsWith('audio/') ? 'audio' : 'video')
    item.className = 'media-preview'
    item.src = '/api' + assetPath(state) + '/' + asset.id + '/file'
    if (item.tagName === 'IMG') item.alt = asset.name
    else { item.controls = true; item.preload = 'metadata'; item.playsInline = true }
    return item
  }

  function library(state) {
    const list = node('div')
    list.className = 'batch-list'
    for (const asset of state.assets) {
      list.append(actionButton(asset.name, () => dialog(asset.name, [preview(state, asset), actionButton(ui('返回素材库'), () => library(state))])))
    }
    const file = node('input')
    file.id = 'media-upload-file'
    file.type = 'file'
    file.accept = '.png,.jpg,.jpeg,.mp4,.wav,.mp3'
    file.required = true
    const status = node('p')
    status.setAttribute('role', 'status')
    let pending
    dialog(ui('素材库'), [list, ...(state.capability.available ? [field('上传媒体文件', file)] : []), status,
      actionButton(ui('返回时间线'), () => render(state))], state.capability.available ? async () => {
      const chosen = file.files[0]
      if (!chosen) return
      if (!chosen.size || chosen.size > 64 * 1024 ** 2) { status.textContent = ui('单个素材须为 1 字节至 64 MiB'); return }
      if (pending?.file !== chosen) pending = { file: chosen, id: uuid() }
      status.textContent = ui('正在上传并校验素材…')
      try {
        const query = new URLSearchParams({ name: chosen.name.slice(0, 160) })
        const response = await fetch('/api' + assetPath(state) + '/' + pending.id + '?' + query,
          { method: 'PUT', body: chosen, signal: AbortSignal.timeout(58_000) })
        const row = await response.json()
        if (!response.ok) throw new Error(ui(row.error || '请求失败'))
        if (!state.assets.some(asset => asset.id === row.id)) state.assets.unshift(row)
        if (visible(state, status)) library(state)
      } catch (error) { status.textContent = error.message }
    } : undefined, ui('上传并入库'))
  }

  function choice(rows, selected, empty) {
    const select = node('select')
    select.append(new Option(ui(empty), ''), ...rows.map(row => new Option(row.name, row.id)))
    select.value = selected ?? ''
    return select
  }

  function number(value, min, max, step, handler) {
    const input = node('input')
    Object.assign(input, { type: 'number', value, min, max, step, required: true })
    input.addEventListener('input', () => handler(input))
    return input
  }

  function tracks(state) {
    const form = node('fieldset')
    form.className = 'script-fields'
    const shots = new Map(state.base.shots.map(shot => [shot.id, shot]))
    const list = node('select')
    list.id = 'timeline-clips'
    list.append(...state.clips.map((clip, index) => new Option(`${index + 1}. ${shots.get(clip.shotId)?.visual ?? ''}`, index)))
    state.selected = Math.min(state.selected, Math.max(0, state.clips.length - 1))
    list.value = String(state.selected)
    list.addEventListener('change', () => { state.selected = Number(list.value); render(state) })
    form.append(field('镜头片段', list))
    const present = new Set(state.clips.map(clip => clip.shotId))
    const unused = state.base.shots.filter(shot => !present.has(shot.id))
    if (unused.length) {
      const add = choice(unused.map(shot => ({ id: shot.id, name: shot.visual })), '', '选择要加入的镜头')
      form.append(field('添加片段', add), actionButton(ui('添加片段'), () => {
        const shot = shots.get(add.value)
        if (!shot) return
        state.selected = state.clips.push(structuredClone(shot.clip)) - 1
        edit(state, true)
      }))
    }
    const clip = state.clips[state.selected]
    if (clip) {
      const visual = state.assets.filter(asset => !asset.type.startsWith('audio/'))
      const select = choice(visual, clip.assetId, '选择画面素材')
      select.id = 'timeline-visual'
      select.addEventListener('change', () => { clip.assetId = select.value || null; clip.startMs = 0; edit(state, true) })
      const item = visual.find(asset => asset.id === clip.assetId)
      form.append(field('画面素材', select))
      if (item) form.append(preview(state, item))
      if (item?.type === 'video/mp4') form.append(field('素材起点（秒）', number(clip.startMs / 1000, 0, item.duration_ms / 1000, .001,
        input => { clip.startMs = ms(input); edit(state) })))
      const duration = number(clip.durationMs / 1000, .28, 180, .04, input => { clip.durationMs = ms(input); edit(state) })
      duration.id = 'timeline-duration'
      const caption = node('textarea')
      Object.assign(caption, { id: 'timeline-caption', value: clip.caption, maxLength: 500, rows: 3 })
      caption.addEventListener('input', () => { clip.caption = caption.value; edit(state) })
      const buttons = node('div')
      buttons.className = 'tools'
      for (const [offset, label] of [[-1, '上移片段'], [1, '下移片段']]) {
        const target = state.selected + offset
        const button = actionButton(ui(label), () => {
          state.clips.splice(state.selected, 1)
          state.clips.splice(target, 0, clip)
          state.selected = target
          edit(state, true)
        })
        button.disabled = target < 0 || target >= state.clips.length
        buttons.append(button)
      }
      buttons.append(actionButton(ui('移除片段'), () => { state.clips.splice(state.selected, 1); edit(state, true) }))
      form.append(field('片段时长（秒）', duration), field('镜头字幕', caption), buttons)
    }
    const audio = state.assets.filter(asset => asset.type.startsWith('audio/'))
    const voice = choice(audio, state.narration?.assetId, '无配音')
    voice.id = 'timeline-narration'
    voice.addEventListener('change', () => {
      state.narration = voice.value ? { assetId: voice.value, startMs: 0, volume: 100 } : null
      edit(state, true)
    })
    form.append(field('配音轨', voice))
    if (state.narration) {
      const narration = state.narration
      const asset = audio.find(item => item.id === narration.assetId)
      if (asset) form.append(preview(state, asset), field('配音起点（秒）', number(narration.startMs / 1000, 0,
        (asset.duration_ms - 1) / 1000, .001, input => { narration.startMs = ms(input); edit(state) })))
      form.append(field('配音音量（%）', number(narration.volume, 0, 200, 1, input => { narration.volume = input.valueAsNumber; edit(state) })))
    }
    return form
  }

  function render(state) {
    active = state
    const panel = node('section')
    panel.id = 'timeline-editor'
    state.panel = panel
    state.status = node('p')
    state.status.id = 'timeline-status'
    state.status.setAttribute('role', 'status')
    state.error = node('p')
    state.error.setAttribute('role', 'alert')
    state.editable = !!state.base.currentBoardRev && !state.base.stale
    state.launch = null
    state.editor = null
    state.recoverButtons = []
    const controls = node('div')
    controls.className = 'tools'
    controls.append(actionButton(ui('素材库'), async () => { if (await canLeave(state)) library(state) }), actionButton(ui('成片任务'), () => jobs(state)),
      actionButton(ui('AI 素材生成'), async () => {
        if (await canLeave(state)) await generation.open(state, () => render(state), asset => {
          if (!state.assets.some(row => row.id === asset.id)) state.assets.unshift(asset)
        })
      }),
      actionButton(ui('重新读取 NAS'), async () => { if (await canLeave(state)) await open(state.pid, state.id, state.back) }),
      actionButton(ui('返回分镜'), async () => { if (await canLeave(state)) await state.back() }))
    panel.append(state.status, state.error, controls)
    if (!state.capability.available) panel.append(node('p', ui('启用 NAS 媒体运行环境后可上传素材和渲染。')))
    if (!state.base.currentBoardRev) panel.append(node('p', ui('请先确认当前分镜，再建立时间线。')))
    if (state.base.stale && state.base.currentBoardRev) controls.append(actionButton(ui('复核分镜来源'), () => {
      dialog(ui('复核分镜来源'), [node('p', ui('采用新分镜顺序，保留仍存在镜头的素材和字幕。旧时间线留在已提交的成片任务中。')),
        actionButton(ui('返回时间线'), () => render(state))], async () => { render(state); await save(state, 'rebase') }, ui('采用新分镜'))
    }))
    for (const record of state.recovery.slice(0, 3)) {
      const button = actionButton(ui('查看本机时间线 · v$1', record.baseRev), () => recovery(state, record))
      state.recoverButtons.push(button)
      controls.append(button)
    }
    if (state.editable) {
      state.launch = actionButton(ui('开始渲染'), () => submitRender(state))
      controls.append(state.launch)
      state.editor = tracks(state)
      panel.append(state.editor)
    } else if (state.clips.length) {
      const names = new Map(state.assets.map(row => [row.id, row.name]))
      const old = node('ol')
      for (const clip of state.clips) old.append(node('li', [names.get(clip.assetId), ui('$1 秒', clip.durationMs / 1000), clip.caption]
        .filter(Boolean).join(' · ')))
      panel.append(old)
    }
    state.total = node('p')
    panel.append(state.total)
    dialog(ui('剪辑时间线 · $1', state.base.title), [panel], state.editable ? () => save(state, 'save') : undefined, ui('保存时间线到 NAS'))
    paint(state)
  }

  function recovery(state, record) {
    const output = node('pre', JSON.stringify({ clips: record.clips, narration: record.narration }, null, 2))
    const compatible = state.editable && record.baseRev === state.base.rev && record.boardRev === state.base.boardRev
    dialog(ui('本机时间线'), [output, actionButton(ui('返回时间线'), () => render(state))], compatible ? () => {
      state.clips = structuredClone(record.clips)
      state.narration = structuredClone(record.narration)
      state.recovered = record
      edit(state, true)
    } : undefined, ui('加载本机稿到编辑器'))
  }

  async function submitRender(state, retryOf, feedback = state.error) {
    if (state.submitting) return
    state.submitting = true
    const value = retryOf ? { retryOf } : { rev: state.base.rev }
    const key = JSON.stringify(value)
    if (state.renderPending?.key !== key) state.renderPending = { key, id: uuid() }
    try {
      const job = await api(state.path + '/renders', 'POST', { ...value, mutationId: state.renderPending.id })
      state.renderPending = null
      if (visible(state, feedback)) showJob(state, job)
    } catch (error) { feedback.textContent = error.message }
    finally { state.submitting = false }
  }

  async function jobs(state) {
    if (!await canLeave(state)) return
    const rows = await api(state.path + '/renders')
    if (!isCurrent(state.pid)) return
    const links = rows.map(job => actionButton(
      `${ui(statuses[job.status])} · ${ui('时间线 v$1', job.timeline_rev)} · ${new Date(job.created).toLocaleString()}`,
      async () => showJob(state, await api(jobPath(state, job.id)))))
    dialog(ui('成片任务'), [actionButton(ui('返回时间线'), () => render(state)), ...links])
  }

  function showJob(state, initial) {
    if (!isCurrent(state.pid)) return
    const path = jobPath(state, initial.id)
    const panel = node('section')
    const status = node('p')
    status.id = 'film-status'
    status.setAttribute('role', 'status')
    const error = node('p')
    error.setAttribute('role', 'alert')
    const actions = node('div')
    actions.className = 'tools'
    const media = node('div')
    panel.append(status, error, actions, media)
    dialog(ui('成片任务'), [panel])
    update(initial)
    function update(job) {
      if (!visible(state, panel)) return
      status.textContent = `${ui(statuses[job.status])} · ${job.progress}% · ${ui('时间线 v$1', job.timeline_rev)}`
      error.textContent = ui(job.error)
      actions.replaceChildren(actionButton(ui('返回成片任务'), () => jobs(state)), actionButton(ui('返回时间线'), () => render(state)))
      if (['queued', 'running'].includes(job.status)) {
        actions.append(actionButton(ui('取消'), () => api(path + '/cancel', 'POST')))
        setTimeout(async () => {
          if (!visible(state, panel)) return
          try { update(await api(path)) }
          catch (failure) { error.textContent = failure.message; actions.append(actionButton(ui('重新读取 NAS'), async () => update(await api(path)))) }
        }, 1000)
      } else if (job.status === 'done') {
        const video = node('video')
        video.className = 'media-preview'
        video.src = '/api' + path + '/film'
        video.controls = true
        video.playsInline = true
        media.append(video)
        for (const [suffix, title] of [['/film?download=1', '下载 MP4'], ['/subtitles', '下载 SRT']]) {
          const link = node('a', ui(title))
          link.href = '/api' + path + suffix
          actions.append(link)
        }
      } else if (state.capability.available) actions.append(actionButton(ui('按原版本重试'), () => submitRender(state, job.id, error)))
    }
  }

  return { open, canClose: () => visible(active ?? {}) ? canLeave(active) : true }
}
