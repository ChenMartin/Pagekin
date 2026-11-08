import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import * as stage from './pages/stage.mjs'

function folderBytes(folder) {
  return Object.fromEntries(fs.readdirSync(folder).sort().map(name => [name, fs.readFileSync(path.join(folder, name), 'utf8')]))
}

export const I626_SCENARIOS = {
  'i626-md-folder-legacy-import': { model: false, shell: 'stage', run: async ({ app, page, roots }) => {
    const folder = path.join(roots.temp, 'AI稿子')
    const copyParent = path.join(roots.temp, '副本位置')
    fs.mkdirSync(folder)
    fs.mkdirSync(copyParent)
    for (let chapter = 1; chapter <= 15; chapter += 1) fs.writeFileSync(path.join(folder, `第${chapter}章.md`), `# 第${chapter}章\n\n正文。\n`)
    const before = folderBytes(folder)
    await app.evaluate(({ dialog }, { folder: chosen, copyParent: parent }) => {
      dialog.showOpenDialog = async options => ({ canceled: false, filePaths: [options.title === '选择旧版小说项目文件夹' ? chosen : parent] })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    }, { folder, copyParent })

    await stage.importLegacyCopy(page)
    const notice = stage.root(page).locator('[role="status"]').filter({ hasText: '导入旧项目副本' })
    await notice.waitFor({ state: 'visible', timeout: 15_000 })
    const shown = (await notice.innerText()).trim()

    assert.doesNotMatch(shown, /LEGACY_IMPORT/u, `提示不露原码，实际：${shown}`)
    assert.match(shown, /不是旧版项目/u, `提示说明这个文件夹不是旧版项目，实际：${shown}`)
    assert.match(shown, /原文件没有改动/u, `提示说明原文件没动，实际：${shown}`)
    assert.ok(!shown.includes(folder), `提示不带路径，实际：${shown}`)
    for (const button of ['小说拆解与仿写', '打开作品']) {
      assert.match(shown, new RegExp(`「${button}」`, 'u'), `提示点名入口「${button}」，实际：${shown}`)
      await stage.root(page).getByRole('button', { name: button, exact: true }).waitFor({ state: 'visible' })
    }
    assert.deepEqual(folderBytes(folder), before, '所选文件夹的文件没有变化')
    assert.deepEqual(fs.readdirSync(copyParent), [], '副本位置没有留下文件')
    return { notice: shown }
  } },
}
