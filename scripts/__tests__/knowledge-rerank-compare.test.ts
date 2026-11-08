import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = path.resolve(__dirname, '../eval/knowledge-rerank.mjs')

type Row = { id: unknown }

const row = (id: unknown) => ({
  id,
  metrics: { 'nDCG@5': 1, 'Recall@40': 1 },
  candidates: [{ paragraphSha256: 'p1', ftsRank: 1, score: 1 }],
  final: ['p1'],
})

const receipt = (queries: Row[] | undefined, count = queries?.length ?? 0) => ({
  schemaVersion: 1,
  kind: 'knowledge-rerank-eval',
  group: 'fts',
  fixture: { sha256: { corpus: 'c', queries: 'q', qrels: 'r' }, queries: count },
  summary: {},
  queries,
})

let dir: string
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'knowledge-rerank-compare-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function compare(base: unknown, other: unknown) {
  const basePath = path.join(dir, 'base.json')
  const otherPath = path.join(dir, 'other.json')
  const outPath = path.join(dir, 'out.json')
  writeFileSync(basePath, JSON.stringify(base))
  writeFileSync(otherPath, JSON.stringify(other))
  const child = spawnSync(process.execPath, [script, 'compare', basePath, otherPath, '--out', outPath], { encoding: 'utf8' })
  return { status: child.status, stderr: child.stderr, out: existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null }
}

describe('knowledge-rerank compare 只比较可信的收据', () => {
  it('两份合法且相同的收据报 identical', () => {
    const result = compare(receipt([row('q01'), row('q02')]), receipt([row('q01'), row('q02')]))
    expect(result.status).toBe(0)
    expect(result.out.identical).toBe(true)
  })

  it.each([
    ['基准 queries 为空、对照非空', receipt([]), receipt([row('q01')]), 'base.json'],
    ['基准 queries 不是数组', receipt(undefined, 1), receipt([row('q01')]), 'base.json'],
    ['对照 queries 条数与 fixture.queries 不符', receipt([row('q01')]), receipt([row('q01')], 2), 'other.json'],
    ['基准有缺 id 的行', receipt([row('q01'), row(null)]), receipt([row('q01'), row('q02')]), 'base.json'],
    ['两份收据的 id 都是空串', receipt([row('')]), receipt([row('')]), 'base.json'],
    ['两份收据的 id 都是数字', receipt([row(1)]), receipt([row(1)]), 'base.json'],
    ['基准 id 重复',receipt([row('q01'), row('q01')]), receipt([row('q01'), row('q02')]), 'base.json'],
    ['对照多出基准没有的查询', receipt([row('q01')]), receipt([row('q01'), row('q02')]), 'other.json'],
  ])('%s时失败退出，不写比较结果', (_name, base, other, blamed) => {
    const result = compare(base, other)
    expect(result.status).not.toBe(0)
    expect(result.out).toBeNull()
    expect(result.stderr).toContain(blamed)
  })
})
