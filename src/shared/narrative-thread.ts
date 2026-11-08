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

export const NARRATIVE_EVENT_EVIDENCE_MAX_LENGTH = 240
export const NARRATIVE_EVENT_REASON_MAX_LENGTH = 500

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

export const CHAPTER_THREAD_TASK_LIMIT = 6

/**
 * 写第 N 章时到期或逾期的线索，开写时冻结进章节信息，作为本章硬任务。
 * 恢复和审稿都读冻结值，开写后作者改计划不影响本轮。
 */
export interface ChapterThreadTask {
  planId: number
  title: string
  authorIntent: string
  schedule: { kind: 'overdue'; chaptersOverdue: number } | { kind: 'due' }
}

function chapterThreadTask(planId: number, title: string, authorIntent: string,
  schedule: ChapterThreadTask['schedule']): ChapterThreadTask {
  return {
    planId, title, authorIntent,
    schedule: schedule.kind === 'overdue' ? { kind: 'overdue', chaptersOverdue: schedule.chaptersOverdue } : { kind: 'due' },
  }
}

export function chapterThreadTasks(threads: readonly NarrativeThreadView[], chapterNumber: number): {
  tasks: ChapterThreadTask[]
  leftOut: number
} {
  const pending = threads.flatMap((thread): { thread: NarrativeThreadView; schedule: ChapterThreadTask['schedule'] }[] => {
    const schedule = narrativeThreadSchedule(thread, chapterNumber)
    if (schedule?.kind === 'overdue') return [{ thread, schedule }]
    return schedule?.kind === 'due' ? [{ thread, schedule: { kind: 'due' } }] : []
  }).sort((left, right) => compareNarrativeThreadSchedules(left.schedule, right.schedule))
  return {
    tasks: pending.slice(0, CHAPTER_THREAD_TASK_LIMIT)
      .map(({ thread, schedule }) => chapterThreadTask(thread.id, thread.title, thread.authorIntent, schedule)),
    leftOut: Math.max(0, pending.length - CHAPTER_THREAD_TASK_LIMIT),
  }
}

/** 读回冻结的任务，键序与开写时一致，恢复时逐字比对才能对上。格式不对返回 null。 */
export function parseChapterThreadTasks(value: unknown): ChapterThreadTask[] | null {
  if (!Array.isArray(value) || value.length > CHAPTER_THREAD_TASK_LIMIT) return null
  const tasks: ChapterThreadTask[] = []
  for (const item of value) {
    const task = item as Partial<ChapterThreadTask> | null
    const schedule = task?.schedule as { kind?: unknown; chaptersOverdue?: unknown } | undefined
    if (!task || !Number.isSafeInteger(task.planId) || Number(task.planId) < 1
      || typeof task.title !== 'string' || typeof task.authorIntent !== 'string' || !schedule
      || !(schedule.kind === 'due' || (schedule.kind === 'overdue'
        && Number.isSafeInteger(schedule.chaptersOverdue) && Number(schedule.chaptersOverdue) >= 1))) return null
    tasks.push(chapterThreadTask(task.planId!, task.title, task.authorIntent, schedule as ChapterThreadTask['schedule']))
  }
  return tasks
}

/** 写稿运行绑定（RunBinding 的 JSON）在作者输入「draft:chapter-info」里冻结的线索任务。没有记录是空列表，记录写坏返回 null。 */
export function writtenChapterThreadTasks(bindingJson: string): ChapterThreadTask[] | null {
  try {
    const inputs = (JSON.parse(bindingJson) as { sourceManifest?: { authorInputs?: { id: string; text: unknown }[] } }).sourceManifest?.authorInputs
    const info = inputs?.find(input => input.id === 'draft:chapter-info')
    if (!info) return []
    if (typeof info.text !== 'string') return null
    const recorded = (JSON.parse(info.text) as { threadTasks?: unknown }).threadTasks
    return recorded === undefined ? [] : parseChapterThreadTasks(recorded)
  } catch {
    return null
  }
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
