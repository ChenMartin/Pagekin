import { describe, expect, it } from 'vitest'
import type { GenerationRecoveryContext } from '../generation-owner-contract'
import { planningRecoverable } from '../planning-recovery'

const context = (extra: Partial<GenerationRecoveryContext>) => ({ blueprintRecovery: {}, ...extra }) as GenerationRecoveryContext
const draft = (standing: 'open' | 'superseded' | 'dismissed') => ({ requestedRange: { from: 1, to: 2 }, createdAtMs: 1, standing })

describe('规划恢复稿是否还给作者（#608）', () => {
  it('只有还开着、续写没完成、也没原样写进正式大纲的才给', () => {
    expect(planningRecoverable(context({ planningDraft: draft('open') }))).toBe(true)
    expect(planningRecoverable(context({}))).toBe(true)
    expect(planningRecoverable(context({ planningDraft: draft('superseded') }))).toBe(false)
    expect(planningRecoverable(context({ planningDraft: draft('dismissed') }))).toBe(false)
    expect(planningRecoverable(context({ planningContinuation: { state: 'complete' } as never }))).toBe(false)
    expect(planningRecoverable({ plotOutlineRecovery: { inFormalOutline: true } } as never)).toBe(false)
    expect(planningRecoverable({} as GenerationRecoveryContext)).toBe(false)
  })
})
