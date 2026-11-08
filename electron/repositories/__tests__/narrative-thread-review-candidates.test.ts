import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { freezeChapterGoals, withChapterThreadGoals, type ChapterThreadOutcome } from '../../../src/shared/chapter-goal-review'
import { countDraftUnits } from '../../../src/shared/draft-units'
import { createHumanConfirmedReviewSnapshot, serializeHumanConfirmedReviewSnapshot } from '../../../src/shared/human-confirmed-review'
import { chapterThreadTasks, type NarrativeThreadPlanRecord } from '../../../src/shared/narrative-thread'
import { buildReviewGenerationReport } from '../../../src/shared/review-generation-report'
import type { ExpectedDraftSource } from '../../../src/shared/ipc-channels'
import { DraftRepository } from '../draft-repository'
import { FinalizationRepository } from '../finalization-repository'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { NarrativeThreadRepository } from '../narrative-thread-repository'
import { ReviewRepository } from '../review-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-thread-candidates-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

const QUOTE = '林岚把青铜钥匙插进灯室的锁孔'
const CHAPTER = `雾散之后，${QUOTE}，门开了。`

function plan(title = '青铜钥匙'): NarrativeThreadPlanRecord {
  return NarrativeThreadRepository.createPlan({ title, type: '伏笔', targetStartChapter: 1, targetEndChapter: 5, authorIntent: '第五章打开灯室。' })
}

function write(chapterNumber: number, content: string): number {
  return DraftRepository.create({ chapterNumber, source: 'write', content, wordCount: countDraftUnits(content) })
}

function source(draftId: number): ExpectedDraftSource {
  const draft = DraftRepository.getFull(draftId)!
  return { id: draftId, chapterNumber: draft.chapterNumber, version: draft.version, status: draft.status as ExpectedDraftSource['status'], content: draft.content }
}

function savedReport(draftId: number, thread: NarrativeThreadPlanRecord, outcome: ChapterThreadOutcome,
  quotes: readonly string[], description = '钥匙打开了灯室，伏笔收束。'): string {
  const { chapterNumber, content } = source(draftId)
  const goals = withChapterThreadGoals(freezeChapterGoals(chapterNumber, null), [
    { planId: thread.id, title: thread.title, authorIntent: thread.authorIntent, schedule: { kind: 'due' } },
  ], 'zh-CN')
  return JSON.stringify(buildReviewGenerationReport({
    content: JSON.stringify({
      summary: '审完了。',
      items: [{ category: '连续性', severity: 'pass', description: '时间线一致。' }],
      goalReviews: [{ id: `ch${chapterNumber}:thread:${thread.id}`, status: outcome, description, evidence: quotes.map(quote => ({ quote })) }],
    }),
    sourceContent: content,
    frozenGoals: goals,
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
    preflightFindings: [],
  }))
}

function saveReview(draftId: number, body: string): number {
  return ReviewRepository.create({ baseDraftId: draftId, content: body, expectedSource: source(draftId) }).id
}

function finalize(draftId: number, content = DraftRepository.getFull(draftId)!.content): void {
  const { chapterNumber } = DraftRepository.getFull(draftId)!
  FinalizationRepository.commit({
    finalizationId: randomUUID(),
    draftId,
    chapterNumber,
    chapterTitle: '灯室',
    content,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    contentRevision: 1,
    targetFileName: `第${chapterNumber}章.txt`,
  })
}

function reviewedFinal(thread: NarrativeThreadPlanRecord, chapterNumber = 5): number {
  const draftId = write(chapterNumber, CHAPTER)
  saveReview(draftId, savedReport(draftId, thread, 'resolved', [QUOTE]))
  finalize(draftId)
  return draftId
}

function importedFinal(chapterNumber: number, content: string): number {
  return FinalizedDraftImportRepository.commit(projectRoot, { operationId: randomUUID(), chapters: [
    { chapterNumber, title: '导入章', content, wordCount: countDraftUnits(content) },
  ] }).drafts[0]!.draftId
}

const statusOf = (planId: number) => NarrativeThreadRepository.list().find(thread => thread.id === planId)?.status

describe('审稿判定已回收的线索变成待确认候选', () => {
  it('定稿后给出候选，引文、章号、线索名都来自审稿和定稿，理由不带结论前缀', () => {
    const thread = plan()
    const draftId = reviewedFinal(thread)

    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([{
      planId: thread.id, draftId, chapterNumber: 5, threadTitle: '青铜钥匙', type: 'resolved',
      evidence: QUOTE, reason: '钥匙打开了灯室，伏笔收束。',
    }])
  })

  it('还没定稿时不出候选', () => {
    const thread = plan()
    const draftId = write(5, CHAPTER)
    saveReview(draftId, savedReport(draftId, thread, 'resolved', [QUOTE]))

    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([])
  })

  it('作者确认后线索变已解决、候选消失，下一章不再列为硬任务', () => {
    const thread = plan()
    reviewedFinal(thread)
    expect(chapterThreadTasks(NarrativeThreadRepository.list(), 6).tasks.map(task => task.planId)).toEqual([thread.id])

    const [candidate] = NarrativeThreadRepository.listReviewCandidates()
    NarrativeThreadRepository.confirmEvent(candidate!)

    expect(statusOf(thread.id)).toBe('resolved')
    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([])
    expect(chapterThreadTasks(NarrativeThreadRepository.list(), 6).tasks).toEqual([])
  })

  it('作者不确认时线索状态不变，重复读取结果相同', () => {
    const thread = plan()
    reviewedFinal(thread)

    const first = NarrativeThreadRepository.listReviewCandidates()
    expect(first).toHaveLength(1)
    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual(first)
    expect(statusOf(thread.id)).toBe('planned')
  })

  it('修稿后引文不在定稿里时不出候选，也不报错', () => {
    const thread = plan()
    const draftId = write(5, CHAPTER)
    saveReview(draftId, savedReport(draftId, thread, 'resolved', [QUOTE]))
    finalize(draftId, '雾散之后，灯室的门依旧紧闭。')

    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([])
  })

  it('第一条引文被修掉、第二条还在时用还在的那条', () => {
    const thread = plan()
    const draftId = write(5, `旧句子。${CHAPTER}`)
    saveReview(draftId, savedReport(draftId, thread, 'resolved', ['旧句子。', QUOTE]))
    finalize(draftId, CHAPTER)

    expect(NarrativeThreadRepository.listReviewCandidates().map(candidate => candidate.evidence)).toEqual([QUOTE])
  })

  it.each([
    ['advanced', [QUOTE]],
    ['unaddressed', []],
    ['resolved', []],
  ] as const)('%s 且引文 %j 时不出候选', (outcome, quotes) => {
    const thread = plan()
    const draftId = write(5, CHAPTER)
    saveReview(draftId, savedReport(draftId, thread, outcome, quotes))
    finalize(draftId)

    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([])
  })

  it.each(['resolved', 'abandoned'] as const)('线索已是终态 %s 时不出候选', (type) => {
    const thread = plan()
    NarrativeThreadRepository.confirmEvent({ planId: thread.id, draftId: importedFinal(1, '终态证据。'), type, evidence: '终态证据。', reason: '作者已定。' })
    reviewedFinal(thread)

    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([])
  })

  it('同一稿已确认过回收、线索后来又有新进展时，不再提示同一条', () => {
    const thread = plan()
    reviewedFinal(thread)
    NarrativeThreadRepository.confirmEvent(NarrativeThreadRepository.listReviewCandidates()[0]!)
    NarrativeThreadRepository.confirmEvent({ planId: thread.id, draftId: importedFinal(6, '钥匙又失踪了。'), type: 'progressing', evidence: '钥匙又失踪了。', reason: '重新打开。' })

    expect(statusOf(thread.id)).toBe('progressing')
    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([])
  })

  it('重开定稿并替换后按新稿重新计算，旧审稿不再出候选', () => {
    const thread = plan()
    reviewedFinal(thread)

    const reopened = FinalizationRepository.reopen({ chapterNumber: 5 })
    if (!reopened.success) throw new Error('reopen failed')
    finalize(reopened.draftId, CHAPTER)
    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([])

    const again = FinalizationRepository.reopen({ chapterNumber: 5 })
    if (!again.success) throw new Error('reopen failed')
    saveReview(again.draftId, savedReport(again.draftId, thread, 'resolved', [QUOTE]))
    finalize(again.draftId, CHAPTER)
    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([expect.objectContaining({ draftId: again.draftId })])
  })

  it('同一稿多次审稿时只认最新一次', () => {
    const thread = plan()
    const draftId = write(5, CHAPTER)
    saveReview(draftId, savedReport(draftId, thread, 'resolved', [QUOTE]))
    saveReview(draftId, savedReport(draftId, thread, 'advanced', [QUOTE]))
    finalize(draftId)

    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([])
  })

  it('作者确认过的审稿清单也能给出候选', () => {
    const thread = plan()
    const draftId = write(5, CHAPTER)
    const body = savedReport(draftId, thread, 'resolved', [QUOTE])
    const reviewId = saveReview(draftId, body)
    const snapshot = createHumanConfirmedReviewSnapshot({
      sourceReviewId: reviewId, sourceDraft: source(draftId), summary: '审完了。', authorGuidance: '', items: [],
      goalReview: (JSON.parse(body) as { goalReview: never }).goalReview,
    })!
    saveReview(draftId, serializeHumanConfirmedReviewSnapshot(snapshot))
    finalize(draftId)

    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([expect.objectContaining({ draftId, evidence: QUOTE })])
  })

  it('旧项目没有逐项核对、审稿报告损坏时只是没有候选，线索列表照常', () => {
    const thread = plan()
    for (const [chapterNumber, body] of [
      [1, JSON.stringify({ summary: '旧报告', items: [{ category: '文笔', severity: 'pass', description: '好。' }] })],
      [2, '{不是 JSON'],
      [3, JSON.stringify({ summary: '坏', items: [], goalReview: { version: 99 } })],
      [4, 'null'],
    ] as const) {
      const draftId = write(chapterNumber, CHAPTER)
      saveReview(draftId, body)
      finalize(draftId)
    }
    importedFinal(5, CHAPTER)

    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([])
    expect(NarrativeThreadRepository.list().map(item => item.id)).toEqual([thread.id])
  })

  it('线索计划已删除时不出候选', () => {
    const thread = plan()
    reviewedFinal(thread)
    NarrativeThreadRepository.deletePlan(thread.id)

    expect(NarrativeThreadRepository.listReviewCandidates()).toEqual([])
  })

  it('超长引文和理由压进记账上限，确认不会被拒', () => {
    const thread = plan()
    const longQuote = '灯'.repeat(300)
    const draftId = write(5, `开头。${longQuote}结尾。`)
    saveReview(draftId, savedReport(draftId, thread, 'resolved', [longQuote], '因'.repeat(600)))
    finalize(draftId)

    const [candidate] = NarrativeThreadRepository.listReviewCandidates()
    expect(candidate!.evidence).toHaveLength(240)
    expect(candidate!.reason).toHaveLength(500)
    expect(NarrativeThreadRepository.confirmEvent(candidate!).type).toBe('resolved')
  })
})
