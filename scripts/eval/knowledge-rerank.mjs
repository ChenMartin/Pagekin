#!/usr/bin/env node
// 用法：
//   node scripts/eval/knowledge-rerank.mjs run --group fts --out <收据.json>
//   node scripts/eval/knowledge-rerank.mjs run --group vector --out <收据.json>   （需要环境变量 SILICONFLOW_API_KEY）
//   node scripts/eval/knowledge-rerank.mjs compare <基准收据.json> <对照收据.json> --out <比较.json>

import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const FIXTURE_DIR = path.join(ROOT, "test", "fixtures", "knowledge-rerank")
const CACHE_ROOT = path.join(ROOT, ".runtime", ".cache", "knowledge-rerank-eval")
const CANDIDATES = 40
const FINAL = 5
const EMBEDDING_TIMEOUT_MS = 60000

const SILICONFLOW = { provider: "siliconflow", baseUrl: "https://api.siliconflow.cn/v1" }
const EMBEDDING_MODEL = "BAAI/bge-m3"
const RERANK_MODEL = "BAAI/bge-reranker-v2-m3"

const GROUPS = {
  fts: { retrieval: "fts", rerank: null },
  vector: { retrieval: "vector", rerank: null },
  "fts+rerank": { retrieval: "fts", rerank: undefined },
  "vector+rerank": { retrieval: "vector", rerank: undefined },
}

const DECISION_RULES = {
  source: "batch11/inv-rerank/report.md 第 8 节，开跑前定",
  ftsRerankVsFts: "nDCG@5 平均提高 >= 0.10，且 >= 70% 查询不变差，且 Distractor@5 降 >= 30%",
  vectorRerankVsVector: "nDCG@5 不降，且变差的查询 <= 20%",
  recallBottleneck: "全文组 Recall@40 < 0.5 时，结论写「召回是瓶颈」",
}

const METRIC_DEFINITIONS = {
  "Recall@40": "等级 >= 1 的判定段落中，出现在 40 个候选里的比例",
  "Recall@40(correct)": "等级 2 的判定段落中，出现在 40 个候选里的比例",
  "nDCG@5": "增益 2^等级 - 1，理想排序取该查询全部判定等级",
  "Hit@5": "前 5 里至少有一个等级 2 段落记 1，否则 0",
  "MRR@5": "前 5 里第一个等级 2 段落名次的倒数，没有记 0",
  "Distractor@5": "前 5 里标为撞词干扰的段落数 / 5",
  chunkMapping: "每个块恰好包含一个完整语料段落；块的等级取该段落的判定等级，未判定记 0",
}

function fail(message) {
  throw new Error(message)
}

const sha256 = value => createHash("sha256").update(value).digest("hex")

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { positional: [] }
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg.startsWith("--")) {
      options[arg.slice(2)] = rest[index + 1]
      index += 1
    } else {
      options.positional.push(arg)
    }
  }
  return { command, options }
}

async function loadFixture() {
  const files = {}
  for (const name of ["corpus.json", "queries.json", "qrels.json"]) {
    const bytes = await readFile(path.join(FIXTURE_DIR, name))
    files[name] = { bytes, sha256: sha256(bytes), value: JSON.parse(bytes.toString("utf8")) }
  }
  const corpus = files["corpus.json"].value
  const paragraphs = new Map()
  for (const chapter of corpus.chapters) {
    chapter.paragraphs.forEach((text, index) => {
      const hash = sha256(Buffer.from(text, "utf8"))
      if (paragraphs.has(hash)) fail(`语料段落重复：第 ${chapter.number} 章第 ${index + 1} 段`)
      paragraphs.set(hash, { text, chapter: chapter.number, index: index + 1 })
    })
  }
  const judgments = new Map()
  for (const judgment of files["qrels.json"].value.judgments) {
    if (!paragraphs.has(judgment.paragraphSha256)) fail(`qrels 段落不在语料里：${judgment.queryId} ${judgment.label}`)
    if (!judgments.has(judgment.queryId)) judgments.set(judgment.queryId, new Map())
    judgments.get(judgment.queryId).set(judgment.paragraphSha256, judgment)
  }
  return {
    corpus,
    queries: files["queries.json"].value.queries,
    paragraphs,
    judgments,
    hashes: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.sha256])),
  }
}

/** 与 generate-draft.command.ts 拼查询的规则一致。 */
function buildQuery(chapterInfo) {
  const hint = chapterInfo.knowledgeQueryHint?.trim() ?? ""
  return [hint, chapterInfo.title, chapterInfo.keyEvents, chapterInfo.characters.join(" ")].filter(Boolean).join(" ")
}

function ftsTerms(query) {
  const raw = query.match(/[\p{L}\p{N}-]+/gu) ?? []
  const meaningful = raw.filter(term => Array.from(term).length >= 2)
  return [...new Map((meaningful.length ? meaningful : raw).map(term => [term.toLocaleLowerCase(), term])).values()].slice(0, 8)
}

function ftsRank(terms, text) {
  return terms.reduce((sum, term, index) => sum + (text.toLocaleLowerCase().includes(term.toLocaleLowerCase()) ? terms.length - index : 0), 0)
}

async function bundleProduction(workDir) {
  const outfile = path.join(workDir, "production.cjs")
  await build({
    stdin: {
      contents: [
        "export { importText, captureWritingKnowledgeSnapshot } from './electron/knowledge-base.ts'",
        "export { generateEmbeddings } from './electron/embedding.ts'",
        "export { captureGenerationKnowledge } from './electron/services/generation-knowledge-source.ts'",
        "export { withKnowledgeSourceGate } from './electron/services/knowledge-source-gate.ts'",
        "export { getProjectDataRoot } from './electron/services/project-data-locator.ts'",
        "export { closeConnection, getCanonicalChunksForEmbeddingRebuild, getChunksWithoutVectors, getEmbeddingSpaces } from './electron/vector-store.ts'",
        "export { prepareCanonicalStorageFixture } from './test/helpers/canonical-project-fixture.ts'",
      ].join("\n"),
      loader: "ts",
      resolveDir: ROOT,
      sourcefile: "knowledge-rerank-eval-entry.ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    // 生产源码在模块顶层用 import.meta.url 建 require；打成 CJS 后换成本文件的 URL。
    banner: { js: "const __bundleUrl = require(\"node:url\").pathToFileURL(__filename).href;" },
    define: { "import.meta.url": "__bundleUrl" },
    target: "node22",
    packages: "external",
    logLevel: "silent",
  })
  return import(pathToFileURL(outfile).href)
}

function embeddingModel(group) {
  if (group.retrieval === "fts") return { ...SILICONFLOW, apiKey: "", modelName: EMBEDDING_MODEL }
  const apiKey = process.env.SILICONFLOW_API_KEY ?? ""
  if (!apiKey.trim()) fail("向量组需要环境变量 SILICONFLOW_API_KEY")
  return { ...SILICONFLOW, apiKey, modelName: EMBEDDING_MODEL }
}

/** 与 knowledge-base.ts 的 embeddingSpaceFor 保持一致，否则生产代码抛 SPACE_NOT_MATCHED。 */
function embeddingSpace(model) {
  return { modelFingerprint: `openai|${model.baseUrl.trim().replace(/\/+$/, "")}|${model.modelName.trim()}`, distanceMetric: "l2" }
}

function mapChunks(chunks, paragraphs) {
  const byChunk = new Map()
  const seen = new Map()
  for (const chunk of chunks) {
    const contained = [...paragraphs.entries()].filter(([, paragraph]) => chunk.text.includes(paragraph.text))
    if (contained.length !== 1) fail(`块 ${chunk.id} 含 ${contained.length} 个完整段落，应为 1`)
    const [hash] = contained[0]
    byChunk.set(chunk.id, hash)
    seen.set(hash, (seen.get(hash) ?? 0) + 1)
  }
  const unresolved = [...paragraphs.keys()].filter(hash => seen.get(hash) !== 1)
  if (unresolved.length) fail(`${unresolved.length} 个段落没有落在唯一的块里`)
  return byChunk
}

function dcg(grades) {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0)
}

function scoreQuery(candidates, final, judged) {
  const gradeOf = hash => judged.get(hash)?.grade ?? 0
  const relevant = [...judged.values()].filter(item => item.grade >= 1)
  const correct = relevant.filter(item => item.grade === 2)
  const candidateSet = new Set(candidates.map(item => item.paragraphSha256))
  const ideal = dcg([...judged.values()].map(item => item.grade).sort((a, b) => b - a).slice(0, FINAL))
  const firstCorrect = final.findIndex(item => gradeOf(item.paragraphSha256) === 2)
  return {
    "Recall@40": relevant.filter(item => candidateSet.has(item.paragraphSha256)).length / relevant.length,
    "Recall@40(correct)": correct.filter(item => candidateSet.has(item.paragraphSha256)).length / correct.length,
    "nDCG@5": ideal ? dcg(final.map(item => gradeOf(item.paragraphSha256))) / ideal : 0,
    "Hit@5": firstCorrect >= 0 ? 1 : 0,
    "MRR@5": firstCorrect >= 0 ? 1 / (firstCorrect + 1) : 0,
    "Distractor@5": final.filter(item => judged.get(item.paragraphSha256)?.distractor).length / FINAL,
  }
}

function mean(rows, key) {
  return rows.length ? rows.reduce((sum, row) => sum + row.metrics[key], 0) / rows.length : 0
}

async function runGroup(groupName, outPath) {
  const group = GROUPS[groupName]
  if (!group) fail(`未知分组：${groupName}，可选 ${Object.keys(GROUPS).join(", ")}`)
  if (group.rerank === undefined) fail(`${groupName} 组要等 R2（electron/rerank.ts）合入后接上重排函数才能跑`)
  const fixture = await loadFixture()
  const workDir = path.join(CACHE_ROOT, `${groupName.replace(/\W/g, "-")}-${randomUUID()}`)
  const projectPath = path.join(workDir, "project")
  await mkdir(projectPath, { recursive: true })
  const model = embeddingModel(group)
  const configuration = group.retrieval === "vector" ? { protocol: "openai", model } : null
  let production
  try {
    production = await bundleProduction(workDir)
    production.prepareCanonicalStorageFixture(projectPath)
    for (const chapter of fixture.corpus.chapters) {
      const result = await production.importText(chapter.paragraphs.join("\n\n"), `第${chapter.number}章 ${chapter.title} 正文.md`,
        projectPath, "openai", model, group.retrieval === "fts" ? { mode: "fts-only" } : undefined)
      if (!result.success) fail(`导入第 ${chapter.number} 章失败：${result.error}`)
    }
    const chunks = await production.getCanonicalChunksForEmbeddingRebuild(projectPath)
    const chunkToParagraph = mapChunks(chunks, fixture.paragraphs)
    const space = configuration ? embeddingSpace(model) : undefined
    let vectorCoverage = null
    if (space) {
      const missing = await production.getChunksWithoutVectors(projectPath, space)
      const registry = await production.getEmbeddingSpaces(projectPath)
      vectorCoverage = { chunksWithoutVectors: missing.count, activeSpaces: registry.spaces.filter(item => item.status === "active").length }
      if (missing.count !== 0) fail(`向量组有 ${missing.count} 个块没有向量，导入时嵌入失败已降级为全文`)
    }
    const root = production.getProjectDataRoot(projectPath)
    const rows = []
    for (const { id, chapterInfo } of fixture.queries) {
      const query = buildQuery(chapterInfo)
      let queryVector
      if (configuration) {
        const [vector] = await production.generateEmbeddings([query], "openai", model, undefined, undefined, AbortSignal.timeout(EMBEDDING_TIMEOUT_MS))
        queryVector = vector
      }
      const snapshot = await production.withKnowledgeSourceGate(root, () => production.captureGenerationKnowledge({
        projectStorageRoot: root, query, topK: CANDIDATES, queryVector, ...(space ? { embeddingSpace: space } : {}),
      }))
      const terms = ftsTerms(query)
      const judged = fixture.judgments.get(id) ?? new Map()
      const candidates = snapshot.items.map(item => {
        const paragraphSha256 = chunkToParagraph.get(item.chunkId)
        if (!paragraphSha256) fail(`候选块 ${item.chunkId} 不在导入的块里`)
        const judgment = judged.get(paragraphSha256)
        return {
          paragraphSha256, label: judgment?.label ?? null, grade: judgment?.grade ?? 0, distractor: Boolean(judgment?.distractor),
          score: item.score, ftsRank: ftsRank(terms, item.text), matchedTerms: terms.filter(term => item.text.toLocaleLowerCase().includes(term.toLocaleLowerCase())),
        }
      })
      if (configuration && candidates.some(item => item.score === 0.5)) fail(`${id} 的候选出现全文检索的固定分 0.5，向量检索可能已回退`)
      const final = group.rerank ? await group.rerank(query, candidates) : candidates.slice(0, FINAL)
      const wrapper = await production.captureWritingKnowledgeSnapshot(query, projectPath, configuration)
      const wrapperTop = wrapper.items.map(item => chunkToParagraph.get(item.chunkId))
      rows.push({
        id, query, ftsTerms: terms,
        productionTop5MatchesCandidateHead: wrapperTop.join() === candidates.slice(0, FINAL).map(item => item.paragraphSha256).join(),
        metrics: scoreQuery(candidates, final, judged),
        candidates, final: final.map(item => item.paragraphSha256),
      })
    }
    const receipt = {
      schemaVersion: 1,
      kind: "knowledge-rerank-eval",
      group: groupName,
      createdAt: new Date().toISOString(),
      sourceCommit: process.env.EVAL_SOURCE_COMMIT ?? null,
      fixture: { id: fixture.corpus.id, sha256: fixture.hashes, chapters: fixture.corpus.chapters.length, paragraphs: fixture.paragraphs.size, chunks: chunks.length, queries: rows.length },
      models: { embedding: group.retrieval === "vector" ? `${SILICONFLOW.baseUrl} ${EMBEDDING_MODEL}` : null, rerank: group.rerank ? `${SILICONFLOW.baseUrl} ${RERANK_MODEL}` : null },
      pipeline: { candidates: CANDIDATES, final: FINAL, retrieval: "captureGenerationKnowledge（真实 LanceDB），前 5 与 captureWritingKnowledgeSnapshot 对照" },
      vectorCoverage,
      metricDefinitions: METRIC_DEFINITIONS,
      decisionRules: DECISION_RULES,
      summary: Object.fromEntries(Object.keys(rows[0]?.metrics ?? {}).map(key => [key, mean(rows, key)])),
      productionTop5Mismatches: rows.filter(row => !row.productionTop5MatchesCandidateHead).map(row => row.id),
      queries: rows,
    }
    await writeReceipt(outPath, receipt)
    console.log(JSON.stringify({ group: groupName, summary: receipt.summary, productionTop5Mismatches: receipt.productionTop5Mismatches }, null, 2))
  } finally {
    production?.closeConnection(projectPath)
    await rm(workDir, { recursive: true, force: true, maxRetries: 5 })
  }
}

async function writeReceipt(outPath, value) {
  const text = JSON.stringify(value, null, 2) + "\n"
  const key = process.env.SILICONFLOW_API_KEY
  if (key && key.trim() && text.includes(key.trim())) fail("收据里出现了 API Key，已拒绝写入")
  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, text, "utf8")
}

/** 全文组平分段的顺序会因块 id 随机而变，需单独标出。 */
async function compare(basePath, otherPath, outPath) {
  const [base, other] = await Promise.all([basePath, otherPath].map(async file => JSON.parse(await readFile(file, "utf8"))))
  if (JSON.stringify(base.fixture.sha256) !== JSON.stringify(other.fixture.sha256)) fail("两份收据的夹具哈希不同")
  const otherById = new Map(other.queries.map(row => [row.id, row]))
  const perQuery = base.queries.map(row => {
    const peer = otherById.get(row.id) ?? fail(`对照收据缺查询 ${row.id}`)
    const delta = peer.metrics["nDCG@5"] - row.metrics["nDCG@5"]
    const sameCandidateSet = JSON.stringify([...row.candidates.map(item => item.paragraphSha256)].sort()) === JSON.stringify([...peer.candidates.map(item => item.paragraphSha256)].sort())
    const orderDiffs = row.candidates.map((item, index) => ({ index, base: item, other: peer.candidates[index] }))
      .filter(({ base: left, other: right }) => left.paragraphSha256 !== right?.paragraphSha256)
      .map(({ index, base: left, other: right }) => ({ position: index + 1, withinEqualRank: Boolean(right) && left.ftsRank === right.ftsRank && left.score === right.score }))
    return {
      id: row.id,
      outcome: Math.abs(delta) < 1e-9 ? "tie" : delta > 0 ? "win" : "loss",
      nDCG5Delta: delta,
      recall40Delta: peer.metrics["Recall@40"] - row.metrics["Recall@40"],
      metricsIdentical: JSON.stringify(row.metrics) === JSON.stringify(peer.metrics),
      sameCandidateSet,
      sameFinalOrder: row.final.join() === peer.final.join(),
      orderDiffs,
    }
  })
  const result = {
    schemaVersion: 1,
    kind: "knowledge-rerank-compare",
    base: { file: path.basename(basePath), group: base.group, summary: base.summary },
    other: { file: path.basename(otherPath), group: other.group, summary: other.summary },
    outcomes: { win: perQuery.filter(row => row.outcome === "win").length, tie: perQuery.filter(row => row.outcome === "tie").length, loss: perQuery.filter(row => row.outcome === "loss").length },
    identical: perQuery.every(row => row.metricsIdentical && row.sameCandidateSet && row.sameFinalOrder && row.orderDiffs.length === 0),
    onlyEqualRankReorders: perQuery.every(row => row.metricsIdentical && row.sameCandidateSet && row.orderDiffs.every(diff => diff.withinEqualRank)),
    perQuery,
  }
  await writeReceipt(outPath, result)
  console.log(JSON.stringify({ outcomes: result.outcomes, identical: result.identical, onlyEqualRankReorders: result.onlyEqualRankReorders }, null, 2))
}

const { command, options } = parseArgs(process.argv.slice(2))
if (command === "run") {
  if (!options.group || !options.out) fail("用法：run --group <fts|vector> --out <收据.json>")
  await runGroup(options.group, path.resolve(options.out))
} else if (command === "compare") {
  if (options.positional.length !== 2 || !options.out) fail("用法：compare <基准.json> <对照.json> --out <比较.json>")
  await compare(path.resolve(options.positional[0]), path.resolve(options.positional[1]), path.resolve(options.out))
} else {
  fail("用法：run --group <fts|vector> --out <收据.json> | compare <基准.json> <对照.json> --out <比较.json>")
}
