import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { page, userEvent } from 'vitest/browser'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { CharacterContinuityTimeline, ContinuityNode, ContinuityProvenance } from '../../../../shared/character-continuity'
import type { PendingFinalizedCharacterStateCandidate } from '../../../../shared/finalized-continuity'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { EMPTY_CARD, useCharacterStore, type CharacterCard } from '../../../../stores/character-store'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { CHARACTER_DRAFT_TAB } from '../../../../stores/project-editor-draft-ledger'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import StageCharacters from '../StageCharacters'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/rain-train', leaseId: '本次打开' }
const card = (characterId: string, name: string, role: CharacterCard['role'] = 'supporting'): CharacterCard =>
  ({ ...EMPTY_CARD, characterId, name, role })
const linzhou = card('c-linzhou', '林舟', 'protagonist')
const shenyan = card('c-shenyan', '沈砚')
const stateCandidate = (key: string, field: PendingFinalizedCharacterStateCandidate['field'], value: string): PendingFinalizedCharacterStateCandidate => ({
  candidateKey: key, characterId: linzhou.characterId!, characterName: '林舟', displayName: '林舟', selectionKey: `state:${key}`,
  field, value, reason: 'author-protected', expectedFieldRevision: 3, expectedFieldValueHash: 'b'.repeat(64),
  source: { draftId: 7, finalizationId: 'final-7', chapterNumber: 7, contentHash: 'c'.repeat(64) },
})

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const realSaveAll = useCharacterStore.getState().saveAll
const realDeleteCharacter = useCharacterStore.getState().deleteCharacter
const restores = [useProjectStore, useWorkflowStore, useStageStore, useLocaleStore, useEditorStore, useCharacterStore, useLLMStore]
  .map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
let pendingStates: PendingFinalizedCharacterStateCandidate[]
let pendingDecisions: number
let timeline: CharacterContinuityTimeline | Error
let store: {
  saveAll: ReturnType<typeof vi.fn>
  deleteCharacter: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
}

const button = (name: string | RegExp) => [...document.querySelectorAll('button')]
  .find(candidate => typeof name === 'string'
    ? candidate.textContent === name || candidate.getAttribute('aria-label') === name
    : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = button(name)
  expect(target, String(name)).toBeTruthy()
  await act(async () => target!.click())
}
const banner = () => host!.querySelector('[aria-label="待处理的角色建议"]')
/** 纸墨对话框标题下的说明，也是对话框的无障碍描述。 */
const dialogDescription = () => {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  return dialog ? document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent ?? null : null
}
/** 外发确认这一步作者读到的全文：发什么、发给哪个模型与端点、确认前不写名单。 */
const fixtureConsent = [
  '本次粘贴及选中文件的全部文本将发送到以下模型端点，用于提取角色卡。提取后需预览并确认，才会写入角色名单；不会直接覆盖角色名单。',
  '',
  '模型：夹具模型 (fixture-1)',
  '端点：https://fixture.example/v1',
  '',
  '是否发送并提取？',
].join('\n')

async function render() {
  await act(async () => root!.render(<StageCharacters projectKey={session.projectPath} />))
}

beforeEach(async () => {
  // 宿主 1200 宽；视口比它窄时焦点移到屏外按钮会滚动页面，滚动事件晚一帧到达时会关掉刚打开的菜单。
  await page.viewport(1280, 960)
  pendingStates = []
  pendingDecisions = 0
  timeline = { nodes: [], chapterRange: { next: 1, last: 1 } }
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:character-continuity-timeline') {
      if (timeline instanceof Error) throw timeline
      return timeline
    }
    if (channel === 'character-proposal:list-pending-finalized') return Array.from({ length: pendingDecisions }, (_, index) =>
      ({ proposalBatchId: `cpb-${index}`, revision: 1, finalizationId: `final-${index}` }))
    if (channel === 'finalized-character:list-state-candidates') return pendingStates.map(candidate => ({
      draftId: 7, candidateKey: candidate.candidateKey, finalizationId: 'final-7',
      characterId: candidate.characterId, characterName: candidate.characterName, field: candidate.field }))
    if (channel === 'finalized-character:read-state-candidate') {
      const { candidateKey } = args[0] as { candidateKey: string }
      return pendingStates.find(candidate => candidate.candidateKey === candidateKey)
    }
    if (channel === 'finalized-character:decide-state-candidate') {
      const { candidateKey } = args[0] as { candidateKey: string }
      pendingStates = pendingStates.filter(candidate => candidate.candidateKey !== candidateKey)
      return { candidateKey, operationId: 'decision', payloadHash: 'd'.repeat(64), decision: 'accept', idempotent: false }
    }
    if (channel === 'character-avatar:read-batch') return { success: true, avatars: [] }
    if (channel === 'db:project-core-get') return null
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, globalLogs: [] })
  useLocaleStore.setState({ locale: 'zh-CN' })
  store = {
    saveAll: vi.fn(async () => undefined),
    deleteCharacter: vi.fn(async () => true),
    load: vi.fn(async () => undefined),
  }
  useCharacterStore.setState({
    characters: [linzhou, shenyan], dataProjectKey: session.projectPath, dataProjectSession: session, loadingProjectKey: null, lastError: null,
    identityBusy: false, saving: false, selectedId: linzhou.characterId, rosterRevision: 1, ...store,
  } as never)
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 900px; display: flex'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

describe('角色名单', () => {
  it.each([
    { cast: [linzhou], count: '1 character · page 1 / 1' },
    { cast: [linzhou, shenyan], count: '2 characters · page 1 / 1' },
  ])('英文名单底栏按人数用单复数，悬停能看到完整的人数与页码：$count', async ({ cast, count }) => {
    useLocaleStore.setState({ locale: 'en-US' })
    useCharacterStore.setState({ characters: cast })
    await render()
    const foot = host!.querySelector<HTMLElement>('.cast-roster-foot span')!
    expect([foot.textContent, foot.title]).toEqual([count, count])
  })

  it('英文名单页两个按钮不重叠，底栏人数与页码不折行', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    useCharacterStore.setState({ characters: [linzhou] })
    await render()
    const [add, paste] = [...host!.querySelectorAll<HTMLElement>('.cast-roster-actions .pi-btn')]
    const a = add.getBoundingClientRect()
    const b = paste.getBoundingClientRect()
    const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    const clipped = [add, paste].filter(button => button.scrollWidth > button.clientWidth + 1).map(button => button.textContent)
    const foot = host!.querySelector<HTMLElement>('.cast-roster-foot span')!
    const lines = Math.round(foot.getBoundingClientRect().height / parseFloat(getComputedStyle(foot).lineHeight))
    const footClipped = foot.scrollWidth > foot.clientWidth + 1
    expect({ overlap, clipped, lines, footClipped }).toEqual({ overlap: false, clipped: [], lines: 1, footClipped: false })
  })

  // 740 与 994 是 1024、1280 宽窗口里角色名单页实测的宽度，600 是 1280 宽窗口开着运行侧页时的宽度（#465）。
  const fitCases = (['en-US', 'zh-CN'] as const).flatMap(locale => [600, 740, 994].map(width => ({ locale, width })))
  it.each(fitCases)('$locale 界面、名单页 $width 宽：按钮不超出名单栏，定位下拉框放得下每个选项，档案首行的输入框都留得出写字的地方', async ({ locale, width }) => {
    useLocaleStore.setState({ locale })
    useCharacterStore.setState({ characters: [linzhou] })
    host!.style.width = `${width}px`
    await render()
    const roster = host!.querySelector('.cast-roster')!.getBoundingClientRect()
    const overflowing = [...host!.querySelectorAll<HTMLElement>('.cast-roster-actions .pi-btn')]
      .filter(button => button.getBoundingClientRect().right > roster.right)
      .map(button => button.textContent)
    // 原生下拉框的箭头画在内容区里：同样样式、只含这一个选项、按内容取宽的副本有多宽，选中它时就要多宽才放得下。
    const select = host!.querySelector<HTMLSelectElement>('.cast-select')!
    const clippedRoles = [...select.options].filter(option => {
      const probe = select.cloneNode(false) as HTMLSelectElement
      probe.append(option.cloneNode(true))
      probe.style.cssText = 'position: absolute; visibility: hidden; width: auto; min-width: 0'
      select.parentElement!.append(probe)
      const needed = probe.getBoundingClientRect().width
      probe.remove()
      return needed > select.getBoundingClientRect().width
    }).map(option => option.textContent)
    // 至少放得下三个汉字。
    const crampedInputs = [...host!.querySelectorAll<HTMLInputElement>('.cast-row-fields input')].filter(input => {
      const style = getComputedStyle(input)
      return input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) < 3 * parseFloat(style.fontSize)
    }).map(input => input.closest('.cast-field')?.querySelector('label')?.textContent)
    expect({ overflowing, clippedRoles, crampedInputs }).toEqual({ overflowing: [], clippedRoles: [], crampedInputs: [] })
  })

  it('名单列出全部角色，改动后保存角色走名单的保存', async () => {
    await render()
    const rows = [...host!.querySelectorAll('.cast-row')].map(row => row.querySelector('.cast-row-name')?.textContent)
    expect(rows).toEqual(['林舟', '沈砚'])
    expect(host!.querySelector('.cast-profile-name')?.textContent).toBe('林舟')

    const motivation = [...host!.querySelectorAll('.cast-field')].find(field => field.textContent?.startsWith('动机'))!.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(motivation, '弄清母亲为什么登上那班车')
      motivation.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useCharacterStore.getState().characters[0].motivation).toBe('弄清母亲为什么登上那班车')

    expect(host!.querySelectorAll('.pi-btn--primary')).toHaveLength(1)
    await click('保存角色')
    expect(store.saveAll).toHaveBeenCalledWith(session.projectPath)
  })

  it('删除角色先出危险确认，取消不删；确认后删除选中的那位', async () => {
    await render()
    await click('角色的更多操作')
    await click('删除角色「林舟」…')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('删除角色「林舟」？')
    await click('取消')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(store.deleteCharacter).not.toHaveBeenCalled()

    await click('角色的更多操作')
    await click('删除角色「林舟」…')
    await click('删除角色')
    await vi.waitFor(() => expect(store.deleteCharacter).toHaveBeenCalledWith(linzhou.characterId, session.projectPath))
  })

  it('角色决策与状态建议合成一条提示条，接受一条后它从提示条消失并重读名单', async () => {
    pendingDecisions = 1
    pendingStates = [stateCandidate('s-location', 'location', '北塔'), stateCandidate('s-items', 'keyItems', '第三封信')]
    await render()
    await vi.waitFor(() => expect(banner()?.textContent).toContain('3 项待处理的角色建议'))
    expect(host!.querySelectorAll('.cast-suggestions')).toHaveLength(1)
    expect(host!.querySelectorAll('.cast-suggestion[data-kind="decision"]')).toHaveLength(1)
    expect(host!.querySelectorAll('.cast-suggestion[data-kind="state"]')).toHaveLength(2)

    const review = [...host!.querySelectorAll('.cast-suggestion[data-kind="state"]')]
      .find(row => row.textContent?.includes('位置'))!.querySelector('button')!
    await act(async () => review.click())
    await vi.waitFor(() => expect(banner()?.textContent).toContain('建议：北塔'))
    await click('接受状态建议')

    await vi.waitFor(() => expect(banner()?.textContent).toContain('2 项待处理的角色建议'))
    expect(store.load).toHaveBeenCalled()
    expect(invoke.mock.calls.find(([channel]) => channel === 'finalized-character:decide-state-candidate')?.[1])
      .toMatchObject({ candidateKey: 's-location', decision: 'accept' })
    expect(banner()?.textContent).not.toContain('位置')
    expect(banner()?.textContent).toContain('关键物品')
  })

  /** Electron 把主进程的异常包成这样交给页面。 */
  const ipcError = (channel: string) => new Error(`Error invoking remote method '${channel}': Error: 项目会话已失效`)

  it('两份待处理列表都读取失败：标题写读取失败，说明可以重新读取，不露原始报错', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'character-proposal:list-pending-finalized' || channel === 'finalized-character:list-state-candidates'
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.querySelector('.pi-notice-title')?.textContent).toBe('角色建议读取失败'))
    expect(banner()!.querySelector('.pi-notice-text')?.textContent).toBe('定稿与导入留下的角色建议这次没读出来，可以重新读取。')
    expect([...banner()!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['重新读取'])
    expect(banner()!.textContent).not.toContain('Error invoking remote method')
    expect(banner()!.textContent).not.toContain('项目会话已失效')
  })

  it('已有待处理的建议、另一份列表读取失败：提示条照常列出，失败的部分用一句话说明并给「重新读取」，不露原始报错', async () => {
    pendingDecisions = 1
    const base = invoke.getMockImplementation()!
    let failing = true
    invoke.mockImplementation(async (channel, ...args) => failing && channel === 'finalized-character:list-state-candidates'
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.querySelector('[role="alert"]')?.textContent).toBe('有一部分角色建议这次没读出来或没处理完，可以重新读取。重新读取'))
    expect(banner()!.querySelector('.pi-notice-title')?.textContent).toBe('1 项待处理的角色建议')
    expect(banner()!.textContent).not.toContain('Error invoking remote method')
    failing = false
    await act(async () => banner()!.querySelector<HTMLButtonElement>('[role="alert"] button')!.click())
    await vi.waitFor(() => expect(banner()!.querySelector('[role="alert"]')).toBeNull())
    expect(banner()!.querySelector('.pi-notice-title')?.textContent).toBe('1 项待处理的角色建议')
  })

  it('部分建议读取失败时提示条用提醒色；收起列表后失败说明与「重新读取」仍然看得到', async () => {
    pendingDecisions = 1
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'finalized-character:list-state-candidates'
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.querySelector('[role="alert"]')).toBeTruthy())
    expect(banner()!.querySelector('.pi-notice')?.getAttribute('data-tone')).toBe('warn')
    await click('收起')
    expect(banner()!.querySelector('.cast-suggestion-list')).toBeNull()
    const alert = banner()!.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toBe('有一部分角色建议这次没读出来或没处理完，可以重新读取。重新读取')
    expect(alert!.getBoundingClientRect().height).toBeGreaterThan(0)
  })

  it('接受状态建议已提交、随后刷新状态建议列表失败：只说这次没读出来、可以重新读取，不说名单没改', async () => {
    pendingDecisions = 1
    pendingStates = [stateCandidate('s-location', 'location', '北塔')]
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'finalized-character:list-state-candidates'
      && invoke.mock.calls.some(([called]) => called === 'finalized-character:decide-state-candidate')
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.textContent).toContain('2 项待处理的角色建议'))
    await click('检查定稿状态建议')
    await vi.waitFor(() => expect(banner()?.textContent).toContain('建议：北塔'))
    await click('接受状态建议')
    await vi.waitFor(() => expect(banner()?.querySelector('[role="alert"]')?.textContent).toBe('有一部分角色建议这次没读出来或没处理完，可以重新读取。重新读取'))
    expect(store.load).toHaveBeenCalled()
  })

  it('接受最后一条状态建议后名单重读、角色决策列表随之读取失败：标题写读取失败，说明只说可以重新读取', async () => {
    pendingStates = [stateCandidate('s-location', 'location', '北塔')]
    store.load.mockImplementation(async () => { useCharacterStore.setState({ rosterRevision: 2 }) })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'character-proposal:list-pending-finalized'
      && invoke.mock.calls.some(([called]) => called === 'finalized-character:decide-state-candidate')
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.textContent).toContain('1 项待处理的角色建议'))
    await click('检查定稿状态建议')
    await vi.waitFor(() => expect(banner()?.textContent).toContain('建议：北塔'))
    await click('接受状态建议')
    await vi.waitFor(() => expect(banner()?.querySelector('.pi-notice-title')?.textContent).toBe('角色建议读取失败'))
    expect(banner()!.querySelector('.pi-notice-text')?.textContent).toBe('定稿与导入留下的角色建议这次没读出来，可以重新读取。')
  })

  it('读取失败后点「重新读取」重读两份列表，读到就换成待处理的建议', async () => {
    pendingDecisions = 1
    const base = invoke.getMockImplementation()!
    let failing = true
    invoke.mockImplementation(async (channel, ...args) => failing && (channel === 'character-proposal:list-pending-finalized' || channel === 'finalized-character:list-state-candidates')
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.querySelector('.pi-notice-title')?.textContent).toBe('角色建议读取失败'))
    failing = false
    const retry = [...banner()!.querySelectorAll('button')].find(button => button.textContent === '重新读取')
    expect(retry, '重新读取按钮').toBeTruthy()
    await act(async () => retry!.click())
    await vi.waitFor(() => expect(banner()!.querySelector('.pi-notice-title')?.textContent).toBe('1 项待处理的角色建议'))
    expect(banner()!.querySelectorAll('[role="alert"]')).toHaveLength(0)
  })

  it('导入留下的角色决策按来源写成作者看得懂的标题，不露操作号', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'character-proposal:list-pending-finalized' ? [
      { proposalBatchId: 'cpb-author', revision: 1, importOperationId: 'novel-import-global-作者运行', importPurpose: 'author-manuscript', itemCount: 3 },
      { proposalBatchId: 'cpb-reference', revision: 1, importOperationId: 'novel-import-global-参考运行', importPurpose: 'reference', itemCount: 1 },
      { proposalBatchId: 'cpb-legacy', revision: 1, importOperationId: 'novel-import-global-旧运行', itemCount: 2 },
    ] : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.textContent).toContain('3 项待处理的角色建议'))
    const titles = [...banner()!.querySelectorAll('.cast-suggestion-text')].map(item => item.textContent)
    expect(titles).toEqual(['从导入原稿反推的角色（3 位）', '从参考小说反推的角色（1 位）', '导入时反推的角色（2 位）'])
    expect(banner()!.textContent).not.toContain('novel-import-global')
  })

  it('英文界面的导入角色决策标题按人数用单复数', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'character-proposal:list-pending-finalized' ? [
      { proposalBatchId: 'cpb-author', revision: 1, importOperationId: 'novel-import-global-作者运行', importPurpose: 'author-manuscript', itemCount: 1 },
      { proposalBatchId: 'cpb-reference', revision: 1, importOperationId: 'novel-import-global-参考运行', importPurpose: 'reference', itemCount: 2 },
    ] : base(channel, ...args))
    await render()
    const english = () => host!.querySelector('[aria-label="Pending character suggestions"]')
    await vi.waitFor(() => expect(english()?.querySelectorAll('.cast-suggestion-text')).toHaveLength(2))
    expect([...english()!.querySelectorAll('.cast-suggestion-text')].map(item => item.textContent)).toEqual([
      '1 character inferred from your manuscript', '2 characters inferred from the reference novel',
    ])
  })

  it('没有待处理的建议时不显示提示条', async () => {
    await render()
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'finalized-character:list-state-candidates')).toBe(true))
    expect(banner()).toBeNull()
  })

  it('导入角色卡用纸墨对话框，外发确认是同一对话框的第二步，不弹旧确认框', async () => {
    useLLMStore.setState({ models: [{ id: 'm1', name: '夹具模型', modelName: 'fixture-1', baseUrl: 'https://fixture.example/v1', purposes: ['generation'] }], defaultModelId: 'm1' } as never)
    const legacyConfirm = vi.spyOn(window, 'confirm')
    await render()
    await click('粘贴 / 导入角色卡')
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog().classList.contains('pi-dialog')).toBe(true)
    expect(dialog().closest('.paper-ink')).toBeTruthy()
    const source = dialog().querySelector<HTMLTextAreaElement>('textarea')!
    expect(source.classList.contains('pi-input')).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(source, '林舟：末班车上的乘客。')
      source.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('AI 提取并预览')
    expect(dialogDescription()).toBe(fixtureConsent)
    expect(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).toHaveLength(1)
    await click('返回')
    expect(dialog().querySelector('textarea')?.value).toBe('林舟：末班车上的乘客。')
    expect(legacyConfirm).not.toHaveBeenCalled()
  })

  it('粘贴角色卡的全文框按 9 行高显示，不被单行输入框的高度压成一行', async () => {
    await render()
    await click('粘贴 / 导入角色卡')
    const source = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
    const line = parseFloat(getComputedStyle(source).lineHeight)
    expect(source.rows).toBe(9)
    expect(source.getBoundingClientRect().height).toBeGreaterThanOrEqual(line * 9)
  })

  it('头像按钮只在基础设定视图里；当前状态与关系图谱视图没有点了没反应的头像按钮', async () => {
    await render()
    expect(button('选择头像')).toBeTruthy()
    for (const view of ['当前状态', '关系图谱']) {
      await click(view)
      expect(button('选择头像'), view).toBeUndefined()
    }
    await click('基础设定')
    expect(button('选择头像')).toBeTruthy()
  })

  // 角色名单页宽：1024 宽窗口约 738px，1280 宽约 994px（窗口宽减去流程脊与边距）。
  const profileHeadCases = (['zh-CN', 'en-US'] as const).flatMap(locale => ([[1024, 738], [1280, 994]] as const)
    .flatMap(([windowWidth, pageWidth]) => [
      { locale, windowWidth, pageWidth, name: '林舟', expected: { clipped: false, wrapped: false } },
      { locale, windowWidth, pageWidth, name: '林舟远赴北境寻找失踪灯塔的守灯人', expected: { wrapped: true } },
    ]))
  it.each(profileHeadCases)('档案头按内容换行：$windowWidth 宽、$locale、名字「$name」', async ({ locale, pageWidth, name, expected }) => {
    useLocaleStore.setState({ locale })
    useCharacterStore.setState({ characters: [{ ...linzhou, name }, shenyan] } as never)
    host!.style.width = `${pageWidth}px`
    await render()
    const title = host!.querySelector<HTMLElement>('.cast-profile-name')!
    const save = button(locale === 'en-US' ? 'Save character' : '保存角色')!
    const [titleBox, saveBox] = [title.getBoundingClientRect(), save.getBoundingClientRect()]
    const avatarBox = host!.querySelector<HTMLElement>('.cast-profile-avatar')!.getBoundingClientRect()
    const overlap = titleBox.left < saveBox.right && saveBox.left < titleBox.right && titleBox.top < saveBox.bottom && saveBox.top < titleBox.bottom
    const observed = { clipped: title.scrollWidth > title.clientWidth + 1, wrapped: saveBox.top >= titleBox.bottom }
    // 名字总和头像在同一行，不会自己掉到头像下面。
    const besideAvatar = titleBox.top < avatarBox.bottom && titleBox.left >= avatarBox.right
    expect({ text: title.textContent, overlap, besideAvatar, ...('clipped' in expected ? observed : { wrapped: observed.wrapped }) })
      .toEqual({ text: name, overlap: false, besideAvatar: true, ...expected })
  })

  it.each(['zh-CN', 'en-US'] as const)('没有选中角色时的档案头没有头像，标题不按头像扣宽度（%s）', async locale => {
    useLocaleStore.setState({ locale })
    useCharacterStore.setState({ characters: [], selectedId: null } as never)
    host!.style.width = '600px'
    await render()
    const title = host!.querySelector<HTMLElement>('.cast-profile-name')!
    expect({ avatar: host!.querySelector('.cast-profile-avatar'), text: title.textContent, clipped: title.scrollWidth > title.clientWidth + 1 })
      .toEqual({ avatar: null, text: locale === 'en-US' ? 'Character profile' : '角色档案', clipped: false })
  })

  it('1024 宽窗口里的关系图谱：工具条与人物侧栏的控件都在图谱框里、点得到；宽时显示中心人物', async () => {
    // 1024 宽窗口去掉流程脊与边距，角色名单页约 738px：名单 272，档案两侧各留 40，图谱框只剩约 385。
    host!.style.width = '738px'
    await render()
    await click('关系图谱')
    const graph = host!.querySelector<HTMLElement>('.cast-graph')!
    const controls = ['缩小关系图谱', '放大关系图谱', '适合视图', '重置图谱布局', '折叠人物侧栏', '搜索图谱人物', '下一页人物']
    // 只看名单页自己的层：被裁掉的控件在那个点上不会出现，被页内元素盖住时最上面的是别人。别的用例留下的全局通知不算。
    const unreachable = () => controls.filter(label => {
      const control = graph.querySelector<HTMLElement>(`[aria-label="${label}"]`)
      if (!control) return true
      const rect = control.getBoundingClientRect()
      const hit = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2).find(element => host!.contains(element))
      return !hit || !control.contains(hit)
    })
    await vi.waitFor(() => expect(unreachable()).toEqual([]))

    host!.style.width = '1200px'
    await vi.waitFor(() => {
      const centerLabel = [...graph.querySelectorAll<HTMLElement>('span')].find(span => span.textContent === '中心: 林舟')
      expect(centerLabel, '中心人物').toBeTruthy()
      expect(getComputedStyle(centerLabel!).display).not.toBe('none')
    })
    expect(unreachable()).toEqual([])
  })

  it('外发确认不能被第一步按钮上的双击或连按回车跳过，只有在第二步单独确认才发送', async () => {
    useLLMStore.setState({ models: [{ id: 'm1', name: '夹具模型', modelName: 'fixture-1', baseUrl: 'https://fixture.example/v1', purposes: ['generation'] }], defaultModelId: 'm1' } as never)
    const startWorkflow = vi.fn(async () => 'r1')
    useWorkflowStore.setState({ startWorkflow: startWorkflow as never })
    await render()
    await click('粘贴 / 导入角色卡')
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
    const source = dialog().querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(source, '林舟：末班车上的乘客。')
      source.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const consentShown = () => dialogDescription() === fixtureConsent

    await userEvent.dblClick(button('AI 提取并预览')!)
    await vi.waitFor(() => expect(consentShown()).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(startWorkflow).not.toHaveBeenCalled()

    await click('返回')
    button('AI 提取并预览')!.focus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(consentShown()).toBe(true))
    expect(document.activeElement?.textContent).toBe('返回')
    await userEvent.keyboard('{Enter}')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(startWorkflow).not.toHaveBeenCalled()
    expect(consentShown()).toBe(false)

    await click('AI 提取并预览')
    await click('发送并提取')
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledTimes(1))
  })
})

describe('角色时间线', () => {
  const author: ContinuityProvenance = { kind: 'author', operationId: '保存' }
  const derived: ContinuityProvenance = { kind: 'derived', source: { finalizationId: '定稿七', draftId: 7, chapterNumber: 7, contentHash: 'c'.repeat(64) } as never }
  let order = 0
  const base = (value: string, effectiveChapter: number, provenance: ContinuityProvenance) => {
    order += 1
    return { eventId: `e${order}`, subjectId: linzhou.characterId!, subjectName: '林舟', value, effectiveChapter, provenance, draftId: null, seq: order, quote: null }
  }
  const stateNode = (value: string, chapter: number, provenance: ContinuityProvenance = author, quote: string | null = null): ContinuityNode =>
    ({ ...base(value, chapter, provenance), aspect: 'location', quote: quote === null ? null : { start: 0, end: quote.length, text: quote } })
  const relationNode = (value: string, chapter: number, relationshipId = 'r1'): ContinuityNode =>
    ({ ...base(value, chapter, author), aspect: 'relation', targetId: shenyan.characterId!, targetName: '沈砚', relationshipId })
  const openState = async () => { await render(); await click('当前状态') }
  const section = () => host!.querySelector<HTMLDetailsElement>('.cast-timeline')
  const expand = async () => {
    const summary = section()!.querySelector<HTMLElement>('summary')!
    await act(async () => summary.click())
  }
  const chapters = () => [...host!.querySelectorAll('.cast-timeline-chapter')].map(group => group.querySelector('h3')!.textContent)
  const rowText = () => [...host!.querySelectorAll('.cast-timeline-row')].map(row => row.textContent)

  it('默认收起成一行摘要，展开后按章倒序，写明字段、值和来历', async () => {
    timeline = { nodes: [stateNode('北塔', 3), stateNode('旧站', 7, derived, '他走回旧站。')], chapterRange: { next: 8, last: 20 } }
    await openState()
    expect(section()!.open).toBe(false)
    expect(section()!.querySelector('summary')!.textContent).toBe('时间线 · 2 处变化')
    await expand()
    expect(section()!.open).toBe(true)
    expect(chapters()).toEqual(['第 7 章', '第 3 章'])
    expect(rowText()[0]).toContain('当前位置/阵营')
    expect(rowText()[0]).toContain('旧站')
    expect(rowText()[0]).toContain('定稿记录')
    expect(rowText()[1]).toContain('作者设定')
  })

  it('定稿记录可以看原文证据，作者设定没有原文入口', async () => {
    timeline = { nodes: [stateNode('旧站', 7, derived, '他走回旧站。'), stateNode('北塔', 3)], chapterRange: { next: 8, last: 20 } }
    await openState()
    await expand()
    const [finalized, authored] = [...host!.querySelectorAll('.cast-timeline-row')]
    expect(authored.querySelector('.cast-timeline-quote')).toBeNull()
    const quote = finalized.querySelector<HTMLDetailsElement>('.cast-timeline-quote')!
    expect(quote.open).toBe(false)
    await act(async () => quote.querySelector('summary')!.click())
    expect(quote.open).toBe(true)
    expect(quote.textContent).toContain('他走回旧站。')
  })

  it('解除关系写成解除并带出原来的关系，同一对角色多条都在', async () => {
    timeline = { nodes: [relationNode('盟友', 2, 'r1'), relationNode('同门', 2, 'r2'), relationNode('', 6, 'r1')], chapterRange: { next: 7, last: 20 } }
    await openState()
    await expand()
    expect(chapters()).toEqual(['第 6 章', '第 2 章'])
    expect(rowText()[0]).toContain('沈砚')
    expect(rowText()[0]).toContain('解除「盟友」')
    expect(rowText().slice(1).join()).toContain('盟友')
    expect(rowText().slice(1).join()).toContain('同门')
  })

  it('升级前已有的节点写明之前的变化没有记录，只写一次', async () => {
    const legacy: ContinuityProvenance = { kind: 'legacy' }
    timeline = { nodes: [stateNode('旧站', 5, legacy), relationNode('盟友', 5)].map((node, index) => index ? { ...node, provenance: legacy } : node), chapterRange: { next: 6, last: 6 } }
    await openState()
    await expand()
    expect(rowText()[0]).toContain('升级前已有')
    expect(section()!.textContent!.match(/升级前的变化没有记录/gu)).toHaveLength(1)
  })

  it('没有节点时只有一行说明，档案其余照常', async () => {
    await openState()
    expect(section()).toBeNull()
    expect(host!.querySelector('.cast-timeline-empty')!.textContent).toBe('时间线 · 还没有逐章记录')
    expect(host!.querySelectorAll('.cast-grid textarea')).toHaveLength(6)
  })

  it('读取失败时只有一行说明，不挡档案', async () => {
    timeline = new Error('读不出来')
    await openState()
    expect(host!.querySelector('[role="alert"]')).toBeNull()
    expect(host!.querySelector('.cast-timeline-empty')!.textContent).toBe('时间线暂时读不出来')
    expect(host!.querySelectorAll('.cast-grid textarea')).toHaveLength(6)
  })

  it('200 条展开后在自己的区域里滚动，不把字段推出版面', async () => {
    timeline = { nodes: Array.from({ length: 200 }, (_, index) => stateNode(`地点${index}`.repeat(index % 7 + 1), index + 1)), chapterRange: { next: 201, last: 201 } }
    await openState()
    await expand()
    const list = host!.querySelector<HTMLElement>('.cast-timeline-list')!
    expect(chapters()).toHaveLength(200)
    expect(list.getBoundingClientRect().height).toBeLessThanOrEqual(400)
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight)
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth)
  })

  it('英文界面的摘要、章号、来历与解除都是英文', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    timeline = { nodes: [relationNode('盟友', 2), relationNode('', 6)], chapterRange: { next: 7, last: 20 } }
    await render()
    await click('Current state')
    expect(section()!.querySelector('summary')!.textContent).toBe('Timeline · 2 changes')
    await expand()
    expect(chapters()).toEqual(['Chapter 6', 'Chapter 2'])
    expect(rowText()[0]).toContain('Ended: 盟友')
    expect(rowText()[0]).toContain('Set by author')
  })

  const typeLocation = async () => {
    const field = host!.querySelector<HTMLTextAreaElement>('.cast-grid textarea')!
    await userEvent.fill(field, '新地点')
  }
  const note = () => host!.querySelector('.cast-state-chapter')

  it('没改状态时不出现生效章说明；改了以后默认下一章起，不弹窗', async () => {
    timeline = { nodes: [], chapterRange: { next: 8, last: 20 } }
    await openState()
    expect(note()).toBeNull()
    await typeLocation()
    expect(note()!.textContent).toContain('手改的状态从第 8 章起生效')
    expect(host!.querySelector('.cast-state-chapter input')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it.each([
    ['zh-CN', '当前状态', '手改的状态从第 8 章起生效，早于已有记录时顺延'],
    ['en-US', 'Current state', 'Hand edits to state apply from chapter 8, or later if that field already has a later record'],
  ] as const)('说明条写明可能顺延：%s', async (locale, viewName, copy) => {
    useLocaleStore.setState({ locale })
    timeline = { nodes: [], chapterRange: { next: 8, last: 20 } }
    await render()
    await click(viewName)
    await typeLocation()
    expect(note()!.querySelector('span')!.textContent).toBe(copy)
  })

  it.each([
    ['基线', { baseValue: '损坏', draftValue: [linzhou] }],
    ['草稿', { baseValue: [linzhou], draftValue: { 损坏: true } }],
  ])('账本里的%s不是角色数组：档案页照常显示，不出现章号说明', async (_, values) => {
    useEditorStore.setState({
      draftLedgers: {
        [CHARACTER_DRAFT_TAB.id]: JSON.stringify({ version: 1, projects: [{ projectKey: session.projectPath, ...values }] }),
      },
    })
    await openState()
    expect(host!.querySelector('.cast-grid textarea')).not.toBeNull()
    expect(note()).toBeNull()
  })

  it('点开才能改章号，保存时带上所选章号', async () => {
    useCharacterStore.setState({ saveAll: realSaveAll } as never)
    const commit = vi.fn(async () => ({ success: false, error: '夹具不提交' }))
    const passthrough = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'db:character-roster-commit' ? commit(...args as []) : passthrough(channel, ...args))
    timeline = { nodes: [], chapterRange: { next: 8, last: 20 } }
    await openState()
    await typeLocation()
    await click('改章号')
    await userEvent.fill(host!.querySelector<HTMLInputElement>('.cast-state-chapter input')!, '12')
    expect(note()!.textContent).toContain('手改的状态从第 12 章起生效')
    await click('保存角色')
    await vi.waitFor(() => expect(commit).toHaveBeenCalled())
    expect((commit.mock.calls[0] as unknown[])[0]).toMatchObject({ stateEffectiveChapter: 12 })
  })

  it('章号超出范围：不报错，如实写按默认章算，保存不带这个章号', async () => {
    useCharacterStore.setState({ saveAll: realSaveAll } as never)
    const commit = vi.fn(async () => ({ success: false, error: '夹具不提交' }))
    const passthrough = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'db:character-roster-commit' ? commit(...args as []) : passthrough(channel, ...args))
    timeline = { nodes: [], chapterRange: { next: 8, last: 20 } }
    await openState()
    await typeLocation()
    await click('改章号')
    await userEvent.fill(host!.querySelector<HTMLInputElement>('.cast-state-chapter input')!, '99')
    expect(note()!.textContent).toContain('手改的状态从第 8 章起生效')
    expect(note()!.textContent).toContain('第 99 章不在 1–20 章内')
    await click('保存角色')
    await vi.waitFor(() => expect(commit).toHaveBeenCalled())
    expect((commit.mock.calls[0] as unknown[])[0]).not.toHaveProperty('stateEffectiveChapter')
  })

  describe('显示的生效章就是保存的生效章', () => {
    const stubCommit = (gate?: Promise<void>) => {
      useCharacterStore.setState({ saveAll: realSaveAll } as never)
      const commit = vi.fn(async (request: { entries: unknown[]; stateEffectiveChapter?: number }) => {
        await gate
        return { success: true, receipt: { revision: 2, created: [], snapshot: { entries: request.entries, identityRevision: 2 } } }
      })
      const passthrough = invoke.getMockImplementation()!
      invoke.mockImplementation(async (channel, ...args) => channel === 'db:character-roster-commit'
        ? commit(args[0] as { entries: unknown[] }) : passthrough(channel, ...args))
      timeline = { nodes: [], chapterRange: { next: 8, last: 20 } }
      return commit
    }
    const chapterInput = () => host!.querySelector<HTMLInputElement>('.cast-state-chapter input')!
    const chooseChapter12 = async () => {
      await click('改章号')
      await userEvent.fill(chapterInput(), '12')
    }
    const savedChapter = (commit: ReturnType<typeof stubCommit>, call: number) => commit.mock.calls[call][0].stateEffectiveChapter

    it('选了章号又放弃改动，再改状态时显示和保存都是默认章', async () => {
      const commit = stubCommit()
      await openState()
      await typeLocation()
      await chooseChapter12()
      await act(async () => useCharacterStore.getState().discardDraft(session.projectPath, session))
      expect(note()).toBeNull()
      await typeLocation()
      expect(note()!.textContent).toContain('手改的状态从第 8 章起生效')
      await click('保存角色')
      await vi.waitFor(() => expect(commit).toHaveBeenCalled())
      expect(savedChapter(commit, 0)).toBeUndefined()
    })

    it('选了章号又切走视图，回来时显示和保存都是默认章', async () => {
      const commit = stubCommit()
      await openState()
      await typeLocation()
      await chooseChapter12()
      await click('基础设定')
      await click('当前状态')
      expect(note()!.textContent).toContain('手改的状态从第 8 章起生效')
      await click('保存角色')
      await vi.waitFor(() => expect(commit).toHaveBeenCalled())
      expect(savedChapter(commit, 0)).toBeUndefined()
    })

    it('保存进行中章号输入框不能改', async () => {
      stubCommit()
      await openState()
      await typeLocation()
      await chooseChapter12()
      expect(chapterInput().disabled).toBe(false)
      await act(async () => useCharacterStore.setState({ saving: true }))
      expect(chapterInput().disabled).toBe(true)
    })

    it('保存途中又改了状态：保存后说明条还写着所选章，下一次保存也按它', async () => {
      let release = () => {}
      const commit = stubCommit(new Promise<void>(resolve => { release = resolve }))
      await openState()
      await typeLocation()
      await chooseChapter12()
      await click('保存角色')
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
      await userEvent.fill(host!.querySelector<HTMLTextAreaElement>('.cast-grid textarea')!, '保存途中改的地点')
      await act(async () => release())
      await vi.waitFor(() => expect(useCharacterStore.getState().saving).toBe(false))
      expect(note()!.textContent).toContain('手改的状态从第 12 章起生效')
      await click('保存角色')
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2))
      expect(savedChapter(commit, 1)).toBe(12)
    })

    it('保存成功后说明条消失，之后再改状态回到默认章', async () => {
      const commit = stubCommit()
      await openState()
      await typeLocation()
      await chooseChapter12()
      await click('保存角色')
      await vi.waitFor(() => expect(note()).toBeNull())
      expect(savedChapter(commit, 0)).toBe(12)
      await userEvent.fill(host!.querySelector<HTMLTextAreaElement>('.cast-grid textarea')!, '再改一次')
      expect(note()!.textContent).toContain('手改的状态从第 8 章起生效')
      await click('保存角色')
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2))
      expect(savedChapter(commit, 1)).toBeUndefined()
    })

    it('只改名字不出现生效章说明，改了状态才出现', async () => {
      stubCommit()
      await render()
      await userEvent.fill(host!.querySelector<HTMLInputElement>('.cast-row-fields input')!, '林舟改名')
      await click('当前状态')
      expect(note()).toBeNull()
      await typeLocation()
      expect(note()!.textContent).toContain('手改的状态从第 8 章起生效')
    })

    it('退出前保存按说明条上的章号写入', async () => {
      const commit = stubCommit()
      await openState()
      await typeLocation()
      await chooseChapter12()
      await act(async () => saveDirtyEditorChangesForExit(session.projectPath))
      expect(savedChapter(commit, 0)).toBe(12)
    })

    it('林舟有待保存的状态，在沈砚的档案上选第 12 章再删除沈砚：删除保存按第 12 章写入', async () => {
      useCharacterStore.setState({ deleteCharacter: realDeleteCharacter } as never)
      const commit = stubCommit()
      await openState()
      await typeLocation()
      await click(/沈砚/)
      await vi.waitFor(() => expect(note()).not.toBeNull())
      await chooseChapter12()
      expect(note()!.textContent).toContain('手改的状态从第 12 章起生效')
      await click('角色的更多操作')
      await click('删除角色「沈砚」…')
      await click('删除角色')
      await vi.waitFor(() => expect(commit).toHaveBeenCalled())
      expect(commit.mock.calls[0][0].entries).toEqual([expect.objectContaining({ characterId: 'c-linzhou', currentState: expect.objectContaining({ location: '新地点' }) })])
      expect(savedChapter(commit, 0)).toBe(12)
    })

    it('选了章号后离开角色页，退出前保存仍按所选章号写入', async () => {
      const commit = stubCommit()
      await openState()
      await typeLocation()
      await chooseChapter12()
      await act(async () => root!.render(<div />))
      await act(async () => saveDirtyEditorChangesForExit(session.projectPath))
      expect(savedChapter(commit, 0)).toBe(12)
    })
  })
})
