import { describe, expect, it } from 'vitest'

import { assembleChapterMaterials, selectReviewRevisionMaterials, type ReviewRevisionMaterial } from '../chapter-materials'
import {
  estimateMaterialTokens, materialBudgetFrom, type MaterialAdmission, type MaterialBudget,
} from '../../../shared/generation-owner-contract'
import { hashAuthorText } from '../../../shared/source-ref'

const IDENTITY = { projectId: '项目', epoch: '会话' }
const NAMES = ['林岚', '周默', '老陈']
const relevanceTerms = ['第十章 雾港夜航', '林岚在雾港码头与周默对峙并得知老陈失踪的真相', ...NAMES]
const NON_MATERIAL_UNITS = 3_000

function cjk(length: number, seed: number): string {
  let state = seed * 2654435761 % 4294967296
  let out = ''
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) % 4294967296
    out += String.fromCharCode(0x4E00 + state % 20000)
  }
  return out
}

const bytes = (text: string) => new TextEncoder().encode(text).length

function budget(contextWindowTokens: number, reservedOutputTokens = 4_096): MaterialBudget {
  return materialBudgetFrom({ contextWindowTokens, contextWindowSource: 'manual', reservedOutputTokens, safetyMarginTokens: 512 })
}

function project(authorChars: number, previousChars: number) {
  const quarter = Math.floor(authorChars / 4)
  const eighth = Math.floor(authorChars / 8)
  const chunks = [0, 0, 1, 2, 3].map((hits, rank) => {
    const names = NAMES.slice(0, hits).join('')
    const text = names + cjk(500 - names.length, 100 + rank)
    return { text, rendered: `[${rank + 1}] (资料${rank + 1}.md)\n${text}`, deduplicateAgainstFinalized: true }
  })
  const thread = `【当前相关活跃叙事线索】\n${NAMES[0]}${cjk(1000, 300)}`
  const older = [8, 7, 6].map((chapterNumber, index) => {
    const paragraphs = Array.from({ length: 5 }, (_, p) => cjk(200, 500 + index * 10 + p))
    paragraphs[2] = NAMES[1] + paragraphs[2]
    return { chapterNumber, draftId: chapterNumber * 10, title: '', content: paragraphs.join('\n\n'),
      evidence: [paragraphs[2].slice(0, 30)], includeEnding: false }
  })
  return {
    identity: IDENTITY, writingLanguage: 'zh-CN' as const, relevanceTerms, nonMaterialUnits: NON_MATERIAL_UNITS,
    authorProjectFacts: [cjk(quarter, 11), cjk(quarter, 12), cjk(quarter, 13)],
    characterProfiles: cjk(eighth, 14),
    futurePlans: cjk(authorChars - 3 * quarter - eighth, 15),
    references: [{ text: thread, rendered: thread }, ...chunks],
    finalized: [{ chapterNumber: 9, draftId: 90, title: '', content: cjk(previousChars, 900), evidence: [], includeEnding: true }, ...older],
    candidates: [],
  }
}

const MATURE = project(12_000, 5_000)
const MIDDLE = project(5_000, 4_000)
const withAdmission = (admission: MaterialAdmission) => ({ admission })
const withBudget = (value: MaterialBudget) => withAdmission({ kind: 'budget', budget: value })
const optionalIds = (result: Awaited<ReturnType<typeof assembleChapterMaterials>>) =>
  result.decision.included.filter(item => !item.required).map(item => item.sourceId)

describe('按模型窗口分配可选材料', () => {
  it('成熟项目在 128K 窗口下，知识库片段、活跃线索、较早定稿证据都进入提示词', async () => {
    const result = await assembleChapterMaterials({ ...MATURE, ...withBudget(budget(128_000)) })

    for (const reference of MATURE.references) expect(result.text).toContain(reference.text)
    for (const older of MATURE.finalized.slice(1)) expect(result.text).toContain(older.evidence[0])
    expect(result.decision.omitted.filter(item => item.reason === 'budget')).toEqual([])
  })

  it('窗口 16,385 时先裁相关度最低的可选材料，整条提示词估算不超过额度', async () => {
    const value = budget(16_385)
    const result = await assembleChapterMaterials({ ...MIDDLE, ...withBudget(value) })
    const included = optionalIds(result)
    const omitted = result.decision.omitted.filter(item => item.reason === 'budget').map(item => item.sourceId)

    expect(included).toContain('reference:5')
    expect(omitted).toEqual(expect.arrayContaining(['reference:1', 'reference:2']))
    expect(included.length).toBeGreaterThan(0)
    expect(estimateMaterialTokens(bytes(result.text) + NON_MATERIAL_UNITS)).toBeLessThanOrEqual(value.inputTokens)
  })

  it('知识库片段按快照排名取舍：额度不够时先裁排名靠后的，字面命中多也不能插队', async () => {
    const [thread, ...chunks] = MIDDLE.references
    // 字面命中最多的片段排名最后；没带排名的线索块仍按相关度和片段穿插。
    const ranked = [thread!, ...chunks.map((chunk, index) => ({ ...chunk, knowledgeRank: index + 1 }))]
    const result = await assembleChapterMaterials({ ...MIDDLE, references: ranked, ...withBudget(budget(16_385)) })
    const included = optionalIds(result)
    const omitted = result.decision.omitted.filter(item => item.reason === 'budget').map(item => item.sourceId)

    expect(included).toContain('reference:1')
    expect(omitted).toContain('reference:5')
  })

  it('必需材料单独超过窗口时照常发出，可选材料全部不放', async () => {
    const value = budget(16_385)
    const result = await assembleChapterMaterials({ ...MATURE, ...withBudget(value) })

    expect(estimateMaterialTokens(result.decision.capacity.admittedUnits)).toBeGreaterThan(value.inputTokens)
    expect(result.decision.included.every(item => item.required)).toBe(true)
    expect(result.decision.included.map(item => item.sourceId)).toEqual(['author:required', 'finalized:90'])
    expect(result.decision.coverage.complete).toBe(true)
  })

  it('额度冻结进收据，用同一额度重选得到同样的材料', async () => {
    const value = budget(16_385)
    const first = await assembleChapterMaterials({ ...MIDDLE, ...withBudget(value) })
    expect(first.decision.budget).toEqual(value)

    const resumed = await assembleChapterMaterials({ ...MIDDLE, ...withBudget(first.decision.budget!) })
    expect(resumed.decision).toEqual(first.decision)
    expect(resumed.text).toBe(first.text)
  })

  it('旧收据没有额度字段时，按收据记下的可选材料原样重现，收据也不多出额度字段', async () => {
    const original = await assembleChapterMaterials({ ...MIDDLE, ...withBudget(budget(16_385)) })
    const legacy = { ...original.decision }
    delete legacy.budget
    const optionalContentHashes = legacy.included.filter(item => !item.required).map(item => item.contentHash)

    const resumed = await assembleChapterMaterials({ ...MIDDLE, ...withAdmission({ kind: 'frozen', optionalContentHashes }) })

    expect(resumed.decision).toEqual(legacy)
    expect(resumed.text).toBe(original.text)
  })
})

describe('旧收据遇到带排名的快照', () => {
  it('恢复时不按排名重排，提示词和当初一字不差', async () => {
    const original = await assembleChapterMaterials({ ...MIDDLE, ...withBudget(budget(32_768)) })
    const optionalContentHashes = original.decision.included.filter(item => !item.required).map(item => item.contentHash)
    const [thread, ...chunks] = MIDDLE.references
    const ranked = [thread!, ...chunks.map((chunk, index) => ({ ...chunk, knowledgeRank: index + 1 }))]

    const resumed = await assembleChapterMaterials({ ...MIDDLE, references: ranked, ...withAdmission({ kind: 'frozen', optionalContentHashes }) })

    expect(resumed.text).toBe(original.text)
  })
})

describe('审稿、修稿走同一套额度', () => {
  const history = async (sourceId: string, chars: number, seed: number, term = ''): Promise<ReviewRevisionMaterial> => {
    const text = term + cjk(chars, seed)
    return { identity: { projectId: IDENTITY.projectId, sourceId, revision: Number(sourceId.split(':')[1]), contentHash: await hashAuthorText(text), provenance: 'finalized' },
      category: 'finalized-history', required: false, text }
  }
  const author = async (chars: number): Promise<ReviewRevisionMaterial> => {
    const text = cjk(chars, 1)
    return { identity: { projectId: IDENTITY.projectId, sourceId: 'author:required', revision: 1, contentHash: await hashAuthorText(text), provenance: 'author' },
      category: 'author', required: true, text }
  }

  it('大窗口放下全部历史；小窗口先裁相关度最低的历史，且不裁必需材料', async () => {
    const materials = [await author(6_000), await history('finalized:1', 2_000, 2), await history('finalized:2', 2_000, 3, '林岚周默')]
    const select = (contextWindowTokens: number) => selectReviewRevisionMaterials({ current: IDENTITY, writingLanguage: 'zh-CN',
      materials, relevanceTerms: NAMES, nonMaterialUnits: NON_MATERIAL_UNITS,
      admission: { kind: 'budget', budget: budget(contextWindowTokens) } })

    expect(select(128_000).admitted.map(item => item.identity.sourceId)).toEqual(['author:required', 'finalized:1', 'finalized:2'])
    const narrow = select(14_000)
    expect(narrow.admitted.map(item => item.identity.sourceId)).toEqual(['author:required', 'finalized:2'])
    expect(narrow.decision.budget).toEqual(budget(14_000))
    expect(select(1_024).admitted.map(item => item.identity.sourceId)).toEqual(['author:required'])
  })
})
