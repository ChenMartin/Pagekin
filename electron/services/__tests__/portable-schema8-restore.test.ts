import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import { removeDirectoryWithWindowsRetry } from '../../utils/remove-directory'
import { ConsistencyExemptionRepository } from '../../repositories/consistency-exemption-repository'
import { exportPortableProject } from '../project-archive-service'
import { restorePortableProject } from '../project-restore-service'
import { continuityBaseline, SCHEMA8_CONTINUITY_ARCHIVE, SCHEMA8_EXPECTED_BASELINE } from '../../../test/helpers/schema8-continuity-archive'

const roots: string[] = []

afterEach(async () => {
  closeProjectDatabase()
  for (const root of roots.splice(0)) await removeDirectoryWithWindowsRetry(root)
})

function workspace(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'schema8-restore-'))
  roots.push(base)
  return base
}

describe('恢复 M08 之前导出的便携包（schema 8）', { timeout: 60_000 }, () => {
  it('解出的库迁到当前版本，按包里的当前状态与关系补齐基线节点，作者数据不变', async () => {
    const target = path.join(workspace(), '恢复')
    await restorePortableProject({ archivePath: SCHEMA8_CONTINUITY_ARCHIVE, targetProjectRoot: target })
    initProjectDatabase(target)
    const db = getProjectDb()!
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    expect(continuityBaseline(db)).toEqual(SCHEMA8_EXPECTED_BASELINE)
    expect(db.prepare("SELECT cs_location FROM characters WHERE name='林澈'").pluck().get()).toBe('雨城北门')
    expect(db.prepare('SELECT stable_fact_key,chapter_number FROM consistency_exemptions').all())
      .toEqual([{ stable_fact_key: 'death:老周', chapter_number: null }])
  })

  it('包里的全局豁免升级后照常保存、撤销，不会多出第二行全局豁免', async () => {
    const target = path.join(workspace(), '恢复')
    await restorePortableProject({ archivePath: SCHEMA8_CONTINUITY_ARCHIVE, targetProjectRoot: target })
    initProjectDatabase(target)
    const [before] = ConsistencyExemptionRepository.list()
    ConsistencyExemptionRepository.save('death:老周', '第 9 章确认是假死')
    ConsistencyExemptionRepository.save('scar:林澈', '旧伤已愈')
    ConsistencyExemptionRepository.revoke('scar:林澈')
    expect(ConsistencyExemptionRepository.list()).toEqual([
      { ...before, reason: '第 9 章确认是假死', revoked: false },
      { stableFactKey: 'scar:林澈', reason: '旧伤已愈', revoked: true },
    ])
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM consistency_exemptions').pluck().get()).toBe(2)
  })

  it('同一个包对同一目标再恢复一次，认出已装好的项目', async () => {
    const target = path.join(workspace(), '恢复')
    const first = await restorePortableProject({ archivePath: SCHEMA8_CONTINUITY_ARCHIVE, targetProjectRoot: target })
    const again = await restorePortableProject({ archivePath: SCHEMA8_CONTINUITY_ARCHIVE, targetProjectRoot: target })
    expect(again).toEqual(first)
  })

  it('恢复出的项目导出成当前版本的包，节点原样带到下一次恢复', async () => {
    const base = workspace()
    const target = path.join(base, '恢复')
    const receipt = await restorePortableProject({ archivePath: SCHEMA8_CONTINUITY_ARCHIVE, targetProjectRoot: target })
    const archive = path.join(base, 'again.ainovel')
    const attempts = path.join(base, 'attempts')
    fs.mkdirSync(attempts)
    await exportPortableProject({ sourceProjectRoot: target,
      projectSession: { projectId: receipt.targetProjectId, projectPath: target, leaseId: 'lease-again' },
      targetArchivePath: archive, attemptParentPath: attempts, assertCurrentContext: () => undefined,
      assets: { snapshot: () => ({ files: [], verifyUnchanged: () => undefined }) }, snapshotGeneration: 'after-schema8' })
    const second = path.join(base, '再恢复')
    await restorePortableProject({ archivePath: archive, targetProjectRoot: second })
    initProjectDatabase(second)
    expect(continuityBaseline(getProjectDb()!)).toEqual(SCHEMA8_EXPECTED_BASELINE)
  })
})
