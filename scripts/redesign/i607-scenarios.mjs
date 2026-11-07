import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import * as stage from './pages/stage.mjs'
import { openInUi } from './f491-scenarios.mjs'
import { confirmAndWait, EMPTY_BOOK, inferenceReply, manuscript, openAuthorImport, seedEmptyBook } from './import-infer-scenarios.mjs'

const Database = createRequire(import.meta.url)('better-sqlite3')

function readImportLedger(projectRoot) {
  const database = new Database(path.join(projectRoot, '.ai-novel', 'project.db'), { readonly: true, fileMustExist: true })
  try {
    return {
      receipts: database.prepare('SELECT effect_namespace AS namespace,effect_key AS key FROM import_run_receipts ORDER BY stage,batch_id').all(),
      ledger: database.prepare("SELECT effect_namespace AS namespace,effect_key AS key FROM import_effect_ledger WHERE evidence_kind='receipt' ORDER BY stage,batch_id").all(),
      runs: database.prepare('SELECT id,effect_namespace AS namespace,status FROM import_runs ORDER BY id').all(),
    }
  } finally { database.close() }
}

async function backupNotice(page, previous = '正在读取云备份配置') {
  const notice = stage.root(page).locator('[data-testid="project-backup-panel"] p[role="status"], [data-testid="project-backup-panel"] p[role="alert"]')
    .filter({ hasNotText: '正在读取云备份配置' }).filter({ hasNotText: previous }).last()
  await notice.waitFor({ state: 'visible', timeout: 60_000 })
  return { role: await notice.getAttribute('role'), text: (await notice.innerText()).trim() }
}

export const I607_SCENARIOS = {
  'i607-archive-after-import': { model: true, shell: 'stage', setup: seedEmptyBook, run: async context => {
    const { app, page, roots, fake, shoot } = context
    fake.replyReview(inferenceReply)
    const dialog = await openAuthorImport(app, page, EMPTY_BOOK, manuscript(roots, [[1, '匿名信'], [2, '茶馆'], [3, '河对岸']]))
    await confirmAndWait(page, dialog, 3)
    const opened = await app.evaluate(() => globalThis.__driveOpened)
    assert.ok(opened?.projectPath, '记下了界面打开作品的会话')
    const { projectPath } = opened
    const source = readImportLedger(projectPath)
    assert.ok(source.receipts.length >= 2, `原稿导入留下多条回执：${source.receipts.length}`)

    const archive = path.join(roots.projects, '雨城存档.ainovel')
    const restoreParent = path.join(roots.projects, 'i607-restore')
    fs.mkdirSync(restoreParent)
    await app.evaluate(({ dialog: electronDialog }, paths) => {
      const opens = [[paths.archive], [paths.restoreParent]]
      electronDialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.archive })
      electronDialog.showOpenDialog = async () => ({ canceled: false, filePaths: opens.shift() ?? (() => { throw new Error('I607_UNEXPECTED_OPEN_DIALOG') })() })
    }, { archive, restoreParent })

    await stage.openSettings(page)
    await stage.showSettingsPage(page, '项目备份')
    await stage.root(page).getByRole('button', { name: '导出本地存档', exact: true }).click()
    const exported = await backupNotice(page)
    await shoot('i607-1-export')
    assert.equal(exported.role, 'status', `导出成功：${exported.text}`)
    assert.match(exported.text, /^本地存档已导出：[a-f0-9]{64}$/u)
    assert.equal(fs.existsSync(archive), true, '存档文件写到了所选位置')

    await stage.root(page).getByRole('button', { name: '从本地存档恢复副本', exact: true }).click()
    const restoredNotice = await backupNotice(page, '本地存档已导出')
    await shoot('i607-2-restore')
    assert.equal(restoredNotice.role, 'status', `恢复成功：${restoredNotice.text}`)
    const restoredText = restoredNotice.text
    const [, restoredProjectId, restoredRoot] = /^已恢复新副本 (\S+)：(.+)$/u.exec(restoredText) ?? []
    assert.ok(restoredRoot && fs.existsSync(restoredRoot), `恢复副本路径存在：${restoredText}`)

    const restored = readImportLedger(restoredRoot)
    assert.deepEqual(restored.receipts, source.receipts, '副本的回执命名空间与效果键与原作品一致')
    assert.deepEqual(restored.ledger, source.ledger, '副本的导入账本与原作品一致')
    assert.deepEqual(restored.runs, source.runs, '副本的导入运行保留命名空间与终态')
    await openInUi(context, restoredRoot)
    const reopened = await app.evaluate(() => globalThis.__driveOpened)
    assert.equal(reopened?.projectId, restoredProjectId, '界面打开的是恢复副本')
    await shoot('i607-3-restored-open')
    return { exported, restoredText, receipts: source.receipts.length, runs: restored.runs }
  } },
}
