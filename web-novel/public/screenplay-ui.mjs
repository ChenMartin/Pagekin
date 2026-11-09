const formats = { short: '短剧', comic: '漫剧' }
const interiors = { interior: '内景', exterior: '外景', mixed: '内外景' }
const types = { action: '动作', dialogue: '对白', parenthetical: '括注', transition: '转场', caption: '字幕', note: '注释' }
const episodeLabel = episode => `第 ${episode.season} 季 · 第 ${episode.number} 集 · ${episode.title}`
const sourceLabel = entry => `第 ${entry.number} 章 · ${entry.title} · v${entry.rev}`
const editable = value => ({ title: value.title, scenes: structuredClone(value.scenes) })

function node(tag, text = '') {
  const element = document.createElement(tag)
  element.textContent = text
  return element
}

function selectField(label, options, value) {
  const wrapper = node('label', label)
  const select = node('select')
  select.append(...Object.entries(options).map(([id, text]) => new Option(text, id)))
  select.value = value
  wrapper.append(select)
  return [wrapper, select]
}

function preview(value) {
  return [value.title, ...value.scenes.map((scene, index) => [
    `${index + 1}. ${scene.title || '未命名场次'} · ${interiors[scene.interior]} · ${scene.location} · ${scene.time}`,
    ...scene.elements.map(item => `${item.speaker || types[item.type]} · ${item.text}`),
  ].join('\n'))].join('\n\n')
}

export function screenplayWorkspace({ api, dialog, field, actionButton, localTransaction, uuid, isCurrent }) {
  let currentDraft
  const open = () => document.getElementById('dialog').open
  const visible = (state, panel = state.panel) => panel?.isConnected && open() && isCurrent(state.pid)
  const sceneButtons = (className, ...children) => {
    const controls = node('div')
    controls.className = className
    controls.append(...children)
    return controls
  }

  window.addEventListener('beforeunload', event => {
    if (currentDraft?.dirty && !currentDraft.localOk) { event.preventDefault(); event.returnValue = '' }
  })
  document.getElementById('dialog').addEventListener('cancel', event => {
    const state = currentDraft
    if (!state?.dirty || !visible(state) || state.localOk) return
    event.preventDefault()
    void canLeave(state).then(ok => { if (ok && visible(state)) document.getElementById('dialog').close() })
  })

  async function list(pid) {
    const rows = await api(`/projects/${pid}/adaptations`)
    if (!isCurrent(pid)) return
    dialog('剧本改编', [actionButton('新建改编项目', () => newAdaptation(pid)),
      ...rows.map(row => actionButton(`${row.title} · ${formats[row.format]} · ${row.episodes} 集`, () => adaptation(pid, row.id)))])
  }

  function newAdaptation(pid) {
    const [titleLabel, title] = field('改编项目名称', { maxLength: 160 })
    const [formatLabel, format] = selectField('改编类型', formats, 'short')
    const [aspectLabel, aspect] = selectField('画幅', { '9:16': '9:16', '16:9': '16:9', '1:1': '1:1' }, '9:16')
    const [secondsLabel, seconds] = field('单集目标时长（秒）', { type: 'number', min: 15, max: 1800, value: '90' })
    const alert = node('p')
    alert.setAttribute('role', 'alert')
    const mutationId = uuid()
    dialog('新建改编项目', [titleLabel, formatLabel, aspectLabel, secondsLabel, alert, actionButton('返回改编列表', () => list(pid))], async () => {
      try {
        const created = await api(`/projects/${pid}/adaptations`, 'POST', { mutationId, title: title.value,
          format: format.value, aspect: aspect.value, seconds: seconds.valueAsNumber })
        if (alert.isConnected && open()) await adaptation(pid, created.id)
      } catch (error) { alert.textContent = error.message }
    }, '创建改编项目')
  }

  async function adaptation(pid, id) {
    const data = await api(`/projects/${pid}/adaptations/${id}`)
    if (!isCurrent(pid)) return
    const label = node('p', `${formats[data.format]} · ${data.aspect} · 目标 ${data.seconds} 秒／集`)
    dialog(data.title, [label, actionButton('新建剧本集', () => newEpisode(pid, data)),
      ...data.episodes.map(row => actionButton(`${episodeLabel(row)} · ${row.status === 'confirmed' ? '已确认' : '草稿'}`, () => loadEpisode(pid, row.id))),
      actionButton('返回改编列表', () => list(pid))])
  }

  async function newEpisode(pid, adaptationInfo) {
    const sources = await api(`/projects/${pid}/adaptations/eligible`)
    if (!isCurrent(pid)) return
    const back = actionButton('返回改编项目', () => adaptation(pid, adaptationInfo.id))
    if (!sources.length) return dialog('新建剧本集', [node('p', '先在小说工作区定稿至少一章，再为剧本集选定原文。'), back])
    const last = adaptationInfo.episodes.at(-1)
    const [titleLabel, title] = field('剧本集标题', { maxLength: 160 })
    const [seasonLabel, season] = field('季号', { type: 'number', min: 1, max: 99, value: last?.season ?? 1 })
    const [numberLabel, number] = field('集号', { type: 'number', min: 1, max: 9999, value: Math.min(9999, (last?.number ?? 0) + 1) })
    const choices = node('div')
    choices.className = 'batch-list'
    const checks = sources.map(entry => {
      const label = node('label')
      const check = node('input')
      check.type = 'checkbox'
      label.append(check, sourceLabel(entry))
      choices.append(label)
      return { check, entry }
    })
    const alert = node('p')
    alert.setAttribute('role', 'alert')
    const mutationId = uuid()
    dialog('新建剧本集', [titleLabel, seasonLabel, numberLabel, node('p', '选择 1–20 章定稿作为本集来源。'), choices, alert, back], async () => {
      try {
        const created = await api(`/projects/${pid}/adaptations/${adaptationInfo.id}/episodes`, 'POST', { mutationId, title: title.value,
          season: season.valueAsNumber, number: number.valueAsNumber, sources: checks.filter(({ check }) => check.checked).map(({ entry }) => ({ id: entry.id, rev: entry.rev })) })
        if (alert.isConnected && open()) await loadEpisode(pid, created.id)
      } catch (error) { alert.textContent = error.message }
    }, '创建剧本集')
  }

  async function loadEpisode(pid, id) {
    const path = `/projects/${pid}/episodes/${id}`
    const [base, documents, drafts] = await Promise.all([
      api(path), api(`/projects/${pid}/documents`),
      localTransaction('readonly', store => store.index('document').getAll(id)).catch(() => null),
    ])
    if (!isCurrent(pid)) return
    const content = editable(base)
    const saved = JSON.stringify(content)
    const recovery = (drafts ?? []).filter(record => record.scope === 'screenplay' &&
      (record.pending || JSON.stringify(record.content) !== saved))
      .sort((a, b) => b.updated - a.updated)
    render({ pid, id, path, base, content, key: 'screenplay:' + uuid(), current: 0,
      dirty: false, localOk: drafts !== null, edit: 0, recovery, cast: documents.filter(row => row.kind === 'character') })
  }

  function paint(state) {
    const server = `${state.base.status === 'confirmed' ? '已确认' : '已存 NAS'} · v${state.base.rev}`
    state.status.textContent = state.dirty ? (state.localOk === true ? `本机草稿已保存 · NAS v${state.base.rev}`
      : state.localOk === false ? '本机草稿保存失败，请先保存到 NAS' : '正在保存本机草稿…') : server
    if (state.confirm) state.confirm.disabled = state.dirty || state.busy
    state.form.disabled = state.base.status === 'confirmed' || state.busy
  }

  function persist(state) {
    const record = { scope: 'screenplay', key: state.key, document: state.id, baseRev: state.base.rev, updated: Date.now(),
      content: structuredClone(state.content), pending: state.pending }
    const write = localTransaction('readwrite', store => state.dirty ? store.put(record) : store.delete(record.key))
      .then(() => true, () => false)
    state.localWrite = write
    void write.then(ok => { if (state.localWrite === write) { state.localOk = ok; paint(state) } })
    return write
  }

  function edited(state, redraw = false) {
    state.dirty = true
    state.edit++
    state.localOk = null
    void persist(state)
    if (redraw) render(state)
    else paint(state)
  }

  async function canLeave(state) {
    if (!state?.dirty) return true
    if (await state.localWrite) return true
    if (await persist(state)) return true
    state.alert.textContent = '无法保存本机草稿。请先保存到 NAS，或复制当前编辑内容。'
    return false
  }

  async function save(state) {
    if (!state.dirty || state.busy) return
    const panel = state.panel
    const pending = state.pending ?? { edit: state.edit, request: { ...editable(state.content), baseRev: state.base.rev, mutationId: uuid() } }
    state.pending = pending
    state.busy = true
    state.alert.textContent = ''
    paint(state)
    await persist(state)
    try {
      state.base = await api(state.path, 'PUT', pending.request)
      state.pending = null
      if (pending.edit === state.edit) {
        state.content = editable(state.base)
        state.dirty = false
        if (state.recovered) {
          const recovered = state.recovered
          await localTransaction('readwrite', store => {
            const request = store.get(recovered.key)
            request.onsuccess = () => { if (request.result?.updated === recovered.updated) store.delete(recovered.key) }
            return request
          }).catch(() => {})
          state.recovery = state.recovery.filter(row => row.key !== recovered.key)
          state.recovered = null
        }
      }
      await persist(state)
    } catch (error) {
      if (error.status && error.status < 500) state.pending = null
      state.alert.textContent = error.message + (error.current ? '。可重新读取 NAS 后比较并恢复本机稿。' : '')
      await persist(state)
    } finally {
      state.busy = false
      if (visible(state, panel) && !state.dirty) render(state)
      else paint(state)
    }
  }

  async function operation(state, action, rev) {
    if (state.dirty || state.busy) return
    const panel = state.panel
    const suffix = action === 'restore' ? '/history' : '/status'
    if (state.operation?.action !== action || state.operation?.rev !== rev) {
      state.operation = { action, rev, mutationId: uuid(), baseRev: state.base.rev }
    }
    state.busy = true
    paint(state)
    try {
      state.base = await api(state.path + suffix, 'POST', state.operation)
      state.content = editable(state.base)
      state.operation = null
      if (visible(state, panel)) render(state)
    } catch (error) {
      if (error.status && error.status < 500) state.operation = null
      state.alert.textContent = error.message
    } finally { state.busy = false; paint(state) }
  }

  function viewRecovery(state, record) {
    const back = actionButton('返回剧本集', () => render(state))
    dialog('对照本机稿与 NAS 剧本', [node('p', `NAS v${state.base.rev}`), node('pre', preview(state.base)),
      node('p', `本机稿基于 v${record.baseRev}`), node('pre', preview(record.content)), back],
    state.base.status === 'draft' ? () => {
      if (state.dirty) state.key = 'screenplay:' + uuid()
      state.content = editable(record.content)
      state.recovered = record
      state.pending = null
      if (record.baseRev === state.base.rev && record.pending) {
        const same = JSON.stringify(editable(record.pending.request)) === JSON.stringify(state.content)
        state.pending = { ...record.pending, edit: same ? state.edit + 1 : -1 }
      }
      edited(state, true)
    } : undefined, '加载本机稿到编辑器')
  }

  async function history(state) {
    const panel = state.panel
    const rows = await api(state.path + '/history')
    if (!await canLeave(state) || !visible(state, panel)) return
    const versions = node('div')
    versions.className = 'batch-list'
    versions.append(...rows.map(row => actionButton(`v${row.rev} · ${row.title} · ${new Date(row.updated).toLocaleString()}`, async () => {
      const snapshot = await api(state.path + '/history?rev=' + row.rev)
      if (!versions.isConnected || !open()) return
      const detail = node('div')
      state.panel = detail
      state.alert = node('p')
      detail.append(node('pre', preview(snapshot)), state.alert, actionButton('返回剧本集', () => render(state)))
      dialog(`剧本历史 v${row.rev}`, [detail], state.base.status === 'draft' && !state.dirty ? () => operation(state, 'restore', row.rev) : undefined, '恢复为新版本')
    })))
    dialog('剧本历史版本', [versions, actionButton('返回剧本集', () => render(state))])
  }

  function bindText(state, label, value, maxLength, set, id, multiline = false) {
    const wrapper = node('label', label)
    const input = node(multiline ? 'textarea' : 'input')
    if (id) input.id = id
    input.value = value
    input.maxLength = maxLength
    if (multiline) input.rows = 4
    input.addEventListener('input', () => { set(input.value); edited(state) })
    wrapper.append(input)
    return wrapper
  }

  function reorder(state, rows, index, offset) {
    const next = index + offset
    if (next < 0 || next >= rows.length) return
    const [item] = rows.splice(index, 1)
    rows.splice(next, 0, item)
    if (rows === state.content.scenes) state.current = next
    edited(state, true)
  }

  function renderLine(state, scene, item, index) {
    const section = node('section')
    section.className = 'script-line'
    const [typeLabel, type] = selectField(`元素 ${index + 1}`, types, item.type)
    type.addEventListener('change', () => { item.type = type.value; edited(state, true) })
    section.append(typeLabel)
    if (item.type === 'dialogue') {
      const characters = Object.fromEntries([['', '手填说话人'], ...state.cast.map(row => [row.id, row.title])])
      const [characterLabel, character] = selectField('关联人物卡', characters, item.characterId ?? '')
      character.addEventListener('change', () => {
        item.characterId = character.value || null
        item.speaker = state.cast.find(row => row.id === item.characterId)?.title ?? item.speaker ?? ''
        edited(state, true)
      })
      section.append(characterLabel, bindText(state, '说话人', item.speaker ?? '', 160, text => { item.speaker = text }))
    }
    const up = actionButton('上移元素', () => reorder(state, scene.elements, index, -1))
    const down = actionButton('下移元素', () => reorder(state, scene.elements, index, 1))
    up.disabled = index === 0
    down.disabled = index === scene.elements.length - 1
    section.append(bindText(state, '正文', item.text, 6000, text => { item.text = text }, '', true), sceneButtons('tools', up, down,
      actionButton('删除元素', () => { scene.elements.splice(index, 1); edited(state, true) })))
    return section
  }

  function render(state) {
    currentDraft = state
    const panel = node('section')
    panel.id = 'screenplay-episode-editor'
    state.panel = panel
    state.status = node('p')
    state.status.id = 'script-save-status'
    state.status.setAttribute('role', 'status')
    state.alert = node('p')
    state.alert.setAttribute('role', 'alert')
    state.form = node('fieldset')
    state.form.className = 'script-fields'
    const locked = state.base.status === 'confirmed'
    const exportLink = node('a', '导出 Markdown')
    exportLink.href = '/api' + state.path + '/export'
    state.confirm = actionButton(locked ? '重开剧本' : '确认剧本', () => operation(state, locked ? 'reopen' : 'confirm'))
    panel.append(state.status, state.alert, sceneButtons('tools', state.confirm, exportLink,
      actionButton('剧本历史', () => history(state)), actionButton('重新读取 NAS', async () => { if (await canLeave(state)) await loadEpisode(state.pid, state.id) }),
      actionButton('返回改编项目', async () => { if (await canLeave(state)) await adaptation(state.pid, state.base.adaptation_id) })))
    for (const record of state.recovery.slice(0, 5)) {
      panel.append(actionButton(`比较本机草稿 · v${record.baseRev} · ${new Date(record.updated).toLocaleString()}`, async () => {
        if (await canLeave(state)) viewRecovery(state, record)
      }))
    }
    if (state.base.sources.some(entry => entry.updated)) panel.append(node('p', '小说来源已更新。本集仍关联原来的定稿版本。'))
    const sources = sceneButtons('tools', ...state.base.sources.map(entry => actionButton('读原文 · ' + sourceLabel(entry), async () => {
      if (!await canLeave(state)) return
      const data = await api(state.path + '/source?chapter=' + encodeURIComponent(entry.id))
      if (visible(state, panel)) dialog('小说原文 · ' + sourceLabel(data), [node('pre', data.body), actionButton('返回剧本集', () => render(state))])
    })))
    panel.append(sources)
    state.form.append(bindText(state, '剧本集标题', state.content.title, 160, text => { state.content.title = text }, 'script-episode-title'))
    const scenes = state.content.scenes
    const addScene = actionButton('添加场次', () => {
      scenes.push({ id: uuid(), title: '', location: '', time: '', interior: 'interior', sourceIds: [], elements: [] })
      state.current = scenes.length - 1
      edited(state, true)
    })
    addScene.id = 'script-add-scene'
    addScene.disabled = scenes.length >= 80
    state.form.append(addScene)
    if (scenes.length) {
      state.current = Math.min(state.current, scenes.length - 1)
      const scene = scenes[state.current]
      const [sceneLabel, scenePicker] = selectField('切换场次', Object.fromEntries(scenes.map((row, index) => [index, `${index + 1}. ${row.title || '未命名场次'}`])), String(state.current))
      scenePicker.id = 'script-scenes'
      scenePicker.addEventListener('change', () => { state.current = Number(scenePicker.value); render(state) })
      // Keep scene navigation available for confirmed episodes.
      panel.append(sceneLabel)
      const [interiorLabel, interior] = selectField('内外景', interiors, scene.interior)
      interior.addEventListener('change', () => { scene.interior = interior.value; edited(state) })
      const links = node('div')
      links.className = 'batch-list'
      for (const entry of state.base.sources) {
        const label = node('label')
        const check = node('input')
        check.type = 'checkbox'
        check.checked = scene.sourceIds.includes(entry.id)
        check.addEventListener('change', () => {
          scene.sourceIds = check.checked ? [...scene.sourceIds, entry.id] : scene.sourceIds.filter(id => id !== entry.id)
          edited(state)
        })
        label.append(check, '关联 ' + sourceLabel(entry))
        links.append(label)
      }
      const addLine = actionButton('添加剧本元素', () => { scene.elements.push({ id: uuid(), type: 'action', text: '' }); edited(state, true) })
      addLine.id = 'script-add-element'
      addLine.disabled = scene.elements.length >= 60
      const up = actionButton('上移场次', () => reorder(state, scenes, state.current, -1))
      const down = actionButton('下移场次', () => reorder(state, scenes, state.current, 1))
      up.disabled = state.current === 0
      down.disabled = state.current + 1 === scenes.length
      state.form.append(bindText(state, '场次标题', scene.title, 160, text => { scene.title = text }, 'script-scene-title'),
        bindText(state, '地点', scene.location, 120, text => { scene.location = text }, 'script-scene-location'),
        bindText(state, '时间', scene.time, 80, text => { scene.time = text }, 'script-scene-time'), interiorLabel, links,
        sceneButtons('tools', up, down, actionButton('删除场次', () => { scenes.splice(state.current, 1); edited(state, true) })),
        ...scene.elements.map((item, index) => renderLine(state, scene, item, index)), addLine)
    }
    panel.append(state.form)
    dialog(episodeLabel(state.base), [panel], locked ? undefined : () => save(state), '保存剧本到 NAS')
    paint(state)
  }

  return { list, canClose: () => visible(currentDraft ?? {}) ? canLeave(currentDraft) : true }
}
