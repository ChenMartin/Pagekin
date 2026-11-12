import { ui } from './locale.mjs'
import { mediaWorkspace } from './media-ui.mjs'

const sizes = { wide: '全景', full: '全身', medium: '中景', close: '近景', detail: '特写' }
const seconds = ms => ms / 1000
const labelFor = (shot, index) => `${index + 1}. ${ui(sizes[shot.size])} · ${ui('$1 秒', seconds(shot.durationMs))}`

export function shotText(shots) {
  return shots.map((shot, i) => [labelFor(shot, i), shot.visual, shot.camera, shot.movement, shot.dialogue, shot.prompt]
    .filter(Boolean).join('\n')).join('\n\n')
}

function node(tag, text = '') {
  const element = document.createElement(tag)
  element.textContent = text
  return element
}

export function storyboardWorkspace({ api, dialog, actionButton, localTransaction, uuid, isCurrent, production }) {
  const media = mediaWorkspace({ api, dialog, actionButton, localTransaction, uuid, isCurrent })
  let active
  const openDialog = () => document.getElementById('dialog')
  const visible = state => state?.panel?.isConnected && openDialog().open && isCurrent(state.pid)
  const pathFor = (pid, id) => `/projects/${pid}/episodes/${id}`

  async function open(pid, id, back, selected) {
    const path = pathFor(pid, id)
    const [base, drafts] = await Promise.all([api(path + '/storyboard'),
      localTransaction('readonly', store => store.index('document').getAll(id)).catch(() => [])])
    if (!isCurrent(pid)) return
    const recovery = drafts.filter(record => record.scope === 'storyboard' && (record.scriptRev !== base.scriptRev ||
      JSON.stringify(record.shots) !== JSON.stringify(base.shots))).sort((a, b) => b.updated - a.updated)
    render({ pid, id, path, base, shots: structuredClone(base.shots), back, sceneId: selected, recovery,
      key: 'storyboard:' + uuid(), dirty: false, mode: 'list', localOk: true })
  }

  function paint(state) {
    if (!state.status) return
    state.status.textContent = [state.base.rev ? ui('分镜 v$1', state.base.rev) : ui('新分镜'),
      state.base.scriptRev && ui('剧本 v$1', state.base.scriptRev),
      state.base.stale && ui('剧本来源待复核'), state.base.status === 'confirmed' && ui('已确认'),
      state.dirty && (state.localOk === true ? ui('本机草稿') : state.localOk === false ? ui('本机保存失败') : ui('本机草稿保存中'))].filter(Boolean).join(' · ')
    for (const button of state.cleanActions ?? []) button.disabled = state.dirty || state.busy
    if (state.totals) {
      const shots = state.shots.filter(shot => shot.sceneId === state.sceneId)
      state.totals.textContent = ui('$1 镜 · $2 秒', shots.length, seconds(shots.reduce((sum, shot) => sum + (shot.durationMs || 0), 0)))
    }
    state.form.disabled = state.busy || state.base.stale || state.base.status === 'confirmed' || state.historical
    if (visible(state) && state.editable) document.getElementById('dialog-submit').hidden = !state.dirty
  }

  function persist(state) {
    const record = { scope: 'storyboard', key: state.key, document: state.id, scriptRev: state.base.scriptRev,
      baseRev: state.base.rev, shots: structuredClone(state.shots), updated: Date.now() }
    const promise = localTransaction('readwrite', store => state.dirty ? store.put(record) : store.delete(record.key))
      .then(() => true, () => false)
    state.write = promise
    void promise.then(ok => { if (state.write === promise) { state.localOk = ok; paint(state) } })
    return promise
  }

  function edited(state, redraw = false) {
    state.dirty = true
    state.localOk = null
    void persist(state)
    if (redraw) render(state)
    else paint(state)
  }

  async function canLeave(state) {
    if (!state?.dirty || await state.write || await persist(state)) return true
    state.alert.textContent = ui('无法保存本机草稿。请先保存到 NAS，或复制当前编辑内容。')
    return false
  }

  window.addEventListener('beforeunload', event => {
    if (visible(active) && active.dirty && !active.localOk) { event.preventDefault(); event.returnValue = '' }
  })
  openDialog().addEventListener('cancel', event => {
    if (!visible(active) || !active.dirty || active.localOk) return
    event.preventDefault()
    const state = active
    void canLeave(state).then(ok => { if (ok && visible(state)) openDialog().close() })
  })

  async function change(state, action, extra = {}) {
    if (state.busy || (action === 'save' && !state.dirty)) return
    const panel = state.panel
    const value = { action, baseRev: state.base.rev, scriptRev: state.base.currentScriptRev, ...extra }
    const fingerprint = JSON.stringify(value)
    if (state.pending?.fingerprint !== fingerprint) state.pending = { fingerprint, mutationId: uuid() }
    state.busy = true
    state.alert.textContent = ''
    paint(state)
    try {
      state.base = await api(state.path + '/storyboard', 'PUT', { ...value, mutationId: state.pending.mutationId })
      state.shots = structuredClone(state.base.shots)
      state.pending = null
      state.dirty = false
      await persist(state)
      if (state.recovered) {
        const record = state.recovered
        await localTransaction('readwrite', store => {
          const request = store.get(record.key)
          request.onsuccess = () => { if (request.result?.updated === record.updated) store.delete(record.key) }
          return request
        }).catch(() => {})
        state.recovery = state.recovery.filter(item => item.key !== record.key)
        state.recovered = null
      }
    } catch (error) {
      if (error.status && error.status < 500) state.pending = null
      state.alert.textContent = error.message
    } finally {
      state.busy = false
      if (visible(state) && state.panel === panel && !state.dirty && !state.alert.textContent) render(state)
      else paint(state)
    }
  }

  function recovery(state, record) {
    const compare = node('div')
    compare.className = 'compare'
    for (const [title, shots] of [[ui('当前版本'), state.shots], [ui('本机草稿'), record.shots]]) {
      const section = node('section')
      section.append(node('h3', title), node('pre', shotText(shots)))
      compare.append(section)
    }
    const sameSource = record.scriptRev === state.base.scriptRev
    const editable = sameSource && !state.base.stale && state.base.status === 'draft'
    const notes = [node('p', `${ui('本机稿基于 v$1', record.baseRev)} · ${ui('剧本 v$1', record.scriptRev)}`)]
    if (!sameSource) notes.push(node('p', ui('本机稿引用旧剧本，可查看并复制镜头内容。')))
    dialog(ui('比较本机分镜'), [...notes, compare,
      actionButton(ui('返回分镜'), () => render(state))], editable ? () => {
      state.shots = structuredClone(record.shots)
      state.recovered = record
      edited(state, true)
    } : undefined, ui('加载本机稿到编辑器'))
  }

  async function history(state) {
    const versions = await api(state.path + '/storyboard-history')
    if (!visible(state)) return
    dialog(ui('分镜历史'), [actionButton(ui('返回分镜'), () => render(state)), ...versions.map(row =>
      actionButton(`${ui('分镜 v$1', row.rev)} · ${ui('剧本 v$1', row.script_rev)} · ${ui(row.status === 'confirmed' ? '已确认' : '草稿')}`, async () => {
        const base = await api(state.path + '/storyboard-history?rev=' + row.rev)
        if (isCurrent(state.pid)) render({ ...state, base, shots: base.shots, historical: true, historyState: state, recovery: [] })
      }))])
  }

  function confirmRebase(state) {
    const count = state.shots.filter(shot => state.base.removed.includes(shot.sceneId)).length
    const names = state.base.scenes.filter(scene => state.base.changed.includes(scene.id)).map(scene => scene.title).join(' · ')
    dialog(ui('复核剧本来源'), [node('p', ui('更新后请核对受影响的场次，再确认分镜。')), ...(names ? [node('p', names)] : []),
      ...(count ? [node('p', ui('$1 个镜头属于已删除场次，将保留在旧版本中。', count))] : []),
      actionButton(ui('返回分镜'), () => render(state))], async () => {
      render(state)
      await change(state, 'rebase', { dropRemoved: count > 0 })
    }, ui('采用当前剧本版本'))
  }

  function editShot(state, scene, shot, fieldset) {
    const addField = (title, key, maxLength, multiline = false) => {
      const label = node('label', ui(title))
      const input = node(multiline ? 'textarea' : 'input')
      input.value = shot[key]
      input.maxLength = maxLength
      if (multiline) input.rows = 3
      input.id = 'shot-' + key
      input.addEventListener('input', () => { shot[key] = input.value; edited(state) })
      label.append(input)
      fieldset.append(label)
    }
    const sizeLabel = node('label', ui('景别'))
    const size = node('select')
    size.append(...Object.entries(sizes).map(([key, name]) => new Option(ui(name), key)))
    size.value = shot.size
    size.addEventListener('change', () => { shot.size = size.value; edited(state) })
    sizeLabel.append(size)
    const durationLabel = node('label', ui('镜头时长（秒）'))
    const duration = node('input')
    Object.assign(duration, { id: 'shot-duration', type: 'number', min: 0.25, max: 180, step: 0.001, value: seconds(shot.durationMs), required: true })
    duration.addEventListener('input', () => { shot.durationMs = Math.round(duration.valueAsNumber * 1000); edited(state) })
    durationLabel.append(duration)
    fieldset.append(sizeLabel, durationLabel)
    addField('画面', 'visual', 2000, true)
    addField('机位', 'camera', 200)
    addField('运镜', 'movement', 200)
    addField('对白', 'dialogue', 1500, true)
    addField('制作提示词', 'prompt', 3000, true)
    const cast = new Map(scene.elements.filter(item => item.characterId).map(item => [item.characterId, item.speaker]))
    if (cast.size) {
      const people = node('div')
      people.className = 'batch-list'
      for (const [id, title] of cast) {
        const label = node('label')
        const check = node('input')
        check.type = 'checkbox'
        check.checked = shot.characterIds.includes(id)
        check.addEventListener('change', () => {
          shot.characterIds = check.checked ? [...shot.characterIds, id] : shot.characterIds.filter(value => value !== id)
          edited(state)
        })
        label.append(check, title)
        people.append(label)
      }
      fieldset.append(people)
    }
  }

  function render(state) {
    active = state
    const panel = node('section')
    panel.id = 'storyboard-editor'
    state.panel = panel
    state.status = node('p')
    state.status.id = 'storyboard-status'
    state.status.setAttribute('role', 'status')
    state.alert = node('p')
    state.alert.setAttribute('role', 'alert')
    state.form = node('fieldset')
    state.form.className = 'script-fields'
    state.cleanActions = []
    state.totals = null
    const locked = state.base.stale || state.base.status === 'confirmed' || state.historical || !state.base.scriptRev
    state.editable = !locked
    const controls = node('div')
    controls.className = 'tools'
    const addAction = (text, action, requiresClean = false) => {
      const button = actionButton(ui(text), action)
      if (requiresClean) state.cleanActions.push(button)
      controls.append(button)
      return button
    }
    if (state.historical) {
      addAction('返回分镜历史', () => { render(state.historyState); return history(state.historyState) })
      const head = state.historyState
      if (!head.base.stale && head.base.status === 'draft' && head.base.scriptRev === state.base.scriptRev) {
        addAction('恢复为新版本', () => { render(head); return change(head, 'restore', { rev: state.base.rev }) })
      }
    } else {
      addAction('返回剧本集', async () => { if (await canLeave(state)) await state.back() })
      addAction('重新读取 NAS', async () => { if (await canLeave(state)) await open(state.pid, state.id, state.back, state.sceneId) })
      if (state.base.rev) addAction('分镜历史', () => history(state), true)
      if (state.base.rev) addAction('剪辑与成片', () => media.open(state.pid, state.id,
        () => open(state.pid, state.id, state.back, state.sceneId)), true)
      if (locked && state.base.rev) addAction('拆镜任务记录', () => production.records(state.pid, state.id, 'shots',
        () => open(state.pid, state.id, state.back, state.sceneId)), true)
      if (state.base.stale && state.base.currentScriptRev) addAction('复核剧本来源', () => confirmRebase(state), true)
      if (!state.base.stale && state.base.status === 'confirmed') addAction('重开分镜', () => change(state, 'reopen'), true)
      if (!locked && state.base.rev) addAction('确认分镜', () => change(state, 'confirm'), true)
      for (const record of state.recovery.slice(0, 3)) addAction('比较本机分镜', () => recovery(state, record), true)
    }
    if (state.base.rev) {
      for (const [format, title] of [['md', '分镜 Markdown'], ['json', '分镜 JSON']]) {
        const link = node('a', ui(title))
        link.href = '/api' + state.path + '/storyboard-export?format=' + format + '&rev=' + state.base.rev
        controls.append(link)
      }
    }
    panel.append(state.status, state.alert, controls)
    if (!state.base.scriptRev) panel.append(node('p', ui('先确认本集剧本，再建立分镜。')))
    if (state.base.stale) panel.append(node('p', ui('以下镜头仍引用原剧本版本，可继续查看和导出。')))
    if (state.base.scenes.length) renderShots(state, panel, locked)
    dialog(ui('分镜 · $1', state.base.title), [panel], locked ? undefined : () => change(state, 'save', { shots: state.shots }), ui('保存分镜到 NAS'))
    paint(state)
  }

  function renderShots(state, panel, locked) {
    const scenes = state.base.scenes
    const scene = scenes.find(row => row.id === state.sceneId) ?? scenes[0]
    state.sceneId = scene.id
    const shots = state.shots.filter(shot => shot.sceneId === scene.id)
    const selected = shots.find(shot => shot.id === state.shotId) ?? shots[0]
    state.shotId = selected?.id
    const controls = node('div')
    controls.className = 'tools'
    const list = node('select')
    list.id = 'storyboard-scenes'
    list.setAttribute('aria-label', ui('切换场次'))
    list.append(...scenes.map((item, index) => new Option(`${index + 1}. ${item.title}`, item.id)))
    list.value = scene.id
    list.addEventListener('change', () => { state.sceneId = list.value; state.shotId = null; render(state) })
    const mode = actionButton(ui(state.mode === 'list' ? '镜头卡' : '镜头列表'), () => {
      state.mode = state.mode === 'list' ? 'cards' : 'list'
      render(state)
    })
    controls.append(list, mode)
    if (!locked) {
      const ai = actionButton(ui('AI 分场拆镜'), () => production.shots(state.pid, state.base, scene,
        () => open(state.pid, state.id, state.back, scene.id)))
      state.cleanActions.push(ai)
      controls.append(ai)
    }
    state.totals = node('p')
    panel.append(controls, state.totals)
    if (state.base.changed.includes(scene.id)) panel.append(node('p', ui('此场次在当前剧本中有变更。')))
    const cards = node('div')
    cards.className = state.mode === 'cards' ? 'storyboard-cards' : 'storyboard-list'
    shots.forEach((shot, index) => {
      const card = actionButton(labelFor(shot, index), () => { state.shotId = shot.id; render(state) })
      card.setAttribute('aria-pressed', String(shot.id === state.shotId))
      if (state.mode === 'cards') card.append(node('span', shot.visual))
      cards.append(card)
    })
    panel.append(cards)
    if (!locked) {
      const add = actionButton(ui('添加镜头'), () => {
        const shot = { id: uuid(), sceneId: scene.id, size: 'medium', durationMs: 3000, visual: '',
          camera: '', movement: '', dialogue: '', prompt: '', characterIds: [] }
        state.shots.push(shot)
        state.shotId = shot.id
        edited(state, true)
      })
      add.id = 'storyboard-add-shot'
      add.disabled = state.shots.length >= 300
      state.form.append(add)
    }
    if (selected) {
      if (locked) panel.append(node('pre', shotText([selected])))
      else {
        editShot(state, scene, selected, state.form)
        const index = shots.indexOf(selected)
        for (const [offset, title] of [[-1, '上移镜头'], [1, '下移镜头']]) {
          const neighbor = shots[index + offset]
          const button = actionButton(ui(title), () => {
            const indexOfSelected = state.shots.indexOf(selected)
            state.shots[state.shots.indexOf(neighbor)] = selected
            state.shots[indexOfSelected] = neighbor
            edited(state, true)
          })
          button.disabled = !neighbor
          state.form.append(button)
        }
        state.form.append(actionButton(ui('删除镜头'), () => { state.shots = state.shots.filter(row => row !== selected); edited(state, true) }))
      }
    }
    if (!locked) panel.append(state.form)
  }

  return { open, canClose: () => visible(active) ? canLeave(active) : media.canClose() }
}
