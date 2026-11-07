import { describe, expect, it } from 'vitest'
import { buildChapterGoalReviewPrompt, chapterGoalReviewItems, freezeChapterGoals, normalizeChapterGoalReview, parseChapterGoalReview, withChapterThreadGoals } from '../chapter-goal-review'

const draft = '她合上已经装订好的相册。两人约定周三再搬设备。'
const goals = freezeChapterGoals(3, '完成相册；约定周三搬设备')
const answer = [
  { id: goals.items[0]!.id, status: 'completed', description: '装订已完成。', evidence: [{ quote: '已经装订好的相册' }] },
  { id: goals.items[1]!.id, status: 'completed', description: '约定已经达成，无需提前搬家。', evidence: [{ quote: '两人约定周三再搬设备。' }] },
]

describe('本章目标审稿合同', () => {
  it('只把当前章的独立必现行并入原目标，普通背景和其他章不入清单', () => {
    const frozen = freezeChapterGoals(3, '交还钥匙', [
      '北塔常年积雪。\n【第3章必现】主角亲眼看见红灯熄灭\n【第4章必现】城门开启',
      '【第3章必现】她当面承认身份\n普通备注：她害怕黑暗',
    ])
    expect(frozen.items).toEqual([
      { id: 'ch3:keyEvents:1', text: '交还钥匙' },
      { id: 'ch3:mustShow:1', text: '主角亲眼看见红灯熄灭' },
      { id: 'ch3:mustShow:2', text: '她当面承认身份' },
    ])
  })

  it('必现缺席是 unknown，正文明确出现与明确相反分别接纳定位证据', () => {
    const frozen = freezeChapterGoals(3, '', ['【第3章必现】主角亲眼看见红灯熄灭'])
    const goal = frozen.items[0]!
    const absent = normalizeChapterGoalReview([{ id: goal.id, status: 'unknown', description: '正文没有展示。', evidence: [] }], frozen, '主角走进北塔。', 'zh-CN')
    expect(absent.items[0]).toMatchObject({ status: 'unknown', evidence: [] })
    expect(normalizeChapterGoalReview([{ id: goal.id, status: 'completed', description: '红灯熄灭。', evidence: [{ quote: '红灯在他眼前熄灭。' }] }], frozen, '红灯在他眼前熄灭。', 'zh-CN').items[0]?.status).toBe('completed')
    expect(normalizeChapterGoalReview([{ id: goal.id, status: 'unmet', description: '正文明确相反。', evidence: [{ quote: '红灯始终亮着。' }] }], frozen, '红灯始终亮着。', 'zh-CN').items[0]?.status).toBe('unmet')
  })

  it('软件按原文冻结每个显式条目，不让模型改写目标', () => {
    expect(goals.items.map(item => item.text)).toEqual(['完成相册', '约定周三搬设备'])
    expect(Object.isFrozen(goals.items)).toBe(true)
    const result = normalizeChapterGoalReview(answer, goals, draft, 'zh-CN')
    expect(result.items.map(item => item.status)).toEqual(['completed', 'completed'])
    for (const item of result.items) for (const evidence of item.evidence) {
      expect(draft.slice(evidence.start, evidence.end)).toBe(evidence.quote)
    }
    expect(parseChapterGoalReview(result)).toEqual(result)
  })

  it.each([
    ['漏项', [answer[0]]],
    ['重复项', [answer[0], answer[0], answer[1]]],
    ['改写目标', [{ ...answer[0], text: '准备相册' }, answer[1]]],
    ['未知状态', [{ ...answer[0], status: 'pass' }, answer[1]]],
    ['非逐字引文', [{ ...answer[0], evidence: [{ quote: '她装订完了相册。' }] }, answer[1]]],
    ['完成但无证据', [{ ...answer[0], evidence: [] }, answer[1]]],
    ['错误id', [{ ...answer[0], id: '别的目标' }, answer[1]]],
    ['缺少结果', undefined],
  ])('%s 不得变成全部通过', (_name, raw) => {
    const result = normalizeChapterGoalReview(raw, goals, draft, 'zh-CN')
    expect(result.coverage).toBe('unknown')
    expect(result.items.map(item => item.text)).toEqual(goals.items.map(item => item.text))
    expect(result.items.some(item => item.status === 'unknown')).toBe(true)
    expect(chapterGoalReviewItems(result, 'zh-CN').some(item => item.severity === 'unknown')).toBe(true)
  })

  it('区分有延期证据的未完成和没有充分证据的未知，不额外请求模型', () => {
    const result = normalizeChapterGoalReview([
      { ...answer[0], status: 'unmet', description: '完成动作被推迟。', evidence: [{ quote: '明天再装订' }] },
      { ...answer[1], status: 'unknown', description: '没有找到约定的证据。', evidence: [] },
    ], goals, '她说，明天再装订。', 'zh-CN')
    expect(result.coverage).toBe('complete') // 已覆盖两项，不代表目标已达成。
    expect(result.items.map(item => item.status)).toEqual(['unmet', 'unknown'])
    expect(chapterGoalReviewItems(result, 'zh-CN').map(item => item.severity)).toEqual(['error', 'unknown'])
  })

  it('未配置与来源读取失败均不作为目标验收通过', () => {
    const absent = normalizeChapterGoalReview([], freezeChapterGoals(3, null), draft, 'zh-CN')
    const unavailable = normalizeChapterGoalReview([], freezeChapterGoals(3, undefined), draft, 'zh-CN')
    expect(absent.coverage).toBe('not_configured')
    expect(unavailable.coverage).toBe('unknown')
    expect(chapterGoalReviewItems(absent, 'zh-CN')[0]?.severity).toBe('unknown')
    expect(chapterGoalReviewItems(unavailable, 'zh-CN')[0]?.severity).toBe('unknown')
  })

  it('提示强调到期动作、原意和同一请求，不要求未来行动提前兑现', () => {
    const prompt = buildChapterGoalReviewPrompt(goals, 'zh-CN')
    expect(prompt).toContain('同一 JSON 根对象')
    expect(prompt).toContain('部分完成不等于整项目标完成')
    expect(prompt).toContain('仅当目标要求达成约定时，本章达成约定即可，不要求提前执行')
    expect(prompt).toContain('先按原意区分当章行动与背景/未来约束')
    expect(prompt).toContain('明确延期、拒绝或相反结果')
    expect(prompt).toContain('正文只写走进图书馆：应 unknown，不能判 unmet')
    expect(prompt.indexOf('1. 先按原意')).toBeLessThan(prompt.indexOf('2. 当章到期'))
    expect(prompt.indexOf('2. 当章到期')).toBeLessThan(prompt.indexOf('3. 全部到期'))
    expect(prompt.indexOf('3. 全部到期')).toBeLessThan(prompt.indexOf('4. 仅未提及'))
    expect(prompt).toContain(JSON.stringify(goals))
    expect(prompt).toContain('按 id、evidence、description、status 顺序')
    expect(prompt).toContain('逐个列出目标原文中的每个当章子动作及其判断，再汇总')
    expect(prompt).toContain('任一 unmet → unmet；否则任一 unknown → unknown；仅全部完成 → completed')
  })

  it('目标与作者设定冲突时一律判 unknown 且不改写目标', () => {
    const zh = buildChapterGoalReviewPrompt(goals, 'zh-CN')
    expect(zh).toContain('目标原文与作者确认设定冲突时，无论正文是否写出该冲突内容，都判 unknown（不判 completed 或 unmet），并在 description 说明冲突，仍不得改写目标。')
    const en = buildChapterGoalReviewPrompt(goals, 'en-US')
    expect(en).toContain("If a goal's text conflicts with author-confirmed settings, judge it unknown (never completed or unmet) whether or not the draft contains the conflicting content, and explain the conflict in description. Still do not rewrite the goal.")
  })

  it.each(['“钟楼已经修好。”', '"钟楼已经修好。"', '“钟楼已经修好。”她说。”'])('只容忍一对外围引号：%s', quote => {
    const source = '“钟楼已经修好。”她说。'
    const frozen = freezeChapterGoals(1, '修好钟楼')
    const result = normalizeChapterGoalReview([{ id: frozen.items[0]!.id, status: 'completed', description: '有完成证据。', evidence: [{ quote }] }], frozen, source, 'zh-CN')
    expect(result.items[0]?.status).toBe('completed')
    const evidence = result.items[0]!.evidence[0]!
    expect(source.slice(evidence.start, evidence.end)).toBe(evidence.quote)
    expect(evidence.quote).toBe(quote === '“钟楼已经修好。”' ? quote : quote.slice(1, -1))
  })

  it.each([
    ['只多一个引号', '钟楼已经修好。”', '钟楼已经修好。'],
    ['空白变化', '“钟楼 已经修好。”', '钟楼已经修好。'],
    ['标点变化', '“钟楼已经修好！”', '钟楼已经修好。'],
    ['跳句拼接', '“钟楼已经修好。工匠离开。”', '钟楼已经修好。他锁好大门。工匠离开。'],
    ['外围剥离后重复', '“修好了”', '修好了。他又说修好了。'],
    ['两层包装', '““修好了””', '修好了'],
    ['空包装', '“”', '修好了'],
  ])('%s 仍是未知，不做模糊匹配', (_case, quote, source) => {
    const frozen = freezeChapterGoals(1, '修好钟楼')
    const result = normalizeChapterGoalReview([{ id: frozen.items[0]!.id, status: 'completed', description: '声称完成。', evidence: [{ quote }] }], frozen, source, 'zh-CN')
    expect(result.items[0]?.status).toBe('unknown')
    expect(result.items[0]?.evidence).toEqual([])
  })

  it('不能丢弃一条坏证据后仅靠其他有效引文通过', () => {
    const frozen = freezeChapterGoals(1, '修好钟楼')
    const result = normalizeChapterGoalReview([{ id: frozen.items[0]!.id, status: 'completed', description: '声称完成。',
      evidence: [{ quote: '钟楼修好了' }, { quote: '“工匠不在正文中的回答”' }] }], frozen, '钟楼修好了。', 'zh-CN')
    expect(result.items[0]?.status).toBe('unknown')
    expect(result.items[0]?.evidence).toEqual([])
  })

  it('完全逐字命中的重复引文保留原有首个偏移行为', () => {
    const frozen = freezeChapterGoals(1, '修好钟楼')
    const result = normalizeChapterGoalReview([{ id: frozen.items[0]!.id, status: 'completed', description: '正文有完成描述。',
      evidence: [{ quote: '修好了' }] }], frozen, '修好了。他又说修好了。', 'zh-CN')
    expect(result.items[0]?.status).toBe('completed')
    expect(result.items[0]?.evidence).toEqual([{ quote: '修好了', start: 0, end: 3 }])
  })

  it('读取历史或损坏报告不假造有效目标合同', () => {
    expect(parseChapterGoalReview(undefined)).toBeNull()
    const valid = normalizeChapterGoalReview(answer, goals, draft, 'zh-CN')
    expect(parseChapterGoalReview({ ...valid, items: [{ ...valid.items[0], status: 'pass' }] })).toBeNull()
    expect(parseChapterGoalReview({ ...valid, items: [{ ...valid.items[0], evidence: [] }] })).toBeNull()
    expect(parseChapterGoalReview({ ...valid, items: [valid.items[0], valid.items[0]] })).toBeNull()
  })
})

describe('伏笔线索任务的审稿目标', () => {
  const tasks = [
    { planId: 7, title: '青铜钥匙', authorIntent: '交代钥匙来历。', schedule: { kind: 'overdue', chaptersOverdue: 2 } },
    { planId: 9, title: '雨夜来信', authorIntent: '揭开寄信人。', schedule: { kind: 'due' } },
  ] as const
  const prose = '她用青铜钥匙打开了父亲的木匣，匣底刻着外祖父的名字。窗外雨声渐密。'

  it('每条线索任务一个目标，覆盖率仍只看作者配置的目标', () => {
    const frozen = withChapterThreadGoals(freezeChapterGoals(6, ''), tasks, 'zh-CN')
    expect(frozen.coverage).toBe('not_configured')
    expect(frozen.items.map(item => item.id)).toEqual(['ch6:thread:7', 'ch6:thread:9'])
    expect(frozen.items[0]!.text).toContain('青铜钥匙')
    expect(withChapterThreadGoals(freezeChapterGoals(6, '交还钥匙'), tasks, 'zh-CN').coverage).toBe('complete')
    expect(buildChapterGoalReviewPrompt(frozen, 'zh-CN')).toContain('resolved')
  })

  it('审稿给出回收、推进或未处理之一，回收和推进必须附引文', () => {
    const frozen = withChapterThreadGoals(freezeChapterGoals(6, ''), tasks, 'zh-CN')
    const review = normalizeChapterGoalReview([
      { id: 'ch6:thread:7', status: 'resolved', description: '木匣揭开了钥匙来历。', evidence: [{ quote: '匣底刻着外祖父的名字' }] },
      { id: 'ch6:thread:9', status: 'unaddressed', description: '正文没有写到来信。', evidence: [] },
    ], frozen, prose, 'zh-CN')
    expect(review.coverage).toBe('not_configured')
    expect(review.items.map(item => [item.status, item.threadOutcome])).toEqual([['completed', 'resolved'], ['unknown', 'unaddressed']])
    expect(review.items[0]!.evidence[0]!.quote).toBe('匣底刻着外祖父的名字')
    expect(review.items[0]!.description).toMatch(/^结论：已回收/u)
    expect(review.items[1]!.description).toMatch(/^结论：未处理/u)
    expect(parseChapterGoalReview(review)).toEqual(review)
    const advanced = normalizeChapterGoalReview([
      { id: 'ch6:thread:7', status: 'advanced', description: '钥匙打开了木匣。', evidence: [{ quote: '她用青铜钥匙打开了父亲的木匣' }] },
      { id: 'ch6:thread:9', status: 'advanced', description: '没有引文。', evidence: [] },
    ], frozen, prose, 'zh-CN')
    expect(advanced.items.map(item => [item.status, item.threadOutcome])).toEqual([['completed', 'advanced'], ['unknown', undefined]])
    expect(advanced.coverage).toBe('not_configured')
  })

  it('未处理的结论不能带引文，带了按无效判断处理，存档也不接受', () => {
    const frozen = withChapterThreadGoals(freezeChapterGoals(6, ''), tasks, 'zh-CN')
    const review = normalizeChapterGoalReview([
      { id: 'ch6:thread:7', status: 'unaddressed', description: '钥匙没有交代。', evidence: [{ quote: '她用青铜钥匙打开了父亲的木匣' }] },
      { id: 'ch6:thread:9', status: 'unaddressed', description: '正文没有写到来信。', evidence: [] },
    ], frozen, prose, 'zh-CN')
    expect(review.items.map(item => [item.status, item.threadOutcome, item.evidence.length])).toEqual([['unknown', undefined, 0], ['unknown', 'unaddressed', 0]])
    expect(review.coverage).toBe('not_configured')
    const stored = { ...review, items: [{ ...review.items[1]!, evidence: [{ quote: '窗外雨声渐密', start: 26, end: 32 }] }] }
    expect(parseChapterGoalReview(stored)).toBeNull()
  })

  it('作者目标仍用原来的三种状态，线索结论只能出现在线索目标上', () => {
    const frozen = withChapterThreadGoals(freezeChapterGoals(6, '打开木匣'), tasks.slice(0, 1), 'zh-CN')
    const review = normalizeChapterGoalReview([
      { id: 'ch6:keyEvents:1', status: 'resolved', description: '打开了。', evidence: [{ quote: '她用青铜钥匙打开了父亲的木匣' }] },
      { id: 'ch6:thread:7', status: 'completed', description: '打开了。', evidence: [{ quote: '她用青铜钥匙打开了父亲的木匣' }] },
    ], frozen, prose, 'zh-CN')
    expect(review.items.map(item => [item.status, item.threadOutcome])).toEqual([['unknown', undefined], ['unknown', undefined]])
    expect(review.coverage).toBe('unknown')
    const valid = normalizeChapterGoalReview([
      { id: 'ch6:keyEvents:1', status: 'completed', description: '打开了。', evidence: [{ quote: '她用青铜钥匙打开了父亲的木匣' }] },
      { id: 'ch6:thread:7', status: 'advanced', description: '推进。', evidence: [{ quote: '她用青铜钥匙打开了父亲的木匣' }] },
    ], frozen, prose, 'zh-CN')
    expect(parseChapterGoalReview({ ...valid, items: [{ ...valid.items[0], threadOutcome: 'resolved' }, valid.items[1]] })).toBeNull()
    expect(parseChapterGoalReview({ ...valid, items: [valid.items[0], { ...valid.items[1], threadOutcome: 'finished' }] })).toBeNull()
  })
})
