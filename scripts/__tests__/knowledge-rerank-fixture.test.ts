import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { chunkText } from '../../electron/embedding'
import { DEFAULT_EMBEDDING_OPTIONS } from '../../src/shared/embedding-options'

const dir = path.resolve(__dirname, '../../test/fixtures/knowledge-rerank')
const read = <T>(name: string): T => JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as T
const corpus = read<{ chapters: { number: number; title: string; paragraphs: string[] }[] }>('corpus.json')
const { queries } = read<{ queries: { id: string }[] }>('queries.json')
const { judgments } = read<{ judgments: { queryId: string; paragraphSha256: string; grade: number; distractor: boolean }[] }>('qrels.json')
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const paragraphs = corpus.chapters.flatMap(chapter => chapter.paragraphs)

describe('知识库重排评估夹具', () => {
  it('每条查询至少有 1 个正确段和 3 个撞词干扰段', () => {
    for (const { id } of queries) {
      const own = judgments.filter(judgment => judgment.queryId === id)
      expect(own.filter(judgment => judgment.grade === 2).length, id).toBeGreaterThanOrEqual(1)
      expect(own.filter(judgment => judgment.distractor && judgment.grade === 0).length, id).toBeGreaterThanOrEqual(3)
    }
  })

  it('qrels 的段落哈希都能在语料里找到，且只判定已有查询', () => {
    const corpusHashes = new Set(paragraphs.map(sha256))
    const queryIds = new Set(queries.map(query => query.id))
    for (const judgment of judgments) {
      expect(corpusHashes.has(judgment.paragraphSha256), `${judgment.queryId} ${judgment.paragraphSha256}`).toBe(true)
      expect(queryIds.has(judgment.queryId)).toBe(true)
    }
  })

  it('按生产默认分块导入时，每个块恰好包含一个完整段落', () => {
    for (const chapter of corpus.chapters) {
      const chunks = chunkText(chapter.paragraphs.join('\n\n'), DEFAULT_EMBEDDING_OPTIONS.chunkSize, DEFAULT_EMBEDDING_OPTIONS.chunkOverlap)
      expect(chunks.map(chunk => chapter.paragraphs.filter(paragraph => chunk.includes(paragraph)).length), `第 ${chapter.number} 章`)
        .toEqual(chapter.paragraphs.map(() => 1))
    }
  })
})
