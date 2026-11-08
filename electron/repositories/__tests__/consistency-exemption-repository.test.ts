import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { ConsistencyExemptionRepository } from '../consistency-exemption-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-consistency-exemption-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('ConsistencyExemptionRepository', () => {
  it('persists only the stable fact key, reason, and revocation state', () => {
    ConsistencyExemptionRepository.save('open-thread:1:key', '刻意延后到第三章')
    expect(ConsistencyExemptionRepository.list()).toEqual([{
      stableFactKey: 'open-thread:1:key',
      reason: '刻意延后到第三章',
      revoked: false,
    }])

    ConsistencyExemptionRepository.revoke('open-thread:1:key')
    expect(ConsistencyExemptionRepository.list()[0]).toEqual({
      stableFactKey: 'open-thread:1:key',
      reason: '刻意延后到第三章',
      revoked: true,
    })
  })

  it('rejects an empty reason and can reactivate an existing stable key', () => {
    expect(() => ConsistencyExemptionRepository.save('open-thread:1:key', '  ')).toThrow(/^CONSISTENCY_EXEMPTION_REASON_INVALID$/u)
    expect(() => ConsistencyExemptionRepository.save('  ', '原因')).toThrow(/^CONSISTENCY_EXEMPTION_KEY_INVALID$/u)
    ConsistencyExemptionRepository.save('open-thread:1:key', '第一次原因')
    ConsistencyExemptionRepository.revoke('open-thread:1:key')
    ConsistencyExemptionRepository.save('open-thread:1:key', '新的原因')
    expect(ConsistencyExemptionRepository.list()).toEqual([{
      stableFactKey: 'open-thread:1:key', reason: '新的原因', revoked: false,
    }])
  })

  it('treats a per-chapter exemption of the same fact as separate from the global one', () => {
    const chapterRow = () => getProjectDb()!.prepare(
      "SELECT reason, revoked FROM consistency_exemptions WHERE stable_fact_key = 'death:老周' AND chapter_number = 3").get()
    getProjectDb()!.prepare("INSERT INTO consistency_exemptions(stable_fact_key, chapter_number, reason) VALUES('death:老周', 3, '第 3 章是回忆')").run()
    expect(ConsistencyExemptionRepository.list()).toEqual([])

    ConsistencyExemptionRepository.save('death:老周', '全书都按假死处理')
    ConsistencyExemptionRepository.revoke('death:老周')
    expect(ConsistencyExemptionRepository.list()).toEqual([{ stableFactKey: 'death:老周', reason: '全书都按假死处理', revoked: true }])
    expect(chapterRow()).toEqual({ reason: '第 3 章是回忆', revoked: 0 })
  })
})
