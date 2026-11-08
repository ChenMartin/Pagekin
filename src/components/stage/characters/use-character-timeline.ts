import { useEffect, useState } from 'react'
import { characterTimeline, type CharacterContinuityTimeline, type CharacterTimelineChapter, type StateChapterRange } from '../../../shared/character-continuity'
import { ipc } from '../../../services/ipc-client'
import { useCharacterStore } from '../../../stores/character-store'
import { useProjectStore } from '../../../stores/project-store'
import { captureProjectSession, isProjectSessionCurrent } from '../../project-session-gate'

export type CharacterTimelineView =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; chapters: CharacterTimelineChapter[]; changeCount: number; chapterRange: StateChapterRange }

export function useCharacterTimeline(characterId: string | undefined, enabled: boolean): CharacterTimelineView {
  const rosterRevision = useCharacterStore(state => state.rosterRevision)
  const [loaded, setLoaded] = useState<{ characterId: string; timeline: CharacterContinuityTimeline | null } | null>(null)

  useEffect(() => {
    const session = captureProjectSession(useProjectStore.getState().currentProject)
    if (!enabled || !characterId || !session) return
    let latest = true
    void ipc.invokeWithProjectSession(session, 'db:character-continuity-timeline', characterId, session.projectPath)
      .catch(() => null)
      .then(timeline => { if (latest && isProjectSessionCurrent(session)) setLoaded({ characterId, timeline }) })
    return () => { latest = false }
  }, [enabled, characterId, rosterRevision])

  if (!loaded || loaded.characterId !== characterId) return { status: 'loading' }
  if (!loaded.timeline) return { status: 'failed' }
  const chapters = characterTimeline(loaded.timeline.nodes)
  return { status: 'ready', chapters, changeCount: chapters.reduce((sum, group) => sum + group.changes.length, 0), chapterRange: loaded.timeline.chapterRange }
}
