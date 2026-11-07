export type NarrativeThreadStatus = 'planned' | 'planted' | 'progressing' | 'resolved' | 'abandoned'
export type NarrativeThreadEventType = Exclude<NarrativeThreadStatus, 'planned'>

export const DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD = 3
export const MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD = 1
export const MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD = 50

export function resolveNarrativeThreadDormantThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_NARRATIVE_THREAD_DORMANT_THRESHOLD
  }
  return Math.min(
    MAX_NARRATIVE_THREAD_DORMANT_THRESHOLD,
    Math.max(MIN_NARRATIVE_THREAD_DORMANT_THRESHOLD, Math.trunc(value)),
  )
}

export function narrativeEvidenceInText(evidence: string, content: string): boolean {
  const needle = evidence.replace(/\s+/gu, '')
  return needle.length > 0 && content.replace(/\s+/gu, '').includes(needle)
}

export interface NarrativeThreadPlanInput {
  title: string
  type: string
  targetStartChapter: number
  targetEndChapter: number
  authorIntent: string
}

export interface NarrativeThreadEventInput {
  planId: number
  draftId: number
  type: NarrativeThreadEventType
  evidence: string
  reason: string
}

export interface NarrativeThreadEvent extends NarrativeThreadEventInput {
  id: number
  chapterNumber: number
  chapterTitle: string
  createdAt: string
}

export interface NarrativeThreadView extends NarrativeThreadPlanInput {
  id: number
  status: NarrativeThreadStatus
  dormantChapters: number
  overdue: boolean
  events: NarrativeThreadEvent[]
  createdAt: string
  updatedAt: string
}

export interface NarrativeThreadPlanRecord extends NarrativeThreadPlanInput {
  id: number
  createdAt: string
  updatedAt: string
}

export interface NarrativeThreadChapterContext {
  chapterNumber: number
  title: string
  keyEvents: string
  characters: string[]
}

/**
 * 线索相对某一章的排期。注入正文时按正在写的章算，线索页按最大定稿章算。
 * 区间数据不可用（导入或手改写坏）时返回 null，调用方只跳过这一条。
 */
export type NarrativeThreadSchedule =
  | { kind: 'overdue'; chaptersOverdue: number }
  | { kind: 'due' | 'in-window' | 'later' | 'terminal' }

export function narrativeThreadSchedule(
  thread: Pick<NarrativeThreadView, 'status' | 'targetStartChapter' | 'targetEndChapter'>,
  chapterNumber: number,
): NarrativeThreadSchedule | null {
  const { targetStartChapter: start, targetEndChapter: end } = thread
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) return null
  if (isTerminalNarrativeThreadStatus(thread.status)) return { kind: 'terminal' }
  if (chapterNumber > end) return { kind: 'overdue', chaptersOverdue: chapterNumber - end }
  if (chapterNumber === end) return { kind: 'due' }
  return { kind: chapterNumber >= start ? 'in-window' : 'later' }
}

export function isTerminalNarrativeThreadStatus(status: NarrativeThreadStatus): boolean {
  return status === 'resolved' || status === 'abandoned'
}

const SCHEDULE_RANK: Record<NarrativeThreadSchedule['kind'], number> = {
  overdue: 0, due: 1, 'in-window': 2, later: 3, terminal: 4,
}

export function compareNarrativeThreadSchedules(left: NarrativeThreadSchedule, right: NarrativeThreadSchedule): number {
  return SCHEDULE_RANK[left.kind] - SCHEDULE_RANK[right.kind]
    || (right.kind === 'overdue' ? right.chaptersOverdue : 0) - (left.kind === 'overdue' ? left.chaptersOverdue : 0)
}

export function narrativeThreadView(
  plan: NarrativeThreadPlanRecord,
  events: NarrativeThreadEvent[],
  currentFinalizedChapter: number,
): NarrativeThreadView {
  const status: NarrativeThreadStatus = events.at(-1)?.type ?? 'planned'
  const lastChapter = events.at(-1)?.chapterNumber ?? plan.targetStartChapter
  return {
    ...plan,
    status,
    dormantChapters: isTerminalNarrativeThreadStatus(status) ? 0 : Math.max(0, currentFinalizedChapter - lastChapter),
    overdue: narrativeThreadSchedule({ ...plan, status }, currentFinalizedChapter)?.kind === 'overdue',
    events,
  }
}
