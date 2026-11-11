import { manuscriptBytes, manuscriptRequestBytes, splitManuscript } from './manuscript.mjs'
import { screenplayWorkspace } from './screenplay-ui.mjs'
import { novelGoals } from './novel-goals.mjs'
import { architectureSections } from './architecture.mjs'
import { referenceNovelWorkspace } from './reference-novel-ui.mjs'

const $ = id => document.getElementById(id)
const names = { settings: '设定与架构', character: '人物', blueprint: '章节蓝图', chapter: '正文', reference: '参考资料' }
const stages = ['settings', 'character', 'blueprint', 'chapter']
const chapterRuns = { draft: '写稿', outline: '写前细纲', review: '审稿', revise: '修稿' }
const runNames = { ...chapterRuns, plan: 'AI 规划', passage: '选段 AI' }
const runStates = { running: '生成中', done: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
const batchStates = { running: '进行中', paused: '已暂停', done: '已结束', cancelled: '已取消' }
const threadKinds = { plot: '剧情线索', foreshadow: '伏笔' }
const threadStates = { planned: '计划埋设', open: '待回收', resolved: '已回收', archived: '已归档' }
let project = ''
let editor
let documents = []
let stage = 'chapter'
const stageDocuments = new Map()
let model = false
let semanticEnabled = false
let navigation = 0
let dialogAction
let draftDb
let composing = false
let projectStream
let syncTimer
let enhancedBody

const bodyControl = () => enhancedBody ?? $('body')

function resetBody(value) {
  if (enhancedBody) enhancedBody.reset(value)
  else $('body').value = value
}

function setComposing(value) {
  if (composing === value) return
  composing = value
  paint()
  if (!value && editor) schedule(editor)
}

async function enableEnhancedEditor() {
  if (enhancedBody) return
  const host = $('body-editor-host')
  const fallback = $('body')
  try {
    const { createEditor } = await import('./editor.bundle.mjs')
    enhancedBody = createEditor(host, {
      value: fallback.value, maxLength: fallback.maxLength,
      nonce: document.querySelector('meta[name="editor-style-nonce"]').content,
      onEdit: edit, onComposition: setComposing, onLimit: () => note('正文超过长度限制'),
    })
    fallback.hidden = true
    host.hidden = false
    $('editor-notices').hidden = false
  } catch {
    note('增强编辑器加载失败，已切换到普通文本编辑器')
  }
}

function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

function note(message = '') {
  $('notice').textContent = message
  $('notice').hidden = !message
}

async function api(path, method = 'GET', data) {
  const response = await fetch('/api' + path, {
    method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(path === '/import' || path.endsWith('/chapter-imports') ? 60_000
      : path.endsWith('/semantic/search') ? 25_000 : 15_000),
  })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error || '请求失败'), { status: response.status, current: result.current })
  return result
}

function localTransaction(mode, operation) {
  draftDb ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('pagekin-web-novel', 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('drafts', { keyPath: 'key' })
      store.createIndex('document', 'document')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('本机草稿库被其他标签页占用'))
  })
  return draftDb.then(db => new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', mode)
    const request = operation(transaction.objectStore('drafts'))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = () => reject(transaction.error || new Error('本机保存失败'))
  }))
}

const dirty = state => state && (state.pending || state.edit > state.acked)
const docPath = state => `/projects/${state.doc.project_id}/documents/${state.doc.id}`

function persistLocal(state) {
  const record = {
    key: state.key, document: state.doc.id, updated: Date.now(), baseRev: state.doc.rev,
    title: state.title, body: state.body, edit: state.edit, acked: state.acked, pending: state.pending,
  }
  const save = dirty(state)
  const result = localTransaction('readwrite', store => save ? store.put(record) : store.delete(record.key))
    .then(() => {
      if (state.localWrite === result) { state.localOk = true; paint(state) }
      return true
    })
    .catch(() => {
      if (state.localWrite === result) { state.localOk = false; paint(state) }
      return false
    })
  state.localWrite = result
  return result
}

function paint(state = editor) {
  if (!state || state !== editor) return
  const locked = state.doc.status === 'final'
  $('title').readOnly = locked || Boolean(state.mutating)
  bodyControl().readOnly = locked || Boolean(state.mutating)
  $('save').disabled = locked || Boolean(state.conflict) || Boolean(state.mutating)
  $('status').disabled = Boolean(state.mutating)
  $('replace-tools').hidden = locked
  $('replace-one').disabled = $('replace-all').disabled = Boolean(state.mutating || state.conflict || composing)
  $('undo-replace').hidden = state.undoReplace?.edit !== state.edit
  $('undo-replace').disabled = $('replace-one').disabled
  $('previous-chapter').hidden = $('next-chapter').hidden = state.doc.kind !== 'chapter'
  $('previous-chapter').disabled = !adjacentChapter(state, -1)
  $('next-chapter').disabled = !adjacentChapter(state, 1)
  const pairedKind = { chapter: 'blueprint', blueprint: 'chapter' }[state.doc.kind]
  $('paired-document').hidden = !pairedKind
  if (pairedKind) $('paired-document').textContent = '本章' + (pairedKind === 'blueprint' ? '蓝图' : '正文')
  $('recover').hidden = !state.recovered.length
  $('conflict').hidden = !state.conflict
  $('reload-remote').hidden = state.remoteRev <= state.doc.rev || Boolean(state.conflict)
  $('reload-remote').disabled = Boolean(state.saving || state.mutating || composing)
  $('status').hidden = state.doc.kind !== 'chapter'
  $('status').textContent = locked ? '重新打开定稿' : '定稿'
  const planning = state.doc.kind !== 'chapter'
  $('ai-passage').hidden = planning || !model || locked
  $('ai-passage').disabled = state.job?.status === 'running'
  $('ai').hidden = false
  $('ai-heading').textContent = planning ? 'AI ' + names[state.doc.kind] : 'AI 细纲、写稿、审稿与修稿'
  $('outline-controls').hidden = planning
  $('selected-outline').textContent = !state.outline ? '可先生成写前细纲，确认后用于写稿。'
    : state.outline.baseRev !== state.doc.rev ? '正文已更新，请重新生成细纲或取消引用。' : '已选细纲，下一次写稿将引用。'
  $('clear-outline').hidden = !state.outline
  $('selected-references').textContent = state.references.size
    ? '已选资料：' + [...state.references].map(([id, title]) => title + (state.referenceSpans.has(id) ? '（片段）' : '')).join('、')
    : '可从参考资料库中选择本次生成所需的资料。'
  $('clear-references').hidden = state.references.size === 0
  $('reference-query-label').hidden = state.references.size === state.referenceSpans.size
  for (const btn of document.querySelectorAll('[data-run]')) {
    btn.hidden = planning !== (btn.dataset.run === 'plan')
    btn.disabled = !model || locked || state.job?.status === 'running'
    if (btn.dataset.run === 'plan') btn.textContent = '生成' + names[state.doc.kind] + '候选'
  }
  $('preview-context').disabled = locked
  if (state.job?.reviewReport) {
    const current = currentReview(state)
    $('review-issues').disabled = !current
    $('review-stale').hidden = !state.job.reviewReport.issues.length || current
  }
  $('length').textContent = `${state.body.length.toLocaleString()} 字符`
  $('document-label').textContent = [names[state.doc.kind], state.doc.number && `第 ${state.doc.number} 章`,
    locked && '已定稿'].filter(Boolean).join(' · ')
  $('save-state').textContent = state.conflict ? '发现版本冲突，请核对两份内容'
    : state.saving ? '正在提交到 NAS…'
      : dirty(state) ? [
        state.localOk === true ? '已存本机，等待同步' : state.localOk === false ? '本机草稿写入失败' : '本机草稿保存中',
        state.error,
      ].filter(Boolean).join(' · ')
        : `已保存到 NAS · v${state.doc.rev}`
}

function schedule(state) {
  clearTimeout(state.timer)
  state.timer = setTimeout(() => { if (state === editor) void flush(state) }, 1500)
}

function edit() {
  const state = editor
  if (!state || state.doc.status === 'final' || state.mutating) return
  state.title = $('title').value
  state.body = bodyControl().value
  state.edit++
  state.localOk = null
  void persistLocal(state)
  paint()
  if (!composing) schedule(state)
}

function adjacentChapter(state, direction) {
  if (state.doc.kind !== 'chapter') return undefined
  const chapters = documents.filter(item => item.kind === 'chapter')
  const index = chapters.findIndex(item => item.id === state.doc.id)
  return index < 0 ? undefined : chapters[index + direction]
}

function findPanel(open, focus = true) {
  $('find-panel').hidden = !open
  $('open-find').setAttribute('aria-expanded', String(open))
  if (open && focus) { $('find-query').focus(); $('find-query').select() }
}

function findPattern() {
  const query = $('find-query').value
  if (!query) return null
  const escaped = Array.from(query, char => '\\u{' + char.codePointAt(0).toString(16) + '}').join('')
  return new RegExp(escaped, $('find-case').checked ? 'gu' : 'giu')
}

function revealMatch(input, offset) {
  if (input.scrollHeight <= input.clientHeight) return
  const mirror = document.createElement('div')
  mirror.className = 'find-mirror'
  const style = getComputedStyle(input)
  for (const property of ['font', 'lineHeight', 'letterSpacing', 'wordSpacing', 'padding', 'tabSize', 'whiteSpace', 'overflowWrap']) {
    mirror.style[property] = style[property]
  }
  mirror.style.width = input.clientWidth + 'px'
  const marker = document.createElement('span')
  marker.textContent = input.value.slice(offset, offset + 1)
  mirror.append(input.value.slice(0, offset), marker, input.value.slice(offset + 1))
  document.body.append(mirror)
  try {
    const top = marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top
    const line = parseFloat(style.lineHeight) || marker.offsetHeight
    if (top < input.scrollTop || top + line > input.scrollTop + input.clientHeight) {
      input.scrollTop = Math.max(0, top - input.clientHeight / 3)
    }
  } finally { mirror.remove() }
}

function locate(direction, reportOnly = false) {
  const input = bodyControl()
  const pattern = findPattern()
  if (!pattern) {
    $('find-result').textContent = ''
    return null
  }
  let first, last, previous, next, current
  let count = 0
  let matchedLength = 0
  for (const match of input.value.matchAll(pattern)) {
    const span = { start: match.index, end: match.index + match[0].length, ordinal: ++count }
    matchedLength += match[0].length
    first ??= span
    last = span
    if (span.end <= input.selectionStart) previous = span
    if (!next && span.start >= input.selectionEnd) next = span
    if (span.start === input.selectionStart && span.end === input.selectionEnd) current = span
  }
  const hit = reportOnly ? current : direction < 0 ? previous ?? last : next ?? first
  $('find-result').textContent = count === 0 ? '没有找到匹配' : hit ? '第 ' + hit.ordinal + ' / ' + count + ' 处' : '找到 ' + count + ' 处'
  if (hit && !reportOnly) {
    input.focus({ preventScroll: true })
    input.setSelectionRange(hit.start, hit.end)
    if (enhancedBody) enhancedBody.reveal(hit.start)
    else revealMatch(input, hit.start)
  }
  return { current, count, matchedLength }
}

function editableForReplace(state) {
  return state && state === editor && state.doc.status !== 'final' && !state.mutating && !state.conflict && !composing
}

function replaceBody(state, next, start, end = start) {
  if (!editableForReplace(state)) throw new Error('请在文档可编辑时替换')
  const input = bodyControl()
  if (next.length > input.maxLength) throw new Error('替换后的正文超过长度限制')
  if (input.value === next) return
  const previous = { body: input.value, start: input.selectionStart, end: input.selectionEnd }
  input.value = next
  input.focus({ preventScroll: true })
  input.setSelectionRange(start, end)
  edit()
  state.undoReplace = { ...previous, edit: state.edit }
  paint(state)
  locate(1, true)
}

function replaceOne() {
  const state = editor
  if (!editableForReplace(state)) return
  const range = locate(1, true)?.current
  if (!range) { locate(1); return }
  const replacement = $('replace-query').value
  const value = bodyControl().value
  replaceBody(state, value.slice(0, range.start) + replacement + value.slice(range.end), range.start + replacement.length)
}

function replaceAll() {
  const state = editor
  const pattern = findPattern()
  if (!pattern || !editableForReplace(state)) return
  const { count, matchedLength } = locate(1, true)
  if (!count) return
  const value = bodyControl().value
  const replacement = $('replace-query').value
  if (value.length - matchedLength + count * replacement.length > bodyControl().maxLength) {
    throw new Error('替换后的正文超过长度限制')
  }
  const summary = document.createElement('p')
  summary.textContent = '将在当前文档中替换 ' + count + ' 处匹配。'
  dialog('确认全部替换', [summary], () => {
    if (!editableForReplace(state) || bodyControl().value !== value) throw new Error('正文已变化，请重新查找')
    $('dialog').close()
    replaceBody(state, value.replace(pattern, () => replacement), 0)
  }, '替换全部')
}

async function flush(state, checkpoint = false) {
  if (!state || state.doc.status === 'final' || state.mutating) return !dirty(state)
  if (state.saving) {
    const ok = await state.saving
    return ok && (checkpoint || dirty(state)) ? flush(state, checkpoint) : ok
  }
  if (state.conflict || (composing && state === editor)) return false
  if (!dirty(state) && !checkpoint) return true
  if (!state.title.trim()) { state.error = '请输入标题'; paint(state); return false }
  if (!state.pending) {
    state.pending = {
      sequence: state.edit,
      request: { title: state.title, body: state.body, baseRev: state.doc.rev, mutationId: uuid(), checkpoint },
    }
  }
  const item = state.pending
  state.saving = (async () => {
    await persistLocal(state)
    try {
      const receipt = await api(docPath(state), 'PUT', item.request)
      state.doc.rev = receipt.rev
      state.doc.updated = receipt.updated
      state.acked = item.sequence
      state.pending = null
      state.error = ''
      if (state.edit === item.sequence) {
        state.title = item.request.title.trim()
        if (editor === state && document.activeElement !== $('title')) $('title').value = state.title
      }
      await persistLocal(state)
      if (!dirty(state) && state.recoverySource && state.localOk) {
        const source = state.recoverySource
        state.recoverySource = null
        await localTransaction('readwrite', store => {
          const request = store.get(source.key)
          request.onsuccess = () => {
            const stored = request.result
            if (stored?.updated === source.updated && stored.edit === source.edit &&
                stored.pending?.request.mutationId === source.pending?.request.mutationId) store.delete(source.key)
          }
          return request
        }).catch(() => {})
      }
      if (editor === state) {
        const itemOption = Array.from($('documents').options).find(option => option.value === state.doc.id)
        if (itemOption) itemOption.textContent = numberedTitle({ ...state.doc, title: state.title })
      }
      return true
    } catch (error) {
      if (error.status === 409 && error.current) state.conflict = error.current
      state.error = error.status === 401 ? '会话已过期，请刷新后重新登录'
        : error.status ? error.message : '连接失败，将重试'
      await persistLocal(state)
      return false
    }
  })()
  paint(state)
  try { return await state.saving }
  finally { state.saving = null; paint(state) }
}

async function leave() {
  const state = editor
  if (!dirty(state)) return
  if (await flush(state) && !dirty(state)) return
  if (!await persistLocal(state)) throw new Error('无法保存本机草稿，请先复制正文或恢复连接')
  note('未同步内容已保留在本机。重新打开该文档可查看草稿。')
}

function remember() {
  try { sessionStorage.setItem('pagekin-location', JSON.stringify([project, editor?.doc.id, stage])) }
  catch { /* Browser storage can be unavailable. */ }
}

function numberedTitle(doc) {
  return [doc.number && `第 ${doc.number} 章`, doc.title, doc.status === 'final' && '（定稿）'].filter(Boolean).join(' ')
}

function choices(element, rows, label, selected = '') {
  element.replaceChildren(new Option(label, ''), ...rows.map(([id, title]) => new Option(title, id)))
  element.value = selected
}

function renderCatalog(selected = editor?.doc.id ?? '') {
  const chapterStatus = $('chapter-filter').value
  const filtered = documents.filter(row => row.kind === stage &&
    (stage !== 'chapter' || !chapterStatus || row.status === chapterStatus))
  for (const button of $('stage-nav').querySelectorAll('[data-stage]')) {
    button.setAttribute('aria-pressed', String(button.dataset.stage === stage))
  }
  $('new-document').textContent = '新建' + names[stage]
  $('architecture-templates').hidden = stage !== 'settings'
  $('batch-blueprints').hidden = stage !== 'blueprint' || !model
  $('catalog-label').textContent = '打开' + names[stage]
  $('chapter-filter-label').hidden = stage !== 'chapter'
  choices($('documents'), filtered.map(row => [row.id, numberedTitle(row)]), '选择文档', selected)

  if ($('empty').hidden) return
  $('overview-title').textContent = project ? $('projects').selectedOptions[0]?.textContent || '作品概览' : '书房'
  const counts = stages.map(kind => documents.filter(row => row.kind === kind).length)
  const finalized = documents.filter(row => row.kind === 'chapter' && row.status === 'final').length
  $('overview-summary').textContent = project
    ? `设定与架构 ${counts[0]} 份 · 人物 ${counts[1]} 人 · 蓝图 ${counts[2]} 章 · 正文 ${counts[3]} 章（${finalized} 章已定稿）`
    : '选择一部作品，或新建作品开始写作。'
  const list = $('overview-documents')
  list.replaceChildren()
  if (!project) return
  const title = document.createElement('h2')
  title.textContent = names[stage]
  list.append(title)
  if (!filtered.length) list.append(document.createTextNode('此阶段没有符合条件的文档。'))
  const latest = filtered.slice().sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 8)
  for (const row of latest) list.append(actionButton(numberedTitle(row), () => openDocument(row.id)))
}

async function refreshDocuments(selected) {
  const pid = project
  const rows = pid ? await api(`/projects/${pid}/documents`) : []
  if (pid !== project) return
  documents = rows
  renderCatalog(selected ?? editor?.doc.id)
  observeRevision(editor, rows.find(row => row.id === editor?.doc.id)?.rev)
}

function observeRevision(state, rev) {
  if (!state || !Number.isSafeInteger(rev)) return
  state.remoteRev = Math.max(state.remoteRev, rev)
  paint(state)
}

function syncCatalog() {
  const pid = project
  if (!pid) return
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    if (project === pid) void refreshDocuments().catch(() => {})
  }, 120)
}

function subscribeProject(pid) {
  projectStream?.close()
  clearTimeout(syncTimer)
  if (!pid) return
  const stream = new EventSource('/api/projects/' + pid + '/events')
  projectStream = stream
  stream.addEventListener('sync', () => { if (project === pid && projectStream === stream) syncCatalog() })
  stream.addEventListener('document', event => {
    if (project !== pid || projectStream !== stream) return
    const { id, rev } = JSON.parse(event.data)
    if (editor?.doc.id === id) observeRevision(editor, rev)
    syncCatalog()
  })
}

function showEditor(doc) {
  findPanel(false)
  $('find-query').value = ''
  $('replace-query').value = ''
  $('find-result').textContent = ''
  stage = doc.kind
  stageDocuments.set(stage, doc.id)
  if (stage === 'chapter' && $('chapter-filter').value && $('chapter-filter').value !== doc.status) $('chapter-filter').value = ''
  editor = {
    doc, title: doc.title, body: doc.body, key: uuid(), edit: 0, acked: 0,
    pending: null, recovered: [], job: null, jobRequest: null,
    references: new Map(), referenceSpans: new Map(), remoteRev: doc.rev,
  }
  composing = false
  $('empty').hidden = true
  $('editor').hidden = false
  $('title').value = doc.title
  resetBody(doc.body)
  $('guidance').value = ''
  $('reference-query').value = ''
  $('ai').open = false
  renderJob(editor)
  renderCatalog(doc.id)
  paint()
  remember()
  return editor
}

function clearEditor() {
  clearTimeout(editor?.timer)
  editor = undefined
  findPanel(false)
  composing = false
  $('editor').hidden = true
  $('empty').hidden = false
  setFocusWriting(false)
  renderCatalog()
  remember()
}

async function openDocument(id) {
  const request = ++navigation
  const pid = project
  await leave()
  if (request !== navigation) return
  if (!id) return clearEditor()
  const doc = await api(`/projects/${pid}/documents/${id}`)
  if (request !== navigation) return
  await leave()
  if (request !== navigation) return
  const state = showEditor(doc)
  await loadRecovery(state)
  if (state === editor) await findActive(state)
}

async function loadRecovery(state) {
  try {
    const recovered = await localTransaction('readonly', store => store.index('document').getAll(state.doc.id))
    state.recovered = recovered.filter(draft => draft.key !== state.key).sort((a, b) => b.updated - a.updated)
  } catch { state.localOk = false }
  paint(state)
}

async function selectProject(id, selected, initialStage = 'chapter') {
  const request = ++navigation
  await leave()
  if (request !== navigation) return
  const rows = id ? await api(`/projects/${id}/documents`) : []
  if (request !== navigation) return
  await leave()
  if (request !== navigation) return
  project = id
  stageDocuments.clear()
  subscribeProject(id)
  documents = rows
  $('projects').value = id
  $('project-tools').hidden = !id
  $('chapter-filter').value = ''
  $('backup').href = `/api/projects/${id}/backup`
  const doc = rows.find(row => row.id === selected)
  stage = doc?.kind ?? initialStage
  clearEditor()
  if (doc) await openDocument(doc.id)
}

async function refreshProjects(selected = '', selectedDoc, initialStage) {
  const rows = await api('/projects')
  choices($('projects'), rows.map(row => [row.id, row.title]), '选择作品', selected)
  await selectProject(rows.some(row => row.id === selected) ? selected : '', selectedDoc, initialStage)
}

function dialog(title, contents, action, submit = '确定') {
  $('dialog-title').textContent = title
  $('dialog-body').replaceChildren(...contents)
  $('dialog-submit').hidden = !action
  $('dialog-submit').textContent = submit
  dialogAction = action
  if (!$('dialog').open) $('dialog').showModal()
}

function field(label, options) {
  const wrapper = document.createElement('label')
  const input = document.createElement('input')
  Object.assign(input, { required: true, ...options })
  wrapper.append(label, input)
  return [wrapper, input]
}

function compare(leftTitle, left, rightTitle, right) {
  const root = document.createElement('div')
  root.className = 'compare'
  for (const [label, body] of [[leftTitle, left], [rightTitle, right]]) {
    const column = document.createElement('section')
    const heading = document.createElement('h3')
    const pre = document.createElement('pre')
    heading.textContent = label
    pre.textContent = body
    column.append(heading, pre)
    root.append(column)
  }
  return root
}

function actionButton(label, action) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.addEventListener('click', () => runAction(action))
  return button
}

function exportManuscript() {
  if (!project) return
  const path = `/api/projects/${project}/export`
  const [scopeLabel, scope] = selectField('正文范围', {
    final: '只导出最近定稿', all: '导出全部章节的 NAS 当前版本（含草稿）',
  }, 'final')
  const [formatLabel, format] = selectField('文件格式', {
    md: '合并 Markdown', txt: '合并 TXT（UTF-8）', zip: '分章 Markdown（ZIP）',
  }, 'md')
  const download = document.createElement('a')
  download.textContent = '下载正文'
  const update = () => {
    const query = new URLSearchParams({ format: format.value })
    if (scope.value === 'all') query.set('drafts', '1')
    download.href = path + '?' + query
  }
  scope.addEventListener('change', update)
  format.addEventListener('change', update)
  update()
  dialog('导出正文', [scopeLabel, formatLabel, download])
}

async function editProjectGoals() {
  const pid = project
  const path = `/projects/${pid}/goals`
  let current = await api(path)
  if (pid !== project) return
  const fields = novelGoals.map(({ key, label, max, maxLength }) => field(label, {
    name: key, required: false, value: current.goals[key] ?? '',
    ...(max ? { type: 'number', min: 1, max, step: 1 } : { maxLength }),
  }))
  const feedback = document.createElement('div')
  feedback.setAttribute('role', 'status')
  const help = document.createElement('p')
  help.textContent = '所填目标会随本作品的 AI 任务发送。各项均可留空。'
  dialog('写作目标', [help, ...fields.map(([label]) => label), feedback], async () => {
    if (pid !== project) return
    const goals = Object.fromEntries(fields.map(([, input]) => [
      input.name, input.type === 'number' ? (input.value === '' ? null : input.valueAsNumber) : input.value,
    ]))
    try {
      await api(path, 'PUT', { goals, baseRev: current.rev })
      if (feedback.isConnected && $('dialog').open) $('dialog').close()
    } catch (error) {
      feedback.textContent = error.message
      if (error.status !== 409 || !error.current) return
      const comparison = document.createElement('p')
      comparison.textContent = novelGoals.map(({ key, label }) => label + ' ' + (error.current.goals[key] ?? '未填写')).join(' · ')
      feedback.append(comparison, actionButton('采用 NAS 版本并继续编辑', () => {
        current = error.current
        for (const [, input] of fields) input.value = current.goals[input.name] ?? ''
        feedback.replaceChildren()
      }))
    }
  }, '保存写作目标')
}

function searchProject() {
  const pid = project
  const [label, query] = field('标题或正文关键词', { type: 'search', maxLength: 100 })
  const results = document.createElement('div')
  dialog('搜索作品', [label, results], async () => {
    const hits = await api(`/projects/${pid}/search?q=${encodeURIComponent(query.value)}`)
    if (pid !== project) return
    results.replaceChildren(...(hits.length ? hits.map(hit => {
      const row = document.createElement('section')
      const excerpt = document.createElement('p')
      excerpt.textContent = hit.excerpt
      row.append(actionButton(`${names[hit.kind]} · ${numberedTitle(hit)}`, async () => {
        if (hit.kind === 'reference') return viewReference(pid, hit.id)
        await openDocument(hit.id)
        if (editor?.doc.id === hit.id) {
          await refreshDocuments(hit.id)
          $('dialog').close()
        }
      }), excerpt)
      return row
    }) : [document.createTextNode('没有找到匹配的内容')]))
  }, '搜索')
}

async function viewReference(pid, id, span) {
  const material = await api(`/projects/${pid}/references/${id}`)
  if (project !== pid) return
  const body = document.createElement('pre')
  body.textContent = span ? material.body.slice(span.start, span.end) : material.body
  const state = editor
  const canSelect = model && state && state.doc.status !== 'final'
  dialog(material.title, [body], canSelect ? () => {
    if (state !== editor) throw new Error('当前章节已切换')
    if (state.references.size >= 5 && !state.references.has(id)) throw new Error('最多可选择五份参考资料')
    state.references.set(id, material.title)
    if (span) state.referenceSpans.set(id, { id, start: span.start, end: span.end })
    else state.referenceSpans.delete(id)
    paint(state)
    $('ai').open = true
    $('dialog').close()
  } : undefined, span ? '引用这个片段' : '加入当前章节的 AI 上下文')
}

function semanticSearch() {
  const pid = project
  const path = '/projects/' + pid + '/semantic'
  const [label, query] = field('用自然语言描述要找的资料', { maxLength: 400, type: 'search' })
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const results = document.createElement('div')
  const explanation = document.createElement('p')
  explanation.textContent = '建立索引会将本作品的资料片段发送到配置的语义模型，每批最多 128 个片段。检索时也会发送查询词。'
  const build = actionButton('建立或继续索引', async () => {
    build.disabled = true
    try {
      await api(path + '/index', 'POST', {})
      await refresh()
    } catch (error) {
      status.textContent = error.message
      build.disabled = false
    }
  })
  const stillOpen = () => pid === project && $('dialog').open && results.isConnected
  let indexed = false

  async function refresh() {
    try {
      const state = await api(path)
      if (!stillOpen()) return
      indexed = state.chunks > 0
      status.textContent = '已完成 ' + state.indexed + ' / ' + state.count + ' 份资料，' + state.chunks + ' 个片段。'
        + (state.state === 'running' ? '正在建立索引…' : state.message)
      build.disabled = state.state === 'running' || state.count === state.indexed || state.chunks >= state.capacity
      if (state.state === 'running') setTimeout(() => { if (stillOpen()) void refresh() }, 1200)
    } catch (error) { if (stillOpen()) status.textContent = error.message }
  }

  build.disabled = true
  dialog('参考资料语义检索', [explanation, build, status, label, results], async () => {
    results.replaceChildren()
    if (!indexed) {
      results.textContent = '请先为本作品建立索引。'
      return
    }
    try {
      const hits = await api(path + '/search', 'POST', { q: query.value })
      if (!stillOpen()) return
      if (!hits.length) results.textContent = '未找到相关片段，可尝试换一种描述或使用关键词搜索。'
      for (const hit of hits) {
        const section = document.createElement('section')
        const excerpt = document.createElement('pre')
        excerpt.textContent = hit.excerpt
        section.append(actionButton(hit.title, () => viewReference(pid, hit.id, hit)), excerpt)
        results.append(section)
      }
    } catch (error) { if (stillOpen()) results.textContent = error.message }
  }, '语义检索')
  void refresh()
}

async function referenceLibrary() {
  const pid = project
  const rows = await api(`/projects/${pid}/references`)
  if (pid !== project) return
  const message = document.createElement('p')
  message.textContent = rows.length ? '打开资料后可查看，或加入当前章节的 AI 上下文。' : '导入 UTF-8 的 TXT 或 Markdown 资料。'
  dialog('参考资料', [
    message,
    actionButton('导入 TXT / Markdown', () => $('reference-file').click()),
    ...rows.map(row => actionButton(row.title, () => viewReference(pid, row.id))),
  ])
}

function selectField(label, options, value) {
  const wrapper = document.createElement('label')
  const select = document.createElement('select')
  for (const [id, text] of Object.entries(options)) select.append(new Option(text, id))
  select.value = value
  wrapper.append(label, select)
  return [wrapper, select]
}

function editThread(pid, thread) {
  const [titleLabel, title] = field('线索标题', { maxLength: 160, value: thread?.title ?? '' })
  const [kindLabel, kind] = selectField('类型', threadKinds, thread?.kind ?? 'foreshadow')
  const [statusLabel, status] = selectField('状态', threadStates, thread?.status ?? 'planned')
  const [plantedLabel, planted] = field('埋设章号', { type: 'number', min: 1, max: 99999, required: false, value: thread?.planted ?? '' })
  const [dueLabel, due] = field('预计回收章号', { type: 'number', min: 1, max: 99999, required: false, value: thread?.due ?? '' })
  const [resolvedLabel, resolved] = field('实际回收章号', { type: 'number', min: 1, max: 99999, required: false, value: thread?.resolved ?? '' })
  const description = document.createElement('label')
  const body = document.createElement('textarea')
  body.rows = 5
  body.maxLength = 6000
  body.value = thread?.body ?? ''
  description.append('线索内容与回收计划', body)
  const errorText = document.createElement('p')
  errorText.setAttribute('role', 'status')
  const toggleResolved = () => { resolved.required = status.value === 'resolved' }
  status.addEventListener('change', toggleResolved)
  toggleResolved()
  const chapterNumber = element => element.value === '' ? null : element.valueAsNumber
  dialog(thread ? '编辑线索' : '新增线索', [titleLabel, kindLabel, statusLabel,
    plantedLabel, dueLabel, resolvedLabel, description, errorText], async () => {
    if (project !== pid) return
    errorText.textContent = ''
    const value = {
      title: title.value, body: body.value, kind: kind.value, status: status.value,
      planted: chapterNumber(planted), due: chapterNumber(due), resolved: chapterNumber(resolved),
    }
    const path = '/projects/' + pid + '/threads'
    try {
      if (thread) await api(path + '/' + thread.id, 'PUT', { ...value, baseRev: thread.rev })
      else await api(path, 'POST', value)
    } catch (error) {
      errorText.textContent = error.message
      if (error.status === 409 && error.current) {
        errorText.append('。NAS 版本：' + error.current.title + ' · ' + threadStates[error.current.status])
      }
      return
    }
    if ($('dialog').open && title.isConnected && project === pid) await threadList()
  }, '保存线索')
}

async function threadList() {
  const pid = project
  const rows = await api('/projects/' + pid + '/threads')
  if (pid !== project) return
  const [filterLabel, filter] = selectField('筛选状态', { all: '全部状态', ...threadStates }, 'all')
  const list = document.createElement('div')
  list.className = 'manuscript-list'
  function render() {
    const filtered = rows.filter(row => filter.value === 'all' || row.status === filter.value)
    list.replaceChildren(...(filtered.length ? filtered.map(row => {
      const section = document.createElement('section')
      const caption = document.createElement('p')
      caption.textContent = [threadKinds[row.kind], threadStates[row.status],
        row.planted && '埋设第 ' + row.planted + ' 章',
        row.due && '预计第 ' + row.due + ' 章',
        row.resolved && '回收第 ' + row.resolved + ' 章'].filter(Boolean).join(' · ')
      section.append(actionButton(row.title, () => editThread(pid, row)), caption)
      return section
    }) : [document.createTextNode('当前没有线索')]))
  }
  filter.addEventListener('change', render)
  render()
  dialog('剧情线索与伏笔', [actionButton('新增线索', () => editThread(pid)), filterLabel, list])
}

function newDocument(content = '', title = '', kind = stage, chapterNumber) {
  const pid = project
  const [titleField, name] = field('标题', { maxLength: 160, value: title })
  const number = chapterNumber ?? Math.max(0, ...documents.filter(doc => doc.kind === kind).map(doc => doc.number ?? 0)) + 1
  const [numberField, ordinal] = field('章节号', { type: 'number', min: 1, max: 99999, value: number })
  const numbered = ['chapter', 'blueprint'].includes(kind)
  dialog(`新建${names[kind]}`, [titleField, ...(numbered ? [numberField] : [])], async () => {
    await leave()
    const doc = await api(`/projects/${pid}/documents`, 'POST', {
      kind, title: name.value, body: content, ...(numbered ? { number: Number(ordinal.value) } : {}),
    })
    await refreshDocuments(doc.id)
    await openDocument(doc.id)
    $('dialog').close()
    bodyControl().focus()
  })
}

function architectureTemplates() {
  const entries = Object.values(architectureSections).map(({ title, headings }) => {
    const existing = documents.find(doc => doc.kind === 'settings' && doc.title === title)
    return actionButton(existing ? '打开' + title : '新建' + title, async () => {
      if (!existing) return newDocument(headings.map(heading => '## ' + heading).join('\n\n') + '\n', title, 'settings')
      await openDocument(existing.id)
      if (editor?.doc.id === existing.id) $('dialog').close()
    })
  })
  dialog('架构模板', entries)
}

function manuscriptPreview(pid, parsed, existing) {
  const occupied = new Set(existing.filter(doc => doc.kind === 'chapter').map(doc => doc.number))
  const last = Math.max(0, ...occupied)
  const numbers = parsed.chapters.map(chapter => chapter.number)
  const preserveDefault = numbers.every(number => number !== null && !occupied.has(number)) && new Set(numbers).size === numbers.length
  const summary = document.createElement('p')
  summary.textContent = parsed.detected
    ? '识别到 ' + parsed.chapters.length + ' 章，请检查标题与正文。' + (parsed.hasPreface ? ' 首章标题前的文字并入首章。' : '')
    : '没有识别到章标题，将按一章预览。'
  const [startLabel, start] = field('连续编号从第几章开始', { type: 'number', min: 1, max: 99999, value: Math.min(99999, last + 1) })
  const preserve = document.createElement('input')
  preserve.type = 'checkbox'
  preserve.checked = preserveDefault
  const preserveLabel = document.createElement('label')
  preserveLabel.className = 'manuscript-check'
  preserveLabel.append(preserve, ' 保留文件中的章号')
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const list = document.createElement('div')
  list.className = 'manuscript-list'
  const rows = parsed.chapters.map(chapter => {
    const row = document.createElement('section')
    const label = document.createElement('label')
    label.className = 'manuscript-check'
    const checked = document.createElement('input')
    checked.type = 'checkbox'
    checked.checked = true
    const title = document.createElement('span')
    label.append(checked, title)
    const details = document.createElement('details')
    const preview = document.createElement('summary')
    preview.textContent = '查看正文片段'
    const excerpt = document.createElement('pre')
    excerpt.textContent = chapter.body ? chapter.body.slice(0, 450) + (chapter.body.length > 450 ? '…' : '') : '（空章）'
    details.append(preview, excerpt)
    row.append(label, details)
    list.append(row)
    return { chapter, checked, title }
  })
  let plan = []
  let problems = []
  const attempts = new Map()
  let submitted = false

  function update() {
    startLabel.hidden = preserve.checked
    start.disabled = preserve.checked
    let next = start.valueAsNumber
    const seen = new Set()
    plan = []
    problems = []
    for (const [index, { chapter, checked, title }] of rows.entries()) {
      const number = preserve.checked ? chapter.number : next
      const issue = !Number.isInteger(number) || number < 1 || number > 99999 ? '章号无效'
        : occupied.has(number) ? '章号已占用'
          : seen.has(number) ? '章号重复'
            : chapter.body.length > 180_000 ? '正文超过单章上限' : ''
      title.textContent = (checked.checked && Number.isInteger(number) ? '第 ' + number + ' 章 · ' : '')
        + chapter.title + '（' + chapter.body.length.toLocaleString() + ' 字符）' + (checked.checked && issue ? ' · ' + issue : '')
      if (!checked.checked) continue
      if (!preserve.checked) next++
      seen.add(number)
      if (issue) problems.push(issue)
      plan.push({ index, number, title: chapter.title, body: chapter.body })
    }
    status.textContent = problems.length ? '请取消选择有问题的章节或调整编号。'
      : plan.length ? '已选择 ' + plan.length + ' 章，将作为草稿加入作品。' : '请选择至少一章。'
  }

  preserve.addEventListener('change', update)
  start.addEventListener('input', update)
  list.addEventListener('change', update)
  update()
  dialog('预览整稿导入', [summary, preserveLabel, startLabel, status, list], async () => {
    if (submitted || pid !== project) return
    if (!plan.length || problems.length) return
    const requestNavigation = navigation
    const selected = plan
    const key = selected.map(chapter => chapter.index + ':' + chapter.number).join(',')
    const mutationId = attempts.get(key) ?? uuid()
    const chapters = selected.map(({ number, title, body }) => ({ number, title, body }))
    const data = { mutationId, chapters }
    if (new Blob([JSON.stringify(data)]).size > manuscriptRequestBytes) {
      status.textContent = '选中的正文超过单次上传限制，请分批导入。'
      return
    }
    attempts.set(key, mutationId)
    status.textContent = '正在导入…'
    let receipt
    try {
      await leave()
      if (project !== pid || navigation !== requestNavigation || !$('dialog').open || !list.isConnected) return
      receipt = await api('/projects/' + pid + '/chapter-imports', 'POST', data)
    } catch (error) {
      if (error.status === 409) {
        for (const number of error.current?.occupied ?? []) occupied.add(number)
        update()
        status.textContent = error.message + '。请检查最新章号后重试。'
      } else {
        status.textContent = error.status ? error.message : '连接中断。可以按同一选择重试，已提交的批次不会重复创建。'
      }
      return
    }
    submitted = true
    const stillPreviewing = $('dialog').open && list.isConnected && navigation === requestNavigation
    if (stillPreviewing) $('dialog').close()
    note('已导入 ' + receipt.chapters.length + ' 章')
    if (pid === project) {
      await refreshDocuments(editor?.doc.id)
      if (stillPreviewing && pid === project && navigation === requestNavigation) await openDocument(receipt.chapters[0].id)
    }
  }, '导入选中章节')
}

async function recover() {
  const state = editor
  await loadRecovery(state)
  const buttons = state.recovered.map(draft => actionButton(
    `${new Date(draft.updated).toLocaleString()} · ${draft.title} · 基于 v${draft.baseRev}`, () => {
      dialog('比较本机草稿', [compare('当前编辑内容', state.body, '本机草稿', draft.body)], async () => {
        if (state.doc.status === 'final') throw new Error('请先重新打开定稿再恢复草稿')
        if (dirty(state)) throw new Error('请先保存或处理当前编辑中的内容')
        const current = await api(docPath(state))
        if (editor !== state || dirty(state)) throw new Error('当前文档已变化')
        if (current.status === 'final') throw new Error('请先重新打开定稿再恢复草稿')
        state.recoverySource = draft
        state.doc = { ...current, rev: draft.baseRev }
        state.title = draft.title
        state.body = draft.body
        state.edit = draft.edit
        state.acked = draft.acked
        state.pending = draft.pending
        // A pending request may have committed before its response was lost.
        state.conflict = current.rev !== draft.baseRev && !draft.pending ? current : null
        $('title').value = state.title
        resetBody(state.body)
        await persistLocal(state)
        state.recovered = state.recovered.filter(entry => entry.key !== draft.key)
        paint(state)
        $('dialog').close()
        if (!state.conflict) void flush(state)
      }, '恢复到编辑器')
    }))
  dialog('本机未同步草稿', buttons.length ? buttons : [document.createTextNode('没有待恢复草稿')])
}

async function conflict() {
  const state = editor
  const current = await api(docPath(state))
  if (editor !== state) return
  state.conflict = current
  dialog('比较并处理版本冲突', [
    compare(`NAS v${current.rev} · ${current.title}`, current.body, `本机 · ${state.title}`, state.body),
    actionButton('打开 NAS 版本，本机稿保留待恢复', async () => {
      if (!await persistLocal(state)) throw new Error('本机草稿保存失败，请先复制正文')
      const next = showEditor(current)
      await loadRecovery(next)
      $('dialog').close()
    }),
  ], current.status === 'final' ? undefined : async () => {
    state.doc = current
    state.pending = null
    state.conflict = null
    state.edit++
    $('dialog').close()
    await flush(state, true)
  }, '以本机稿保存为新版本')
}

async function clean(state) {
  if (!await flush(state) || dirty(state)) throw new Error('请先同步当前编辑内容或处理版本冲突')
  if (state !== editor) throw new Error('当前文档已切换')
}

async function mutateEditor(state, action) {
  await clean(state)
  if (state.mutating) throw new Error('正在处理当前文档')
  state.mutating = true
  paint(state)
  try { return await action() }
  finally { state.mutating = false; paint(state) }
}

async function showHistory() {
  const state = editor
  const items = await api(docPath(state) + '/history')
  if (editor !== state) return
  dialog('历史版本', items.map(item => actionButton(`v${item.rev} · ${item.title} · ${new Date(item.created).toLocaleString()}`, () => {
    dialog('查看历史正文', [compare('当前版本', state.body, `历史 v${item.rev}`, item.body)],
      state.doc.status === 'final' ? undefined : () => mutateEditor(state, async () => {
        const updated = await api(docPath(state) + '/history', 'POST', { baseRev: state.doc.rev, rev: item.rev })
        if (editor === state) {
          const next = showEditor(updated)
          await loadRecovery(next)
        }
        $('dialog').close()
      }), '恢复为新版本')
  })))
}

function currentReview(state) {
  return state === editor && state?.job?.reviewReport && state.job.document_id === state.doc.id && state.job.base_rev === state.doc.rev &&
    state.remoteRev <= state.doc.rev && state.doc.status === 'draft' && !state.conflict && !state.mutating && !dirty(state) && !composing
}

function renderReview(state) {
  const report = state.job?.reviewReport
  $('review-report').hidden = !report
  $('review-list').replaceChildren()
  if (!report) return
  const { issues } = report
  const version = `正文 v${state.job.base_rev}`
  $('review-summary').textContent = issues.length
    ? `${version} · 模型列出 ${issues.length} 条问题，请核对原文后选择。`
    : `${version} · 模型未列出问题。`
  $('review-issues').hidden = issues.length === 0
  $('use-review-issues').hidden = !issues.some(issue => issue.evidence === 'verified')
  $('use-review-issues').disabled = true
  const evidence = { verified: '引文可唯一定位', ambiguous: '引文在原文中出现多次', missing: '在该版本未找到引文', unavailable: '缺少审稿版本的正文快照' }
  issues.forEach((issue, index) => {
    const item = document.createElement('article')
    const title = document.createElement('h3')
    title.textContent = `${index + 1}. ${issue.title}（${issue.severity === 'major' ? '重要' : '一般'}）`
    const source = document.createElement('p')
    const quote = document.createElement('q')
    quote.textContent = issue.quote
    source.append(evidence[issue.evidence] + ' · ', quote)
    const reason = document.createElement('p')
    reason.textContent = '原因 · ' + issue.reason
    const suggestion = document.createElement('p')
    suggestion.textContent = '改法 · ' + issue.suggestion
    item.append(title, source, reason, suggestion)
    if (issue.evidence === 'verified') {
      const tools = document.createElement('div')
      tools.className = 'tools'
      const locate = document.createElement('button')
      locate.textContent = '定位原文'
      locate.addEventListener('click', () => runAction(() => {
        if (!currentReview(state)) throw new Error('请为当前版本重新审稿')
        const input = bodyControl()
        const start = input.value.indexOf(issue.quote)
        if (start < 0 || input.value.indexOf(issue.quote, start + 1) >= 0) throw new Error('无法在当前编辑器中唯一定位该引文')
        input.focus({ preventScroll: true })
        input.setSelectionRange(start, start + issue.quote.length)
        if (enhancedBody) enhancedBody.reveal(start)
        else revealMatch(input, start)
        $(enhancedBody ? 'body-editor-host' : 'body').scrollIntoView({ block: 'nearest' })
      }))
      const label = document.createElement('label')
      const check = document.createElement('input')
      check.type = 'checkbox'
      check.value = index
      check.setAttribute('aria-label', `采纳第 ${index + 1} 条意见`)
      label.append(check, '采纳这条意见')
      tools.append(locate, label)
      item.append(tools)
    }
    $('review-list').append(item)
  })
}

function renderJob(state) {
  if (editor !== state) return
  const job = state.job
  $('run-view').hidden = !job
  $('run-output').textContent = job?.output || ''
  $('run-output').hidden = Boolean(job?.reviewReport)
  renderReview(state)
  $('run-status').textContent = job ? [runNames[job.kind], runStates[job.status],
    job.continued_from && '分段续跑', job.applied_rev !== null && '已应用', job.error].filter(Boolean).join(' · ') : ''
  $('cancel-run').hidden = job?.status !== 'running'
  $('continue-run').hidden = !model || !job?.canContinue
  $('apply-run').hidden = !job || !['draft', 'revise', 'plan', 'passage'].includes(job.kind) ||
    job.status === 'running' || (['plan', 'passage'].includes(job.kind) && job.status !== 'done') || !job.source_hash ||
    !job.output?.trim() || job.applied_rev !== null
  $('use-outline').hidden = !model || job?.kind !== 'outline' || job.status !== 'done' || !job.source_hash ||
    job.base_rev !== state.doc.rev || state.doc.status === 'final'
  $('use-review').hidden = job?.kind !== 'review' || job.status === 'running' || !job.output || Boolean(job.reviewReport)
  paint(state)
}

async function viewRun(state, id) {
  const request = state.jobView = (state.jobView ?? 0) + 1
  const job = await api(`/projects/${state.doc.project_id}/runs/${id}`)
  if (editor !== state || state.jobView !== request) return
  state.job = job
  $('ai').open = true
  renderJob(state)
}

async function findActive(state) {
  const runs = await api(docPath(state) + '/runs')
  const active = runs.find(run => run.status === 'running')
  if (active && editor === state) await viewRun(state, active.id)
}

function writingRequest(state, kind, extra) {
  const referenceIds = [...state.references.keys()]
  const referenceSpans = [...state.referenceSpans.values()]
  const referenceQuery = referenceIds.length > referenceSpans.length ? $('reference-query').value : ''
  const outlineId = kind === 'draft' ? state.outline?.id ?? null : null
  return { kind, baseRev: state.doc.rev, guidance: $('guidance').value, referenceIds, referenceQuery, referenceSpans, outlineId, ...extra }
}

async function startRun(kind, extra) {
  const state = editor
  await clean(state)
  const request = writingRequest(state, kind, extra)
  if (state.jobRequest) {
    const { mutationId, ...previous } = state.jobRequest
    if (JSON.stringify(previous) !== JSON.stringify(request)) {
      throw new Error('上次任务提交状态未知。请用相同操作重试，或查看任务历史。')
    }
  }
  state.jobRequest ??= { ...request, mutationId: uuid() }
  try {
    state.jobView = (state.jobView ?? 0) + 1
    state.job = await api(docPath(state) + '/runs', 'POST', state.jobRequest)
    state.jobRequest = null
    renderJob(state)
  } catch (error) {
    if (error.status && error.status < 500) state.jobRequest = null
    throw error
  }
}

async function showContext(state, result, kind, extra) {
  result.textContent = ''
  try {
    await clean(state)
    const data = await api(docPath(state) + '/context', 'POST', writingRequest(state, kind, extra))
    if (!result.isConnected || state !== editor) return
    const size = document.createElement('p')
    const length = data.messages.reduce((total, message) => total + message.content.length, 0)
    size.textContent = length.toLocaleString() + ' / ' + data.limit.toLocaleString() + ' 字符。预览不会调用模型。'
    result.append(size)
    for (const { role, content } of data.messages) {
      const heading = document.createElement('h3')
      const text = document.createElement('pre')
      heading.textContent = role === 'system' ? '写作指令' : '正文与资料'
      text.textContent = content
      result.append(heading, text)
    }
  } catch (error) { result.textContent = error.message }
}

function previewContext() {
  const state = editor
  const picker = document.createElement('select')
  const label = document.createElement('label')
  label.append('任务类型', picker)
  const options = state.doc.kind === 'chapter' ? chapterRuns : { plan: '生成' + names[state.doc.kind] + '候选' }
  for (const [kind, title] of Object.entries(options)) picker.append(new Option(title, kind))
  const result = document.createElement('div')
  dialog('预览模型输入', [label, result], () => showContext(state, result, picker.value), '生成预览')
}

function planArchitecture() {
  const state = editor
  const sections = Object.entries(architectureSections)
  const suggested = sections.find(([, section]) => section.title === state.title)?.[0] ?? 'general'
  const [label, scope] = selectField('规划范围', {
    general: '整体设定与架构',
    ...Object.fromEntries(sections.map(([key, section]) => [key, section.title])),
  }, suggested)
  const help = document.createElement('p')
  help.textContent = '候选用于替换当前整份文档。建议为每个架构模块使用独立文档。'
  const result = document.createElement('div')
  const options = () => scope.value === 'general' ? undefined : { planSection: scope.value }
  const preview = actionButton('预览发送内容', () => showContext(state, result, 'plan', options()))
  dialog('生成架构候选', [label, help, preview, result], async () => {
    if (state !== editor) return
    try {
      await startRun('plan', options())
      if (state === editor && result.isConnected) $('dialog').close()
    } catch (error) { result.textContent = error.message }
  }, '生成候选')
}

function editPassage() {
  const state = editor
  const input = bodyControl()
  const start = input.selectionStart
  const end = input.selectionEnd
  const quote = input.value.slice(start, end)
  if (!quote.trim() || quote.length > 6000) throw new Error('请先选中 1–6000 字符的正文')
  const label = document.createElement('label')
  const mode = document.createElement('select')
  mode.append(new Option('在选段后续写', 'continue'), new Option('润色', 'polish'),
    new Option('扩写', 'expand'), new Option('改成对话', 'dialogue'))
  label.append('选段操作', mode)
  const excerpt = document.createElement('pre')
  excerpt.textContent = quote
  const guidanceLabel = document.createElement('label')
  const guidance = document.createElement('textarea')
  guidance.rows = 3
  guidance.maxLength = 6000
  guidanceLabel.append('本次要求', guidance)
  const result = document.createElement('div')
  const options = () => ({ guidance: guidance.value, passage: { mode: mode.value, start, end, quote } })
  const preview = actionButton('预览发送内容', () => showContext(state, result, 'passage', options()))
  dialog('选段 AI', [label, excerpt, guidanceLabel, preview, result], async () => {
    if (state !== editor) return
    try {
      await startRun('passage', options())
      if (editor === state && result.isConnected) {
        $('ai').open = true
        $('dialog').close()
      }
    } catch (error) { result.textContent = error.message }
  }, '生成选段候选')
}

async function listRuns() {
  const state = editor
  const runs = await api(docPath(state) + '/runs')
  if (editor !== state) return
  if (runs.some(job => job.id === state.jobRequest?.mutationId)) state.jobRequest = null
  dialog('任务历史', runs.length ? runs.map(run => actionButton(
    `${runNames[run.kind]} · ${runStates[run.status]} · ${new Date(run.created).toLocaleString()}`, async () => {
      await viewRun(state, run.id)
      $('dialog').close()
    })) : [document.createTextNode('暂无任务')])
}

async function showLibrary() {
  const rows = await api('/projects')
  const buttons = rows.map(row => actionButton(row.id === project ? '返回 · ' + row.title : row.title, async () => {
    if (row.id !== project) await selectProject(row.id)
    if (row.id === project) $('dialog').close()
  }))
  dialog('书房', [...buttons, actionButton('新建作品', () => $('new-project').click()),
    actionButton('恢复备份', () => $('backup-file').click())])
}

async function showOverview(next = stage) {
  const request = ++navigation
  await leave()
  if (request !== navigation) return
  stage = next
  clearEditor()
}

function showProjectRuns() {
  const pid = project
  const panel = document.createElement('div')
  const controls = document.createElement('div')
  controls.className = 'tools'
  const list = document.createElement('div')
  list.className = 'batch-list'
  list.setAttribute('aria-label', '任务列表')
  const message = document.createElement('p')
  message.setAttribute('role', 'status')
  let scope = 'active'
  let request = 0
  let timer
  let previous
  const visible = () => panel.isConnected && $('dialog').open && project === pid
  const active = actionButton('进行中', () => select('active'))
  const history = actionButton('历史', () => select('history'))
  controls.append(active, history, actionButton('批量任务记录', () => listBatches(pid)))
  panel.append(controls, message, list)
  dialog('运行中心', [panel])
  select(scope)

  function select(next) {
    scope = next
    previous = undefined
    active.setAttribute('aria-pressed', String(scope === 'active'))
    history.setAttribute('aria-pressed', String(scope === 'history'))
    list.replaceChildren()
    message.textContent = '正在读取任务…'
    void refresh()
  }

  async function refresh() {
    clearTimeout(timer)
    if (!visible()) return
    const seq = ++request
    try {
      const rows = await api(`/projects/${pid}/runs?scope=${scope}`)
      if (!visible() || seq !== request) return
      message.textContent = rows.length ? '' : scope === 'active' ? '当前没有进行中的章节任务。' : '当前没有任务历史。'
      const snapshot = JSON.stringify(rows)
      if (snapshot === previous) return
      previous = snapshot
      list.replaceChildren(...rows.map(row => {
        const item = document.createElement('section')
        const summary = document.createElement('p')
        summary.textContent = [new Date(row.created).toLocaleString(), row.applied_rev !== null && '已应用', row.error].filter(Boolean).join(' · ')
        item.append(actionButton(`${numberedTitle(row)} · ${runNames[row.kind]} · ${runStates[row.status]}`, async () => {
          if (editor?.doc.id !== row.document_id) await openDocument(row.document_id)
          if (!visible() || editor?.doc.id !== row.document_id) return
          await viewRun(editor, row.id)
          if (visible()) $('dialog').close()
        }), summary)
        return item
      }))
    } catch (error) {
      if (seq === request) message.textContent = error.message
    } finally {
      if (seq === request && visible() && scope === 'active') timer = setTimeout(refresh, 2000)
    }
  }
}

const themes = { system: '跟随系统', light: '浅色', dark: '深色' }
const textSizes = { standard: '标准', large: '大字', extra: '特大字' }

function applyAppearance() {
  let saved
  try { saved = JSON.parse(localStorage.getItem('pagekin-appearance')) } catch { /* Optional browser preferences. */ }
  document.documentElement.dataset.theme = typeof saved?.theme === 'string' && Object.hasOwn(themes, saved.theme) ? saved.theme : 'system'
  document.documentElement.dataset.textSize = typeof saved?.textSize === 'string' && Object.hasOwn(textSizes, saved.textSize) ? saved.textSize : 'standard'
}

function showSettings() {
  const preference = (title, values, selected) => {
    const label = document.createElement('label')
    const select = document.createElement('select')
    select.append(...Object.entries(values).map(([key, value]) => new Option(value, key)))
    select.value = selected
    label.append(title, select)
    return [label, select]
  }
  const root = document.documentElement
  const [themeLabel, theme] = preference('外观主题', themes, root.dataset.theme)
  const [sizeLabel, size] = preference('正文字号', textSizes, root.dataset.textSize)
  const services = document.createElement('p')
  services.textContent = `写作模型${model ? '已配置' : '待配置'} · 语义检索${semanticEnabled ? '已配置' : '待配置'} · ${enhancedBody ? 'CodeMirror' : '普通编辑器'}`
  const guide = document.createElement('p')
  guide.textContent = '模型连接由 NAS 的 Compose 环境变量配置。外观和字号保存在当前浏览器。'
  dialog('设置', [themeLabel, sizeLabel, services, guide], () => {
    root.dataset.theme = theme.value
    root.dataset.textSize = size.value
    try { localStorage.setItem('pagekin-appearance', JSON.stringify({ theme: theme.value, textSize: size.value })) }
    catch { note('浏览器无法保留外观设置，当前页面已应用。') }
    $('dialog').close()
  }, '保存外观')
}

function setFocusWriting(enabled) {
  document.body.classList.toggle('focus-writing', enabled)
  $('focus-writing').setAttribute('aria-pressed', String(enabled))
  $('focus-writing').textContent = enabled ? '退出专注' : '专注写作'
}

async function listBatches(pid) {
  const batches = await api(`/projects/${pid}/batches`)
  if (pid !== project) return
  const rows = batches.map(batch => actionButton(
    `${batch.operation === 'plan' ? '蓝图' : '正文'} · ${batchStates[batch.status]} · 已生成 ${batch.completed} / ${batch.total} 章 · ${new Date(batch.created).toLocaleString()}`, async () => {
      const current = await api(`/projects/${pid}/batches/${batch.id}`)
      if (pid === project) showBatch(pid, current)
    }))
  dialog('批量任务', [...(model ? [actionButton('新建写作批次', () => newBatch(pid)),
    actionButton('批量生成蓝图', () => newBlueprintBatch(pid))] : []),
    ...(rows.length ? rows : [document.createTextNode('当前没有批量任务记录。')])])
}

function newBlueprintBatch(pid) {
  const next = Math.min(99999, Math.max(0, ...documents.filter(row => row.kind === 'blueprint').map(row => row.number)) + 1)
  const [startLabel, start] = field('起始章号', { type: 'number', min: 1, max: 99999, value: next })
  const [endLabel, end] = field('结束章号', { type: 'number', min: 1, max: 99999, value: next })
  const label = document.createElement('label')
  const guidance = document.createElement('textarea')
  guidance.maxLength = 6000
  guidance.rows = 3
  label.append('本批规划要求', guidance)
  const help = document.createElement('p')
  help.textContent = '每批最多 20 章。缺失的蓝图会建立空白文档，已有内容的蓝图会跳过。'
  const error = document.createElement('p')
  error.setAttribute('role', 'alert')
  const mutationId = uuid()
  dialog('批量生成蓝图', [help, startLabel, endLabel, label, error], async () => {
    try {
      if (editor) await clean(editor)
      if (project !== pid || !error.isConnected) return
      const batch = await api(`/projects/${pid}/batches`, 'POST', { mutationId, guidance: guidance.value,
        blueprintRange: { start: start.valueAsNumber, end: end.valueAsNumber } })
      if (project === pid && error.isConnected && $('dialog').open) showBatch(pid, batch)
    } catch (failure) { error.textContent = failure.message }
  }, '开始生成蓝图候选')
}

async function newBatch(pid) {
  if (editor) await clean(editor)
  const chapters = await api(`/projects/${pid}/batches/eligible`)
  if (pid !== project) return
  const help = document.createElement('p')
  help.textContent = chapters.length ? '每批可选 1–20 个空白章节，按章号依次生成待确认候选。'
    : '暂无空白且未定稿的章节。请先新建正文章节。'
  const back = actionButton('返回批次列表', () => listBatches(pid))
  if (!chapters.length) return dialog('新建写作批次', [help, back])
  const list = document.createElement('div')
  list.className = 'batch-list'
  for (const chapter of chapters) {
    const label = document.createElement('label')
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.value = chapter.id
    label.append(check, numberedTitle(chapter))
    list.append(label)
  }
  const label = document.createElement('label')
  const guidance = document.createElement('textarea')
  guidance.maxLength = 6000
  guidance.rows = 3
  label.append('本批通用写作要求（可选）', guidance)
  const error = document.createElement('p')
  error.setAttribute('role', 'alert')
  let pending
  dialog('新建写作批次', [help, list, label, error, back], async () => {
    const checked = new Set([...list.querySelectorAll('input:checked')].map(check => check.value))
    if (!checked.size || checked.size > 20) { error.textContent = '请选择 1–20 个空白章节。'; return }
    const request = { chapters: chapters.filter(row => checked.has(row.id)).map(row => ({ id: row.id, baseRev: row.rev })), guidance: guidance.value }
    const fingerprint = JSON.stringify(request)
    if (pending && pending.fingerprint !== fingerprint) { error.textContent = '上次提交结果未知。请按原选择重试，或查看批次列表。'; return }
    pending ??= { fingerprint, value: { ...request, mutationId: uuid() } }
    error.textContent = ''
    try {
      const batch = await api(`/projects/${pid}/batches`, 'POST', pending.value)
      if (list.isConnected && $('dialog').open && pid === project) showBatch(pid, batch)
    } catch (failure) {
      if (failure.status && failure.status < 500) pending = null
      error.textContent = failure.message
    }
  }, '开始生成候选')
}

function showBatch(pid, first) {
  const panel = document.createElement('section')
  const path = `/projects/${pid}/batches/${first.id}`
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const controls = document.createElement('div')
  controls.className = 'tools'
  const list = document.createElement('div')
  list.className = 'batch-list'
  const error = document.createElement('p')
  error.setAttribute('role', 'alert')
  panel.append(status, controls, error, list)
  let batch
  let timer
  let command = 0
  const visible = () => panel.isConnected && $('dialog').open && pid === project

  function schedule() {
    clearTimeout(timer)
    if (batch.status !== 'running' && !batch.items.some(item => item.status === 'running')) return
    timer = setTimeout(async () => {
      if (!visible()) return
      if (document.hidden) { schedule(); return }
      const observed = command
      try {
        const next = await api(path)
        if (visible() && command === observed) render(next)
      } catch { if (visible() && command === observed) schedule() }
    }, 1500)
  }

  async function change(action) {
    command++
    clearTimeout(timer)
    for (const button of controls.querySelectorAll('button')) button.disabled = true
    error.textContent = ''
    try {
      const next = await api(path + '/' + action, 'POST')
      if (visible()) render(next, true)
    } catch (failure) {
      error.textContent = failure.message
      if (visible()) render(batch, true)
    }
  }

  function render(next, force = false) {
    if (force || JSON.stringify(next) !== JSON.stringify(batch)) {
      batch = next
      const active = batch.items.some(item => item.status === 'running')
      const complete = batch.items.filter(item => item.status === 'done').length
      status.textContent = [`${batchStates[batch.status]} · 已生成 ${complete} / ${batch.items.length} 章`, batch.error].filter(Boolean).join(' · ')
      controls.replaceChildren(actionButton('返回批次列表', () => listBatches(pid)))
      if (batch.status === 'running') controls.append(actionButton('暂停批次', () => change('pause')))
      if (batch.status === 'paused') {
        const resume = actionButton('继续批次', () => change('resume'))
        resume.disabled = active || !model
        controls.append(resume)
      }
      if (['running', 'paused'].includes(batch.status)) controls.append(actionButton('取消批次', () => change('cancel')))
      list.replaceChildren(...batch.items.map(item => {
        const row = document.createElement('section')
        const state = item.status === 'queued' ? '待生成' : item.status === 'skipped' ? '已跳过' : runStates[item.status]
        row.textContent = [numberedTitle(item), state, item.error].filter(Boolean).join(' · ')
        if (item.run_id) row.append(actionButton(item.status === 'done' ? '查看候选' : '查看任务', async () => {
          await openDocument(item.id)
          if (editor?.doc.id !== item.id || project !== pid) return
          await viewRun(editor, item.run_id)
          if (panel.isConnected) $('dialog').close()
        }))
        return row
      }))
    }
    schedule()
  }

  dialog(first.operation === 'plan' ? '批量蓝图进度' : '批量写作进度', [panel])
  render(first)
}

async function showWritingSkills(pid) {
  const path = `/projects/${pid}/writing-skills`
  const { skills, bindings, rev } = await api(path)
  if (pid !== project) return
  const help = document.createElement('p')
  help.textContent = '可分别设置规划与细纲、写稿、审稿和修稿的提示词。实际内容可在模型输入预览中查看。'
  const error = document.createElement('p')
  error.setAttribute('role', 'alert')
  const selections = new Map()
  const labels = Object.entries(chapterRuns).map(([kind, title]) => {
    const label = document.createElement('label')
    const select = document.createElement('select')
    choices(select, skills.map(skill => [skill.id, skill.title]), '无 Skill', bindings[kind] ?? '')
    select.dataset.skillStage = kind
    selections.set(kind, select)
    label.append(kind === 'outline' ? '规划与细纲' : title, select)
    return label
  })
  const library = document.createElement('div')
  library.className = 'batch-list'
  library.append(...skills.map(skill => actionButton('查看 · ' + skill.title, async () => {
    const details = await api(path + '/' + skill.id)
    if (pid !== project || !library.isConnected) return
    const preview = document.createElement('pre')
    preview.textContent = details.body
    const controls = [actionButton('返回 Skill 设置', () => showWritingSkills(pid))]
    if (!Object.values(bindings).includes(skill.id)) controls.push(actionButton('删除此 Skill', async () => {
      await api(path + '/' + skill.id, 'DELETE')
      await showWritingSkills(pid)
    }))
    dialog(details.title, [preview, ...controls])
  })))
  dialog('写作 Skill', [help, ...labels, actionButton('添加写作 Skill', () => newWritingSkill(pid)), library, error], async () => {
    try {
      await api(path + '/bindings', 'PUT', { baseRev: rev,
        bindings: Object.fromEntries([...selections].map(([kind, select]) => [kind, select.value || null])) })
      if (library.isConnected) $('dialog').close()
    } catch (failure) { error.textContent = failure.message }
  }, '保存阶段绑定')
}

function newWritingSkill(pid, preset) {
  const [titleLabel, title] = field('Skill 名称', { maxLength: 120, value: preset?.title.slice(0, 120).toWellFormed() ?? '' })
  const [fileLabel, file] = field('从本机载入 UTF-8 文本（可选）', { type: 'file', accept: '.md,.markdown,.txt,text/plain,text/markdown', required: false })
  const label = document.createElement('label')
  const content = document.createElement('textarea')
  content.required = true
  content.maxLength = 8000
  content.rows = 8
  content.value = preset?.body ?? ''
  label.append('写作提示词内容 · 核对后安装', content)
  const error = document.createElement('p')
  error.setAttribute('role', 'alert')
  file.addEventListener('change', async () => {
    const source = file.files[0]
    if (!source) return
    try {
      if (source.size > 32_000) throw new Error('Skill 文件过大')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await source.arrayBuffer())
      if (file.files[0] !== source || !file.isConnected) return
      if (text.length > content.maxLength) throw new Error('Skill 最多 8000 字符')
      title.value ||= source.name.replace(/\.[^.]+$/, '').slice(0, title.maxLength)
      content.value = text
      error.textContent = ''
    } catch (failure) { error.textContent = failure.message }
  })
  let pending
  dialog('添加写作 Skill', [titleLabel, fileLabel, label, error, actionButton('返回 Skill 设置', () => showWritingSkills(pid))], async () => {
    const next = { title: title.value, body: content.value }
    if (pending && (pending.title !== next.title || pending.body !== next.body)) {
      error.textContent = '上次提交结果未知。请用原内容重试，或查看已安装列表。'
      return
    }
    pending ??= { ...next, mutationId: uuid() }
    try {
      await api(`/projects/${pid}/writing-skills`, 'POST', pending)
      if (content.isConnected && $('dialog').open) await showWritingSkills(pid)
    } catch (failure) {
      if (failure.status && failure.status < 500) pending = null
      error.textContent = failure.message
    }
  }, '安装提示词')
}

function runAction(action) {
  Promise.resolve().then(action).catch(error => note(error.message))
}
function click(id, action) { $(id).addEventListener('click', () => runAction(action)) }

$('login').addEventListener('submit', event => {
  event.preventDefault()
  runAction(async () => {
    const input = event.target.elements.password
    await api('/session', 'POST', { password: input.value })
    input.value = ''
    note()
    await boot()
  })
})
click('logout', async () => { await leave(); await api('/session', 'DELETE'); location.reload() })
click('library-menu', showLibrary)
click('workspace-settings', showSettings)
click('workbench-overview', () => showOverview())
click('project-goals', editProjectGoals)
click('project-runs', showProjectRuns)
click('export', exportManuscript)
click('focus-writing', () => setFocusWriting(!document.body.classList.contains('focus-writing')))
for (const button of $('stage-nav').querySelectorAll('[data-stage]')) {
  button.addEventListener('click', () => {
    const next = button.dataset.stage
    if (next === stage) return
    const id = stageDocuments.get(next)
    runAction(() => id ? openDocument(id) : showOverview(next))
  })
}
click('batch-writing', () => listBatches(project))
click('batch-blueprints', () => newBlueprintBatch(project))
click('writing-skills', () => showWritingSkills(project))
const screenplay = screenplayWorkspace({ api, dialog, field, actionButton, localTransaction, uuid, isCurrent: pid => project === pid })
click('screenplay-workspace', () => screenplay.list(project))
click('new-project', () => {
  const [label, title] = field('作品名称', { maxLength: 160 })
  dialog('新建作品', [label], async () => {
    await leave()
    const created = await api('/projects', 'POST', { title: title.value })
    await refreshProjects(created.id)
    $('dialog').close()
  })
})
click('rename-project', () => {
  const pid = project
  const option = $('projects').selectedOptions[0]
  let baseTitle = option.textContent
  const [label, title] = field('书名', { maxLength: 160, value: baseTitle })
  const result = document.createElement('p')
  result.setAttribute('role', 'status')
  dialog('修改书名', [label, result], async () => {
    if (pid !== project) return
    try {
      const updated = await api('/projects/' + pid, 'PATCH', { title: title.value, baseTitle })
      option.textContent = updated.title
      if (project === pid) renderCatalog()
      if (title.isConnected && $('dialog').open) $('dialog').close()
    } catch (error) {
      result.textContent = error.message
      if (error.status === 409 && error.current) {
        baseTitle = error.current.title
        option.textContent = baseTitle
        if (project === pid) renderCatalog()
        result.append('。当前书名为“' + baseTitle + '”。再次保存将使用输入框中的书名。')
      }
    }
  }, '保存书名')
})
click('new-document', () => newDocument())
click('architecture-templates', architectureTemplates)
click('search-project', searchProject)
click('narrative-threads', threadList)
click('reference-library', referenceLibrary)
const referenceNovels = referenceNovelWorkspace({ api, dialog, field, actionButton, uuid,
  isCurrent: pid => pid === project, modelEnabled: () => model, installSkill: newWritingSkill })
click('reference-novel-library', () => referenceNovels.list(project))
click('semantic-search', semanticSearch)
click('clear-references', () => {
  editor.references.clear()
  editor.referenceSpans.clear()
  $('reference-query').value = ''
  paint()
})
$('reference-file').addEventListener('change', event => runAction(async () => {
  const pid = project
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  if (file.size > 720_000) throw new Error('资料文件过大，请拆成多份导入')
  const body = await file.text()
  if (body.length > 180_000) throw new Error('单份资料最多 180000 字符')
  const title = (file.name.replace(/\.[^.]+$/, '').trim() || file.name).slice(0, 160)
  await api(`/projects/${pid}/references`, 'POST', { title, body })
  if (pid === project) await referenceLibrary()
}))
click('import-backup', () => $('backup-file').click())
click('import-text', () => $('text-file').click())
click('import-manuscript', () => $('manuscript-file').click())
$('manuscript-file').addEventListener('change', event => runAction(async () => {
  const file = event.target.files[0]
  event.target.value = ''
  const pid = project
  if (!file || !pid) return
  if (file.size > manuscriptBytes) throw new Error('整稿文件超过 8 MB，请分批导入')
  let content
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) }
  catch { throw new Error('请将整稿保存为 UTF-8 的 TXT 或 Markdown 文件') }
  const title = (file.name.replace(/\.[^.]+$/, '').trim() || '导入正文').slice(0, 160)
  const parsed = splitManuscript(content, title)
  const existing = await api('/projects/' + pid + '/documents')
  if (pid === project) manuscriptPreview(pid, parsed, existing)
}))
$('backup-file').addEventListener('change', event => runAction(async () => {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  const desktop = file.name.toLowerCase().endsWith('.ainovel')
  const limit = desktop ? 48_000_000 : 24_000_000
  if (file.size > limit) throw new Error(`备份超过 ${limit / 1_000_000} MB`)
  await leave()
  $('import-backup').disabled = true
  note('正在读取备份并创建作品副本…')
  try {
    let created
    if (desktop) {
      const response = await fetch('/api/import-desktop', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      })
      created = await response.json()
      if (!response.ok) throw new Error(created.error || '无法导入桌面归档')
    } else {
      created = await api('/import', 'POST', JSON.parse(await file.text()))
    }
    await refreshProjects(created.id)
    note('已恢复为一部新作品')
  } finally { $('import-backup').disabled = false }
}))
$('text-file').addEventListener('change', event => runAction(async () => {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  if (file.size > 720_000) throw new Error('正文文件过大，请按章节导入')
  const content = await file.text()
  if (content.length > 180_000) throw new Error('单个文档最多 180000 字符')
  await refreshDocuments()
  newDocument(content, file.name.replace(/\.[^.]+$/, '').slice(0, 160), 'chapter')
}))
$('projects').addEventListener('change', event => {
  const id = event.target.value
  event.target.value = project
  runAction(() => selectProject(id))
})
$('documents').addEventListener('change', event => {
  const id = event.target.value
  runAction(async () => {
    try { await openDocument(id) }
    catch (error) { event.target.value = editor?.doc.id ?? ''; throw error }
  })
})
$('chapter-filter').addEventListener('change', () => renderCatalog())
for (const element of [$('title'), $('body')]) {
  element.addEventListener('input', edit)
  element.addEventListener('compositionstart', () => setComposing(true))
  element.addEventListener('compositionend', () => setComposing(false))
  element.addEventListener('blur', () => setComposing(false))
}
click('save', () => flush(editor, true))
click('recover', recover)
click('conflict', conflict)
click('reload-remote', async () => {
  const state = editor
  if (!state || composing || state.saving || state.mutating) return
  const current = await api(docPath(state))
  if (state !== editor || current.rev <= state.doc.rev) return
  if (dirty(state) || composing || state.saving || state.mutating) {
    if (dirty(state)) state.conflict = current
    observeRevision(state, current.rev)
    return
  }
  const guidance = $('guidance').value
  const referenceQuery = $('reference-query').value
  const next = showEditor(current)
  next.references = state.references
  next.referenceSpans = state.referenceSpans
  $('guidance').value = guidance
  $('reference-query').value = referenceQuery
  paint(next)
  await loadRecovery(next)
  if (next === editor) await findActive(next)
})
click('history', showHistory)
click('status', async () => {
  const state = editor
  await mutateEditor(state, async () => {
    const action = state.doc.status === 'final' ? 'reopen' : 'finalize'
    const updated = await api(docPath(state) + '/status', 'POST', { baseRev: state.doc.rev, action })
    if (editor !== state) return
    const next = showEditor(updated)
    await loadRecovery(next)
    await refreshDocuments(updated.id)
  })
})
for (const button of document.querySelectorAll('[data-run]')) {
  button.addEventListener('click', () => runAction(() => {
    if (button.dataset.run === 'plan' && editor?.doc.kind === 'settings') return planArchitecture()
    return startRun(button.dataset.run)
  }))
}
click('runs', listRuns)
click('preview-context', previewContext)
click('ai-passage', editPassage)
click('use-outline', () => {
  const state = editor
  const job = state?.job
  if (job?.kind !== 'outline' || job.status !== 'done' || job.base_rev !== state.doc.rev) return
  state.outline = { id: job.id, baseRev: job.base_rev }
  paint(state)
})
click('clear-outline', () => { editor.outline = null; paint() })
$('use-review').addEventListener('pointerdown', event => event.preventDefault())
function addRevisionGuidance(text) {
  const guidance = $('guidance')
  const next = [guidance.value.trim(), text].filter(Boolean).join('\n\n')
  if (next.length > guidance.maxLength) throw new Error('修稿要求过长，请缩小选择范围')
  guidance.value = next
  guidance.focus()
  note('已加入修稿要求，确认后点击“修稿”')
}
click('use-review', () => {
  const selection = window.getSelection()
  const output = $('run-output')
  if (!selection || !output.contains(selection.anchorNode) || !output.contains(selection.focusNode) || !selection.toString().trim()) {
    throw new Error('请先在审稿结果里选中要处理的文字')
  }
  addRevisionGuidance(selection.toString().trim())
})
$('review-list').addEventListener('change', () => {
  $('use-review-issues').disabled = !$('review-list').querySelector('input:checked')
})
click('use-review-issues', () => {
  if (!currentReview(editor)) throw new Error('请为当前版本重新审稿')
  const selected = [...$('review-list').querySelectorAll('input:checked')]
  if (!selected.length) return
  addRevisionGuidance(selected.map(check => {
    const issue = editor.job.reviewReport.issues[check.value]
    return [issue.title, `原文「${issue.quote}」`, `原因 · ${issue.reason}`, `改法 · ${issue.suggestion}`].join('\n')
  }).join('\n\n'))
  for (const check of selected) check.checked = false
  $('use-review-issues').disabled = true
})
click('cancel-run', async () => {
  const state = editor
  await api(`/projects/${project}/runs/${state.job.id}/cancel`, 'POST')
  await viewRun(state, state.job.id)
})
click('continue-run', async () => {
  const state = editor
  const from = state.job
  const button = $('continue-run')
  button.disabled = true
  try {
    await clean(state)
    if (state.continueRequest?.from !== from.id) state.continueRequest = { from: from.id, mutationId: uuid() }
    const job = await api(`/projects/${state.doc.project_id}/runs/${from.id}/continue`, 'POST', {
      mutationId: state.continueRequest.mutationId,
    })
    state.continueRequest = null
    if (editor === state && state.job?.id === from.id) {
      state.job = job
      renderJob(state)
    }
  } catch (error) {
    if (error.status && error.status < 500) state.continueRequest = null
    throw error
  } finally { button.disabled = false }
})
async function applyCandidate(state, job, path, value) {
  const action = dialogAction
  await mutateEditor(state, async () => {
    const updated = await api(path, 'POST', value)
    if (dialogAction === action) $('dialog').close()
    if (editor === state) {
      const next = showEditor(updated)
      await loadRecovery(next)
      await viewRun(next, job.id).catch(() => note('正文已保存，任务状态暂未刷新。'))
    }
  })
}

function chooseRevision(state, job, path, { plan, changes }) {
  if (!changes.length) {
    const message = document.createElement('p')
    message.textContent = '修稿候选与当前正文没有可应用的改动。'
    return dialog('比较修稿候选', [message])
  }
  const selected = new Set()
  const pageSize = 12
  let page = 0
  const pageCount = Math.ceil(changes.length / pageSize)
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  const errorMessage = document.createElement('p')
  errorMessage.setAttribute('role', 'alert')
  const list = document.createElement('div')
  list.className = 'revision-list'
  const controls = document.createElement('div')
  controls.className = 'tools'
  const previous = actionButton('上一页', () => { page--; renderPage() })
  const next = actionButton('下一页', () => { page++; renderPage() })
  previous.hidden = next.hidden = pageCount === 1
  const selectAll = actionButton('全选改动', () => { changes.forEach((_, i) => selected.add(i)); renderPage() })
  const clear = actionButton('清空选择', () => { selected.clear(); renderPage() })
  controls.append(previous, next, selectAll, clear)

  function summarize() {
    status.textContent = `已选 ${selected.size} / ${changes.length} 处 · 第 ${page + 1} / ${pageCount} 页`
  }

  function renderPage() {
    previous.disabled = page === 0
    next.disabled = page + 1 === pageCount
    const start = page * pageSize
    list.replaceChildren(...changes.slice(start, start + pageSize).map(({ line, before, after }, offset) => {
      const i = start + offset
      const item = document.createElement('article')
      const label = document.createElement('label')
      const check = document.createElement('input')
      check.type = 'checkbox'
      check.checked = selected.has(i)
      check.addEventListener('change', () => {
        if (check.checked) selected.add(i)
        else selected.delete(i)
        summarize()
      })
      const kind = !before ? '插入' : !after ? '删除' : '替换'
      label.append(check, `采纳改动 ${i + 1} · 第 ${line} 行 · ${kind}`)
      const lineEndingOnly = before.replace(/\r?\n$|\r$/, '') === after.replace(/\r?\n$|\r$/, '')
      const display = text => {
        if (!text) return '（无）'
        if (lineEndingOnly) return text + (/[\r\n]$/.test(text) ? '（末尾有换行）' : '\n（末尾无换行）')
        return text.trim() ? text : '（空行或空白）'
      }
      item.append(label, compare('原稿', display(before), '修稿', display(after)))
      return item
    }))
    list.scrollTop = 0
    summarize()
  }

  renderPage()
  dialog('选择要接受的修稿改动', [status, controls, list, errorMessage], async () => {
    errorMessage.textContent = ''
    if (!selected.size) { errorMessage.textContent = '请至少勾选一处改动。'; return }
    try { await applyCandidate(state, job, path, { plan, picks: [...selected] }) }
    catch (error) { errorMessage.textContent = error.message }
  }, '应用选中的改动')
}

click('apply-run', async () => {
  const state = editor
  const job = state.job
  const path = `/projects/${state.doc.project_id}/runs/${job.id}`
  if (job.kind === 'passage') {
    await clean(state)
    const { current, candidate } = await api(path + '/candidate')
    if (editor === state && state.job?.id === job.id) {
      dialog('比较并确认选段候选', [compare('当前正文', current, '应用后正文', candidate)],
        () => applyCandidate(state, job, path + '/apply'), '应用选段改动')
    }
    return
  }
  if (job.kind === 'revise' && job.status === 'done') {
    await clean(state)
    const plan = await api(path + '/merge')
    if (editor === state && state.job?.id === job.id) chooseRevision(state, job, path + '/merge', plan)
    return
  }
  dialog('比较并确认 AI 候选', [compare('当前' + names[state.doc.kind], state.body, '候选内容', job.output)],
    () => applyCandidate(state, job, path + '/apply'), '应用为新版本')
})
click('close-dialog', async () => { if (await screenplay.canClose()) $('dialog').close() })
click('open-find', () => findPanel($('find-panel').hidden))
click('close-find', () => { findPanel(false); bodyControl().focus({ preventScroll: true }) })
click('paired-document', () => {
  const { doc, title } = editor
  const kind = doc.kind === 'chapter' ? 'blueprint' : 'chapter'
  const counterpart = documents.find(row => row.kind === kind && row.number === doc.number)
  return counterpart ? openDocument(counterpart.id) : newDocument('', title, kind, doc.number)
})
click('find-back', () => locate(-1))
click('find-next', () => locate(1))
click('replace-one', replaceOne)
click('replace-all', replaceAll)
click('undo-replace', () => {
  const state = editor
  const change = state?.undoReplace
  if (!editableForReplace(state) || change?.edit !== state.edit) return
  replaceBody(state, change.body, change.start, change.end)
  state.undoReplace = null
  paint(state)
})
for (const [id, direction] of [['previous-chapter', -1], ['next-chapter', 1]]) {
  click(id, () => {
    const chapter = editor && adjacentChapter(editor, direction)
    if (chapter) return openDocument(chapter.id)
  })
}
$('find-query').addEventListener('input', event => { if (!event.isComposing) locate(1, true) })
$('find-query').addEventListener('compositionend', () => locate(1, true))
$('find-case').addEventListener('change', () => locate(1, true))
$('find-query').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return
  event.preventDefault()
  locate(event.shiftKey ? -1 : 1)
})
$('dialog-form').addEventListener('submit', event => {
  event.preventDefault()
  const action = dialogAction
  if (!action || $('dialog-submit').disabled) return
  $('dialog-submit').disabled = true
  runAction(async () => {
    try { await action() }
    finally { $('dialog-submit').disabled = false }
  })
})
document.addEventListener('keydown', event => {
  if (!editor || event.isComposing || $('dialog').open) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    findPanel(true)
  }
  if (event.key === 'Escape' && !$('find-panel').hidden) {
    findPanel(false)
    bodyControl().focus({ preventScroll: true })
  } else if (event.key === 'Escape' && document.body.classList.contains('focus-writing')) {
    setFocusWriting(false)
  }
  if (editor && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void flush(editor, true)
  }
})
window.addEventListener('online', () => { if (dirty(editor)) void flush(editor); syncCatalog() })
document.addEventListener('visibilitychange', () => {
  if (dirty(editor)) void flush(editor)
  if (!document.hidden) syncCatalog()
})
window.addEventListener('beforeunload', event => {
  if (dirty(editor) && editor.localOk !== true) { event.preventDefault(); event.returnValue = '' }
})
setInterval(() => { if (dirty(editor) && !document.hidden) void flush(editor) }, 10_000)
let polling = false
setInterval(async () => {
  if (polling || document.hidden || editor?.job?.status !== 'running') return
  polling = true
  try { await viewRun(editor, editor.job.id) }
  catch { /* The job is stored server-side. Retry on the next interval. */ }
  finally { polling = false }
}, 2000)

async function boot() {
  try {
    const session = await api('/session')
    model = session.model
    $('model-status').hidden = model
    semanticEnabled = session.semanticSearch
    $('semantic-search').hidden = !semanticEnabled
    $('release-version').textContent = session.version ? 'v' + session.version : ''
    if (session.enhancedEditor) await enableEnhancedEditor()
  } catch (error) {
    if (error.status !== 401) throw error
    $('login').hidden = false
    return
  }
  $('login').hidden = true
  $('workspace').hidden = false
  $('workspace-menu').hidden = false
  let saved
  try { saved = JSON.parse(sessionStorage.getItem('pagekin-location')) } catch { /* Optional. */ }
  await refreshProjects(saved?.[0], saved?.[1], stages.includes(saved?.[2]) ? saved[2] : 'chapter')
}
applyAppearance()
runAction(boot)
