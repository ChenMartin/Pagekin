import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function replicateFixture(root, assets) {
  const predictions = new Map()
  const requests = []
  let failDownload = true
  const send = (res, status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname
      requests.push({ method: req.method, pathname })
      if (pathname.startsWith('/fixtures/')) {
        assert.equal(req.headers.authorization, undefined)
        if (pathname === '/fixtures/recover' && failDownload) {
          failDownload = false
          return send(res, 503, { detail: 'remote storage temporarily unavailable' })
        }
        const file = assets[pathname.split('/').at(-1)]
        if (!file) return send(res, 404, {})
        return res.writeHead(200, { 'Content-Length': file.length }).end(file)
      }
      assert.equal(req.headers.authorization, 'Bearer test-provider-token-only')
      const modelPath = /^\/v1\/models\/(.+)\/predictions$/u.exec(pathname)
      if (req.method === 'POST' && modelPath) {
        assert.equal(req.headers['cancel-after'], '20m')
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const { input } = JSON.parse(Buffer.concat(chunks))
        const text = input.prompt ?? input.text
        const model = modelPath[1]
        const id = 'fixtureprediction' + String(predictions.size + 1).padStart(4, '0')
        const url = key => 'https://replicate.delivery/fixtures/' + key
        let output = model.includes('/speech-') ? url('audio') : model.includes('/video-') ? url('video') : [url('image'), url('second')]
        if (text.includes('安全检查')) output = 'https://replicate.delivery.invalid/never-fetch'
        if (text.includes('回收失败')) output = url('recover')
        const row = { id, model, input, status: text.includes('暂不结束') ? 'processing' : 'succeeded', version: '1'.repeat(64), output }
        predictions.set(id, row)
        if (text.includes('提交结果未知')) return res.destroy()
        return send(res, 201, row)
      }
      const path = /^\/v1\/predictions\/([a-z0-9]+)(\/cancel)?$/u.exec(pathname)
      const row = path && predictions.get(path[1])
      if (!row) return send(res, 404, {})
      if (path[2] && req.method === 'POST') row.status = 'canceled'
      return send(res, 200, row)
    } catch (error) {
      return send(res, 500, { detail: error.message })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const setup = join(root, 'replicate-fixture-fetch.mjs')
  const origin = `http://127.0.0.1:${server.address().port}`
  await writeFile(setup, `
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(input);
      if (url.hostname === 'api.replicate.com' || url.hostname === 'replicate.delivery') {
        return realFetch(new URL(url.pathname + url.search, ${JSON.stringify(origin)}), init);
      }
      throw new Error('Unexpected network destination in media integration test');
    };
  `)
  return { setup, predictions, requests, submissions: () => requests.filter(row => row.method === 'POST' && row.pathname.startsWith('/v1/models/')).length,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
