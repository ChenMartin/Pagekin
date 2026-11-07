import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { FIXTURE_PROSE } from './fake-model.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import { firstLine, seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

const PLANS = Object.freeze([
  { title: '青铜钥匙', type: '伏笔', targetStartChapter: 1, targetEndChapter: 2, authorIntent: '第二章揭示钥匙能打开灯室。' },
  { title: '父亲的旧信', type: '伏笔', targetStartChapter: 3, targetEndChapter: 5, authorIntent: '第五章林岚读到父亲的旧信。' },
])

const seed = context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path, session }) => {
  const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(), chapters: [3, 4].map((number) => {
    const content = STAGE_SAMPLE.drafts[number].text
    return { chapterNumber: number, title: stageChapterTitle(number), content, wordCount: countUnits(content) }
  }) }, path, session)
  assert.equal(imported.success, true, imported.error)
  for (const plan of PLANS) {
    const created = await invoke(page, 'db:narrative-thread-plan-create', plan, path, session)
    assert.equal(created.success, true, created.error)
  }
} })

export const A11_SCENARIOS = {
  'a11-overdue-thread-prompt': { model: true, shell: 'stage', setup: seed, run: async ({ page, fake }) => {
    await chapterView.open(page, 5)
    const proseBefore = fake.chats.filter(chat => chat.kind === 'prose').length
    await chapterView.view(page).getByRole('button', { name: '写作此章', exact: true }).click()
    await chapterView.prose(page).getByText(firstLine(FIXTURE_PROSE)).first().waitFor({ state: 'visible', timeout: 90_000 })
    const prose = fake.chats.filter(chat => chat.kind === 'prose').slice(proseBefore)
    assert.equal(prose.length, 1, '写第 5 章只发一次正文请求')
    const prompt = prose[0].messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
    const line = title => prompt.split('\n').find(text => text.startsWith(`- ${title} `)) ?? ''
    const measured = { overdue: line('青铜钥匙'), due: line('父亲的旧信') }
    assert.match(measured.overdue, /已逾期 3 章/, '计划第 1–2 章的线索在写第 5 章时标已逾期 3 章')
    assert.match(measured.due, /本章到期/, '计划第 3–5 章的线索在第 5 章标本章到期')
    await refs.open(page, 'plot')
    await refs.plotView(page, '伏笔线索').click()
    await page.getByText('写正文时会参考这里，到期和逾期的排在最前。', { exact: false }).waitFor({ state: 'visible' })
    return measured
  } },
}
