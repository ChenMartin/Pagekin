import { chapterThreadGoalPlanId, withoutResolvedOutcomeLabel, type ChapterGoalReview } from './chapter-goal-review'
import {
  isTerminalNarrativeThreadStatus,
  NARRATIVE_EVENT_EVIDENCE_MAX_LENGTH,
  NARRATIVE_EVENT_REASON_MAX_LENGTH,
  narrativeEvidenceInText,
  type NarrativeThreadEventInput,
  type NarrativeThreadView,
} from './narrative-thread'

export interface NarrativeThreadReviewCandidate extends NarrativeThreadEventInput {
  type: 'resolved'
  chapterNumber: number
  threadTitle: string
}

export interface ReviewedFinalDraft {
  draftId: number
  chapterNumber: number
  content: string
  goalReview: ChapterGoalReview
}

export function narrativeThreadReviewCandidates(
  threads: readonly NarrativeThreadView[],
  drafts: readonly ReviewedFinalDraft[],
): NarrativeThreadReviewCandidate[] {
  const threadsById = new Map(threads.map(thread => [thread.id, thread]))
  return drafts.flatMap(draft => draft.goalReview.items.flatMap((item): NarrativeThreadReviewCandidate[] => {
    if (item.threadOutcome !== 'resolved') return []
    const planId = chapterThreadGoalPlanId(item.id)
    const thread = planId === null ? undefined : threadsById.get(planId)
    if (!thread || isTerminalNarrativeThreadStatus(thread.status)
      || thread.events.some(event => event.draftId === draft.draftId && event.type === 'resolved')) return []
    const quote = item.evidence.find(evidence => narrativeEvidenceInText(evidence.quote, draft.content))?.quote
    if (!quote) return []
    return [{
      planId: thread.id,
      draftId: draft.draftId,
      chapterNumber: draft.chapterNumber,
      threadTitle: thread.title,
      type: 'resolved',
      evidence: quote.trim().slice(0, NARRATIVE_EVENT_EVIDENCE_MAX_LENGTH),
      reason: withoutResolvedOutcomeLabel(item.description).trim().slice(0, NARRATIVE_EVENT_REASON_MAX_LENGTH),
    }]
  }))
}
