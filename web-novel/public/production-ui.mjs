import { ui } from './locale.mjs'

const titles = { plan: 'AI 分集提案', script: 'AI 剧本候选', shots: 'AI 分场拆镜' }
const statuses = { running: '生成中', done: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
const sourceLabel = row => ui('第 $1 章 · $2 · v$3', row.number, row.title, row.rev)

function node(tag, text = '') {
  const element = document.createElement(tag)
  element.textContent = text
  return element
}

export function productionWorkspace({ api, dialog, field, actionButton, uuid, isCurrent, modelEnabled, modelName, scriptText, shotText }) {
  const visible = (pid, panel) => isCurrent(pid) && panel.isConnected && document.getElementById('dialog').open
  const root = pid => `/projects/${pid}/production-runs`

  async function plan(pid, adaptation, back) {
    const sources = await api(`/projects/${pid}/adaptations/eligible`)
    if (!isCurrent(pid)) return
    const last = adaptation.episodes.at(-1)
    const [seasonLabel, season] = field(ui('季号'), { type: 'number', min: 1, max: 99, value: last?.season ?? 1 })
    const [firstLabel, first] = field(ui('起始集号'), { type: 'number', min: 1, max: 9999, value: Math.min(9999, (last?.number ?? 0) + 1) })
    const [countLabel, count] = field(ui('计划集数'), { type: 'number', min: 1, max: 12, value: 1 })
    const list = node('div')
    list.className = 'batch-list'
    list.id = 'production-sources'
    const checks = sources.map(row => {
      const label = node('label')
      const check = node('input')
      check.type = 'checkbox'
      label.append(check, sourceLabel(row))
      list.append(label)
      return { check, row }
    })
    form(pid, 'plan', adaptation.id, [seasonLabel, firstLabel, countLabel, node('p', ui('选择 1–20 章定稿作为分集来源。')), list], () => ({
      season: season.valueAsNumber, first: first.valueAsNumber, count: count.valueAsNumber,
      sources: checks.filter(({ check }) => check.checked).map(({ row: { id, rev } }) => ({ id, rev })),
    }), back)
  }

  function script(pid, episode, back) {
    const notes = [node('p', ui('采用后将替换本集场次，原版本可在剧本历史查看。'))]
    if (episode.synopsis) notes.push(node('pre', episode.synopsis))
    notes.push(...episode.sources.map(row => node('p', sourceLabel(row))))
    form(pid, 'script', episode.id, notes, () => ({ baseRev: episode.rev }), back)
  }

  function shots(pid, board, scene, back) {
    form(pid, 'shots', board.episodeId, [node('p', `${scene.title} · ${ui('剧本 v$1', board.scriptRev)}`),
      node('p', ui('采用后将替换本场镜头，其他场次继续使用原镜头。'))],
    () => ({ baseRev: board.rev, scriptRev: board.scriptRev, sceneId: scene.id }), back)
  }

  function form(pid, kind, target, fields, scope, back) {
    const label = node('label', ui('本次要求'))
    const guidance = node('textarea')
    guidance.rows = 3
    guidance.maxLength = 1500
    label.append(guidance)
    const feedback = node('p')
    feedback.setAttribute('role', 'status')
    const preview = node('pre')
    preview.hidden = true
    const value = () => ({ kind, target, ...scope(), guidance: guidance.value })
    let pending
    const controls = node('div')
    controls.className = 'tools'
    const previewButton = actionButton(ui('预览发送内容'), async () => {
      feedback.textContent = ''
      preview.hidden = true
      const invalid = fields.flatMap(element => [...element.querySelectorAll('input')]).find(input => !input.checkValidity())
      if (invalid) { invalid.reportValidity(); return }
      try {
        const result = await api(root(pid) + '/preview', 'POST', value())
        preview.textContent = result.messages.map(message => message.content).join('\n\n')
        preview.hidden = false
      } catch (error) { feedback.textContent = error.message }
    })
    previewButton.id = 'production-preview'
    const again = () => form(pid, kind, target, fields, scope, back)
    controls.append(previewButton, actionButton(ui('任务历史'), () => history(pid, target, kind, back, again)),
      actionButton(ui('返回'), back))
    const enabled = modelEnabled()
    dialog(ui(titles[kind]), [...fields, label, controls, feedback, preview], enabled ? async () => {
      try {
        const input = value()
        const key = JSON.stringify(input)
        if (pending?.key !== key) pending = { key, id: uuid() }
        const job = await api(root(pid), 'POST', { ...input, mutationId: pending.id })
        if (visible(pid, feedback)) showJob(pid, job, back, again)
      } catch (error) { feedback.textContent = error.message }
    } : undefined, ui('生成候选'))
    if (!enabled) feedback.textContent = ui('写作模型待配置。可查看既有任务、候选和模型输入预览。')
  }

  async function history(pid, target, kind, back, again) {
    const jobs = await api(root(pid) + '?' + new URLSearchParams({ target, kind }))
    if (!isCurrent(pid)) return
    const list = node('div')
    list.className = 'batch-list'
    for (const row of jobs) {
      list.append(actionButton([ui(statuses[row.status]), row.applied && ui('已采用'), new Date(row.created).toLocaleString()].filter(Boolean).join(' · '),
        async () => showJob(pid, await api(root(pid) + '/' + row.id), back, again)))
    }
    dialog(ui('任务历史'), [actionButton(ui('返回'), again), jobs.length ? list : node('p', ui('暂无任务'))])
  }

  function compare(original, candidate) {
    const panel = node('div')
    panel.className = 'compare'
    for (const [title, text] of [[ui('当前版本'), original], [ui('候选内容'), candidate]]) {
      const section = node('section')
      section.append(node('h3', title), node('pre', text || ui('（无）')))
      panel.append(section)
    }
    return panel
  }

  function showJob(pid, first, back, again) {
    const path = root(pid) + '/' + first.id
    const panel = node('section')
    const status = node('p')
    status.id = 'production-progress'
    status.setAttribute('role', 'status')
    const feedback = node('p')
    feedback.setAttribute('role', 'alert')
    const contents = node('div')
    const actions = node('div')
    actions.className = 'tools'
    panel.append(status, feedback, actions, contents)
    dialog(ui(titles[first.kind]), [panel])
    paint(first)

    function paint(job) {
      if (!visible(pid, panel)) return
      status.textContent = [ui(statuses[job.status]), modelName(job.model_ref), job.applied && ui('已采用'), job.error].filter(Boolean).join(' · ')
      actions.replaceChildren(actionButton(ui('任务历史'), () => history(pid, job.target, job.kind, back, again)),
        actionButton(ui('返回工作区'), back))
      if (job.status === 'running') {
        const cancel = actionButton(ui('取消'), async () => {
          cancel.disabled = true
          try { await api(path + '/cancel', 'POST') }
          catch (error) { feedback.textContent = error.message; cancel.disabled = false }
        })
        actions.append(cancel)
        setTimeout(async () => {
          if (!visible(pid, panel)) return
          try { paint(await api(path)) }
          catch (error) { feedback.textContent = error.message; actions.append(actionButton(ui('重新读取 NAS'), async () => paint(await api(path)))) }
        }, 1000)
      }
      contents.replaceChildren()
      if (job.output) {
        const raw = node('details')
        raw.append(node('summary', ui('模型原始输出')), node('pre', job.output))
        contents.append(raw)
      }
      if (job.candidate) void proposals(job).catch(error => { feedback.textContent = error.message })
      if (again !== back && ['failed', 'interrupted', 'cancelled'].includes(job.status)) actions.append(actionButton(ui('返回生成设置'), again))
    }

    async function proposals(job) {
      const options = []
      let section
      if (job.kind === 'plan') {
        const sources = new Map(job.input.sources.map(row => [row.id, row]))
        section = node('div')
        section.className = 'batch-list production-proposal'
        for (const row of job.candidate.episodes) {
          const item = node('section')
          const label = node('label')
          const check = node('input')
          check.type = 'checkbox'
          check.checked = true
          check.disabled = !!job.applied
          options.push(check)
          label.append(check, ui('第 $1 季 · 第 $2 集 · $3', row.season, row.number, row.title))
          item.append(label, node('p', row.synopsis), node('p', row.sourceIds.map(id => sourceLabel(sources.get(id))).join(' · ')))
          section.append(item)
        }
      } else {
        const episodePath = `/projects/${pid}/episodes/${job.target}`
        if (job.kind === 'script') {
          const original = await api(episodePath + '/history?rev=' + job.input.baseRev)
          section = compare(scriptText(original), scriptText({ title: original.title, synopsis: original.synopsis, scenes: job.candidate.scenes }))
        } else {
          const original = job.input.baseRev ? await api(episodePath + '/storyboard-history?rev=' + job.input.baseRev) : { shots: [] }
          section = compare(shotText(original.shots.filter(shot => shot.sceneId === job.input.sceneId)), shotText(job.candidate.shots))
        }
        section.classList.add('production-proposal')
      }
      if (!visible(pid, panel)) return
      contents.prepend(section)
      if (job.applied) return
      const apply = actionButton(ui(job.kind === 'plan' ? '创建选中的剧本集' : '采用候选'), async () => {
        apply.disabled = true
        feedback.textContent = ''
        try {
          const selected = options.flatMap((check, index) => check.checked ? [index + 1] : [])
          if (job.kind === 'plan' && !selected.length) throw new Error(ui('请选择至少一集。'))
          await api(path + '/apply', 'POST', { selected })
          if (visible(pid, panel)) await back()
        } catch (error) { feedback.textContent = error.message; apply.disabled = false }
      })
      contents.append(apply)
    }
  }

  return { plan, script, shots, records: (pid, target, kind, back) => history(pid, target, kind, back, back) }
}
