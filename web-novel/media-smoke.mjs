import { strict as assert } from 'node:assert'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { openStore } from './store.mjs'
import { backupDatabase, restoreDatabase, verifyMedia } from './maintenance.mjs'

const exec = promisify(execFile)
const password = 'pagekin-media-smoke-local'

test('real FFmpeg renders trimmed picture and video, narration, Chinese subtitles and a recoverable film', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pagekin-media-smoke-'))
  const data = join(root, 'data')
  let child, base, cookie
  const ffmpeg = args => exec('ffmpeg', ['-nostdin', '-v', 'error', '-filter_threads', '1', '-y', ...args], { timeout: 20_000 })

  async function request(path, method = 'GET', value, status = 200, extra = {}) {
    const { anonymous, ...headers } = extra
    const response = await fetch(base + '/api' + path, { method, signal: AbortSignal.timeout(15_000),
      headers: { ...(!anonymous && cookie ? { Cookie: cookie } : {}),
        ...(value === undefined || Buffer.isBuffer(value) ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: value === undefined || Buffer.isBuffer(value) ? value : JSON.stringify(value) })
    if (method === 'HEAD') { assert.equal(response.status, status); return response }
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(response.status, status, `${method} ${path}: ${bytes.subarray(0, 500)}`)
    if (path === '/session') cookie = response.headers.get('set-cookie').split(';')[0]
    if (response.headers.get('content-type')?.includes('json')) return JSON.parse(bytes)
    return { bytes, headers: response.headers }
  }

  async function waitJob(path, states) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const job = await request(path)
      if (states.includes(job.status)) return job
      await delay(100)
    }
    assert.fail('Render did not reach ' + states.join(', '))
  }

  try {
    const picture = join(root, 'scene.png'), video = join(root, 'clip.mp4'), audio = join(root, 'voice.wav')
    await Promise.all([
      ffmpeg(['-f', 'lavfi', '-i', 'color=red:s=120x80', '-vf', 'format=rgb24', '-frames:v', '1', '-threads', '1', picture]),
      ffmpeg(['-f', 'lavfi', '-i', 'color=blue:s=160x90:d=2:r=25', '-c:v', 'libx264', '-threads', '1', video]),
      ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.2', audio]),
    ])
    const store = openStore(data)
    let pid, other, episode, board
    try {
      pid = store.createProject('实测漫剧').id
      other = store.createProject('另一作品').id
      const chapter = store.addDocument(pid, { kind: 'chapter', number: 1, title: '码头', body: '夜色中，轮船缓缓驶出。' })
      const final = store.transition(pid, chapter.id, { action: 'finalize', baseRev: chapter.rev })
      const adaptation = store.screenplay.create(pid, { mutationId: randomUUID(), title: '夜航', format: 'comic', aspect: '9:16', seconds: 30 })
      episode = store.screenplay.createEpisode(pid, adaptation.id, { mutationId: randomUUID(), title: '第一集', season: 1, number: 1,
        sources: [{ id: chapter.id, rev: final.rev }] })
      const scene = { id: randomUUID(), title: '渡口', location: '码头', time: '夜', interior: 'exterior', sourceIds: [chapter.id],
        elements: [{ id: randomUUID(), type: 'action', text: '轮船缓缓驶出。' }] }
      episode = store.screenplay.changeEpisode(pid, episode.id, { mutationId: randomUUID(), baseRev: episode.rev, title: episode.title,
        scenes: [scene] }, 'save')
      episode = store.screenplay.changeEpisode(pid, episode.id, { mutationId: randomUUID(), baseRev: episode.rev }, 'confirm')
      const shots = ['渡口的灯', '驶出的轮船'].map(visual => ({ id: randomUUID(), sceneId: scene.id, size: 'wide', durationMs: 1000, visual }))
      board = store.storyboard.change(pid, episode.id, { mutationId: randomUUID(), action: 'save', baseRev: 0, scriptRev: episode.rev, shots })
      board = store.storyboard.change(pid, episode.id, { mutationId: randomUUID(), action: 'confirm', baseRev: board.rev, scriptRev: episode.rev })
    } finally { store.db.close() }

    const app = process.env.PAGEKIN_TEST_APP_DIR ? join(process.env.PAGEKIN_TEST_APP_DIR, 'server.mjs') : fileURLToPath(new URL('./server.mjs', import.meta.url))
    child = spawn(process.execPath, [app], { env: { ...process.env, APP_DATA_DIR: data, APP_ORIGIN: '', APP_HOST: '127.0.0.1', PORT: '0',
      APP_PASSWORD: password, APP_PASSWORD_FILE: '', APP_SECURE_COOKIE: '0', PAGEKIN_MEDIA: '1', WEBDAV_BACKUP_URL: '',
    }, stdio: ['ignore', 'pipe', 'inherit'] })
    const line = await Promise.race([once(child.stdout, 'data').then(([chunk]) => chunk.toString()),
      once(child, 'exit').then(() => { throw new Error('Media app exited during startup') }), delay(10_000, null, { ref: false })])
    assert.ok(line)
    base = 'http://127.0.0.1:' + JSON.parse(line.trim().split('listening on ')[1]).port
    await request('/session', 'POST', { password })
    assert.equal((await request('/media-capabilities')).available, true)
    const project = '/projects/' + pid
    const library = project + '/media-assets/'
    const upload = async (file, name, id = randomUUID()) => request(library + id + '?name=' + encodeURIComponent(name), 'PUT', await readFile(file), 201)
    const still = await upload(picture, '渡口.png')
    assert.equal((await upload(picture, '重复图片.png')).id, still.id)
    const tooLarge = await new Promise((resolve, reject) => {
      const req = httpRequest(base + '/api' + library + randomUUID() + '?name=oversize.png', { method: 'PUT',
        headers: { Cookie: cookie, 'Content-Length': 64 * 1024 ** 2 + 1 } }, response => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
      })
      req.once('error', reject)
      req.setTimeout(4000, () => req.destroy(new Error('Oversize upload was not rejected from its headers')))
      req.end()
    })
    assert.equal(tooLarge, 413)
    await request(library + randomUUID() + '?name=bad.png', 'PUT', Buffer.from('<svg/>'), 415)
    await request(library + still.id + '/file', 'GET', undefined, 401, { anonymous: true })
    await request('/projects/' + other + '/media-assets/' + still.id + '/file', 'GET', undefined, 404)
    const range = await request(library + still.id + '/file', 'GET', undefined, 206, { Range: 'bytes=0-7' })
    assert.equal(range.bytes.length, 8)
    assert.equal(range.headers.get('content-type'), 'image/png')
    assert.equal((await request(library + still.id + '/file', 'HEAD')).headers.get('accept-ranges'), 'bytes')
    await request(library + still.id + '/file', 'GET', undefined, 416, { Range: 'bytes=999999-' })
    const footage = await upload(video, '渡轮.mp4')
    const voice = await upload(audio, '旁白.wav')
    const episodePath = project + '/episodes/' + episode.id
    const path = episodePath + '/timeline'
    const initial = await request(path)
    assert.equal(initial.boardRev, board.rev)
    const value = { action: 'save', baseRev: 0, boardRev: board.rev, mutationId: randomUUID(),
      clips: [{ ...initial.clips[1], assetId: footage.id, startMs: 400, caption: '轮船出发。' },
        { ...initial.clips[0], assetId: still.id, caption: '夜色落在码头。' }], narration: { assetId: voice.id, startMs: 200, volume: 70 } }
    const timeline = await request(path, 'PUT', value)
    assert.deepEqual(await request(path, 'PUT', value), timeline)
    await request(path, 'PUT', { ...value, mutationId: randomUUID() }, 409)
    await request(path, 'PUT', { ...value, baseRev: timeline.rev, mutationId: randomUUID(),
      clips: [{ ...value.clips[0], startMs: 1700 }, value.clips[1]] }, 422)
    const submission = { rev: timeline.rev, mutationId: randomUUID() }
    const job = await request(episodePath + '/renders', 'POST', submission, 202)
    assert.equal((await request(episodePath + '/renders', 'POST', submission, 202)).id, job.id)
    const jobPath = project + '/media-renders/' + job.id
    const ready = await waitJob(jobPath, ['done', 'failed'])
    assert.equal(ready.status, 'done', ready.error)
    const rendered = await request(jobPath + '/film?download=1')
    assert.match(rendered.headers.get('content-disposition'), /pagekin-film\.mp4/)
    const output = join(root, 'result.mp4')
    await writeFile(output, rendered.bytes)
    if (process.env.PAGEKIN_TEST_FILM) await writeFile(process.env.PAGEKIN_TEST_FILM, rendered.bytes)
    const info = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_entries',
      'stream=width,height,codec_name,duration', '-of', 'json', output])).stdout)
    assert.deepEqual(info.streams.map(row => row.codec_name), ['h264', 'aac', 'mov_text'])
    assert.equal(info.streams[0].width, 540)
    assert.equal(info.streams[0].height, 960)
    assert.equal(Number(info.streams[0].duration), 2)
    const embedded = await exec('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:s:0', '-f', 'srt', '-'])
    assert.match(embedded.stdout, /轮船出发。[\s\S]*夜色落在码头。/u)
    assert.match((await request(jobPath + '/subtitles')).bytes.toString(), /00:00:01,000 --> 00:00:02,000\n夜色落在码头。/u)

    const long = await request(path, 'PUT', { ...value, baseRev: timeline.rev, mutationId: randomUUID(),
      clips: [{ ...value.clips[1], durationMs: 160_000 }], narration: null })
    const slow = await request(episodePath + '/renders', 'POST', { rev: long.rev, mutationId: randomUUID() }, 202)
    const slowPath = project + '/media-renders/' + slow.id
    await waitJob(slowPath, ['running'])
    await request(slowPath + '/cancel', 'POST', undefined, 202)
    assert.equal((await waitJob(slowPath, ['cancelled', 'done', 'failed'])).status, 'cancelled')

    await request(path, 'PUT', { ...value, baseRev: long.rev, mutationId: randomUUID() })
    const retry = await request(episodePath + '/renders', 'POST', { retryOf: slow.id, mutationId: randomUUID() }, 202)
    assert.equal(retry.timeline_rev, long.rev)
    const retryPath = project + '/media-renders/' + retry.id
    await request(retryPath + '/cancel', 'POST', undefined, 202)
    assert.equal((await waitJob(retryPath, ['cancelled', 'done', 'failed'])).status, 'cancelled')

    const boardPath = episodePath + '/storyboard'
    const reopened = await request(boardPath, 'PUT', { action: 'reopen', mutationId: randomUUID(), baseRev: board.rev, scriptRev: episode.rev })
    assert.equal((await request(path)).stale, true)
    const confirmed = await request(boardPath, 'PUT', { action: 'confirm', mutationId: randomUUID(), baseRev: reopened.rev, scriptRev: episode.rev })
    const stale = await request(path)
    const rebased = await request(path, 'PUT', { action: 'rebase', mutationId: randomUUID(), baseRev: stale.rev, boardRev: confirmed.rev })
    assert.equal(rebased.stale, false)
    assert.deepEqual(rebased.clips.map(row => row.assetId), [still.id, footage.id])
    assert.equal((await request(jobPath + '/film')).bytes.length, rendered.bytes.length)

    const snapshot = join(root, 'snapshot.sqlite')
    await backupDatabase(join(data, 'novels.sqlite'), snapshot)
    assert.deepEqual(await verifyMedia(snapshot, data), { mediaFiles: 4 })
    const recovered = join(root, 'recovered')
    const database = join(recovered, 'novels.sqlite')
    await restoreDatabase(createReadStream(snapshot), database)
    await assert.rejects(verifyMedia(database), /缺失或摘要不匹配/u)
    await cp(join(data, 'media', 'blobs'), join(recovered, 'media', 'blobs'), { recursive: true })
    assert.deepEqual(await verifyMedia(database), { mediaFiles: 4 })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill(); await stopped
    }
    await rm(root, { recursive: true, force: true })
  }
})
