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

export function continuityWorkspace({ api, dialog, actionButton, isCurrent }) {
  const root = pid => '/projects/' + pid + '/continuity'
  const open = element => element.isConnected && element.closest('dialog')?.open

  async function list(pid, { characterId, chapter = 0 } = {}) {
    const roster = await api(root(pid))
    if (!isCurrent(pid)) return
    const { characters, finals } = roster
    if (!characters.length) {
      dialog('人物连载', [node('p', '先在人物阶段新建人物卡。')])
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
      actionButton('查看该位置的人物关系', () => showRelationships(pid, roster, person.value, Number(source.value)))],
      () => edit(pid, roster, person.value, Number(source.value)), '打开状态与关系')
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

  async function edit(pid, roster, id, chapter) {
    const path = root(pid) + '/' + id
    const data = await api(path + '?chapter=' + chapter)
    if (!isCurrent(pid)) return
    const { current, previous, source, history } = data
    const starting = current ?? previous
    const names = new Map(roster.characters.map(row => [row.id, row.title]))
    const fields = Object.entries(characterStateFields).map(([key, title]) => {
      const input = node('textarea')
      input.rows = 2
      input.maxLength = characterStateLimit
      input.name = key
      input.value = starting?.state[key] ?? ''
      return { input, label: label(title, input) }
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

    for (const entry of starting?.relationships ?? []) addRelation(entry)
    updateAdd()
    const back = actionButton('选择人物或章节', () => list(pid, { characterId: id, chapter }))
    const historyButton = actionButton('查看连载记录', () => showHistory(pid, roster, id, chapter, history))
    historyButton.disabled = !history.length
    const feedback = node('p')
    feedback.setAttribute('role', 'status')
    const status = current ? '当前记录 v' + current.rev
      : previous ? '表单已带入' + recordLabel(previous) + '的状态。保存前请核对所有字段和关系。'
        : '填写此位置的人物状态和关系。留空字段表示此位置没有记录。'
    dialog(names.get(id) + ' · ' + recordLabel({ chapter, finalRev: source.rev }), [
      back, historyButton, node('p', status), ...fields.map(row => row.label),
      node('h3', '人物关系'), add, relationList, feedback,
    ], async () => {
      const links = [...relationships.values()].map(({ target, text }) => ({ targetId: target.value, relation: text.value }))
      if (new Set(links.map(entry => entry.targetId)).size !== links.length) {
        feedback.textContent = '同一人物只保留一条关系，可在一条内描述多个方面'
        return
      }
      try {
        const saved = await api(path, 'PUT', { chapter, finalRev: source.rev, baseRev: current?.rev ?? 0,
          state: Object.fromEntries(fields.map(({ input }) => [input.name, input.value])), relationships: links })
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

  function describe(record, names) {
    const fields = Object.entries(characterStateFields).filter(([key]) => record.state[key])
      .map(([key, title]) => title + ' · ' + record.state[key])
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

  return { list }
}
