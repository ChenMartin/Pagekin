import assert from 'node:assert/strict'

import * as blueprint from './pages/blueprint.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { seedStageSample } from './scenarios.mjs'

const closeSheet = page => runSheet.sheet(page).getByRole('button', { name: '收起运行侧页' }).first().click()

/** 生成一次第 from–to 章蓝图，等它发出请求并结束（完成或失败），再收起侧页，下一次生成才能分出是否已开始。 */
async function generate(page, fake, from, to, status) {
  const before = fake.chats.length
  await blueprint.generateRange(page, from, to)
  await runSheet.waitUntilOpen(page)
  for (const deadline = Date.now() + 60_000; fake.chats.length === before; await page.waitForTimeout(100))
    assert.ok(Date.now() < deadline, `第 ${from}–${to} 章的蓝图生成没有发出模型请求`)
  await runSheet.sheet(page).getByRole('button', { name: /^取消「/ }).waitFor({ state: 'detached', timeout: 90_000 })
  await runSheet.lastRun(page).locator('.run-card-meta').filter({ hasText: status }).waitFor({ state: 'visible', timeout: 90_000 })
  await closeSheet(page)
  await runSheet.sheet(page).waitFor({ state: 'hidden' })
}

/** 主进程答完一次可恢复列表的读取，再等两帧交给 React 渲染。 */
async function recoveryListed(app, page) {
  await app.evaluate(({ ipcMain }) => {
    globalThis.__i608Reads = 0
    if (globalThis.__i608Wrapped) return
    globalThis.__i608Wrapped = true
    const original = ipcMain._invokeHandlers.get('generation:list-recovery')
    ipcMain._invokeHandlers.set('generation:list-recovery', async (...args) => {
      const result = await original(...args)
      globalThis.__i608Reads += 1
      return result
    })
  })
  await runSheet.openFromPalette(page)
  for (const deadline = Date.now() + 10_000; ; await page.waitForTimeout(50)) {
    if (await app.evaluate(() => globalThis.__i608Reads) > 0) break
    assert.ok(Date.now() < deadline, '10 秒内运行侧页没有读可恢复列表')
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

function recoveryCards(page) {
  return runSheet.sheet(page).getByRole('article').evaluateAll(cards => cards
    .filter(card => card.querySelector('.run-card-kicker')?.textContent === '可恢复')
    .map(card => ({ title: card.querySelector('h3')?.textContent ?? '', meta: card.querySelector('.run-card-heading .run-card-meta')?.textContent ?? '',
      earlier: card.querySelector('.run-earlier > summary')?.textContent ?? '',
      notes: [...card.querySelectorAll(':scope > .run-note')].map(note => note.textContent ?? '') })))
}

export const I608_SCENARIOS = {
  /**
   * #608：第 13–14 章蓝图生成完成；第 15–16 章连着失败两次；作者再改第 13 章标题并保存。
   */
  'i608-recovery-pile': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ app, page, fake, shoot }) => {
    await blueprint.open(page)
    fake.replyDirectoryBlueprints()
    await generate(page, fake, 13, 14, '已完成')
    fake.replyDirectoryBlueprints(false)
    for (let attempt = 0; attempt < 2; attempt++) await generate(page, fake, 15, 16, '失败')
    await blueprint.planItem(page, 13).click()
    await blueprint.titleInput(page).fill('第十三夜改名')
    await page.keyboard.press('ControlOrMeta+S')
    await stage.saveStatus(page).getByText('已保存').waitFor({ state: 'visible' })
    await recoveryListed(app, page)
    const cards = await recoveryCards(page)
    await shoot('i608-run-sheet')
    assert.deepEqual(cards.map(card => [card.title, card.earlier]), [['蓝图恢复稿 · 第 15–16 章', '更早的 1 份']])
    assert.match(cards[0].meta, /^缺第 15–16 章 · \d+月\d+日 \d{2}:\d{2} 生成$/u)

    const sheet = runSheet.sheet(page)
    await sheet.locator('.run-earlier > summary').click()
    await sheet.locator('.run-earlier-item').first().waitFor({ state: 'visible' })
    await shoot('i608-run-sheet-earlier')

    await sheet.locator('.run-recovery > .run-card > .run-card-buttons').getByRole('button', { name: '放弃…' }).click()
    await sheet.getByRole('group').getByText('正式内容不受影响；放弃后这份恢复稿不再列出。').waitFor({ state: 'visible' })
    await shoot('i608-run-sheet-dismiss-confirm')
    await sheet.getByRole('group').getByRole('button', { name: '放弃', exact: true }).click()
    await sheet.locator('.run-earlier').waitFor({ state: 'detached' })
    const afterDismiss = await recoveryCards(page)
    await shoot('i608-run-sheet-dismissed')
    assert.deepEqual(afterDismiss.map(card => [card.title, card.earlier]), [['蓝图恢复稿 · 第 15–16 章', '']])
    return { cards, afterDismiss }
  } },
}
