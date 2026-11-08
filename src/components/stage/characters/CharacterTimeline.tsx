import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { resolveStateEffectiveChapter, type CharacterTimelineChange, type CharacterTimelineSource, type StateChapterRange } from '../../../shared/character-continuity'
import { pluralEn } from '../../../shared/plural-en'
import { useLocaleStore, type LocaleState } from '../../../stores/locale-store'
import { CHARACTER_STATE_FIELDS } from '../../editor/character-state-fields'
import { Button } from '../../ui/Button'
import type { CharacterTimelineView } from './use-character-timeline'

type Text = LocaleState['text']

const SOURCE_LABELS: Readonly<Record<CharacterTimelineSource, readonly [string, string]>> = {
  author: ['作者设定', 'Set by author'],
  finalized: ['定稿记录', 'From a finalized chapter'],
  legacy: ['升级前已有', 'From before the upgrade'],
}

function fieldLabel({ node }: CharacterTimelineChange, text: Text): string {
  if (node.aspect === 'relation') return text(`与${node.targetName}的关系`, `With ${node.targetName}`)
  const [, zh, en] = CHARACTER_STATE_FIELDS.find(([field]) => field === node.aspect)!
  return text(zh, en)
}

function shownValue({ node, removed, value }: CharacterTimelineChange, text: Text): string {
  if (!removed) return value
  if (node.aspect !== 'relation') return text('已清除', 'Cleared')
  return value ? text(`解除「${value}」`, `Ended: ${value}`) : text('解除', 'Ended')
}

function TimelineRow({ change }: { change: CharacterTimelineChange }) {
  const text = useLocaleStore(state => state.text)
  const [zh, en] = SOURCE_LABELS[change.source]
  return (
    <li className="cast-timeline-row">
      <span>{fieldLabel(change, text)}</span>
      <span className="cast-timeline-value" data-removed={change.removed || undefined}>{shownValue(change, text)}</span>
      <span>{text(zh, en)}</span>
      {change.node.quote && (
        <details className="cast-timeline-quote">
          <summary className="pi-focusable">{text('原文', 'Source text')}</summary>
          <blockquote>{change.node.quote.text}</blockquote>
        </details>
      )}
    </li>
  )
}

export default function CharacterTimeline({ timeline, open, onOpenChange }: { timeline: CharacterTimelineView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const text = useLocaleStore(state => state.text)
  if (timeline.status === 'loading') return null
  if (timeline.status === 'failed') return <p className="cast-timeline-empty">{text('时间线暂时读不出来', 'The timeline could not be read')}</p>
  if (timeline.changeCount === 0) return <p className="cast-timeline-empty">{text('时间线 · 还没有逐章记录', 'Timeline · nothing recorded yet')}</p>
  return (
    <details className="cast-timeline" open={open} onToggle={event => onOpenChange(event.currentTarget.open)}>
      <summary className="cast-timeline-summary pi-focusable">
        <ChevronRight className="cast-timeline-chevron" size={14} aria-hidden />
        {text(`时间线 · ${timeline.changeCount} 处变化`, `Timeline · ${timeline.changeCount} ${pluralEn(timeline.changeCount, 'change')}`)}
      </summary>
      <ol className="cast-timeline-list">
        {timeline.chapters.map(({ chapter, changes }) => (
          <li key={chapter} className="cast-timeline-chapter">
            <h3>{chapter === 0 ? text('写作开始前', 'Before chapter 1') : text(`第 ${chapter} 章`, `Chapter ${chapter}`)}</h3>
            {changes.some(change => change.source === 'legacy') && <p className="cast-timeline-legacy">{text('升级前的变化没有记录', 'Changes before the upgrade were not recorded')}</p>}
            <ul className="cast-timeline-changes">
              {changes.map(change => <TimelineRow key={change.node.eventId} change={change} />)}
            </ul>
          </li>
        ))}
      </ol>
    </details>
  )
}

export function StateChapterNote({ range, disabled, onChange }: { range: StateChapterRange; disabled: boolean; onChange: (chapter: number | undefined) => void }) {
  const text = useLocaleStore(state => state.text)
  const [draft, setDraft] = useState<string | null>(null)
  const requested = draft?.trim() ? Number(draft) : undefined
  const chapter = resolveStateEffectiveChapter(requested, range)
  const update = (value: string) => {
    setDraft(value)
    const resolved = resolveStateEffectiveChapter(value.trim() ? Number(value) : undefined, range)
    onChange(resolved === range.next ? undefined : resolved)
  }
  return (
    <div className="cast-view-note cast-state-chapter">
      <span>{text(`手改的状态从第 ${chapter} 章起生效，早于已有记录时顺延`, `Hand edits to state apply from chapter ${chapter}, or later if that field already has a later record`)}</span>
      {draft === null
        ? <Button variant="text" size="sm" onClick={() => setDraft('')}>{text('改章号', 'Change chapter')}</Button>
        : <label>{text('章号', 'Chapter')}<input className="pi-input" type="number" min={1} max={range.last} placeholder={String(range.next)} disabled={disabled} value={draft} onChange={event => update(event.target.value)} /></label>}
      {requested !== undefined && requested !== chapter && (
        <span>{text(`第 ${requested} 章不在 1–${range.last} 章内，先按第 ${chapter} 章算`, `Chapter ${requested} is outside 1–${range.last}, so chapter ${chapter} is used`)}</span>
      )}
    </div>
  )
}
