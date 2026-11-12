import { ui } from './locale.mjs'
import { approaches, projectFields, chapterFields, methodCards } from './workbench-fields.mjs'

function node(tag, text = '') {
  const element = document.createElement(tag)
  element.textContent = text
  return element
}

function textFields(fields, data) {
  return fields.map(([key, title, maxLength]) => {
    const label = node('label', ui(title))
    const input = Object.assign(node('textarea'), { name: key, rows: key === 'sample' ? 4 : 2, maxLength, value: data[key] ?? '' })
    label.append(input)
    return label
  })
}

function values(panel) {
  return Object.fromEntries([...panel.querySelectorAll('textarea[name], select[name]')].map(input => [input.name, input.value]))
}

function group(title, controls) {
  const section = node('fieldset')
  section.className = 'script-fields workbench-section'
  section.append(node('legend', ui(title)), ...controls)
  return section
}

export function openWorkbenchUi({ api, dialog, actionButton }) {
  async function project(pid, current, actions) {
    const path = `/projects/${pid}/workbench`
    const saved = await api(path)
    if (!current()) return
    const panel = node('section')
    const choice = node('label', ui('创作方式'))
    const approach = node('select')
    approach.name = 'approach'
    approach.append(new Option(ui('暂未决定'), ''), ...Object.entries(approaches).map(([key, title]) => new Option(ui(title), key)))
    approach.value = saved.data.approach ?? ''
    choice.append(approach)
    const buttons = node('div')
    buttons.className = 'tools workbench-actions'
    buttons.append(...actions.map(([label, action]) => actionButton(label, action)))
    panel.append(buttons,
      group('创作简报', [choice, ...textFields(projectFields.slice(0, 4), saved.data)]),
      group('本书的叙述声音', textFields(projectFields.slice(4, 6), saved.data)),
      group('接着写什么', textFields(projectFields.slice(6), saved.data)),
      node('p', ui('候选方向、待调研和作者备注留在工作台。本章生成使用已决定的方向、写作边界和叙述声音。')))
    edit(path, saved.rev, panel, () => ({ ...values(panel) }), current, '创作工作台')
  }

  async function chapter(pid, number, current) {
    const path = `/projects/${pid}/workbench/${number}`
    const saved = await api(path)
    if (!current()) return
    const panel = node('section')
    const methods = Object.entries(methodCards).map(([key, card]) => {
      const label = node('label')
      label.className = 'manuscript-check'
      const input = Object.assign(node('input'), { type: 'checkbox', value: key, checked: saved.data.methods?.includes(key) ?? false })
      label.append(input, document.createTextNode(ui(card.title)))
      return { label, input }
    })
    const methodGroup = group('本章方法（最多两个，可留空）', methods.map(item => item.label))
    methodGroup.addEventListener('change', () => {
      const full = methods.filter(item => item.input.checked).length >= 2
      for (const { input } of methods) input.disabled = full && !input.checked
    })
    methodGroup.dispatchEvent(new Event('change'))
    const sources = new Map(saved.finals.map(row => [row.id, row]))
    const slots = Array.from({ length: 3 }, (_, index) => evidenceSlot(pid, index, sources, saved.evidence[index]))
    const evidence = group('定稿证据', [node('p', ui('从本章之前的定稿复制一处唯一引句。来源有新版时，旧引句留在工作台供核对。')),
      ...slots.map(slot => slot.node)])
    panel.append(group('本章任务', textFields(chapterFields, saved.data)), methodGroup, evidence)
    edit(path, saved.rev, panel, () => ({ ...values(panel), methods: methods.filter(item => item.input.checked).map(item => item.input.value),
      evidence: slots.map(slot => slot.value()).filter(Boolean) }), current, ui('第 $1 章 · 本章任务与依据', number))
  }

  function evidenceSlot(pid, index, sources, existing) {
    const source = node('select')
    source.id = `workbench-source-${index}`
    source.append(new Option(ui('选择前文定稿'), ''), ...[...sources.values()].map(row =>
      new Option(`${ui('第 $1 章', row.number)} · ${row.title} · v${row.rev}`, row.id)))
    source.value = existing?.id ?? ''
    const label = node('label', ui('前文来源'))
    label.append(source)
    const quoteLabel = node('label', ui('唯一原文引句'))
    const quote = Object.assign(node('textarea'), { id: `workbench-quote-${index}`, rows: 2, maxLength: 240, value: existing?.quote ?? '' })
    quoteLabel.append(quote)
    const status = node('p')
    status.setAttribute('role', 'status')
    const preview = node('pre')
    preview.hidden = true
    let selected = existing ?? null
    const view = actionButton(ui('查看所选定稿'), async () => {
      if (!selected) return
      const wanted = selected
      const row = await api(`/projects/${pid}/documents/${wanted.id}/history?rev=${wanted.rev}`)
      if (wanted === selected && preview.isConnected) { preview.textContent = row.body; preview.hidden = false }
    })
    const rebind = actionButton(ui('改用最新定稿'), () => {
      const latest = sources.get(source.value)
      if (latest) choose(latest)
    })
    function render() {
      status.textContent = selected?.stale ? ui('旧引句 · v$1。请核对最新版后重新引用。', selected.rev)
        : selected ? ui('定稿 v$1', selected.rev) : ''
      quoteLabel.hidden = view.hidden = !selected
      rebind.hidden = !selected?.stale
    }
    function choose(row) {
      selected = row ?? null
      quote.value = ''
      preview.hidden = true
      preview.textContent = ''
      render()
    }
    source.addEventListener('change', () => choose(sources.get(source.value)))
    render()
    return { node: group(ui('引用 $1', index + 1), [label, status, view, rebind, preview, quoteLabel]), value: () =>
      selected && ({ id: selected.id, rev: selected.rev, quote: quote.value }) }
  }

  function edit(path, rev, panel, value, current, title) {
    const feedback = node('p')
    feedback.setAttribute('role', 'status')
    dialog(ui(title), [panel, feedback], async () => {
      if (!current()) return
      try {
        await api(path, 'PUT', { baseRev: rev, data: value() })
        if (current() && panel.isConnected) document.getElementById('dialog').close()
      } catch (error) { feedback.textContent = error.message }
    }, ui('保存工作台'))
  }

  return { project, chapter }
}
