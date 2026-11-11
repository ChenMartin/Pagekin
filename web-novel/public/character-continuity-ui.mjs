import { characterStateFields, characterStateLimit, relationshipLimit, relationshipTextLimit } from './character-state.mjs'

const node = (tag, text) => {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  return element
}
const label = (title, control) => {
  const element = node('label', title)
  element.append(control)
  return element
}
const chapterLabel = chapter => chapter ? '第 ' + chapter + ' 章后' : '开篇'
const recordLabel = ({ chapter, finalRev }) => chapterLabel(chapter) + (chapter ? ' · 定稿 v' + finalRev : '')
const runStatus = { running: '提取中', done: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
const evidenceStatus = { verified: '原文唯一匹配', ambiguous: '引文重复', missing: '定稿中未找到', unavailable: '缺少原文' }
const desktopSourceNames = { author: '桌面作者记录', adopted: '桌面作者采纳', derived: '桌面定稿派生', legacy: '桌面迁移基线' }

export function continuityWorkspace({ api, dialog, actionButton, uuid, isCurrent, modelEnabled }) {
  const root = pid => '/projects/' + pid + '/continuity'
  const open = element => element.isConnected && element.closest('dialog')?.open

  async function list(pid, { characterId, chapter = 0 } = {}) {
    const roster = await api(root(pid))
    if (!isCurrent(pid)) return
    const { characters, finals } = roster
    const desktopButton = roster.desktopHistory
      ? actionButton('查看桌面人物历史', () => showDesktopHistory(pid, roster, characterId ?? '')) : null
    if (!characters.length) {
      dialog('人物连载', [node('p', '先在人物阶段新建人物卡。'), ...(desktopButton ? [desktopButton] : [])])
      return
    }
    const person = node('select')
    person.append(...characters.map(row => new Option(row.title, row.id)))
    if (characters.some(row => row.id === characterId)) person.value = characterId
    const source = node('select')
    source.append(new Option('开篇状态', 0),
      ...finals.map(row => new Option(chapterLabel(row.number) + ' · ' + row.title + ' · 定稿 v' + row.rev, row.number)))
    if (finals.some(row => row.number === chapter)) source.value = chapter
    dialog('人物连载', [label('人物卡', person), label('记录位置', source),
      ...(desktopButton ? [desktopButton] : []),
      actionButton('查看该位置的人物关系', () => showRelationships(pid, roster, person.value, Number(source.value)))],
      () => edit(pid, roster, person.value, Number(source.value)), '打开状态与关系')
  }

  function showDesktopHistory(pid, roster, id) {
    const filter = node('select')
    filter.append(new Option('全部人物', ''), ...roster.characters.map(row => new Option(row.title, row.id)),
      new Option('已移除或未匹配的人物', 'unlinked'))
    filter.value = id
    const results = node('div')
    results.className = 'batch-list'
    const feedback = node('p')
    feedback.setAttribute('role', 'status')
    const actions = node('div')
    actions.className = 'tools'
    const previous = actionButton('上一页', () => refresh(offset - 50))
    const next = actionButton('下一页', () => refresh(offset + 50))
    actions.append(previous, next)
    let offset = 0
    let sequence = 0
    filter.addEventListener('change', () => { void refresh(0) })
    dialog('桌面人物历史', [actionButton('返回人物连载', () => list(pid)), label('筛选人物', filter), feedback, results, actions])
    void refresh(0)

    async function refresh(start) {
      const key = ++sequence
      previous.disabled = next.disabled = true
      feedback.textContent = '正在读取桌面历史…'
      const query = new URLSearchParams({ offset: start })
      if (filter.value) query.set('character', filter.value)
      try {
        const { rows, more } = await api(root(pid) + '/desktop-history?' + query)
        if (sequence !== key || !open(results) || !isCurrent(pid)) return
        offset = start
        previous.disabled = !offset
        next.disabled = !more
        feedback.textContent = rows.length ? '第 ' + (offset + 1) + '–' + (offset + rows.length) + ' 条' : '此筛选下没有桌面历史。'
        results.replaceChildren(...rows.map(row => {
          const when = !row.chapter ? '开篇' : ['author', 'adopted'].includes(row.kind)
            ? '自第 ' + row.chapter + ' 章起' : '第 ' + row.chapter + ' 章后'
          const field = row.field === 'relation' ? '→ ' + (row.targetName || '未匹配人物') : characterStateFields[row.field]
          const detail = node('details')
          detail.append(node('summary', [when, row.characterName || '未匹配人物', field].join(' · ')),
            node('p', desktopSourceNames[row.kind] + (row.active ? '' : ' · 仅历史参考')),
            node('pre', row.value || '此项已清除'))
          if (row.sourceRev) detail.append(node('p', '来源 · 第 ' + row.sourceChapter + ' 章 v' + row.sourceRev))
          if (row.quote) detail.append(node('p', '原文引证'), node('pre', row.quote))
          return detail
        }))
      } catch (error) {
        if (sequence === key && open(results)) feedback.textContent = error.message
      }
    }
  }

  async function showRelationships(pid, roster, id, chapter) {
    const { source, records } = await api(root(pid) + '/relationships?chapter=' + chapter)
    if (!isCurrent(pid)) return
    const filter = node('select')
    filter.append(new Option('全部人物', ''), ...roster.characters.map(row => new Option(row.title, row.id)))
    const results = node('div')
    results.className = 'batch-list'
    const render = () => {
      const rows = records.filter(row => !filter.value || row.id === filter.value || row.relationships.some(link => link.targetId === filter.value))
      results.replaceChildren()
      for (const row of rows) {
        const section = node('section')
        section.append(actionButton(row.name, () => edit(pid, roster, row.id, chapter)),
          node('p', '记录位置 · ' + chapterLabel(row.chapter)))
        for (const link of row.relationships) {
          if (!filter.value || row.id === filter.value || link.targetId === filter.value) {
            section.append(node('p', row.name + ' → ' + link.name + ' · ' + link.relation))
          }
        }
        results.append(section)
      }
      if (!rows.length) results.append(node('p', '此位置没有符合筛选条件的人物关系。'))
    }
    filter.addEventListener('change', render)
    render()
    dialog('人物关系 · ' + recordLabel({ chapter, finalRev: source.rev }), [
      actionButton('返回人物连载', () => list(pid, { characterId: id, chapter })), label('筛选人物', filter), results,
    ])
  }

  async function edit(pid, roster, id, chapter, initialJob, stillOpen = () => true) {
    const path = root(pid) + '/' + id
    const data = await api(path + '?chapter=' + chapter)
    if (!isCurrent(pid) || !stillOpen()) return
    const { current, previous, source, history, importedState } = data
    const starting = current ?? importedState ?? previous
    const names = new Map(roster.characters.map(row => [row.id, row.title]))
    const picks = new Map()
    const fields = Object.entries(characterStateFields).map(([key, title]) => {
      const input = node('textarea')
      input.rows = 2
      input.maxLength = characterStateLimit
      input.name = key
      input.value = starting?.state[key] ?? ''
      const evidence = node('span')
      const update = () => {
        const quote = current?.state[key] === input.value.trim() ? current.evidence[key] : ''
        evidence.hidden = !quote
        evidence.textContent = quote ? '已保存引文 · ' + quote : ''
      }
      input.addEventListener('input', () => { picks.delete(key); update() })
      update()
      const wrapper = label(title, input)
      wrapper.append(evidence)
      return { input, label: wrapper, update }
    })
    const relationList = node('div')
    relationList.className = 'batch-list'
    const relationships = new Map()
    const add = actionButton('添加关系', () => addRelation())
    const targets = roster.characters.filter(row => row.id !== id)

    function updateAdd() {
      add.disabled = relationships.size >= Math.min(relationshipLimit, targets.length)
    }

    function addRelation(entry) {
      const row = node('section')
      const target = node('select')
      target.required = true
      target.append(new Option('选择人物', ''), ...targets.map(person => new Option(person.title, person.id)))
      target.value = entry?.targetId ?? ''
      const text = node('input')
      text.required = true
      text.maxLength = relationshipTextLimit
      text.value = entry?.relation ?? ''
      row.append(label('关系对象', target), label('从当前人物指向对方的关系', text),
        actionButton('移除此关系', () => {
          row.remove()
          relationships.delete(row)
          updateAdd()
        }))
      relationships.set(row, { target, text })
      relationList.append(row)
      updateAdd()
    }

    for (const entry of starting?.relationships.slice(0, relationshipLimit) ?? []) addRelation(entry)
    updateAdd()
    const back = actionButton('选择人物或章节', () => list(pid, { characterId: id, chapter }))
    const historyButton = actionButton('查看连载记录', () => showHistory(pid, roster, id, chapter, history))
    historyButton.disabled = !history.length
    const feedback = node('p')
    feedback.setAttribute('role', 'status')
    const status = current ? '当前记录 v' + current.rev
      : importedState ? '表单已带入在此位置有效的桌面状态。保存前请核对。'
        : previous ? '表单已带入' + recordLabel(previous) + '的状态。保存前请核对所有字段和关系。'
        : '填写此位置的人物状态和关系。留空字段表示此位置没有记录。'
    const oversized = importedState && (Object.values(importedState.state).some(value => value.length > characterStateLimit) ||
      importedState.relationships.length > relationshipLimit ||
      importedState.relationships.some(row => row.relation.length > relationshipTextLimit))
    const importedNotice = oversized ? [node('p', '部分桌面记录超出 Web 表单容量。可查看完整桌面历史，再整理后保存。')] : []
    dialog(names.get(id) + ' · ' + recordLabel({ chapter, finalRev: source.rev }), [
      back, historyButton,
      ...(roster.desktopHistory ? [actionButton('查看桌面人物历史', () => showDesktopHistory(pid, roster, id))] : []),
      node('p', status), ...importedNotice, ...(chapter ? [suggestions(pid, id, source, fields, picks, initialJob)] : []),
      ...fields.map(row => row.label),
      node('h3', '人物关系'), add, relationList, feedback,
    ], async () => {
      const links = [...relationships.values()].map(({ target, text }) => ({ targetId: target.value, relation: text.value }))
      if (new Set(links.map(entry => entry.targetId)).size !== links.length) {
        feedback.textContent = '同一人物只保留一条关系，可在一条内描述多个方面'
        return
      }
      try {
        const saved = await api(path, 'PUT', { chapter, finalRev: source.rev, baseRev: current?.rev ?? 0,
          state: Object.fromEntries(fields.map(({ input }) => [input.name, input.value])), relationships: links,
          picks: [...picks].map(([field, runId]) => ({ field, runId })) })
        if (open(feedback)) await edit(pid, roster, id, saved.chapter)
      } catch (error) {
        feedback.textContent = error.message
        if (error.status === 409) {
          const conflict = error.current?.current
          const changed = conflict ? describe(conflict, names) : []
          feedback.replaceChildren(node('span', error.message), ...changed,
            actionButton('重新读取 NAS 记录', () => list(pid, { characterId: id, chapter })))
        }
      }
    }, '保存人物状态')
  }

  function changeRows(report, pick) {
    return report.changes.map(change => {
      const row = node('section')
      const title = characterStateFields[change.field]
      row.append(node('h4', title), node('p', change.value), node('pre', change.quote), node('p', evidenceStatus[change.evidence]))
      if (pick && change.evidence === 'verified') row.append(actionButton('填入' + title, () => pick(change, title)))
      return row
    })
  }

  async function openJob(pid, chapter, job, stillOpen) {
    const roster = await api(root(pid))
    if (!isCurrent(pid) || !stillOpen()) return
    const person = roster.characters.find(row => row.id === job.continuityCharacterId)
    if (person && roster.finals.some(row => row.number === chapter && row.rev === job.base_rev)) {
      await edit(pid, roster, person.id, chapter, job, stillOpen)
      return
    }
    const result = job.continuityReport ? changeRows(job.continuityReport) : [node('pre', job.output)]
    dialog('历史人物变化 · 第 ' + chapter + ' 章 · 定稿 v' + job.base_rev, [
      node('p', '对应定稿版本已变更。' + (person ? ' 人物 · ' + person.title : '')), ...result,
    ])
  }

  function suggestions(pid, id, source, fields, picks, initialJob) {
    const panel = node('details')
    const feedback = node('p')
    feedback.setAttribute('role', 'status')
    const controls = node('div')
    controls.className = 'tools'
    const results = node('div')
    results.className = 'batch-list'
    const docPath = '/projects/' + pid + '/documents/' + source.id
    const jobPath = '/projects/' + pid + '/runs/'
    const request = { kind: 'continuity', baseRev: source.rev, continuityCharacterId: id }
    let version = 0
    let mutationId
    let submitting = false
    const active = seq => version === seq && open(panel) && isCurrent(pid)
    const startView = () => {
      feedback.textContent = ''
      results.replaceChildren()
      return ++version
    }
    controls.append(actionButton('查看本版提取记录', async () => {
      const seq = startView()
      try {
        const jobs = await api(root(pid) + '/' + id + '/suggestions?chapter=' + source.number + '&finalRev=' + source.rev)
        if (!active(seq)) return
        for (const job of jobs) results.append(actionButton(runStatus[job.status] + ' · ' + new Date(job.created).toLocaleString(),
          () => viewRun(job.id, startView())))
        if (!jobs.length) feedback.textContent = '此人物在本定稿版本上还没有提取记录。'
      } catch (error) { if (active(seq)) feedback.textContent = error.message }
    }))
    if (modelEnabled()) {
      controls.append(actionButton('预览发送内容', async () => {
        const seq = startView()
        try {
          const preview = await api(docPath + '/context', 'POST', request)
          if (active(seq)) results.replaceChildren(...preview.messages.map(message => node('pre', message.content)))
        } catch (error) { if (active(seq)) feedback.textContent = error.message }
      }))
      const extract = actionButton('从定稿提取人物变化', async () => {
        if (submitting) return
        submitting = extract.disabled = true
        const seq = startView()
        feedback.textContent = '正在提交提取任务…'
        mutationId ??= uuid()
        try {
          const job = await api(docPath + '/runs', 'POST', { ...request, mutationId })
          mutationId = undefined
          if (active(seq)) renderRun(job, seq)
        } catch (error) {
          if (error.status && error.status < 500) mutationId = undefined
          if (active(seq)) feedback.textContent = error.message
        } finally { submitting = extract.disabled = false }
      })
      controls.append(extract)
    }
    panel.append(node('summary', 'AI 人物变化候选'), controls,
      node('p', '提取会向模型发送所选定稿。填入字段后仍需核对并保存人物状态。'), feedback, results)
    if (initialJob) {
      panel.open = true
      renderRun(initialJob, startView())
    }

    async function viewRun(id, seq) {
      if (!active(seq)) return
      try {
        const job = await api(jobPath + id)
        if (active(seq)) renderRun(job, seq)
      } catch (error) { if (active(seq)) feedback.textContent = error.message }
    }

    function renderRun(job, seq) {
      if (job.base_rev !== source.rev || job.continuityCharacterId !== id) {
        feedback.textContent = '记录属于另一份定稿或人物。请重新打开当前状态表单。'
        return
      }
      feedback.textContent = runStatus[job.status] + (job.error ? ' · ' + job.error : '')
      results.replaceChildren()
      if (job.status === 'running') {
        results.append(actionButton('取消提取', () => api(jobPath + job.id + '/cancel', 'POST')))
        setTimeout(() => viewRun(job.id, seq), 1000)
        return
      }
      if (!job.continuityReport) {
        if (job.output) results.append(node('pre', job.output))
        if (job.status === 'done') feedback.textContent = '输出格式无法核对，请查看原输出或重新提取。'
        return
      }
      if (!job.continuityReport.changes.length) feedback.textContent = '模型未提取到可列出的人物变化。'
      results.append(...changeRows(job.continuityReport, (change, title) => {
        const { input, update } = fields.find(field => field.input.name === change.field)
        input.value = change.value
        picks.set(change.field, job.id)
        update()
        feedback.textContent = '已填入' + title + '，请核对后保存。'
      }))
    }

    return panel
  }

  function describe(record, names) {
    const fields = Object.entries(characterStateFields).filter(([key]) => record.state[key])
      .map(([key, title]) => title + ' · ' + record.state[key] + (record.evidence[key] ? '\n原文 · ' + record.evidence[key] : ''))
    const links = record.relationships.map(entry => '对「' + (names.get(entry.targetId) ?? '人物') + '」的关系 · ' + entry.relation)
    return [node('pre', [...fields, ...links].join('\n') || '该记录的状态和关系均为空。')]
  }

  function showHistory(pid, roster, id, chapter, rows) {
    const names = new Map(roster.characters.map(row => [row.id, row.title]))
    const list = node('div')
    list.className = 'batch-list'
    for (const row of rows) list.append(actionButton(recordLabel(row) + (row.active ? '' : ' · 已被新定稿取代'), async () => {
      const record = await api(root(pid) + '/' + id + '/history?chapter=' + row.chapter + '&finalRev=' + row.finalRev)
      if (!isCurrent(pid) || !open(list)) return
      dialog(names.get(id) + ' · ' + recordLabel(record), [
        ...describe(record, names), actionButton('返回连载记录', () => showHistory(pid, roster, id, chapter, rows)),
      ])
    }))
    dialog('人物连载记录', [actionButton('返回人物状态', () => edit(pid, roster, id, chapter)), list])
  }

  return { list, openJob }
}
