// Optional browser check. Set BROWSER_EXE to a Chromium or Edge executable.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { sampleEpub } from './epub-test-fixture.mjs'

const executable = process.env.BROWSER_EXE
if (!executable) throw new Error('Set BROWSER_EXE to a Chromium executable')
const root = await mkdtemp(join(tmpdir(), 'pagekin-browser-'))
const password = 'browser-test-local-only'
const revisionLines = Array.from({ length: 14 }, (_, index) => `原稿第 ${index + 1} 段`)
const revisionCandidate = revisionLines.join('\n\n').replaceAll('原稿', '修稿')
let app, browser, socket
const modelMock = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const payload = JSON.parse(Buffer.concat(chunks))
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const instruction = payload.messages[0].content
    let content = '本章先调查船票。'
    let finish = 'stop'
    if (payload.messages.at(-1).content.includes('浏览器续跑演练')) {
      const anchor = '船票背面写着失踪水手的名字。'
      if (instruction.includes('中断后续写')) content = anchor + '　　她听见了开船的汽笛。'
      else { content = anchor + '忽然'; finish = 'length' }
    }
    if (instruction.includes('返回修订后的完整正文')) content = revisionCandidate
    if (instruction.includes('生成当前章的章节蓝图')) content = '## 章目标\n找出失踪船票。'
    if (instruction.includes('本次只生成「世界观」模块')) content = '## 世界规则\n灯塔每月熄灭一天。'
    if (instruction.includes('你是小说研究助手')) content = JSON.stringify({
      structure: '开篇先交代行动目标', style: '用动作表现人物', constraints: '用场景后果推动下一场冲突。',
      chapters: [...payload.messages.at(-1).content.matchAll(/【位置 (\d+) · /g)].map(([, position]) => ({
        position: Number(position), summary: '主角看见轮渡', blueprint: '登船后呈现阻力',
      })),
    })
    if (payload.messages.at(-1).content.includes('【整书归纳】')) content = JSON.stringify({
      structure: '首尾呼应', style: '用动作表现人物', constraints: '用场景后果推动下一场冲突。',
    })
    if (instruction.includes('只返回替换片段')) content = '新的选段。'
    if (instruction.includes('你是小说连载助手')) content = JSON.stringify({ changes: [
      { field: 'location', value: '到了码头出口', quote: '章节末尾' },
      { field: 'keyItems', value: '旧船票', quote: '没有这句原文' },
    ] })
    if (instruction.includes('审查当前正文')) content = JSON.stringify({ issues: [
      { title: '补写动作', severity: 'major', quote: '断网的本机', reason: '缺少动作', suggestion: '加入登船动作' },
      { title: '模型误引', severity: 'minor', quote: '原文没有这句话', reason: '引文待核对', suggestion: '调整灯塔描写' },
    ] })
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n')
    return
  }
  const { input } = payload
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }))
})

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
  modelMock.listen(0, '127.0.0.1')
  await once(modelMock, 'listening')
  const modelBase = `http://127.0.0.1:${modelMock.address().port}/v1`
  const entry = process.env.PAGEKIN_TEST_APP_DIR
    ? join(process.env.PAGEKIN_TEST_APP_DIR, 'server.mjs')
    : fileURLToPath(new URL('./server.mjs', import.meta.url))
  app = spawn(process.execPath, [entry], {
    env: { ...process.env, APP_PASSWORD: password, APP_PASSWORD_FILE: '', APP_SECURE_COOKIE: '0',
      APP_ORIGIN: '', APP_HOST: '127.0.0.1', PORT: '0', APP_DATA_DIR: join(root, 'data'),
      APP_EDITOR: process.env.PAGEKIN_TEST_EDITOR === 'plain' ? 'plain' : 'auto',
      EMBEDDING_BASE_URL: modelBase,
      EMBEDDING_MODEL: 'preview-embedding', EMBEDDING_API_KEY: '',
      LLM_MODEL: 'writing-mock', LLM_BASE_URL: modelBase, LLM_API_KEY: '', LLM_CONTEXT_CHARS: '8000',
      LLM_PROFILES_FILE: '', LLM_PROFILES_JSON: JSON.stringify([
        { id: 'browser-alt', label: '浏览器备选模型', baseUrl: modelBase, model: 'writing-alternate', contextChars: 12000 },
      ]) },
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
  async function reload() {
    await evaluate("document.documentElement.dataset.smokeReload = 'pending'")
    await command('Page.reload')
    await until(() => evaluate("!document.documentElement.dataset.smokeReload"), 'Page did not reload')
  }
  let enhanced = false
  const bodyText = "(document.querySelector('#body').hidden ? Array.from(document.querySelectorAll('.cm-content .cm-line'), line => line.textContent).join('\\n') : document.querySelector('#body').value)"
  const readOnly = "(document.querySelector('#body').hidden ? document.querySelector('.cm-content')?.getAttribute('aria-readonly') === 'true' : document.querySelector('#body').readOnly)"
  async function fillBody(text) {
    if (!enhanced) return fill('#body', text)
    await evaluate("document.querySelector('.cm-content').focus()")
    await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await command('Input.insertText', { text })
  }
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
  await visible('#editor')
  enhanced = await evaluate("!document.querySelector('#body-editor-host').hidden")
  if (process.env.PAGEKIN_TEST_EDITOR === 'enhanced') assert.equal(enhanced, true, 'CodeMirror did not load')
  if (process.env.PAGEKIN_TEST_EDITOR === 'plain') assert.equal(enhanced, false)
  if (enhanced) {
    const nonce = await evaluate("document.querySelector('meta[name=editor-style-nonce]').content")
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('style')).some(style => style.nonce === ${JSON.stringify(nonce)})`), 'CodeMirror style was not nonce-authorized')
    await evaluate("document.querySelector('.cm-content').focus()")
    await command('Input.imeSetComposition', { text: '自动保存的中文稿', selectionStart: 8, selectionEnd: 8 })
    await delay(1700)
    assert.equal(await evaluate("document.querySelector('#save-state').textContent.includes('v2')"), false, 'IME preedit was committed early')
    await command('Input.insertText', { text: '自动保存的中文稿' })
  } else await fillBody('自动保存的中文稿')
  await saved(2)
  await reload()
  await until(() => evaluate(bodyText + " === '自动保存的中文稿'"), 'Chapter did not reopen')

  await command('Network.enable')
  await command('Network.setBlockedURLs', { urls: ['*/api/projects/*/documents/*'] })
  await fillBody('暂时断网的本机稿')
  await until(() => evaluate("document.querySelector('#save-state').textContent.includes('连接失败，将重试')"), 'Offline save did not stay in IndexedDB')
  await command('Network.setBlockedURLs', { urls: [] })
  await reload()
  await visible('#recover')
  await click('#recover')
  await click('#dialog-body button')
  await click('#dialog-submit')
  await saved(3)
  assert.equal(await evaluate(bodyText), '暂时断网的本机稿')
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
  await click('#semantic-search')
  await visible('#dialog input[type=search]')
  await until(() => evaluate("!document.querySelector('#dialog-body button').disabled"), 'Index control did not load')
  await click('#dialog-body button')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('已完成 1 / 1')"), 'Reference index did not complete')
  await fill('#dialog input[type=search]', '海岸的导航建筑')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('古灯塔的背景资料')"), 'Semantic search did not find the reference')
  await click('#dialog-body section button')
  await until(() => evaluate("document.querySelector('#dialog-submit').textContent === '引用这个片段'"), 'Semantic excerpt did not open')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#selected-references').textContent.includes('（片段）')"), 'Semantic excerpt was not selected')
  await click('[data-run=outline]')
  await visible('#use-outline')
  assert.equal(await evaluate("document.querySelector('#apply-run').hidden"), true)
  await click('#use-outline')
  await click('#preview-context')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('【已选写前细纲】') && document.querySelector('#dialog-body').textContent.includes('本章先调查船票。')"), 'Selected outline did not enter the draft preview')
  await click('#close-dialog')
  await click('#clear-outline')
  await click('[data-run=review]')
  await visible('#review-report')
  assert.match(await evaluate("document.querySelector('#review-list').textContent"), /在该版本未找到引文/)
  assert.equal(await evaluate("document.querySelectorAll('#review-list input').length"), 1)
  await click('#review-list button')
  assert.equal(await evaluate(enhanced ? 'String(window.getSelection())' : "document.querySelector('#body').value.slice(document.querySelector('#body').selectionStart, document.querySelector('#body').selectionEnd)"), '断网的本机')
  await click('#review-list input')
  await click('#use-review-issues')
  const revisedGuidance = await evaluate("document.querySelector('#guidance').value")
  assert.match(revisedGuidance, /加入登船动作/)
  assert.doesNotMatch(revisedGuidance, /调整灯塔描写/)
  assert.equal(await evaluate(bodyText), '暂时断网的本机稿')
  await click('#preview-context')
  await fill('#dialog select', 'revise')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('加入登船动作')"), 'Selected issue did not enter the revision preview')
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
  assert.equal(await evaluate("document.querySelector('#review-issues').disabled"), true)
  await fillBody('这台设备的稿')
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
  await fillBody('灯塔.A、灯塔.a、灯塔Za')
  await saved(2)
  await click('#open-find')
  await fill('#find-query', '灯塔.A')
  await until(() => evaluate("document.querySelector('#find-result').textContent.includes('2 处')"), 'Literal find did not count matches')
  await click('#find-next')
  const selectedText = enhanced ? 'window.getSelection().toString()'
    : "(() => { const el = document.querySelector('#body'); return el.value.slice(el.selectionStart, el.selectionEnd) })()"
  await until(() => evaluate(selectedText + " === '灯塔.A'"), 'Find did not select a match')
  await fill('#replace-query', '海岸')
  await click('#replace-all')
  await until(() => evaluate("document.querySelector('#dialog').open && document.querySelector('#dialog-title').textContent === '确认全部替换'"), 'Replace confirmation missing')
  await click('#dialog-submit')
  await saved(3)
  assert.equal(await evaluate(bodyText), '海岸、海岸、灯塔Za')
  await click('#undo-replace')
  await saved(4)
  assert.equal(await evaluate(bodyText), '灯塔.A、灯塔.a、灯塔Za')
  await click('#previous-chapter')
  await until(() => evaluate(bodyText + " === '另一设备的新稿'"), 'Previous chapter did not load')
  await click('#next-chapter')
  await until(() => evaluate(bodyText + " === '灯塔.A、灯塔.a、灯塔Za'"), 'Next chapter did not load')
  await fillBody('上面的文字\n'.repeat(140) + '章节末尾')
  await saved(5)
  await click('#open-find')
  await fill('#find-query', '章节末尾')
  await click('#find-next')
  await until(() => evaluate((enhanced ? "document.querySelector('.cm-scroller')" : "document.querySelector('#body')") + '.scrollTop > 1000'),
    'Find did not reveal a match outside the viewport')
  await click('#status')
  await until(() => evaluate(readOnly + " && document.querySelector('#status').textContent === '重新打开定稿'"), 'Chapter did not finalize')
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
  assert.equal(await evaluate(bodyText), '码头上有人。')
  assert.equal(await evaluate("document.querySelector('#documents').options.length"), 4)
  await click('#previous-chapter')
  await until(() => evaluate("document.querySelector('#title').value === '第二章' && " + readOnly), 'Existing chapter changed after import')
  await click('#next-chapter')
  await until(() => evaluate("document.querySelector('#title').value === '靠岸'"), 'Imported draft did not reopen')
  await fillBody(revisionLines.join('\n\n'))
  await saved(2)
  await click('#ai summary')
  await click('[data-run=revise]')
  await visible('#apply-run')
  await click('#apply-run')
  await visible('.revision-list input')
  assert.equal(await evaluate("document.querySelectorAll('.revision-list input:checked').length"), 0)
  await click('.revision-list input')
  await evaluate("Array.from(document.querySelectorAll('#dialog-body button')).find(button => button.textContent === '下一页').click()")
  await until(() => evaluate("document.querySelector('.revision-list').textContent.includes('采纳改动 14')"), 'Revision preview did not change pages')
  await click('.revision-list article:last-child input')
  assert.match(await evaluate("document.querySelector('#dialog-body [role=status]').textContent"), /已选 2 \/ 14/)
  await click('#dialog-submit')
  await saved(3)
  const expected = revisionLines.map((line, index) => [0, 13].includes(index) ? line.replace('原稿', '修稿') : line).join('\n\n')
  assert.equal(await evaluate(bodyText), expected)
  for (const title of ['批次甲', '批次乙']) {
    await click('#new-document')
    await modal('#dialog input', title)
  }
  await click('#batch-writing')
  await visible('#dialog-body button')
  await click('#dialog-body button')
  await visible('.batch-list input')
  assert.equal(await evaluate("document.querySelectorAll('.batch-list input').length"), 2)
  await click('.batch-list label:last-child input')
  await click('.batch-list label:first-child input')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body [role=status]')?.textContent.includes('已结束 · 已生成 2 / 2 章')"), 'Batch did not complete')
  assert.match(await evaluate("document.querySelector('.batch-list section').textContent"), /批次甲/)
  await click('.batch-list section:first-child button')
  await until(() => evaluate("!document.querySelector('#dialog').open && document.querySelector('#run-output').textContent.includes('本章先调查船票。')"), 'Batch candidate did not open')
  assert.equal(await evaluate(`(async () => {
    const [project, doc] = JSON.parse(sessionStorage.getItem('pagekin-location'));
    const response = await fetch('/api/projects/' + project + '/documents/' + doc);
    return (await response.json()).body;
  })()`), '')
  await click('#writing-skills')
  await visible('#dialog-body select[data-skill-stage=draft]')
  await evaluate("Array.from(document.querySelectorAll('#dialog-body button')).find(button => button.textContent === '添加写作 Skill').click()")
  await visible('#dialog-body input[type=file]')
  await evaluate(`(() => {
    const input = document.querySelector('#dialog-body input[type=file]');
    const files = new DataTransfer();
    files.items.add(new File(['叙事节奏采用短句。'], '短句.md', { type: 'text/plain' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change'));
  })()`)
  await until(() => evaluate("document.querySelector('#dialog-body textarea').value === '叙事节奏采用短句。'"), 'Skill text did not load for inspection')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body select[data-skill-stage=draft]')?.options.length === 2"), 'Skill did not install')
  await evaluate("document.querySelector('#dialog-body select[data-skill-stage=draft]').selectedIndex = 1")
  await click('#dialog-submit')
  await until(() => evaluate("!document.querySelector('#dialog').open"), 'Skill bindings did not save')
  await click('#preview-context')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('叙事节奏采用短句。')"), 'Bound writing Skill did not enter the draft preview')
  await click('#close-dialog')
  await fill('#guidance', '浏览器续跑演练')
  await click('[data-run=draft]')
  await visible('#continue-run')
  await click('#continue-run')
  await until(() => evaluate("document.querySelector('#run-status').textContent.includes('已完成 · 分段续跑')"), 'Continuation did not complete')
  assert.equal(await evaluate("document.querySelector('#run-output').textContent"), '船票背面写着失踪水手的名字。\n\n　　她听见了开船的汽笛。')
  await click('[data-stage=character]')
  await until(() => evaluate("document.querySelector('[data-stage=character]').getAttribute('aria-pressed') === 'true' && !document.querySelector('#empty').hidden"), 'Stage switch did not open the catalog')
  await click('#new-document')
  await modal('#dialog input', '码头守门人')
  await until(() => evaluate("document.querySelector('#title').value === '码头守门人'"), 'Character document did not open')
  await fillBody('值夜时守在旧码头。')
  await click('#project-runs')
  await visible('#dialog-body .tools button')
  await click('#dialog-body .tools button:nth-child(2)')
  const reviewButton = "Array.from(document.querySelectorAll('#dialog-body section button')).find(button => button.textContent.includes('测试章节') && button.textContent.includes('审稿'))"
  await until(() => evaluate(`Boolean(${reviewButton})`), 'Project run history did not list another chapter')
  await evaluate(`(${reviewButton}).click()`)
  await until(() => evaluate("!document.querySelector('#dialog').open && document.querySelector('#title').value === '测试章节' && !document.querySelector('#review-report').hidden"), 'Project run did not reopen the chapter and report')
  await click('[data-stage=character]')
  await until(() => evaluate(bodyText + " === '值夜时守在旧码头。'"), 'Stage did not reopen its last document with saved edits')
  const otherCharacter = await evaluate(`(async () => {
    const [pid] = JSON.parse(sessionStorage.getItem('pagekin-location'));
    const response = await fetch('/api/projects/' + pid + '/documents', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'character', title: '领航员', body: '' }) });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).id;
  })()`)
  await click('#continuity-document')
  await visible('#dialog-body select')
  await click('#dialog-submit')
  await visible('#dialog-body textarea[name=location]')
  await fill('#dialog-body textarea[name=location]', '开篇值夜在码头')
  await evaluate("Array.from(document.querySelectorAll('#dialog-body button')).find(button => button.textContent === '添加关系').click()")
  await visible('#dialog-body .batch-list select')
  await fill('#dialog-body .batch-list select', otherCharacter)
  await fill('#dialog-body .batch-list input', '同行者')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('当前记录 v1')"), 'Character continuity did not persist')
  assert.equal(await evaluate("document.querySelector('#dialog-body textarea[name=location]').value"), '开篇值夜在码头')
  await click('#close-dialog')
  await click('#continuity-document')
  await visible('#dialog-body select')
  await evaluate("Array.from(document.querySelectorAll('#dialog-body button')).find(button => button.textContent === '查看该位置的人物关系').click()")
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('→ 领航员 · 同行者')"), 'Directed relationship was not displayed')
  await click('#close-dialog')
  await click('#continuity-document')
  await visible('#dialog-body select')
  await evaluate("document.querySelectorAll('#dialog-body select')[1].value = '2'")
  await click('#dialog-submit')
  await visible('#dialog-body details summary')
  await click('#dialog-body details summary')
  await evaluate("Array.from(document.querySelectorAll('#dialog-body button')).find(button => button.textContent === '从定稿提取人物变化').click()")
  await until(() => evaluate("document.querySelector('#dialog-body details').textContent.includes('定稿中未找到')"), 'Continuity evidence validation did not render')
  assert.equal(await evaluate("document.querySelector('#dialog-body textarea[name=location]').value"), '开篇值夜在码头')
  await evaluate("Array.from(document.querySelectorAll('#dialog-body button')).find(button => button.textContent === '填入位置／阵营').click()")
  assert.equal(await evaluate("document.querySelector('#dialog-body textarea[name=location]').value"), '到了码头出口')
  assert.equal(await evaluate("document.querySelector('#dialog-body textarea[name=keyItems]').value"), '')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('已保存引文 · 章节末尾')"), 'Continuity evidence was not saved')
  await click('#close-dialog')
  await click('#project-runs')
  await visible('#dialog-body .tools button:nth-child(2)')
  await click('#dialog-body .tools button:nth-child(2)')
  const continuityButton = "Array.from(document.querySelectorAll('#dialog-body section button')).find(button => button.textContent.includes('人物变化提取'))"
  await until(() => evaluate(`Boolean(${continuityButton})`), 'Run history did not include the continuity extraction')
  await evaluate(`(${continuityButton}).click()`)
  await until(() => evaluate("document.querySelector('#dialog-body details')?.open && document.querySelector('#dialog-body').textContent.includes('原文唯一匹配')"), 'Run history did not reopen the structured continuity candidate')
  await click('#close-dialog')
  await click('[data-stage=chapter]')
  await until(() => evaluate("document.querySelector('#title').value === '测试章节'"), 'Chapter stage did not reopen its last document')
  await evaluate("const filter = document.querySelector('#chapter-filter'); filter.value = 'final'; filter.dispatchEvent(new Event('change'))")
  assert.deepEqual(await evaluate("Array.from(document.querySelector('#documents').options).slice(1).map(option => option.textContent)"), ['第 2 章 第二章 （定稿）'])
  await click('#paired-document')
  await visible('#dialog-body input[type=number]')
  assert.equal(await evaluate("document.querySelector('#dialog-body input[type=number]').value"), '1')
  await modal('#dialog input', '第一章蓝图')
  await until(() => evaluate("document.querySelector('#title').value === '第一章蓝图'"), 'Chapter blueprint did not open')
  await click('#ai summary')
  await click('[data-run=plan]')
  await visible('#apply-run')
  await click('#apply-run')
  await visible('#dialog-body .compare')
  await click('#dialog-submit')
  await until(() => evaluate(bodyText + ".includes('找出失踪船票。')"), 'Blueprint candidate did not apply')
  await click('#batch-blueprints')
  await visible('#dialog-body input[type=number]')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '批量蓝图进度' && document.querySelector('#dialog-body [role=status]')?.textContent.includes('已结束 · 已生成 1 / 1 章')"), 'Blueprint batch did not finish')
  await click('#close-dialog')
  await click('#paired-document')
  await until(() => evaluate("document.querySelector('#title').value === '测试章节'"), 'Blueprint did not return to its matching chapter')
  await fillBody('前文。选中的旧文字。后文。')
  await click('#open-find')
  await fill('#find-query', '选中的旧文字。')
  await click('#find-next')
  await click('#ai-passage')
  await visible('#dialog-body select')
  await evaluate("document.querySelector('#dialog-body select').value = 'polish'")
  await click('#dialog-submit')
  await visible('#apply-run')
  await click('#apply-run')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('前文。新的选段。后文。')"), 'Passage preview did not preserve surrounding prose')
  await click('#dialog-submit')
  await until(() => evaluate(bodyText + " === '前文。新的选段。后文。'"), 'Selected passage did not apply')
  await click('#project-goals')
  await visible('#dialog-body input[name=genre]')
  await fill('#dialog-body input[name=genre]', '港口悬疑')
  await fill('#dialog-body input[name=chapters]', '24')
  await click('#dialog-submit')
  await until(() => evaluate("!document.querySelector('#dialog').open"), 'Writing goals did not save')
  await click('#project-goals')
  await visible('#dialog-body input[name=genre]')
  assert.equal(await evaluate("document.querySelector('#dialog-body input[name=genre]').value"), '港口悬疑')
  assert.equal(await evaluate("document.querySelector('#dialog-body input[name=chapters]').valueAsNumber"), 24)
  await click('#close-dialog')
  await click('.workspace-tools:has(#export) summary')
  await click('#export')
  await visible('#dialog-body a')
  await evaluate(`const [scope, format] = document.querySelectorAll('#dialog-body select');
    scope.value = 'all'; format.value = 'zip'; format.dispatchEvent(new Event('change'))`)
  assert.match(await evaluate("document.querySelector('#dialog-body a').getAttribute('href')"), /\/export\?format=zip&drafts=1$/)
  await click('#close-dialog')
  await click('[data-stage=settings]')
  await click('#architecture-templates')
  await evaluate("Array.from(document.querySelectorAll('#dialog-body button')).find(button => button.textContent === '新建世界观').click()")
  await visible('#dialog-body input')
  await click('#dialog-submit')
  await until(() => evaluate(bodyText + ".includes('规则、限制与代价')"), 'Architecture template did not open')
  await click('#ai summary')
  await click('[data-run=plan]')
  await visible('#dialog-body select')
  assert.equal(await evaluate("document.querySelector('#dialog-body select').value"), 'world')
  await click('#dialog-submit')
  await visible('#apply-run')
  await click('#apply-run')
  await visible('#dialog-body .compare')
  await click('#dialog-submit')
  await until(() => evaluate(bodyText + ".includes('灯塔每月熄灭一天。')"), 'Scoped architecture candidate did not apply')
  await click('#architecture-templates')
  await dialogButton('管理字段与确认')
  await dialogButton('世界观 · 待建立')
  await click('#dialog-submit')
  await visible('#dialog-body textarea')
  await evaluate(`Array.from(document.querySelectorAll('#dialog-body textarea')).forEach((field, i) => {
    field.value = ['雾岛', '港口议会', '灯塔定期熄灭', '夜航需要路标'][i];
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })`)
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('世界观 · 已确认')"), 'Structured architecture was not confirmed')
  await click('#close-dialog')
  assert.match(await evaluate(bodyText), /灯塔每月熄灭一天。[\s\S]*港口议会/)

  const unsavedArchitecture = (await evaluate(bodyText)) + '\n切换界面语言后仍需保留。'
  await fillBody(unsavedArchitecture)
  await click('#workspace-settings')
  await evaluate("document.querySelectorAll('#dialog-body select')[2].value = 'en-US'")
  await click('#dialog-submit')
  await until(() => evaluate(`document.documentElement.lang === 'en-US' && (${bodyText}) === ${JSON.stringify(unsavedArchitecture)}`), 'English UI reload did not preserve unsaved manuscript')
  assert.equal(await evaluate("document.querySelector('#workspace-settings').textContent"), 'Settings')
  assert.equal(await evaluate("document.querySelector('#save').textContent"), 'Save now')
  assert.match(await evaluate("document.querySelector('#save-state').textContent"), /Saved to NAS/)
  await click('#workspace-settings')
  await dialogButton('WebDAV backup')
  await until(() => evaluate("document.querySelector('#dialog-body [role=status]')?.textContent.includes('Configure WebDAV')"), 'English WebDAV settings did not load')
  await dialogButton('Back to settings')
  await evaluate("document.querySelectorAll('#dialog-body select')[2].value = 'zh-CN'")
  await click('#dialog-submit')
  await until(() => evaluate("document.documentElement.lang === 'zh-CN' && document.querySelector('#title').value === '世界观'"), 'Chinese UI did not reopen the same document')
  await click('[data-stage=chapter]')
  await until(() => evaluate("document.querySelector('#title').value === '测试章节'"), 'Chapter did not reopen after architecture planning')
  await click('#focus-writing')
  assert.equal(await evaluate("document.querySelector('#workspace aside').getClientRects().length"), 0)
  await click('#focus-writing')
  assert.ok(await evaluate("document.querySelector('#workspace aside').getClientRects().length"))
  await click('#workspace-settings')
  await visible('#dialog-body select:nth-of-type(1)')
  await evaluate("document.querySelectorAll('#dialog-body select')[0].value = 'dark'; document.querySelectorAll('#dialog-body select')[1].value = 'large'")
  await click('#dialog-submit')
  await until(() => evaluate("document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.textSize === 'large'"), 'Appearance preferences did not apply')
  async function dialogButton(prefix) {
    const expression = `Array.from(document.querySelectorAll('#dialog-body button')).find(button => button.textContent.startsWith(${JSON.stringify(prefix)}))`
    await until(() => evaluate(`Boolean(${expression})`), `Missing ${prefix}`)
    await evaluate(`(${expression}).click()`)
  }
  await click('#workspace-settings')
  await dialogButton('模型预设与诊断')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '模型预设与诊断'"), 'Writing profile settings did not load')
  await fill('#dialog-body select', 'browser-alt')
  await evaluate("document.querySelector('#dialog-body select').dispatchEvent(new Event('change'))")
  await dialogButton('测试所选写作模型')
  await until(() => evaluate("document.querySelector('#dialog-body [role=status]').textContent.includes('连接成功')"), 'Writing profile diagnosis did not pass')
  await click('#dialog-submit')
  await until(() => evaluate("!document.querySelector('#dialog-submit').disabled"), 'Writing profile submission did not complete')
  await click('#close-dialog')
  await click('#workspace-settings')
  await dialogButton('模型预设与诊断')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '模型预设与诊断' && document.querySelector('#dialog-body select').value === 'browser-alt'"), 'Writing profile selection did not persist')
  await click('#close-dialog')
  await click('#reference-novel-library')
  await dialogButton('导入参考小说')
  await visible('#dialog-body input[type=file]')
  await evaluate(String.raw`const file = document.querySelector('#dialog-body input[type=file]');
    const list = new DataTransfer();
    list.items.add(new File(['第一章 轮渡\n\n他登上了轮渡。'], '参考试读.txt', { type: 'text/plain' }));
    file.files = list.files; file.dispatchEvent(new Event('change'))`)
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('预览 1 节')"), 'Reference import preview did not appear')
  await click('#dialog-submit')
  await dialogButton('选择范围拆解')
  await dialogButton('预览发送内容')
  await until(() => evaluate("document.querySelector('#dialog-body pre')?.textContent.includes('参考书节选')"), 'Reference context preview did not appear')
  await click('#dialog-submit')
  await dialogButton('核对写法并保存为 Skill')
  assert.equal(await evaluate("document.querySelector('#dialog-body textarea').value"), '用场景后果推动下一场冲突。')
  await click('#close-dialog')
  await click('#reference-novel-library')
  await dialogButton('参考试读 ·')
  await dialogButton('整书归纳')
  await visible('#dialog-body textarea')
  await click('#dialog-submit')
  await dialogButton('核对写法并保存为 Skill')
  await click('#dialog-submit')
  await dialogButton('查看 · 仿写约束 · 参考试读')
  await visible('#dialog-body pre')
  assert.equal(await evaluate("document.querySelector('#dialog-body pre').textContent"), '用场景后果推动下一场冲突。')
  await click('#close-dialog')
  await click('#screenplay-workspace')
  await dialogButton('新建改编项目')
  await fill('#dialog-body input', '夜航短剧')
  await click('#dialog-submit')
  await dialogButton('新建剧本集')
  await visible('#dialog-body .batch-list input')
  await fill('#dialog-body input', '第一集：线索')
  await click('#dialog-body .batch-list input')
  await click('#dialog-submit')
  await visible('#script-add-scene')
  await click('#script-add-scene')
  await fill('#script-scene-title', '码头相遇')
  await fill('#script-scene-location', '旧码头')
  await fill('#script-scene-time', '夜')
  await click('.script-fields .batch-list input')
  await click('#script-add-element')
  await fill('.script-line textarea', '渔船靠岸。')
  await until(() => evaluate("document.querySelector('#script-save-status').textContent.includes('本机草稿已保存')"), 'Screenplay edit did not persist locally')
  await reload()
  await visible('#screenplay-workspace')
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark')
  await click('#screenplay-workspace')
  await dialogButton('夜航短剧')
  await dialogButton('第 1 季 · 第 1 集')
  await dialogButton('比较本机草稿')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '对照本机稿与 NAS 剧本'"), 'Screenplay recovery did not open')
  await click('#dialog-submit')
  await visible('#script-scene-title')
  assert.equal(await evaluate("document.querySelector('.script-line textarea').value"), '渔船靠岸。')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#script-save-status').textContent === '已存 NAS · v2'"), 'Screenplay was not saved to NAS')
  await dialogButton('确认剧本')
  await until(() => evaluate("document.querySelector('#script-save-status').textContent === '已确认 · v3'"), 'Screenplay was not confirmed')
  assert.equal(await evaluate("document.querySelector('.script-fields').disabled"), true)
  await dialogButton('剧本历史')
  await dialogButton('v2 ·')
  await until(() => evaluate("document.querySelector('#dialog-body pre')?.textContent.includes('渔船靠岸。')"), 'Saved screenplay version did not open')
  await dialogButton('返回剧本集')
  await dialogButton('读原文')
  await until(() => evaluate("document.querySelector('#dialog-body pre')?.textContent.includes('章节末尾')"), 'Pinned source was not displayed')
  const importedPeople = await evaluate(`(async () => {
    const sourceDoc = (id, kind, title, body, number = null, status = 'draft') =>
      ({ id, kind, title, body, number, status, rev: 1, history: [] });
    const source = {
      format: 'pagekin-web-novel-v1', title: '桌面人物迁移浏览器样稿', goals: { chapters: 35 },
      documents: [sourceDoc('rain','character','阿雨','红伞'), sourceDoc('other','character','领航员',''),
        sourceDoc('chapter-1','chapter','出航','阿雨在旧码头。',1,'final'),
        sourceDoc('blueprint-1','blueprint','出航蓝图','从码头开始。',1)],
      threads: [{ title: '失踪船票', body: '尾声核对', kind: 'foreshadow', status: 'open', due: 1 }],
      desktopContinuity: [{ eventId: 'state', characterId: 'rain', characterName: '阿雨',
        targetId: null, targetName: null, field: 'location', value: '旧码头', chapter: 1, kind: 'derived',
        series: 'location', seq: 0, sourceId: 'chapter-1', sourceRev: 1, quote: '阿雨在旧码头。',
        bound: true, eligible: true }],
    };
    const response = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(source) });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).id;
  })()`)
  await reload()
  await visible('#projects')
  await until(() => evaluate(`Array.from(document.querySelector('#projects').options).some(row => row.value === ${JSON.stringify(importedPeople)})`), 'Imported novel did not appear')
  await fill('#projects', importedPeople)
  await evaluate("document.querySelector('#projects').dispatchEvent(new Event('change'))")
  await until(() => evaluate("document.querySelector('#overview-title').textContent === '桌面人物迁移浏览器样稿'"), 'Imported novel did not open')
  await visible('#character-continuity')
  await click('#character-continuity')
  await dialogButton('查看桌面人物历史')
  await visible('#dialog-body .batch-list summary')
  await click('#dialog-body .batch-list summary')
  assert.match(await evaluate("document.querySelector('#dialog-body').textContent"), /桌面定稿派生[\s\S]*原文引证[\s\S]*阿雨在旧码头/)
  await click('#close-dialog')
  await click('#project-progress')
  await visible('.progress-table tbody button')
  assert.match(await evaluate("document.querySelector('.progress-table tbody tr').textContent"), /出航蓝图[\s\S]*出航[\s\S]*已定稿/)
  await dialogButton('下一页')
  await until(() => evaluate("document.querySelector('.progress-table tbody th').textContent === '31'"), 'Progress did not page to chapter 31')
  await fill('.progress-navigation input', '1')
  await dialogButton('跳转')
  await until(() => evaluate("document.querySelector('.progress-table tbody th').textContent === '1'"), 'Progress did not jump back to chapter 1')
  await click('#dialog-body details summary')
  await dialogButton('第 1 章 · 失踪船票')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '编辑线索'"), 'Progress warning did not open its thread editor')
  assert.equal(await evaluate("document.querySelector('#dialog-body input').value"), '失踪船票')
  await fill('#dialog-body input[type=number]', '1')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '长篇进度'"), 'Saving a thread did not return to the progress view')
  await dialogButton('第 1 章 · 失踪船票 · 埋设')
  await visible('#dialog-body input[type=search]')
  await fill('#dialog-body input[type=search]', '阿雨在旧码头')
  await click('#dialog-submit')
  await dialogButton('确认此引文')
  await until(() => evaluate("document.querySelector('#dialog-body blockquote')?.textContent === '阿雨在旧码头'"), 'Evidence was not linked to the final chapter')
  await dialogButton('返回线索')
  await visible('.progress-table tbody td:nth-child(3) button')
  await click('.progress-table tbody td:nth-child(3) button')
  await until(() => evaluate("document.querySelector('#title').value === '出航' && !document.querySelector('#dialog').open"), 'Progress did not open the chosen chapter')
  const pickEpub = selector => evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const files = new DataTransfer();
    const archive = Uint8Array.from(atob(${JSON.stringify(sampleEpub().toString('base64'))}), char => char.charCodeAt(0));
    files.items.add(new File([archive], '海上样稿.epub', { type: 'application/epub+zip' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change'));
  })()`)
  await pickEpub('#manuscript-file')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '预览整稿导入' && document.querySelectorAll('.manuscript-list section').length === 3"), 'EPUB manuscript preview did not display 3 chapters')
  assert.match(await evaluate("document.querySelector('.manuscript-list').textContent"), /风起[\s\S]*Return[\s\S]*海上番外/)
  await click('#close-dialog')
  await click('#reference-novel-library')
  await dialogButton('导入参考小说')
  await visible('#dialog-body input[type=file]')
  await pickEpub('#dialog-body input[type=file]')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('预览 3 节')"), 'EPUB reference preview did not display 3 chapters')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '海上样稿' && document.querySelector('#dialog-body select')?.options.length === 3"), 'EPUB did not enter the reference bookshelf')
  await dialogButton('整书自动拆解')
  await visible('#dialog-body input[type=number]')
  await fill('#dialog-body input[type=number]', '2')
  await click('#dialog-submit')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('已完成 · 已拆解 3 / 3 节')"), 'Reference queue did not finish all chapters')
  await dialogButton('返回参考小说')
  await dialogButton('查看整书拆解')
  await until(() => evaluate("document.querySelector('#dialog-body').textContent.includes('已完成 · 已拆解 3 / 3 节')"), 'Reference queue status did not persist')
  await dialogButton('整书归纳')
  await until(() => evaluate("document.querySelector('#dialog-title').textContent === '整书归纳'"), 'Reference queue did not lead to synthesis')
  console.log('Browser workflow passed (' + (enhanced ? 'CodeMirror' : 'plain') + '): novel, architecture, evidence, locale, screenplay, EPUB and reference batch')
} finally {
  socket?.close()
  for (const child of [browser, app]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
  modelMock.closeAllConnections()
  await new Promise(resolve => modelMock.close(resolve))
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
