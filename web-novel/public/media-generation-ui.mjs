import { ui } from './locale.mjs'

const labels = { image: '生成图像', video: '生成视频', speech: '生成配音' }
const states = { queued: '等待提交', submitting: '正在提交', waiting: '等待供应商', unknown: '提交待核对',
  recover: '结果待回收', poll_paused: '查询已暂停', ready: '候选已就绪', failed: '失败', cancelled: '已取消' }
const active = ['queued', 'submitting', 'waiting']

function node(tag, text = '') {
  const element = document.createElement(tag)
  element.textContent = text
  return element
}

export function mediaGenerationWorkspace({ api, dialog, actionButton, uuid, isCurrent }) {
  const endpoint = (pid, id) => `/projects/${pid}/media-generations/${id}`
  const visible = (state, element) => element.isConnected && document.getElementById('dialog').open && isCurrent(state.pid)

  async function open(state, back, adopted) {
    const [capability, jobs] = await Promise.all([api('/media-generation-capabilities'), api(state.path + '/generations')])
    if (!isCurrent(state.pid)) return
    const buttons = [actionButton(ui('返回时间线'), back)]
    const chosen = state.clips[state.selected]
    const shot = state.base.shots.find(item => item.id === chosen?.shotId)
    const canCreate = capability.available && !state.base.stale && state.base.currentBoardRev
    if (canCreate) for (const [kind, model] of Object.entries(capability.models)) {
      if (kind !== 'speech' && !shot) continue
      buttons.push(actionButton(ui(labels[kind]), () => form(state, kind, model, shot, chosen, back, adopted)))
    }
    const info = !capability.available ? ui(capability.invalid ? 'NAS 的媒体生成配置无效。' : '启用媒体环境并配置 Replicate 后可生成素材。')
      : !canCreate ? ui('请先确认分镜并复核时间线来源。') : ''
    const history = node('div')
    history.className = 'batch-list'
    for (const job of jobs) history.append(actionButton(`${ui(labels[job.kind])} · ${ui(states[job.state])} · ${new Date(job.created).toLocaleString()}`,
      async () => {
        const data = await api(endpoint(state.pid, job.id))
        if (visible(state, history)) detail(state, data, back, adopted)
      }))
    dialog(ui('AI 素材生成'), [...buttons, ...(info ? [node('p', info)] : []), history])
  }

  function form(state, kind, model, shot, clip, back, adopted) {
    const text = node('textarea')
    text.id = 'media-generation-prompt'
    text.maxLength = 3000
    text.rows = 6
    text.value = (kind === 'speech' ? clip?.caption ?? '' : shot?.prompt || shot?.visual || '').slice(0, 3000)
    const label = node('label', ui(kind === 'speech' ? '配音文本' : '生成提示词'))
    label.append(text)
    const output = node('pre')
    output.hidden = true
    const alert = node('p')
    alert.setAttribute('role', 'status')
    let approved
    let busy = false
    let attempt = 0
    const submissions = new Map()
    const preview = actionButton(ui('预览发送内容'), async () => {
      if (busy) return
      const number = ++attempt
      const value = { kind, boardRev: state.base.boardRev, timelineRev: state.base.rev, shotId: shot?.id ?? null, prompt: text.value }
      confirm.disabled = true
      alert.textContent = ''
      output.hidden = true
      try {
        const data = await api(state.path + '/generation-preview', 'POST', value)
        if (number !== attempt || !visible(state, alert)) return
        if (!submissions.has(data.approval)) submissions.set(data.approval, uuid())
        approved = { ...value, approval: data.approval, mutationId: submissions.get(data.approval) }
        output.textContent = JSON.stringify(data.manifest, null, 2)
        output.hidden = false
        confirm.disabled = false
      } catch (error) { if (number === attempt) alert.textContent = error.message }
    })
    const confirm = actionButton(ui('确认付费生成'), async () => {
      if (!approved || busy) return
      busy = true
      confirm.disabled = true
      text.disabled = true
      try {
        const job = await api(state.path + '/generations', 'POST', approved)
        if (visible(state, alert)) detail(state, job, back, adopted)
      } catch (error) { alert.textContent = error.message; confirm.disabled = false }
      finally { busy = false; text.disabled = false }
    })
    confirm.id = 'media-generation-submit'
    confirm.disabled = true
    text.addEventListener('input', () => {
      attempt++
      approved = null
      confirm.disabled = true
      output.hidden = true
    })
    dialog(ui(labels[kind]), [node('p', model), label,
      node('p', ui('确认后会把下方输入发送给 Replicate，供应商可能按任务收费。')),
      preview, alert, output, confirm, actionButton(ui('返回生成任务'), () => open(state, back, adopted))])
  }

  function detail(state, first, back, adopted) {
    const panel = node('section')
    const status = node('p')
    status.id = 'media-generation-status'
    status.setAttribute('role', 'status')
    const alert = node('p')
    alert.setAttribute('role', 'alert')
    const actions = node('div')
    actions.className = 'tools'
    const results = node('div')
    const input = node('details')
    input.append(node('summary', ui('固定的生成输入')), node('pre', JSON.stringify(first.manifest, null, 2)))
    panel.append(status, alert, actions, input, results)
    dialog(ui(labels[first.kind]), [panel])
    const path = endpoint(state.pid, first.id)
    let timer
    let sequence = 0
    async function refresh() {
      const check = ++sequence
      try {
        const data = await api(path)
        if (visible(state, panel) && check === sequence) show(data)
      } catch (error) { if (check === sequence) alert.textContent = error.message }
    }

    function show(job) {
      clearTimeout(timer)
      status.textContent = [ui(states[job.state]), job.external_id, job.external_version?.slice(0, 12),
        job.cancel_requested ? ui('已请求取消') : '', job.error].filter(Boolean).join(' · ')
      actions.replaceChildren(actionButton(ui('返回生成任务'), () => open(state, back, adopted)),
        actionButton(ui('重新读取 NAS'), refresh))
      if (active.includes(job.state)) {
        if (!job.cancel_requested) actions.append(actionButton(ui('取消'), () => change('/cancel')))
        timer = setTimeout(() => { if (visible(state, panel)) void refresh() }, 3000)
      }
      if (['recover', 'poll_paused'].includes(job.state)) actions.append(actionButton(ui('继续查询并回收'), () => change('/resume')))
      if (job.state === 'unknown') {
        const field = node('input')
        field.maxLength = 80
        const label = node('label', ui('供应商任务编号'))
        label.append(field)
        actions.append(label, actionButton(ui('核对并关联'), () => change('/link', { externalId: field.value.trim() })))
      }
      if (active.includes(job.state)) return
      results.replaceChildren(...job.variants.map(variant => {
        const section = node('section')
        const item = node(variant.type.startsWith('image/') ? 'img' : variant.type.startsWith('audio/') ? 'audio' : 'video')
        item.src = '/api' + path + '/file?variant=' + variant.ordinal
        item.className = 'media-preview'
        if (item.tagName === 'IMG') { item.alt = ui('生成候选 $1', variant.ordinal); item.loading = 'lazy' }
        else { item.controls = true; item.preload = 'metadata'; item.playsInline = true }
        section.append(node('h3', ui('生成候选 $1', variant.ordinal)), item)
        if (variant.adopted_asset_id) section.append(node('p', ui('已加入素材库')))
        else {
          const name = node('input')
          name.maxLength = 160
          name.value = `${ui(labels[job.kind])} ${job.id.slice(0, 8)}-${variant.ordinal}`
          const label = node('label', ui('素材名称'))
          label.append(name)
          const button = actionButton(ui('加入素材库'), async () => {
            button.disabled = true
            try {
              const asset = await api(path + '/adopt?variant=' + variant.ordinal, 'POST', { name: name.value })
              adopted(asset)
              if (visible(state, section)) await refresh()
            } catch (error) { alert.textContent = error.message; button.disabled = false }
          })
          section.append(label, button)
        }
        return section
      }))
    }

    async function change(suffix, value) {
      try { await api(path + suffix, 'POST', value); await refresh() }
      catch (error) { alert.textContent = error.message }
    }
    show(first)
  }

  return { open }
}
