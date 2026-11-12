import { ui } from './locale.mjs'
import { productionWorkspace } from './production-ui.mjs'
import { shotText, storyboardWorkspace } from './storyboard-ui.mjs'
const formats = { short: ui("短剧"), comic: ui("漫剧") }
const interiors = { interior: ui("内景"), exterior: ui("外景"), mixed: ui("内外景") }
const types = { action: ui("动作"), dialogue: ui("对白"), parenthetical: ui("括注"), transition: ui("转场"), caption: ui("字幕"), note: ui("注释") }
const episodeLabel = episode => ui("第 $1 季 · 第 $2 集 · $3", episode.season, episode.number, episode.title)
const sourceLabel = entry => ui("第 $1 章 · $2 · v$3", entry.number, entry.title, entry.rev)
const editable = value => ({ title: value.title, synopsis: value.synopsis ?? '', scenes: structuredClone(value.scenes) })

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
  return [value.title, value.synopsis, ...value.scenes.map((scene, index) => [
    `${index + 1}. ${scene.title || ui("未命名场次")} · ${interiors[scene.interior]} · ${scene.location} · ${scene.time}`,
    ...scene.elements.map(item => `${item.speaker || types[item.type]} · ${item.text}`),
  ].join('\n'))].filter(Boolean).join('\n\n')
}

export function screenplayWorkspace({ api, dialog, field, actionButton, localTransaction, uuid, isCurrent, modelEnabled, modelName }) {
  const production = productionWorkspace({ api, dialog, field, actionButton, uuid, isCurrent, modelEnabled, modelName, scriptText: preview, shotText })
  const board = storyboardWorkspace({ api, dialog, actionButton, localTransaction, uuid, isCurrent, production })
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
    dialog(ui("剧本改编"), [actionButton(ui("新建改编项目"), () => newAdaptation(pid)),
      ...rows.map(row => actionButton(ui("$1 · $2 · $3 集", row.title, formats[row.format], row.episodes), () => adaptation(pid, row.id)))])
  }

  function newAdaptation(pid) {
    const [titleLabel, title] = field(ui("改编项目名称"), { maxLength: 160 })
    const [formatLabel, format] = selectField(ui("改编类型"), formats, 'short')
    const [aspectLabel, aspect] = selectField(ui("画幅"), { '9:16': '9:16', '16:9': '16:9', '1:1': '1:1' }, '9:16')
    const [secondsLabel, seconds] = field(ui("单集目标时长（秒）"), { type: 'number', min: 15, max: 1800, value: '90' })
    const alert = node('p')
    alert.setAttribute('role', 'alert')
    const mutationId = uuid()
    dialog(ui("新建改编项目"), [titleLabel, formatLabel, aspectLabel, secondsLabel, alert, actionButton(ui("返回改编列表"), () => list(pid))], async () => {
      try {
        const created = await api(`/projects/${pid}/adaptations`, 'POST', { mutationId, title: title.value,
          format: format.value, aspect: aspect.value, seconds: seconds.valueAsNumber })
        if (alert.isConnected && open()) await adaptation(pid, created.id)
      } catch (error) { alert.textContent = error.message }
    }, ui("创建改编项目"))
  }

  async function adaptation(pid, id) {
    const data = await api(`/projects/${pid}/adaptations/${id}`)
    if (!isCurrent(pid)) return
    const label = node('p', ui("$1 · $2 · 目标 $3 秒／集", formats[data.format], data.aspect, data.seconds))
    dialog(data.title, [label, actionButton(ui("新建剧本集"), () => newEpisode(pid, data)),
      actionButton(ui('AI 分集提案'), () => production.plan(pid, data, () => adaptation(pid, id))),
      ...data.episodes.map(row => actionButton(`${episodeLabel(row)} · ${row.status === 'confirmed' ? ui("已确认") : ui("草稿")}`, () => loadEpisode(pid, row.id))),
      actionButton(ui("返回改编列表"), () => list(pid))])
  }

  async function newEpisode(pid, adaptationInfo) {
    const sources = await api(`/projects/${pid}/adaptations/eligible`)
    if (!isCurrent(pid)) return
    const back = actionButton(ui("返回改编项目"), () => adaptation(pid, adaptationInfo.id))
    if (!sources.length) return dialog(ui("新建剧本集"), [node('p', ui("先在小说工作区定稿至少一章，再为剧本集选定原文。")), back])
    const last = adaptationInfo.episodes.at(-1)
    const [titleLabel, title] = field(ui("剧本集标题"), { maxLength: 160 })
    const [seasonLabel, season] = field(ui("季号"), { type: 'number', min: 1, max: 99, value: last?.season ?? 1 })
    const [numberLabel, number] = field(ui("集号"), { type: 'number', min: 1, max: 9999, value: Math.min(9999, (last?.number ?? 0) + 1) })
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
    dialog(ui("新建剧本集"), [titleLabel, seasonLabel, numberLabel, node('p', ui("选择 1–20 章定稿作为本集来源。")), choices, alert, back], async () => {
      try {
        const created = await api(`/projects/${pid}/adaptations/${adaptationInfo.id}/episodes`, 'POST', { mutationId, title: title.value,
          season: season.valueAsNumber, number: number.valueAsNumber, sources: checks.filter(({ check }) => check.checked).map(({ entry }) => ({ id: entry.id, rev: entry.rev })) })
        if (alert.isConnected && open()) await loadEpisode(pid, created.id)
      } catch (error) { alert.textContent = error.message }
    }, ui("创建剧本集"))
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
    const server = `${state.base.status === 'confirmed' ? ui("已确认") : ui("已存 NAS")} · v${state.base.rev}`
    state.status.textContent = state.dirty ? (state.localOk === true ? ui("本机草稿已保存 · NAS v$1", state.base.rev)
      : state.localOk === false ? ui("本机草稿保存失败，请先保存到 NAS") : ui("正在保存本机草稿…")) : server
    if (state.confirm) state.confirm.disabled = state.dirty || state.busy
    if (state.generate) state.generate.disabled = state.dirty || state.busy
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
    state.alert.textContent = ui("无法保存本机草稿。请先保存到 NAS，或复制当前编辑内容。")
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
      state.alert.textContent = error.message + (error.current ? ui("。可重新读取 NAS 后比较并恢复本机稿。") : '')
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
    const back = actionButton(ui("返回剧本集"), () => render(state))
    dialog(ui("对照本机稿与 NAS 剧本"), [node('p', `NAS v${state.base.rev}`), node('pre', preview(state.base)),
      node('p', ui("本机稿基于 v$1", record.baseRev)), node('pre', preview(record.content)), back],
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
    } : undefined, ui("加载本机稿到编辑器"))
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
      detail.append(node('pre', preview(snapshot)), state.alert, actionButton(ui("返回剧本集"), () => render(state)))
      dialog(ui("剧本历史 v$1", row.rev), [detail], state.base.status === 'draft' && !state.dirty ? () => operation(state, 'restore', row.rev) : undefined, ui("恢复为新版本"))
    })))
    dialog(ui("剧本历史版本"), [versions, actionButton(ui("返回剧本集"), () => render(state))])
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
    const [typeLabel, type] = selectField(ui("元素 $1", index + 1), types, item.type)
    type.addEventListener('change', () => { item.type = type.value; edited(state, true) })
    section.append(typeLabel)
    if (item.type === 'dialogue') {
      const characters = Object.fromEntries([['', ui("手填说话人")], ...state.cast.map(row => [row.id, row.title])])
      const [characterLabel, character] = selectField(ui("关联人物卡"), characters, item.characterId ?? '')
      character.addEventListener('change', () => {
        item.characterId = character.value || null
        item.speaker = state.cast.find(row => row.id === item.characterId)?.title ?? item.speaker ?? ''
        edited(state, true)
      })
      section.append(characterLabel, bindText(state, ui("说话人"), item.speaker ?? '', 160, text => { item.speaker = text }))
    }
    const up = actionButton(ui("上移元素"), () => reorder(state, scene.elements, index, -1))
    const down = actionButton(ui("下移元素"), () => reorder(state, scene.elements, index, 1))
    up.disabled = index === 0
    down.disabled = index === scene.elements.length - 1
    section.append(bindText(state, ui("正文"), item.text, 6000, text => { item.text = text }, '', true), sceneButtons('tools', up, down,
      actionButton(ui("删除元素"), () => { scene.elements.splice(index, 1); edited(state, true) })))
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
    const exportLink = node('a', ui("导出 Markdown"))
    exportLink.href = '/api' + state.path + '/export'
    state.confirm = actionButton(locked ? ui("重开剧本") : ui("确认剧本"), () => operation(state, locked ? 'reopen' : 'confirm'))
    const reopen = () => loadEpisode(state.pid, state.id)
    state.generate = locked ? null : actionButton(ui('AI 剧本候选'), () => production.script(state.pid, state.base, reopen))
    const ai = state.generate ?? actionButton(ui('剧本候选记录'), () => production.records(state.pid, state.id, 'script', reopen))
    panel.append(state.status, state.alert, sceneButtons('tools', state.confirm, exportLink, ai,
      actionButton(ui('分镜工作区'), async () => { if (await canLeave(state)) await board.open(state.pid, state.id, reopen) }),
      actionButton(ui("剧本历史"), () => history(state)), actionButton(ui("重新读取 NAS"), async () => { if (await canLeave(state)) await loadEpisode(state.pid, state.id) }),
      actionButton(ui("返回改编项目"), async () => { if (await canLeave(state)) await adaptation(state.pid, state.base.adaptation_id) })))
    for (const record of state.recovery.slice(0, 5)) {
      panel.append(actionButton(ui("比较本机草稿 · v$1 · $2", record.baseRev, new Date(record.updated).toLocaleString()), async () => {
        if (await canLeave(state)) viewRecovery(state, record)
      }))
    }
    if (state.base.sources.some(entry => entry.updated)) panel.append(node('p', ui("小说来源已更新。本集仍关联原来的定稿版本。")))
    const sources = sceneButtons('tools', ...state.base.sources.map(entry => actionButton(ui("读原文 · ") + sourceLabel(entry), async () => {
      if (!await canLeave(state)) return
      const data = await api(state.path + '/source?chapter=' + encodeURIComponent(entry.id))
      if (visible(state, panel)) dialog(ui("小说原文 · ") + sourceLabel(data), [node('pre', data.body), actionButton(ui("返回剧本集"), () => render(state))])
    })))
    panel.append(sources)
    state.form.append(bindText(state, ui("剧本集标题"), state.content.title, 160, text => { state.content.title = text }, 'script-episode-title'))
    state.form.append(bindText(state, ui('分集提纲'), state.content.synopsis ?? '', 3000,
      text => { state.content.synopsis = text }, 'script-episode-synopsis', true))
    const scenes = state.content.scenes
    const addScene = actionButton(ui("添加场次"), () => {
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
      const [sceneLabel, scenePicker] = selectField(ui("切换场次"), Object.fromEntries(scenes.map((row, index) => [index, `${index + 1}. ${row.title || ui("未命名场次")}`])), String(state.current))
      scenePicker.id = 'script-scenes'
      scenePicker.addEventListener('change', () => { state.current = Number(scenePicker.value); render(state) })
      // Keep scene navigation available for confirmed episodes.
      panel.append(sceneLabel)
      const [interiorLabel, interior] = selectField(ui("内外景"), interiors, scene.interior)
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
        label.append(check, ui("关联 ") + sourceLabel(entry))
        links.append(label)
      }
      const addLine = actionButton(ui("添加剧本元素"), () => { scene.elements.push({ id: uuid(), type: 'action', text: '' }); edited(state, true) })
      addLine.id = 'script-add-element'
      addLine.disabled = scene.elements.length >= 60
      const up = actionButton(ui("上移场次"), () => reorder(state, scenes, state.current, -1))
      const down = actionButton(ui("下移场次"), () => reorder(state, scenes, state.current, 1))
      up.disabled = state.current === 0
      down.disabled = state.current + 1 === scenes.length
      state.form.append(bindText(state, ui("场次标题"), scene.title, 160, text => { scene.title = text }, 'script-scene-title'),
        bindText(state, ui("地点"), scene.location, 120, text => { scene.location = text }, 'script-scene-location'),
        bindText(state, ui("时间"), scene.time, 80, text => { scene.time = text }, 'script-scene-time'), interiorLabel, links,
        sceneButtons('tools', up, down, actionButton(ui("删除场次"), () => { scenes.splice(state.current, 1); edited(state, true) })),
        ...scene.elements.map((item, index) => renderLine(state, scene, item, index)), addLine)
    }
    panel.append(state.form)
    dialog(episodeLabel(state.base), [panel], locked ? undefined : () => save(state), ui("保存剧本到 NAS"))
    paint(state)
  }

  return { list, canClose: () => visible(currentDraft ?? {}) ? canLeave(currentDraft) : board.canClose() }
}
