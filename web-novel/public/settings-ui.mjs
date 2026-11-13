import { locale, ui } from './locale.mjs'

const $ = id => document.getElementById(id)
const appearanceKey = 'pagekin-appearance'
const themes = { system: '跟随系统', light: '浅色', dark: '深色' }
const sizes = { standard: '标准', large: '大字', extra: '特大字' }
const spacing = { compact: '紧凑', comfortable: '舒展' }
const defaults = { theme: 'system', textSize: 'standard', lineSpacing: 'comfortable' }
const stages = { planning: '规划', draft: '写稿', review: '审稿', revision: '修稿', continuity: '定稿人物提取' }

function node(tag, text, className) {
  const element = document.createElement(tag)
  if (text) element.textContent = text
  if (className) element.className = className
  return element
}

function group(className, ...children) {
  const element = node('div', '', className)
  element.append(...children)
  return element
}

function help(text) { return node('p', ui(text), 'settings-help') }

function card(title, ...children) {
  const element = node('section', '', 'settings-card')
  element.append(node('h4', ui(title)), ...children)
  return element
}

function selectField(id, label, choices, selected) {
  const field = node('label', ui(label))
  const select = Object.assign(node('select'), { id })
  select.append(...choices.map(([value, text]) => new Option(text, value)))
  select.value = selected
  field.append(select)
  return [field, select]
}

function details(rows) {
  const list = node('dl', '', 'settings-details')
  for (const [label, value] of rows) list.append(node('dt', ui(label)), node('dd', value || ui('暂无')))
  return list
}

function feedback() {
  const message = node('p', '', 'settings-feedback')
  message.setAttribute('role', 'status')
  return message
}

function report(message, text, state = '') {
  message.textContent = text
  message.dataset.state = state
}

function setAppearance(element, values) {
  for (const key of Object.keys(defaults)) element.dataset[key] = values[key]
}

function storedAppearance() {
  let saved
  try { saved = JSON.parse(localStorage.getItem(appearanceKey)) } catch { /* Optional browser preferences. */ }
  return {
    theme: Object.hasOwn(themes, saved?.theme) ? saved.theme : defaults.theme,
    textSize: Object.hasOwn(sizes, saved?.textSize) ? saved.textSize : defaults.textSize,
    lineSpacing: Object.hasOwn(spacing, saved?.lineSpacing) ? saved.lineSpacing : defaults.lineSpacing,
    editor: saved?.editor === 'plain' ? 'plain' : 'auto',
  }
}

export function applyAppearance() { setAppearance(document.documentElement, storedAppearance()) }
export function prefersPlainEditor() { return storedAppearance().editor === 'plain' }

export function settingsWorkspace({ api, actionButton, prepareReload, onModelSaved, editorMode, projectTools }) {
  const dialog = $('settings-dialog')
  const content = $('settings-content')
  const navigation = $('settings-nav')
  const pages = {
    appearance: ['外观与编辑器', '这些偏好保存在当前浏览器。你可以为手机和电脑分别设置。', appearance],
    models: ['写作模型', '默认模型用于未单独指定模型的新任务。每次写稿仍可临时选择。', models],
    stages: ['分工模型', '新任务按环节选用模型。已创建的任务和批次沿用原模型。', stageModels],
    retrieval: ['语义检索', '语义模型用于建立资料索引和按含义检索。连接测试发送固定的测试文本。', retrieval],
    backup: ['备份与恢复', '作品备份可恢复成独立副本。WebDAV 定时备份保存整个工作区的 SQLite 快照。', backup],
    project: ['作品配置', '写作 Skill 和写作目标按作品保存。', projectSettings],
    about: ['关于', '查看当前工作区版本和编辑器模式。', about],
  }
  let current
  const buttons = new Map(Object.entries(pages).map(([id, [title]]) => {
    const button = actionButton(ui(title), () => open(id))
    button.dataset.settingsPage = id
    return [id, button]
  }))
  navigation.append(...buttons.values())

  function canLeave() {
    return !current?.saving && (!current?.dirty?.() || confirm(ui('放弃本页尚未保存的设置？')))
  }

  function close() {
    if (!canLeave()) return
    current = undefined
    dialog.close()
  }

  $('close-settings').addEventListener('click', close)
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })

  async function open(id = 'appearance', reload = false) {
    if (dialog.open && !reload && (current?.id === id || !canLeave())) return
    const [title, description, render] = pages[id]
    const heading = Object.assign(node('h3', ui(title)), { id: 'settings-section-title', tabIndex: -1 })
    const body = node('div')
    const page = { id, body, active: () => current === page && dialog.open }
    current = page
    for (const [key, button] of buttons) {
      if (key === id) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    }
    content.replaceChildren(heading, node('p', ui(description), 'settings-lede'), body)
    content.scrollTop = 0
    if (!dialog.open) dialog.showModal()
    heading.focus()
    try { await render(page) }
    catch (error) {
      if (!page.active()) return
      const message = feedback()
      report(message, error.message, 'error')
      body.replaceChildren(message, actionButton(ui('重新读取设置'), () => open(id, true)))
    }
  }

  async function load(page, path) {
    const message = feedback()
    report(message, ui('正在读取设置…'))
    page.body.append(message)
    const data = await api(path)
    message.remove()
    return data
  }

  function editForm(page, fields, controls, message, submitLabel, save, extras = []) {
    const form = node('form')
    const submit = Object.assign(node('button', ui(submitLabel), 'primary'), { type: 'submit' })
    submit.id = 'settings-save'
    const actions = group('tools settings-actions', submit, ...extras)
    const values = () => controls.map(control => control.value)
    let initial = JSON.stringify(values())
    page.dirty = () => JSON.stringify(values()) !== initial
    const update = () => { submit.disabled = page.saving || !page.dirty() || !form.checkValidity() }
    form.addEventListener('input', update)
    form.addEventListener('change', update)
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (submit.disabled || page.saving || !page.active()) return
      const next = values()
      page.saving = true
      update()
      for (const control of controls) control.disabled = true
      for (const button of extras) button.disabled = true
      report(message, ui('正在保存设置…'))
      try {
        const savedMessage = await save(next)
        initial = JSON.stringify(next)
        report(message, savedMessage || ui('设置已保存。'), savedMessage ? 'error' : 'success')
      } catch (error) {
        report(message, error.message, 'error')
        if (error.status === 409) {
          actions.querySelector('[data-settings-reload]')?.remove()
          const retry = actionButton(ui('重新读取设置'), () => { if (canLeave()) return open(page.id, true) })
          retry.dataset.settingsReload = 'true'
          actions.append(retry)
        }
      } finally {
        page.saving = false
        for (const control of controls) control.disabled = false
        for (const button of extras) button.disabled = false
        update()
      }
    })
    form.append(fields, group('settings-form-footer', actions, message))
    update()
    return form
  }

  function appearance(page) {
    const root = document.documentElement
    const choices = options => Object.entries(options).map(([key, label]) => [key, ui(label)])
    const [themeField, theme] = selectField('settings-theme', '外观主题', choices(themes), root.dataset.theme)
    const [sizeField, size] = selectField('settings-text-size', '正文字号', choices(sizes), root.dataset.textSize)
    const [spacingField, lineSpacing] = selectField('settings-spacing', '正文行距', choices(spacing), root.dataset.lineSpacing)
    const [languageField, language] = selectField('settings-language', '界面语言', [['zh-CN', '简体中文'], ['en-US', 'English']], locale)
    const originalEditor = storedAppearance().editor
    const [editorField, editor] = selectField('settings-editor', '编辑器偏好', choices({ auto: '自动（使用 NAS 提供的编辑器）', plain: '普通编辑器' }), originalEditor)
    editorField.className = 'settings-editor-preference'
    const controls = [theme, size, lineSpacing, language, editor]
    const preview = node('p', ui('潮水退去后，石阶上留下了一枚铜钥匙。她把灯提近了些，才看见齿槽里的盐霜。'), 'settings-preview')
    const updatePreview = () => setAppearance(preview, { theme: theme.value, textSize: size.value, lineSpacing: lineSpacing.value })
    for (const control of [theme, size, lineSpacing]) control.addEventListener('input', updatePreview)
    updatePreview()
    const reset = actionButton(ui('恢复默认外观'), () => {
      theme.value = defaults.theme
      size.value = defaults.textSize
      lineSpacing.value = defaults.lineSpacing
      theme.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const fields = group('', group('settings-fields settings-appearance-fields', themeField, sizeField, spacingField, languageField, editorField),
      card('正文预览', preview), help('切换语言或编辑器会先保存当前文稿，再重新打开原位置。'))
    page.body.append(editForm(page, fields, controls, feedback(), '保存外观', async ([theme, textSize, lineSpacing, language, editor]) => {
      const reload = language !== locale || editor !== originalEditor
      if (reload) await prepareReload(language)
      const values = { theme, textSize, lineSpacing, editor }
      setAppearance(root, values)
      let message
      try { localStorage.setItem(appearanceKey, JSON.stringify(values)) }
      catch { message = ui('浏览器无法保留外观或编辑器设置。') }
      if (reload && (!message || language !== locale)) location.reload()
      return message
    }, [reset]))
  }

  function diagnosis(path, label, data, enabled) {
    const message = feedback()
    let pending = false
    const update = () => { button.disabled = pending || !enabled() }
    const button = actionButton(ui(label), async () => {
      if (pending || !enabled()) return
      const request = data()
      const stillSelected = () => request.id === data().id
      pending = true
      update()
      report(message, ui('正在测试连接…'))
      try {
        const result = await api(`/model-profiles/${path}`, 'POST', request)
        const text = ui('连接成功 · ') + result.elapsedMs + ui(' 毫秒') +
          (result.dimensions ? ui(' · 向量维度 ') + result.dimensions : '')
        if (stillSelected()) report(message, text, 'success')
      } catch (error) { if (stillSelected()) report(message, error.message, 'error') }
      finally { pending = false; update() }
    })
    update()
    return { button, message, update }
  }

  async function models(page) {
    let data = await load(page, '/model-profiles')
    if (!page.active()) return
    onModelSaved(data)
    const selected = () => data.profiles.find(row => row.id === select.value)
    const name = id => data.profiles.find(row => row.id === id)?.label || id || ''
    const [field, select] = selectField('settings-model', '写作模型预设', [['', ui('选择预设')],
      ...data.profiles.map(row => [row.id, `${row.label} · ${row.model}`])], data.available ? data.activeId : '')
    select.required = true
    const info = node('div')
    const display = () => {
      const row = selected()
      info.replaceChildren(details([
        ['工作区当前默认', name(data.activeId) ? name(data.activeId) + (data.available ? '' : ` (${ui('已移除')})`) : ui('待配置')],
        ...(row ? [['模型标识', row.model], ['上下文字符预算', row.contextLimit.toLocaleString(locale)]] : []),
      ]))
    }
    display()
    const guide = card('NAS 部署配置', help('在 Compose 的 .env 中设置 LLM_MODEL、LLM_BASE_URL 和 LLM_API_KEY。多个预设使用 LLM_PROFILES_JSON 或 LLM_PROFILES_FILE。修改后重新创建容器。'))
    if (!data.profiles.length) {
      page.body.append(info, help('在 NAS 配置写作模型后，此处可选择预设。'), guide)
      return
    }
    const test = diagnosis('diagnose', '测试所选写作模型', () => ({ id: select.value }), () => Boolean(selected()))
    const saveMessage = feedback()
    const update = () => { display(); report(test.message, ''); test.update() }
    select.addEventListener('input', update)
    const fields = group('', group('settings-fields', field), info)
    page.body.append(editForm(page, fields, [select], saveMessage, '保存预设', async ([id]) => {
      data = await api('/model-profiles', 'PUT', { id, baseRev: data.rev })
      onModelSaved(data)
      display()
    }), card('连接测试', help('连接测试针对所选预设，只发送固定的测试文本。'), test.button, test.message), guide)
  }

  async function stageModels(page) {
    let data = await load(page, '/model-profiles')
    if (!page.active()) return
    onModelSaved(data)
    const name = data.profiles.find(row => row.id === data.activeId)?.label
    const defaultLabel = name ? ui('跟随默认模型（$1）', name) : ui('跟随默认模型')
    if (!data.profiles.length) {
      page.body.append(help('在 NAS 配置写作模型后，此处可选择预设。'), actionButton(ui('打开写作模型'), () => open('models')))
      return
    }
    const options = [['', defaultLabel], ...data.profiles.map(row => [row.id, row.label])]
    const controls = Object.entries(stages).map(([stage, label]) => selectField(`settings-stage-${stage}`, label, options, data.stages[stage] || ''))
    const fields = group('settings-fields', ...controls.map(([field]) => field))
    page.body.append(help('定稿人物提取使用这里的模型处理手动提取任务。'),
      editForm(page, fields, controls.map(([, select]) => select), feedback(), '保存分工模型', async values => {
        data = await api('/model-profiles/stages', 'PUT', { baseRev: data.stageRev,
          stages: Object.fromEntries(Object.keys(stages).map((stage, i) => [stage, values[i] || null])) })
      }))
  }

  async function retrieval(page) {
    const data = await load(page, '/model-profiles')
    if (!page.active()) return
    const test = diagnosis('diagnose-semantic', '测试语义模型', () => ({}), () => data.semantic)
    page.body.append(details([['状态', ui(data.semantic ? '已配置' : '待配置')], ['模型标识', data.semanticModel]]),
      card('连接测试', test.button, test.message),
      card('NAS 部署配置', help('在 Compose 的 .env 中设置 EMBEDDING_BASE_URL、EMBEDDING_MODEL 和 EMBEDDING_API_KEY，重新创建容器后，在作品的资料库中建立索引。')))
  }

  async function backup(page) {
    const actions = projectTools()
    const restore = actionButton(ui('从备份恢复副本'), () => { close(); actions.restore() })
    const exportLink = Object.assign(node('a', ui('下载作品备份')), { href: actions.backupUrl || '', hidden: !actions.backupUrl })
    const local = card('作品备份', help(actions.backupUrl ? '下载当前作品的 JSON 备份，恢复时会创建新副本。' : '选择作品后，可在此下载该作品的备份。'), group('tools', exportLink, restore))
    const status = feedback()
    const summary = node('div')
    let pending = false
    let timer
    const time = value => value ? new Date(value).toLocaleString(locale) : ''
    const start = actionButton(ui('立即备份'), () => refresh('POST'))
    const reload = actionButton(ui('刷新备份状态'), () => refresh('GET'))
    start.disabled = true
    page.body.append(local, card('WebDAV 备份', status, summary, group('tools', start, reload),
      help('SQLite 快照覆盖整个工作区。恢复时请按部署说明导入独立的数据卷。'),
      help('在 NAS 的 Compose .env 中配置 WEBDAV_BACKUP_URL、WEBDAV_BACKUP_USERNAME 和 WEBDAV_BACKUP_PASSWORD，再重新创建容器。')))
    report(status, ui('正在读取设置…'))
    let enabled = false
    let running = false
    await refresh('GET')

    async function refresh(method) {
      if (pending || !page.active()) return
      pending = true
      clearTimeout(timer)
      start.disabled = reload.disabled = true
      try {
        const state = await api('/webdav-backup', method)
        if (!page.active()) return
        enabled = state.enabled
        running = state.running
        const error = !running && (state.configError || state.error)
        report(status, error ? ui(error) : ui(running ? '正在备份…' : !enabled ? '请先在 NAS 配置 WebDAV 备份。'
          : state.succeeded ? '最近一次备份成功' : '等待首次备份'), error ? 'error' : !running && state.succeeded ? 'success' : '')
        summary.replaceChildren(details([
          ['备份间隔', state.intervalHours ? ui('$1 小时', state.intervalHours) : ''], ['最近尝试', time(state.attempted)],
          ['最近成功', time(state.succeeded)], ['快照文件', state.file], ['下次计划', running ? '' : time(state.next)],
        ]))
        if (running) timer = setTimeout(() => refresh('GET'), 1500)
      } catch (error) { report(status, error.message, 'error') }
      finally {
        pending = false
        reload.disabled = false
        start.disabled = !enabled || running
      }
    }
  }

  function projectSettings(page) {
    const actions = projectTools()
    if (!actions.title) { page.body.append(help('请先在书房选择作品。')); return }
    page.body.append(details([['当前作品', actions.title]]), group('tools', ...[
      ['写作 Skill', actions.skills], ['写作目标', actions.goals],
    ].map(([label, action]) => actionButton(ui(label), () => { close(); return action() }))))
  }

  function about(page) {
    page.body.append(details([['工作区版本', $('release-version').textContent], ['编辑器', editorMode()]]))
  }

  return { open }
}
