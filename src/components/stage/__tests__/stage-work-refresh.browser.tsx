/* eslint-disable react-refresh/only-export-components */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { globalEventBus } from '../../../shared/event-bus'
import type { NovelConfig, ProjectData, ProjectSessionContext } from '../../../shared/ipc-channels'
import { PLOT_OUTLINE_PROTOCOL, renderPlotOutlineSynopsis } from '../../../shared/plot-outline-contract'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useDraftStore } from '../../../stores/draft-store'
import { useStageStore } from '../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../stores/project-store'
import StageSpine from '../StageSpine'
import { useStageView, useStageWorkRefresh } from '../use-stage-work'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PATH = 'C:\\novels\\recovery'
const TOTAL_CHAPTERS = 5
const CONFIG: Partial<NovelConfig> = { coreOutline: '雾钟每晚提前一刻响起。', genre: '悬疑', targetAudience: '成年读者', totalChapters: TOTAL_CHAPTERS, wordsPerChapter: 3000 }
const CURRENT: ProjectSessionContext = { projectId: 'recovery', leaseId: 'current', projectPath: PATH }
const PREVIOUS: ProjectSessionContext = { ...CURRENT, leaseId: 'previous' }

const LONG = '雾'.repeat(60)
const outlineBody = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index)
  .map(chapter => `## 第${chapter}章：第${chapter}盏灯\n林舟在第${chapter}站认出一位失踪者的座位。`).join('\n\n')
const COMPLETE_OUTLINE = renderPlotOutlineSynopsis(outlineBody(1, TOTAL_CHAPTERS), TOTAL_CHAPTERS, { totalChapters: TOTAL_CHAPTERS, writingLanguage: 'zh-CN' })
const HANDLE = { projectId: CURRENT.projectId, epoch: CURRENT.leaseId, rootActionId: '重写大纲', runId: '中断的一批' }

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [snapshot(useDraftStore), snapshot(useStageStore), snapshot(useProjectStore)]

let root: Root | undefined
let host: HTMLDivElement | undefined
let standing: 'open' | 'dismissed'

function Spine() {
  useStageWorkRefresh()
  const view = useStageView()
  const ignore = () => undefined
  return <StageSpine stages={view.stages} chapters={view.chapters} location={view.location} onStage={ignore} onChapter={ignore} onResource={ignore} onSettings={ignore} />
}

const architectureState = () => host!.querySelector<HTMLElement>('[data-stage="architecture"]')?.dataset.state
const elapse = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
async function expectArchitectureState(state: string) {
  await vi.waitFor(async () => {
    await elapse(20)
    expect(architectureState()).toBe(state)
  }, { timeout: 10_000 })
}

const announce = (projectSession: ProjectSessionContext) => act(async () => globalEventBus.emit('PLANNING_RECOVERY_CHANGED', { projectSession }))

beforeEach(async () => {
  standing = 'open'
  const invoke = async (channel: string) => {
    switch (channel) {
      case 'db:project-core-get': return { premise: LONG, worldbuilding: LONG, synopsis: COMPLETE_OUTLINE }
      case 'db:character-roster-read': return { status: 'ready' }
      case 'db:blueprint-get-all': return []
      case 'db:draft-list-all': return []
      case 'fs:read-json': return { success: true, data: { synopsis_protocol: PLOT_OUTLINE_PROTOCOL, synopsis_incomplete: true, synopsis_generation_handle: HANDLE } }
      case 'generation:read-context': return {
        handle: HANDLE,
        plotOutlineRecovery: { draft: outlineBody(3, 3), completeChapters: [3], writeState: { kind: 'ready' }, saved: null },
        planningDraft: { requestedRange: { from: 3, to: 5 }, createdAtMs: 1, standing },
        planningContinuation: { state: 'ready', remainingRange: { from: 4, to: 5 } },
      }
      default: throw new Error(`unexpected IPC ${channel}`)
    }
  }
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {}, once: () => {}, send: () => {} } })
  await act(async () => {
    setActiveProjectSessionContext(CURRENT)
    useStageStore.setState({ work: null, spineFacts: null })
    useDraftStore.setState({ draftsByChapter: {}, dataProjectSession: null, loading: false })
    useProjectStore.setState({ currentProject: { id: CURRENT.projectId, sessionLease: CURRENT.leaseId, name: '恢复稿', path: PATH, novelConfig: CONFIG } as unknown as ProjectData })
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Spine />))
  await expectArchitectureState('active')
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('放弃大纲恢复稿后流程脊的架构状态（#608）', () => {
  it('正式大纲已写满、只因恢复稿才未完成：放弃后流程脊立即标为完成', async () => {
    standing = 'dismissed'
    await announce(CURRENT)
    await expectArchitectureState('done')
  })

  it('上一次打开发出的事件不刷新；这次打开的事件才刷新', async () => {
    standing = 'dismissed'
    await announce(PREVIOUS)
    await elapse(300)
    expect(architectureState()).toBe('active')

    await announce(CURRENT)
    await expectArchitectureState('done')
  })
})
