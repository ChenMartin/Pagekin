import { manuscriptRequestBytes, readManuscript } from './manuscript.mjs'

const states = { running: '拆解中', done: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
const batchStates = { running: '正在排队拆解', paused: '已暂停', done: '已完成', cancelled: '已取消' }
const node = (tag, text) => {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  return element
}
const label = (caption, input) => {
  const wrapper = node('label', caption)
  wrapper.append(input)
  return wrapper
}
const status = () => {
  const element = node('p')
  element.setAttribute('role', 'status')
  return element
}

export function referenceNovelWorkspace({ api, dialog, field, actionButton, uuid, isCurrent, modelEnabled, installSkill }) {
  const root = pid => '/projects/' + pid + '/reference-novels'
  const jobPath = (pid, id) => '/projects/' + pid + '/reference-analysis/' + id
  const batchPath = (pid, id) => '/projects/' + pid + '/reference-batches/' + id
  const open = element => element.isConnected && element.closest('dialog')?.open
  const back = (pid, book) => actionButton('返回参考小说', () => book ? showBook(pid, book.id) : list(pid))
  const positions = (first, last) => first === last ? '位置 ' + first : '位置 ' + first + '–' + last
  const jobLabel = job => job.mode === 'synthesis' ? '整书归纳' : positions(job.first, job.last)

  async function list(pid) {
    const books = await api(root(pid))
    if (!isCurrent(pid)) return
    const library = node('div')
    library.className = 'batch-list'
    library.append(...books.map(book => actionButton(book.title + ' · ' + book.chapter_count + ' 节', () => showBook(pid, book.id))))
    if (!books.length) library.append(node('p', '还没有导入参考小说。'))
    dialog('参考小说与仿写', [actionButton('导入参考小说', () => importBook(pid)), library])
  }

  function importBook(pid) {
    const [name, title] = field('参考小说书名', { maxLength: 160 })
    const file = node('input')
    file.type = 'file'
    file.accept = '.txt,.md,.epub,text/plain,text/markdown,application/epub+zip'
    file.required = true
    const preview = node('div')
    const feedback = status()
    let source
    let pending
    file.addEventListener('change', async () => {
      const selected = file.files[0]
      source = undefined
      preview.replaceChildren()
      feedback.textContent = ''
      if (!selected) return
      try {
        const fallback = (selected.name.replace(/\.[^.]+$/, '').trim() || '参考小说').slice(0, 160)
        feedback.textContent = '正在读取文件…'
        const { text, parsed: { chapters } } = await readManuscript(selected, fallback,
          bytes => api('/projects/' + pid + '/epub-preview', 'POST', bytes))
        if (file.files[0] !== selected || !open(preview)) return
        if (chapters.some(row => row.body.length > 180_000)) throw new Error('单节超过 180,000 字符，请补充章节标题后重试')
        title.value ||= fallback
        preview.append(node('p', '预览 ' + chapters.length + ' 节'),
          node('p', chapters.slice(0, 6).map(row => row.title).join(' · ')))
        source = { selected, content: text === undefined ? { chapters } : { text } }
        feedback.textContent = ''
      } catch (error) {
        if (file.files[0] === selected && open(preview)) feedback.textContent = error.message
      }
    })
    dialog('导入参考小说', [name, label('TXT、Markdown 或 EPUB', file), preview, feedback, back(pid)], async () => {
      if (!isCurrent(pid) || !source) {
        feedback.textContent ||= '请先选择并读取参考文件'
        return
      }
      const name = title.value.trim()
      if (pending && (pending.name !== name || pending.source !== source.selected)) {
        feedback.textContent = '上次导入结果待核对，请用原书名和文件重试，或回书架查看。'
        return
      }
      pending ??= { name, source: source.selected, id: uuid() }
      const request = { title: name, ...source.content, mutationId: pending.id }
      if (new TextEncoder().encode(JSON.stringify(request)).byteLength > manuscriptRequestBytes) {
        pending = undefined
        feedback.textContent = '文件编码后的请求超过限制，请分成多个参考文件'
        return
      }
      try {
        const book = await api(root(pid), 'POST', request)
        if (isCurrent(pid) && open(preview)) showBook(pid, book.id, book)
      } catch (error) {
        if (error.status && error.status < 500) pending = undefined
        feedback.textContent = error.message
      }
    }, '导入到参考小说')
  }

  async function showBook(pid, id, loaded) {
    const book = loaded ?? await api(root(pid) + '/' + id)
    if (!isCurrent(pid)) return
    const chapter = node('select')
    chapter.append(...book.chapters.map(row => new Option(row.position + ' · ' + row.title, row.position)))
    chapter.value = book.coverage.next ?? 1
    const chapterControls = node('div')
    chapterControls.className = 'tools'
    chapterControls.append(label('原文位置', chapter), actionButton('读原文', async () => {
      const row = await api(root(pid) + '/' + id + '/chapter?position=' + chapter.value)
      if (open(chapterControls) && isCurrent(pid)) {
        dialog(row.title, [node('pre', row.body), back(pid, book)])
      }
    }))
    const controls = node('div')
    controls.className = 'tools'
    controls.append(back(pid))
    if (book.batch) controls.append(actionButton('查看整书拆解', () => showBatch(pid, book, book.batch.id)))
    if (modelEnabled()) {
      const synthesize = actionButton('整书归纳', () => plan(pid, book, 1, 'synthesis'))
      synthesize.disabled = book.coverage.next !== null
      controls.append(actionButton('选择范围拆解', () => plan(pid, book, Number(chapter.value))), synthesize)
      if (book.coverage.next !== null && !['running', 'paused'].includes(book.batch?.status)) {
        controls.append(actionButton('整书自动拆解', () => planBatch(pid, book)))
      }
    }
    const progress = node('p', '已拆解 ' + book.coverage.completed + ' / ' + book.chapter_count + ' 节' +
      (book.coverage.next === null ? '' : ' · 下一未拆解位置 ' + book.coverage.next))
    const history = node('div')
    history.className = 'batch-list'
    history.append(...book.jobs.map(job => actionButton(
      jobLabel(job) + ' · ' + states[job.status] + ' · ' + new Date(job.created).toLocaleString(),
      () => showJob(pid, book, job.id))))
    if (!book.jobs.length) history.append(node('p', '尚无拆解记录。'))
    dialog(book.title, [controls, progress, chapterControls, node('h3', '拆解记录'), history])
  }

  function planBatch(pid, book) {
    const [chunkLabel, chunk] = field('每次模型请求最多处理几节', { type: 'number', min: 1, max: 20, value: 5 })
    const guidance = node('textarea')
    guidance.rows = 3
    guidance.maxLength = 2000
    const feedback = status()
    let pending
    dialog('整书自动拆解', [
      node('p', '还剩 ' + (book.chapter_count - book.coverage.completed) + ' 节未拆解。启动后会将未拆解章节的节选依次发送给当前模型。'),
      chunkLabel, label('本次研究重点', guidance), feedback, back(pid, book),
    ], async () => {
      if (!isCurrent(pid)) return
      const input = { chunkSize: chunk.valueAsNumber, guidance: guidance.value.trim() }
      const signature = JSON.stringify(input)
      if (pending && pending.signature !== signature) {
        feedback.textContent = '上次提交结果待核对，请按原设置重试或返回书架查看。'
        return
      }
      pending ??= { signature, id: uuid() }
      try {
        const batch = await api(root(pid) + '/' + book.id + '/batch', 'POST', { ...input, mutationId: pending.id })
        if (open(feedback)) await showBatch(pid, book, batch.id, batch)
      } catch (error) {
        if (error.status && error.status < 500) pending = undefined
        feedback.textContent = error.message
      }
    }, '开始整书拆解')
  }

  async function showBatch(pid, book, id, loaded) {
    const path = batchPath(pid, id)
    const batch = loaded ?? await api(path)
    if (!isCurrent(pid)) return
    const feedback = status()
    const warning = status()
    const summary = node('p')
    const report = node('div')
    const controls = node('div')
    controls.className = 'tools'
    const pause = actionButton('暂停整书拆解', () => change('pause'))
    const resume = actionButton('继续整书拆解', () => change('resume'))
    const cancel = actionButton('取消整书拆解', () => change('cancel'))
    const synthesize = actionButton('整书归纳', () => plan(pid, book, 1, 'synthesis'))
    controls.append(pause, resume, cancel, synthesize, back(pid, book))
    let sequence = 0
    let timer
    dialog(book.title + ' · 整书拆解', [feedback, summary, warning, report, controls])
    render(batch)

    function render(current) {
      feedback.textContent = batchStates[current.status] + ' · 已拆解 ' + current.completed + ' / ' + current.chapter_count + ' 节'
      summary.textContent = current.next ? '下一未拆解位置 ' + current.next : ''
      warning.textContent = current.error || ''
      pause.hidden = current.status !== 'running'
      resume.hidden = current.status !== 'paused' || !modelEnabled()
      resume.disabled = current.job?.status === 'running'
      cancel.hidden = !['running', 'paused'].includes(current.status)
      synthesize.hidden = current.status !== 'done' || !modelEnabled()
      report.replaceChildren()
      if (current.job) report.append(actionButton(jobLabel(current.job) + ' · ' + states[current.job.status],
        () => showJob(pid, book, current.job.id, undefined, id)))
      clearTimeout(timer)
      if (current.status === 'running' || current.job?.status === 'running') timer = setTimeout(() => refresh(), 1000)
    }

    async function refresh(action) {
      clearTimeout(timer)
      const current = ++sequence
      if (!open(feedback) || !isCurrent(pid)) return
      try {
        const updated = await api(action ? path + '/' + action : path, action ? 'POST' : 'GET')
        if (current === sequence && open(feedback)) render(updated)
      } catch (error) {
        if (current !== sequence || !open(feedback)) return
        warning.textContent = error.message
        timer = setTimeout(() => refresh(), 3000)
      }
    }

    async function change(action) {
      pause.disabled = resume.disabled = cancel.disabled = true
      await refresh(action)
      pause.disabled = cancel.disabled = false
    }
  }

  function plan(pid, book, firstPosition, mode = 'range') {
    const [firstLabel, first] = field('起始位置', { type: 'number', min: 1, max: book.chapter_count, value: firstPosition })
    const [lastLabel, last] = field('结束位置', { type: 'number', min: 1, max: book.chapter_count, value: Math.min(firstPosition + 4, book.chapter_count) })
    const guidance = node('textarea')
    guidance.rows = 3
    guidance.maxLength = 2000
    const context = node('div')
    const feedback = status()
    const path = root(pid) + '/' + book.id
    const value = () => {
      if (mode === 'synthesis') return { mode, guidance: guidance.value.trim() }
      const start = first.valueAsNumber
      const end = last.valueAsNumber
      if (!first.checkValidity() || !last.checkValidity() || end < start || end - start >= 20) {
        throw new Error('请选择连续的 1–20 个参考章节位置')
      }
      return { first: start, last: end, guidance: guidance.value.trim() }
    }
    const preview = actionButton('预览发送内容', async () => {
      try {
        const data = await api(path + '/context', 'POST', value())
        if (!open(context)) return
        context.replaceChildren(...data.messages.map(message => node('pre', message.content)))
        feedback.textContent = '已生成预览'
      } catch (error) { feedback.textContent = error.message }
    })
    for (const input of [first, last, guidance]) input.addEventListener('input', () => {
      feedback.textContent = ''
      context.replaceChildren()
    })
    let pending
    dialog(mode === 'synthesis' ? '整书归纳' : '拆解参考小说', [
      node('p', mode === 'synthesis' ? '使用覆盖全书的拆解摘要和区间分析生成归纳。' : '选定章节的节选会发送到当前模型。拆解报告可按范围反复查看。'),
      ...(mode === 'range' ? [firstLabel, lastLabel] : []),
      label('本次研究重点', guidance), preview, feedback, context, back(pid, book),
    ], async () => {
      if (!isCurrent(pid)) return
      try {
        const input = value()
        const signature = JSON.stringify(input)
        if (pending && pending.signature !== signature) throw new Error('上次提交结果待核对，请按原范围重试或查看拆解记录')
        pending ??= { signature, id: uuid() }
        const job = await api(path + '/analyze', 'POST', { ...input, mutationId: pending.id })
        if (open(context)) await showJob(pid, book, job.id, job)
      } catch (error) {
        if (error.status && error.status < 500) pending = undefined
        feedback.textContent = error.message
      }
    }, mode === 'synthesis' ? '开始归纳' : '开始拆解')
  }

  async function showJob(pid, book, id, loaded, batchId) {
    const path = jobPath(pid, id)
    const job = loaded ?? await api(path)
    if (!isCurrent(pid)) return
    const result = node('div')
    const feedback = status()
    const cancel = actionButton('取消拆解', async () => {
      cancel.disabled = true
      try { await api(path + '/cancel', 'POST') }
      catch (error) { feedback.textContent = error.message; cancel.disabled = false }
    })
    const returnButton = batchId ? actionButton('返回整书拆解', () => showBatch(pid, book, batchId)) : back(pid, book)
    dialog(book.title + ' · ' + jobLabel(job), [returnButton, feedback, cancel, result])
    render(job)

    function render(current) {
      const running = current.status === 'running'
      feedback.textContent = states[current.status] + (current.error ? ' · ' + current.error : '')
      cancel.hidden = !running
      if (current.report) {
        const { structure, style, constraints, chapters } = current.report
        const list = node('div')
        list.className = 'batch-list'
        for (const row of chapters) {
          const detail = node('details')
          const original = book.chapters[row.position - 1]
          detail.append(node('summary', row.position + ' · ' + original.title),
            node('h4', '节选摘要'), node('pre', row.summary), node('h4', '逆向蓝图'), node('pre', row.blueprint))
          list.append(detail)
        }
        result.replaceChildren(node('h3', '叙事结构'), node('pre', structure), node('h3', '文风特征'), node('pre', style),
          node('h3', '可迁移的写法'), node('pre', constraints),
          actionButton('核对写法并保存为 Skill', () => installSkill(pid, { title: '仿写约束 · ' + book.title, body: constraints })))
        if (chapters.length) result.append(node('h3', '逐节拆解'), list)
      } else {
        result.replaceChildren(node('pre', current.output || (running ? '等待模型响应…' : '没有可查看的输出')))
      }
      if (running) setTimeout(refresh, 1000)
    }

    async function refresh() {
      if (!open(result) || !isCurrent(pid)) return
      try {
        const updated = await api(path)
        if (open(result)) render(updated)
      } catch (error) {
        if (!open(result)) return
        feedback.textContent = error.message
        setTimeout(refresh, 3000)
      }
    }
  }

  return { list }
}
