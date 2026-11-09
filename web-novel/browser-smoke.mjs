// Optional browser check. Set BROWSER_EXE to a Chromium or Edge executable.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const executable = process.env.BROWSER_EXE
if (!executable) throw new Error('Set BROWSER_EXE to a Chromium executable')
const root = await mkdtemp(join(tmpdir(), 'pagekin-browser-'))
const password = 'browser-test-local-only'
let app, browser, socket

async function until(action, message) {
  const deadline = Date.now() + 8000
  let latest
  while (Date.now() < deadline) {
    try {
      const result = await action()
      if (result) return result
    } catch (error) { latest = error }
    await delay(70)
  }
  throw new Error(message, { cause: latest })
}

try {
  const entry = process.env.PAGEKIN_TEST_APP_DIR
    ? join(process.env.PAGEKIN_TEST_APP_DIR, 'server.mjs')
    : fileURLToPath(new URL('./server.mjs', import.meta.url))
  app = spawn(process.execPath, [entry], {
    env: { ...process.env, APP_PASSWORD: password, APP_PASSWORD_FILE: '', APP_SECURE_COOKIE: '0',
      APP_ORIGIN: '', APP_HOST: '127.0.0.1', PORT: '0', APP_DATA_DIR: join(root, 'data'),
      LLM_MODEL: 'preview-only', LLM_BASE_URL: 'http://127.0.0.1:1', LLM_API_KEY: '', LLM_CONTEXT_CHARS: '8000' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const [chunk] = await Promise.race([once(app.stdout, 'data'), delay(5000).then(() => { throw new Error('App failed to start') })])
  const { port } = JSON.parse(chunk.toString().split('listening on ')[1])
  const url = `http://127.0.0.1:${port}/`
  browser = spawn(executable, [
    '--headless=new', '--disable-gpu', '--disable-background-networking', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${join(root, 'profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' })
  const devtools = await until(async () => (await readFile(join(root, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0],
    'Browser did not open DevTools')
  const targets = await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json()
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const requests = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const request = requests.get(message.id)
    if (!request) return
    requests.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  function command(method, params) {
    return new Promise((resolve, reject) => {
      requests.set(++id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evaluate(expression) {
    const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || 'Browser script failed')
    return response.result.value
  }
  const visible = selector => until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`), `Missing ${selector}`)
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const fill = (selector, value) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const saved = revision => until(() => evaluate(`document.querySelector('#save-state')?.textContent === '已保存到 NAS · v${revision}'`), 'Autosave did not complete')
  const modal = async (selector, value) => {
    await visible(selector)
    await fill(selector, value)
    await click('#dialog-submit')
    await until(() => evaluate("!document.querySelector('#dialog').open"), 'Dialog submission did not complete')
  }

  await command('Page.navigate', { url })
  await visible('#login')
  await fill('#login input', password)
  await click('#login button')
  await visible('#new-project')
  await click('#new-project')
  await modal('#dialog input', '测试作品')
  await click('#rename-project')
  await modal('#dialog input', '测试作品改名')
  assert.equal(await evaluate("document.querySelector('#projects').selectedOptions[0].textContent"), '测试作品改名')
  await click('#new-document')
  await modal('#dialog input', '测试章节')
  await visible('#body')
  await fill('#body', '自动保存的中文稿')
  await saved(2)
  await command('Page.reload')
  assert.equal(await until(() => evaluate("document.querySelector('#body')?.value"), 'Chapter did not reopen'), '自动保存的中文稿')

  await command('Network.enable')
  await command('Network.setBlockedURLs', { urls: ['*/api/projects/*/documents/*'] })
  await fill('#body', '暂时断网的本机稿')
  await until(() => evaluate("document.querySelector('#save-state').textContent.includes('连接失败，将重试')"), 'Offline save did not stay in IndexedDB')
  await command('Network.setBlockedURLs', { urls: [] })
  await command('Page.reload')
  await visible('#recover')
  await click('#recover')
  await click('#dialog-body button')
  await click('#dialog-submit')
  await saved(3)
  assert.equal(await evaluate("document.querySelector('#body').value"), '暂时断网的本机稿')
  await click('#reference-library')
  await visible('#dialog-body button')
  await evaluate(`(() => {
    const input = document.querySelector('#reference-file');
    const files = new DataTransfer();
    files.items.add(new File(['古灯塔的背景资料'], '海边地理.txt', { type: 'text/plain' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change'));
  })()`)
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('海边地理')"), 'Reference did not appear')
  await click('#close-dialog')
  await click('#search-project')
  await visible('#dialog input')
  await fill('#dialog input', '灯塔')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('古灯塔的背景资料')"), 'Reference did not appear in search')
  await click('#dialog-body button')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '海边地理'"), 'Reference did not open')
  await click('#dialog-submit')
  await until(() => evaluate("!document.querySelector('#dialog').open"), 'Reference was not selected')
  await fill('#reference-query', '灯塔')
  await click('#preview-context')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('古灯塔的背景资料') && document.querySelector('#dialog-body').textContent.includes('预览不会调用模型')"), 'AI context preview did not show selected material')
  await click('#close-dialog')
  assert.equal(await evaluate(`(async () => {
    const [project, doc] = JSON.parse(sessionStorage.getItem('pagekin-location'));
    const response = await fetch('/api/projects/' + project + '/documents/' + doc, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '测试章节', body: '另一设备的新稿', baseRev: 3, mutationId: crypto.randomUUID() }),
    });
    return response.status;
  })()`), 200)
  await visible('#reload-remote')
  await fill('#body', '这台设备的稿')
  await click('#reload-remote')
  await visible('#conflict')
  await click('#conflict')
  await until(() => evaluate("document.querySelector('#dialog').open && document.querySelector('#dialog-title').textContent === '比较并处理版本冲突'"), 'Conflict comparison did not open')
  assert.match(await evaluate("document.querySelector('#dialog-body').textContent"), /另一设备的新稿/)
  assert.match(await evaluate("document.querySelector('#dialog-body').textContent"), /这台设备的稿/)
  await click('#close-dialog')
  await click('#narrative-threads')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '剧情线索与伏笔'"), 'Narrative threads did not load')
  await click('#dialog-body button')
  await fill('#dialog input', '旧船票')
  await fill('#dialog textarea', '留意船票背面的号码')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '剧情线索与伏笔' && document.querySelector('#dialog-body').textContent.includes('旧船票')"), 'Thread was not saved')
  await click('#close-dialog')
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await until(() => evaluate('innerWidth === 390 && document.documentElement.scrollWidth <= innerWidth'), 'Narrow layout overflows')
  await click('#new-document')
  await modal('#dialog input', '第二章')
  await fill('#body', '灯塔.A、灯塔.a、灯塔Za')
  await saved(2)
  await click('#open-find')
  await fill('#find-query', '灯塔.A')
  await until(() => evaluate("document.querySelector('#find-result').textContent.includes('2 处')"), 'Literal find did not count matches')
  await click('#find-next')
  assert.equal(await evaluate("(() => { const el = document.querySelector('#body'); return el.value.slice(el.selectionStart, el.selectionEnd) })()"), '灯塔.A')
  await fill('#replace-query', '海岸')
  await click('#replace-all')
  await until(() => evaluate("document.querySelector('#dialog').open && document.querySelector('#dialog-title').textContent === '确认全部替换'"), 'Replace confirmation missing')
  await click('#dialog-submit')
  await saved(3)
  assert.equal(await evaluate("document.querySelector('#body').value"), '海岸、海岸、灯塔Za')
  await click('#undo-replace')
  await saved(4)
  assert.equal(await evaluate("document.querySelector('#body').value"), '灯塔.A、灯塔.a、灯塔Za')
  await click('#previous-chapter')
  await until(() => evaluate("document.querySelector('#body').value === '另一设备的新稿'"), 'Previous chapter did not load')
  await click('#next-chapter')
  await until(() => evaluate("document.querySelector('#body').value === '灯塔.A、灯塔.a、灯塔Za'"), 'Next chapter did not load')
  await fill('#body', '上面的文字\n'.repeat(140) + '章节末尾')
  await saved(5)
  await click('#open-find')
  await fill('#find-query', '章节末尾')
  await click('#find-next')
  assert.ok(await evaluate("document.querySelector('#body').scrollTop > 1000"), 'Find did not reveal a match outside the viewport')
  await click('#status')
  await until(() => evaluate("document.querySelector('#body').readOnly && document.querySelector('#status').textContent === '重新打开定稿'"), 'Chapter did not finalize')
  await click('#open-find')
  await fill('#find-query', '章节末尾')
  await click('#find-next')
  assert.equal(await evaluate("document.querySelector('#replace-tools').hidden"), true)
  await click('#close-find')
  await evaluate(`(() => {
    const input = document.querySelector('#manuscript-file');
    const files = new DataTransfer();
    files.items.add(new File(['## 第一章：靠岸\\n码头上有人。\\n## Chapter 2: Beacon\\n灯亮了。'], '整稿.md', { type: 'text/markdown' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change'));
  })()`)
  await until(() => evaluate("document.querySelector('#dialog').open && document.querySelector('#dialog-title').textContent === '预览整稿导入'"), 'Manuscript preview did not open')
  assert.match(await evaluate("document.querySelector('.manuscript-list').textContent"), /第 3 章 · 靠岸/)
  await click('.manuscript-list section:nth-child(2) input')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#title').value === '靠岸'"), 'Selected chapter was not imported')
  assert.equal(await evaluate("document.querySelector('#body').value"), '码头上有人。')
  assert.equal(await evaluate("document.querySelector('#documents').options.length"), 4)
  await click('#previous-chapter')
  await until(() => evaluate("document.querySelector('#title').value === '第二章' && document.querySelector('#body').readOnly"), 'Existing chapter changed after import')
  console.log('Browser workflow passed: autosave, recovery, context preview, remote updates, threads, editing and import')
} finally {
  socket?.close()
  for (const child of [browser, app]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
