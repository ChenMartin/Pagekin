import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { manuscriptChapterLimit } from './public/manuscript.mjs'
import { schemaVersion } from './version.mjs'
import { reviewReport } from './review-report.mjs'
import { mergeRevision, revisionChanges } from './revision-merge.mjs'

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

export const kinds = ['settings', 'character', 'blueprint', 'chapter']
const runKinds = ['outline', 'draft', 'review', 'revise']
export const outlineMaxChars = 2400
export const hash = value => createHash('sha256').update(value).digest('hex')
export const now = () => new Date().toISOString()

export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '请求格式无效')
  return value
}

export function string(value, limit, required = false) {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new ApiError(400, '文本为空或超过长度限制')
  }
  return value
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ApiError(400, '版本号无效')
  return value
}

function input(value) {
  object(value)
  return { title: string(value.title, 160, true).trim(), body: string(value.body, 180_000) }
}

function numbered(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 99999) throw new ApiError(400, '章节号应在 1–99999 之间')
  return value
}

export function openStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(directory, 'novels.sqlite'), { enableForeignKeyConstraints: true })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version > schemaVersion) throw new Error('数据库版本高于当前服务，请用对应版本启动')
  db.exec(`
    BEGIN;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL CHECK(kind IN ('settings','character','blueprint','chapter')),
      number INTEGER, title TEXT NOT NULL, body TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
      created TEXT NOT NULL, updated TEXT NOT NULL,
      UNIQUE(project_id, kind, number)
    );
    CREATE INDEX IF NOT EXISTS documents_project ON documents(project_id, kind, number);
    CREATE TABLE IF NOT EXISTS history (
      document_id TEXT NOT NULL REFERENCES documents(id), rev INTEGER NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
      reason TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(document_id, rev)
    );
    CREATE TABLE IF NOT EXISTS receipts (
      document_id TEXT NOT NULL REFERENCES documents(id), mutation TEXT NOT NULL,
      fingerprint TEXT NOT NULL, rev INTEGER NOT NULL, updated TEXT NOT NULL,
      PRIMARY KEY(document_id, mutation)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
      base_rev INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL, applied_rev INTEGER, request_hash TEXT NOT NULL, source_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_document ON runs(document_id, created);
    CREATE UNIQUE INDEX IF NOT EXISTS runs_single_active ON runs(status) WHERE status='running';
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    COMMIT;
  `)
  if (version < 2) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE reference_material (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL
      );
      CREATE INDEX reference_material_project ON reference_material(project_id,created);
      ALTER TABLE runs ADD COLUMN reference_ids TEXT NOT NULL DEFAULT '[]';
      PRAGMA user_version = 2;
      COMMIT;
    `)
  }
  if (version < 3) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE chapter_imports (
        project_id TEXT NOT NULL REFERENCES projects(id), mutation TEXT NOT NULL,
        fingerprint TEXT NOT NULL, receipt TEXT NOT NULL,
        PRIMARY KEY(project_id, mutation)
      );
      PRAGMA user_version = 3;
      COMMIT;
    `)
  }
  if (version < 4) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE project_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
        document_id TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE INDEX project_events_cursor ON project_events(project_id,cursor);
      CREATE TRIGGER document_created_event AFTER INSERT ON documents BEGIN
        INSERT INTO project_events(project_id,document_id,revision) VALUES (NEW.project_id,NEW.id,NEW.rev);
      END;
      CREATE TRIGGER document_updated_event AFTER UPDATE OF rev ON documents WHEN NEW.rev IS NOT OLD.rev BEGIN
        INSERT INTO project_events(project_id,document_id,revision) VALUES (NEW.project_id,NEW.id,NEW.rev);
      END;
      PRAGMA user_version = 4;
      COMMIT;
    `)
  }
  if (version < 5) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE narrative_threads (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('plot','foreshadow')),
        status TEXT NOT NULL CHECK(status IN ('planned','open','resolved','archived')),
        planted INTEGER, due INTEGER, resolved INTEGER,
        rev INTEGER NOT NULL, updated TEXT NOT NULL
      );
      CREATE INDEX narrative_threads_project ON narrative_threads(project_id,status,planted,due);
      PRAGMA user_version=5;
      COMMIT;
    `)
  }
  if (version < 6) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE reference_vectors (
        profile TEXT NOT NULL, reference_id TEXT NOT NULL REFERENCES reference_material(id),
        part INTEGER NOT NULL, total_parts INTEGER NOT NULL,
        start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
        dimensions INTEGER NOT NULL, vector BLOB NOT NULL,
        PRIMARY KEY(profile, reference_id, part)
      );
      PRAGMA user_version=6;
      COMMIT;
    `)
  }
  if (version < 7) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE runs ADD COLUMN outline_id TEXT;
      PRAGMA user_version=7;
      COMMIT;
    `)
  }
  if (version < 8) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE writing_batches (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        status TEXT NOT NULL CHECK(status IN ('running','paused','done','cancelled')),
        guidance TEXT NOT NULL, fingerprint TEXT NOT NULL, created TEXT NOT NULL, error TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX writing_batches_single_active ON writing_batches(status) WHERE status='running';
      CREATE INDEX writing_batches_project ON writing_batches(project_id,created);
      CREATE TABLE writing_batch_items (
        batch_id TEXT NOT NULL REFERENCES writing_batches(id), document_id TEXT NOT NULL REFERENCES documents(id),
        base_rev INTEGER NOT NULL, run_id TEXT UNIQUE REFERENCES runs(id), skipped TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(batch_id,document_id)
      );
      PRAGMA user_version=8;
      COMMIT;
    `)
  }
  if (version < 9) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE writing_skills (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL
      );
      CREATE INDEX writing_skills_project ON writing_skills(project_id,created);
      CREATE TABLE writing_skill_profiles (
        project_id TEXT PRIMARY KEY REFERENCES projects(id), bindings TEXT NOT NULL, rev INTEGER NOT NULL
      );
      ALTER TABLE writing_batches ADD COLUMN draft_skill TEXT;
      PRAGMA user_version=9;
      COMMIT;
    `)
  }
  db.prepare("UPDATE runs SET status='interrupted',error='服务重启，已保留收到的内容' WHERE status='running'").run()
  db.prepare("UPDATE writing_batches SET status='paused',error='服务重启，待手动继续' WHERE status='running'").run()
  const get = (sql, ...args) => db.prepare(sql).get(...args)
  const all = (sql, ...args) => db.prepare(sql).all(...args)
  const run = (sql, ...args) => db.prepare(sql).run(...args)

  function tx(action) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function project(id) {
    const row = get('SELECT * FROM projects WHERE id=?', id)
    if (!row) throw new ApiError(404, '作品不存在')
    return row
  }

  function document(pid, id) {
    const row = get('SELECT * FROM documents WHERE project_id=? AND id=?', pid, id)
    if (!row) throw new ApiError(404, '文档不存在')
    return row
  }

  function checkpoint(doc, reason) {
    run('INSERT OR IGNORE INTO history VALUES (?,?,?,?,?,?,?)',
      doc.id, doc.rev, doc.title, doc.body, doc.status, reason, now())
  }

  function createProject(title) {
    const row = { id: randomUUID(), title: string(title, 160, true).trim(), created: now() }
    run('INSERT INTO projects VALUES (?,?,?)', row.id, row.title, row.created)
    return row
  }

  function renameProject(pid, value) {
    object(value)
    const title = string(value.title, 160, true).trim()
    const baseTitle = string(value.baseTitle, 160, true)
    const changed = run('UPDATE projects SET title=? WHERE id=? AND title=?', title, pid, baseTitle)
    const current = project(pid)
    if (!changed.changes && current.title !== title) throw new ApiError(409, '另一设备已更改书名，请核对最新书名', current)
    return current
  }

  function addDocument(pid, value) {
    project(pid)
    const { title, body } = input(value)
    if (!kinds.includes(value.kind)) throw new ApiError(400, '文档类型无效')
    const number = ['blueprint', 'chapter'].includes(value.kind) ? numbered(value.number) : null
    if (number && get('SELECT id FROM documents WHERE project_id=? AND kind=? AND number=?', pid, value.kind, number)) {
      throw new ApiError(409, '该编号已存在')
    }
    const id = randomUUID()
    const stamp = now()
    run('INSERT INTO documents (id,project_id,kind,number,title,body,created,updated) VALUES (?,?,?,?,?,?,?,?)',
      id, pid, value.kind, number, title, body, stamp, stamp)
    const doc = document(pid, id)
    checkpoint(doc, 'created')
    return doc
  }

  function importChapters(pid, value) {
    object(value)
    const mutation = string(value.mutationId, 80, true)
    if (!Array.isArray(value.chapters) || !value.chapters.length || value.chapters.length > manuscriptChapterLimit) {
      throw new ApiError(400, '每次请选择 1–500 章')
    }
    const incoming = value.chapters.map(chapter => ({ ...input(chapter), number: numbered(chapter.number) }))
    const numbers = new Set()
    for (const chapter of incoming) {
      if (numbers.has(chapter.number)) throw new ApiError(400, '待导入的章号有重复')
      numbers.add(chapter.number)
    }
    const fingerprint = hash(JSON.stringify(incoming))
    return tx(() => {
      project(pid)
      const receipt = get('SELECT fingerprint,receipt FROM chapter_imports WHERE project_id=? AND mutation=?', pid, mutation)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ApiError(422, '导入请求编号已被使用')
        return JSON.parse(receipt.receipt)
      }
      const occupied = all("SELECT number FROM documents WHERE project_id=? AND kind='chapter' ORDER BY number", pid)
        .map(row => row.number).filter(number => numbers.has(number))
      if (occupied.length) throw new ApiError(409, '存在已占用的章号，本次没有导入任何章节', { occupied })
      const imported = incoming.map(chapter => {
        const { id, number, title } = addDocument(pid, { ...chapter, kind: 'chapter' })
        return { id, number, title }
      })
      const result = { chapters: imported }
      run('INSERT INTO chapter_imports VALUES (?,?,?,?)', pid, mutation, fingerprint, JSON.stringify(result))
      return result
    })
  }

  function eventHead() {
    return get("SELECT seq FROM sqlite_sequence WHERE name='project_events'")?.seq ?? 0
  }

  function projectEvents(pid, after) {
    return all('SELECT cursor,document_id,revision FROM project_events WHERE project_id=? AND cursor>? ORDER BY cursor LIMIT 128', pid, after)
  }

  function pruneEvents(head) {
    run('DELETE FROM project_events WHERE cursor<=?', head - 4096)
  }

  function match(doc, baseRev) {
    if (doc.rev !== revision(baseRev)) throw new ApiError(409, 'NAS 上已有更新版本', doc)
  }

  function update(doc, next, status, reason) {
    if (doc.title !== next.title || doc.body !== next.body || doc.status !== status) {
      run('UPDATE documents SET title=?,body=?,status=?,rev=rev+1,updated=? WHERE id=?',
        next.title, next.body, status, now(), doc.id)
    }
    const saved = document(doc.project_id, doc.id)
    const last = get('SELECT max(created) stamp FROM history WHERE document_id=?', doc.id)
    if (reason !== 'auto' || Date.now() - Date.parse(last.stamp) >= 300_000) checkpoint(saved, reason)
    return saved
  }

  function save(pid, id, value) {
    const next = input(value)
    const mutation = string(value.mutationId, 80, true)
    const baseRev = revision(value.baseRev)
    const reason = value.checkpoint === true ? 'manual' : 'auto'
    const fingerprint = hash(JSON.stringify([baseRev, next, reason]))
    return tx(() => {
      const doc = document(pid, id)
      const receipt = get('SELECT * FROM receipts WHERE document_id=? AND mutation=?', id, mutation)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ApiError(422, '保存请求编号已被使用')
        return { rev: receipt.rev, updated: receipt.updated }
      }
      match(doc, baseRev)
      if (doc.status === 'final') throw new ApiError(409, '请先重新打开定稿', doc)
      const saved = update(doc, next, doc.status, reason)
      run('INSERT INTO receipts VALUES (?,?,?,?,?)', id, mutation, fingerprint, saved.rev, saved.updated)
      return { rev: saved.rev, updated: saved.updated }
    })
  }

  function transition(pid, id, value) {
    object(value)
    return tx(() => {
      const doc = document(pid, id)
      match(doc, value.baseRev)
      if (doc.kind !== 'chapter') throw new ApiError(400, '只有正文可以定稿')
      if (value.action === 'finalize' && doc.status === 'draft' && doc.body.trim()) {
        checkpoint(doc, 'before-final')
        return update(doc, doc, 'final', 'final')
      }
      if (value.action === 'reopen' && doc.status === 'final') return update(doc, doc, 'draft', 'reopen')
      throw new ApiError(422, '当前状态无法执行操作，定稿需要非空正文')
    })
  }

  function history(pid, id) {
    document(pid, id)
    return all('SELECT * FROM history WHERE document_id=? ORDER BY rev DESC', id)
  }

  function restore(pid, id, value) {
    object(value)
    return tx(() => {
      const doc = document(pid, id)
      match(doc, value.baseRev)
      if (doc.status === 'final') throw new ApiError(409, '请先重新打开定稿', doc)
      const old = get('SELECT * FROM history WHERE document_id=? AND rev=?', id, revision(value.rev))
      if (!old) throw new ApiError(404, '历史版本不存在')
      checkpoint(doc, 'before-restore')
      return update(doc, old, 'draft', 'restore')
    })
  }

  function getRun(pid, id) {
    const row = get('SELECT r.* FROM runs r JOIN documents d ON r.document_id=d.id WHERE d.project_id=? AND r.id=?', pid, id)
    if (!row) throw new ApiError(404, '任务不存在')
    return row
  }

  function runDetail(pid, id) {
    const job = getRun(pid, id)
    if (job.kind !== 'review' || job.status !== 'done') return job
    const snapshot = get('SELECT body FROM history WHERE document_id=? AND rev=?', job.document_id, job.base_rev)
    const report = reviewReport(job.output, snapshot?.body)
    return report ? { ...job, reviewReport: report } : job
  }

  function parseRun(value) {
    object(value)
    const kind = value.kind
    if (!runKinds.includes(kind)) throw new ApiError(400, 'AI 操作无效')
    const guidance = string(value.guidance ?? '', 6000)
    const baseRev = revision(value.baseRev)
    const refs = value.referenceIds ?? []
    if (!Array.isArray(refs) || refs.length > 5 || new Set(refs).size !== refs.length ||
        refs.some(ref => typeof ref !== 'string' || !/^[a-f0-9-]{36}$/i.test(ref))) {
      throw new ApiError(400, '每次可引用最多五份不同的参考资料')
    }
    const referenceQuery = string(value.referenceQuery ?? '', 100).trim()
    const spans = value.referenceSpans ?? []
    if (!Array.isArray(spans) || spans.length > refs.length ||
        spans.some(span => !span || !refs.includes(span.id) || !Number.isSafeInteger(span.start) ||
          !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.end - span.start > 1200) ||
        new Set(spans.map(span => span.id)).size !== spans.length) {
      throw new ApiError(400, '引用的资料片段无效')
    }
    const outlineId = value.outlineId ?? null
    if (outlineId !== null && (kind !== 'draft' || typeof outlineId !== 'string' || !/^[a-f0-9-]{36}$/i.test(outlineId))) {
      throw new ApiError(400, '只有写稿可以引用已完成的细纲')
    }
    return { kind, guidance, baseRev, refs, referenceQuery, outlineId, spans: spans.map(({ id, start, end }) => ({ id, start, end })) }
  }

  function requestFingerprint(id, { kind, baseRev, guidance, refs, referenceQuery, spans, outlineId }) {
    const fingerprint = [id, baseRev, kind, guidance]
    if (refs.length || referenceQuery) fingerprint.push(refs)
    if (referenceQuery) fingerprint.push(referenceQuery)
    if (spans.length) fingerprint.push(spans)
    if (outlineId) fingerprint.push({ outlineId })
    return hash(JSON.stringify(fingerprint))
  }

  function outlineBinding(sourceHash, outline) {
    return 'outline:' + hash(JSON.stringify([sourceHash, outline.id, hash(outline.output)]))
  }

  function completedOutline(doc, id) {
    const row = get('SELECT * FROM runs WHERE id=? AND document_id=?', id, doc.id)
    if (!row || row.kind !== 'outline' || row.status !== 'done' || !row.output.trim() ||
        row.output.length > outlineMaxChars || row.base_rev !== doc.rev) {
      throw new ApiError(409, '细纲已失效或尚未完成，请为当前章节重新生成')
    }
    return row
  }

  function skillProfile(pid) {
    const row = get('SELECT bindings,rev FROM writing_skill_profiles WHERE project_id=?', pid)
    return row ? { bindings: JSON.parse(row.bindings), rev: row.rev }
      : { bindings: Object.fromEntries(runKinds.map(kind => [kind, null])), rev: 0 }
  }

  function writingSkill(pid, id) {
    const row = get('SELECT id,title,body FROM writing_skills WHERE project_id=? AND id=?', pid, id)
    if (!row) throw new ApiError(404, '写作 Skill 不存在')
    return row
  }

  function stageSkill(pid, kind) {
    const id = skillProfile(pid).bindings[kind]
    return id ? writingSkill(pid, id) : null
  }

  function skillSource(sourceHash, skill) {
    return skill ? 'skill:' + hash(JSON.stringify([sourceHash, skill.id, hash(skill.body)])) : sourceHash
  }

  function listSkills(pid) {
    return { ...skillProfile(pid), skills: all('SELECT id,title FROM writing_skills WHERE project_id=? ORDER BY created,id', pid) }
  }

  function skillInput(value) {
    object(value)
    return { title: string(value.title, 120, true).trim(), body: string(value.body, 8000, true) }
  }

  function installSkill(pid, value) {
    const { title, body } = skillInput(value)
    const id = string(value.mutationId, 80, true)
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new ApiError(400, 'Skill 编号无效')
    return tx(() => {
      const existing = get('SELECT project_id,title,body FROM writing_skills WHERE id=?', id)
      if (existing) {
        if (existing.project_id !== pid || existing.title !== title || existing.body !== body) throw new ApiError(409, 'Skill 编号已被使用')
      } else {
        if (get('SELECT count(*) n FROM writing_skills WHERE project_id=?', pid).n >= 40) throw new ApiError(422, '每部作品最多安装 40 个 Skill')
        run('INSERT INTO writing_skills VALUES (?,?,?,?,?)', id, pid, title, body, now())
      }
      return writingSkill(pid, id)
    })
  }

  function parseSkillBindings(value) {
    object(value)
    if (Object.keys(value).some(key => !runKinds.includes(key))) throw new ApiError(400, 'Skill 阶段无效')
    return Object.fromEntries(runKinds.map(kind => [kind, value[kind] == null ? null : string(value[kind], 80, true)]))
  }

  function bindSkills(pid, value) {
    object(value)
    const bindings = parseSkillBindings(value.bindings)
    if (!Number.isSafeInteger(value.baseRev) || value.baseRev < 0) throw new ApiError(400, 'Skill 设置版本无效')
    return tx(() => {
      const current = skillProfile(pid)
      const next = JSON.stringify(bindings)
      if (next === JSON.stringify(current.bindings)) return current
      if (value.baseRev !== current.rev) throw new ApiError(409, '另一设备已修改 Skill 绑定，请重新打开设置', current)
      for (const id of new Set(Object.values(bindings).filter(Boolean))) writingSkill(pid, id)
      run('INSERT INTO writing_skill_profiles VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET bindings=excluded.bindings,rev=excluded.rev',
        pid, next, current.rev + 1)
      return skillProfile(pid)
    })
  }

  function deleteSkill(pid, id) {
    return tx(() => {
      if (Object.values(skillProfile(pid).bindings).includes(id) || get(`SELECT 1 FROM writing_batches
          WHERE project_id=? AND draft_skill=? AND status IN ('running','paused')`, pid, id)) {
        throw new ApiError(409, '请先解除该 Skill 的绑定并处理仍使用它的批次')
      }
      run('DELETE FROM writing_skills WHERE project_id=? AND id=?', pid, id)
      return { ok: true }
    })
  }

  function runContext(doc, request) {
    match(doc, request.baseRev)
    if (doc.kind !== 'chapter' || doc.status !== 'draft') throw new ApiError(422, 'AI 操作需要未定稿章节')
    if (['review', 'revise'].includes(request.kind) && !doc.body.trim()) throw new ApiError(422, '请先填写正文')
    const source = sources(doc, request.refs, request.spans)
    const skill = stageSkill(doc.project_id, request.kind)
    const context = { doc, ...source, skill, sourceHash: skillSource(source.sourceHash, skill), guidance: request.guidance, referenceQuery: request.referenceQuery }
    if (!request.outlineId) return context
    const outline = completedOutline(doc, request.outlineId)
    const expected = requestFingerprint(doc.id, { ...request, kind: 'outline', outlineId: null })
    if (outline.source_hash !== skillSource(source.sourceHash, stageSkill(doc.project_id, 'outline')) || outline.request_hash !== expected) {
      throw new ApiError(409, '细纲与当前资料或作者要求不一致，请重新生成或取消引用')
    }
    return { ...context, outline: outline.output, sourceHash: outlineBinding(context.sourceHash, outline) }
  }

  function previewRun(pid, id, value, prepare) {
    const request = parseRun(value)
    return prepare(request.kind, runContext(document(pid, id), request))
  }

  function writingAvailable() {
    if (get("SELECT id FROM runs WHERE status='running'") || get("SELECT id FROM writing_batches WHERE status='running'")) {
      throw new ApiError(409, '已有生成任务正在运行')
    }
  }

  function insertRun(doc, request, jobId, prepare, previousCandidate) {
    const { kind, refs, outlineId } = request
    const context = runContext(doc, request)
    const messages = prepare(kind, { ...context, previousCandidate })
    const sourceHash = previousCandidate ? batchBinding(context.sourceHash, previousCandidate) : context.sourceHash
    if (kind === 'review') checkpoint(doc, 'before-review')
    run("INSERT INTO runs (id,document_id,base_rev,kind,status,created,request_hash,source_hash,reference_ids,outline_id) VALUES (?,?,?,?,'running',?,?,?,?,?)",
      jobId, doc.id, doc.rev, kind, now(), requestFingerprint(doc.id, request), sourceHash, JSON.stringify(refs), outlineId)
    return { job: getRun(doc.project_id, jobId), messages }
  }

  function startRun(pid, id, value, prepare) {
    const request = parseRun(value)
    const requestHash = requestFingerprint(id, request)
    return tx(() => {
      const doc = document(pid, id)
      const jobId = string(value.mutationId, 80, true)
      if (!/^[a-f0-9-]{36}$/i.test(jobId)) throw new ApiError(400, '任务编号无效')
      const existing = get('SELECT * FROM runs WHERE id=?', jobId)
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new ApiError(409, '任务编号已被使用')
        }
        return { job: runDetail(pid, jobId) }
      }
      writingAvailable()
      return insertRun(doc, request, jobId, prepare)
    })
  }

  function batchBinding(sourceHash, predecessor) {
    return 'batch:' + hash(JSON.stringify([sourceHash, predecessor.id, hash(predecessor.body)]))
  }

  function batchPredecessor(batchId, doc) {
    return get(`SELECT r.id,d.number,d.title,r.output body FROM writing_batch_items i
      JOIN documents d ON d.id=i.document_id JOIN runs r ON r.id=i.run_id
      WHERE i.batch_id=? AND d.number=? AND r.status='done'
        AND (d.rev=r.base_rev OR (d.rev=r.applied_rev AND d.body=r.output))
        AND NOT EXISTS (SELECT 1 FROM history WHERE document_id=d.id AND status='final')`, batchId, doc.number - 1)
  }

  function getBatch(pid, id) {
    const batch = get('SELECT id,status,created,error FROM writing_batches WHERE project_id=? AND id=?', pid, id)
    if (!batch) throw new ApiError(404, '批量写作任务不存在')
    const items = all(`SELECT d.id,d.number,d.title,i.run_id,CASE WHEN i.skipped<>'' THEN 'skipped' ELSE COALESCE(r.status,'queued') END status,
        CASE WHEN i.skipped<>'' THEN i.skipped ELSE COALESCE(r.error,'') END error
      FROM writing_batch_items i JOIN documents d ON d.id=i.document_id LEFT JOIN runs r ON r.id=i.run_id
      WHERE i.batch_id=? ORDER BY d.number`, id)
    return { ...batch, items }
  }

  function listBatches(pid) {
    return all(`SELECT b.id,b.status,b.created,COUNT(i.document_id) total,SUM(CASE WHEN r.status='done' THEN 1 ELSE 0 END) completed
      FROM writing_batches b JOIN writing_batch_items i ON i.batch_id=b.id LEFT JOIN runs r ON r.id=i.run_id
      WHERE b.project_id=? GROUP BY b.id ORDER BY b.created DESC,b.id DESC LIMIT 30`, pid)
  }

  function batchChapters(pid) {
    return all(`SELECT id,number,title,rev FROM documents
      WHERE project_id=? AND kind='chapter' AND status='draft' AND trim(body,?)='' ORDER BY number`, pid,
    '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
  }

  function createBatch(pid, value) {
    object(value)
    const id = string(value.mutationId, 80, true)
    const guidance = string(value.guidance ?? '', 6000)
    if (!/^[a-f0-9-]{36}$/i.test(id) || !Array.isArray(value.chapters) || !value.chapters.length || value.chapters.length > 20) {
      throw new ApiError(400, '每批请选择 1–20 个章节')
    }
    const chapters = value.chapters.map(item => [string(object(item).id, 80, true), revision(item.baseRev)])
      .sort(([left], [right]) => left.localeCompare(right))
    if (new Set(chapters.map(([doc]) => doc)).size !== chapters.length) throw new ApiError(400, '请选择不同的章节')
    const fingerprint = hash(JSON.stringify([pid, chapters, guidance]))
    return tx(() => {
      const existing = get('SELECT fingerprint FROM writing_batches WHERE id=?', id)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ApiError(409, '批次编号已被使用')
        return getBatch(pid, id)
      }
      writingAvailable()
      for (const [docId, baseRev] of chapters) {
        const doc = document(pid, docId)
        match(doc, baseRev)
        if (doc.kind !== 'chapter' || doc.status !== 'draft' || doc.body.trim()) throw new ApiError(422, '批量写作只接收空白且未定稿的章节')
      }
      run("INSERT INTO writing_batches (id,project_id,status,guidance,fingerprint,created,draft_skill) VALUES (?,?,'running',?,?,?,?)",
        id, pid, guidance, fingerprint, now(), stageSkill(pid, 'draft')?.id ?? null)
      for (const [docId, baseRev] of chapters) run('INSERT INTO writing_batch_items (batch_id,document_id,base_rev) VALUES (?,?,?)', id, docId, baseRev)
      return getBatch(pid, id)
    })
  }

  function changeBatch(pid, id, action) {
    return tx(() => {
      const batch = getBatch(pid, id)
      if (action === 'resume' && batch.status === 'paused') {
        writingAvailable()
        const { draft_skill: skill } = get('SELECT draft_skill FROM writing_batches WHERE id=?', id)
        if ((stageSkill(pid, 'draft')?.id ?? null) !== skill) throw new ApiError(409, '写稿 Skill 绑定已变化，请恢复原绑定或新建批次')
        run("UPDATE writing_batches SET status='running',error='' WHERE id=?", id)
      }
      if (action === 'pause' && batch.status === 'running') run("UPDATE writing_batches SET status='paused',error='' WHERE id=?", id)
      if (action === 'cancel' && ['running', 'paused'].includes(batch.status)) {
        run("UPDATE writing_batches SET status='cancelled',error='' WHERE id=?", id)
      }
      return getBatch(pid, id)
    })
  }

  function nextBatchRun(id, prepare) {
    return tx(() => {
      const batch = get("SELECT * FROM writing_batches WHERE id=? AND status='running'", id)
      if (!batch) return null
      if ((stageSkill(batch.project_id, 'draft')?.id ?? null) !== batch.draft_skill) {
        pauseBatch(id, '写稿 Skill 绑定已变化，请恢复原绑定或新建批次')
        return null
      }
      const items = all(`SELECT i.document_id,i.base_rev FROM writing_batch_items i
        JOIN documents d ON d.id=i.document_id LEFT JOIN runs r ON r.id=i.run_id
        WHERE i.batch_id=? AND i.skipped='' AND COALESCE(r.status,'')<>'done' ORDER BY d.number`, id)
      for (const item of items) {
        const doc = document(batch.project_id, item.document_id)
        const skip = message => run('UPDATE writing_batch_items SET skipped=? WHERE batch_id=? AND document_id=?', message, id, doc.id)
        if (doc.rev !== item.base_rev || doc.status !== 'draft' || doc.body.trim()) {
          skip('章节已被编辑或定稿，保留当前正文')
          continue
        }
        const request = parseRun({ kind: 'draft', baseRev: item.base_rev, guidance: batch.guidance })
        const jobId = randomUUID()
        let result
        try { result = insertRun(doc, request, jobId, prepare, batchPredecessor(id, doc)) }
        catch (error) {
          if (!(error instanceof ApiError)) throw error
          skip(error.message)
          continue
        }
        run('UPDATE writing_batch_items SET run_id=? WHERE batch_id=? AND document_id=?', jobId, id, doc.id)
        return result
      }
      run("UPDATE writing_batches SET status='done' WHERE id=?", id)
      return null
    })
  }

  function pauseBatch(id, error) {
    run("UPDATE writing_batches SET status='paused',error=? WHERE id=? AND status='running'", error, id)
  }

  function sources(doc, refs, spans = []) {
    const materials = all(`
      SELECT id, rev, kind, title, body, number FROM documents WHERE project_id=? AND
        (kind IN ('settings','character') OR (kind='blueprint' AND number=?))
      ORDER BY CASE kind WHEN 'blueprint' THEN 0 WHEN 'settings' THEN 1 ELSE 2 END, created, id LIMIT 100`,
      doc.project_id, doc.number)
    const [previous, ...earlier] = all(finalizedSelect + ' AND d.number<? ORDER BY d.number DESC LIMIT 3', doc.project_id, doc.number)
    const selected = refs.map(id => {
      const entry = { ...reference(doc.project_id, id), kind: 'reference', rev: 1 }
      const span = spans.find(candidate => candidate.id === id)
      if (!span) return entry
      if (span.end > entry.body.length) throw new ApiError(400, '引用片段已超出资料范围')
      return { ...entry, body: entry.body.slice(span.start, span.end), exactExcerpt: true }
    })
    const threads = all(`
      SELECT id,rev,title,body,kind,status,planted,due,resolved FROM narrative_threads
      WHERE project_id=? AND status<>'archived' AND
        ((status='planned' AND planted=?) OR (status='open' AND (planted IS NULL OR planted<=?)) OR
          (status='resolved' AND resolved BETWEEN ? AND ?))
      ORDER BY CASE WHEN due=? OR resolved=? THEN 0 WHEN status='open' THEN 1 ELSE 2 END, updated DESC,id
      LIMIT 12`, doc.project_id, doc.number, doc.number, Math.max(1, doc.number - 2), doc.number, doc.number, doc.number)
    const dependencies = [...materials, ...selected, ...(previous ? [previous] : [])].map(({ id, rev }) => [id, rev])
    const legacyHash = hash(JSON.stringify(dependencies))
    const extended = [...dependencies, ...earlier.map(({ id, rev }) => [id, rev])]
    const previousHash = 'v2:' + hash(JSON.stringify(extended))
    const sourceHash = 'v3:' + hash(JSON.stringify([...extended, ...threads.map(({ id, rev }) => [id, rev])]))
    return { materials: [...selected, ...materials], previous, earlier, threads, sourceHash, previousHash, legacyHash }
  }

  // A reopened draft has a mutable head while the latest final remains in history.
  const finalizedSelect = `
    SELECT d.id,d.number,h.title,h.body,h.rev FROM documents d
    JOIN history h ON h.document_id=d.id AND h.rev=(
      SELECT MAX(f.rev) FROM history f WHERE f.document_id=d.id AND f.status='final'
    )
    WHERE d.project_id=? AND d.kind='chapter'`

  function chapters(pid, includeDrafts) {
    return includeDrafts
      ? all("SELECT number,title,body FROM documents WHERE project_id=? AND kind='chapter' ORDER BY number", pid)
      : all(finalizedSelect + ' ORDER BY d.number', pid)
  }

  function reference(pid, id) {
    const row = get('SELECT * FROM reference_material WHERE project_id=? AND id=?', pid, id)
    if (!row) throw new ApiError(404, '参考资料不存在')
    return row
  }

  function threads(pid) {
    return all(`
      SELECT * FROM narrative_threads WHERE project_id=?
      ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'planned' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
        due IS NULL,due,planted IS NULL,planted,updated DESC,id`, pid)
  }

  function saveThread(pid, id, value) {
    const { title, body } = input(value)
    string(body, 6000)
    const { kind, status } = value
    if (!['plot', 'foreshadow'].includes(kind) || !['planned', 'open', 'resolved', 'archived'].includes(status)) {
      throw new ApiError(400, '线索类型或状态无效')
    }
    const planted = value.planted == null ? null : numbered(value.planted)
    const due = value.due == null ? null : numbered(value.due)
    const resolved = value.resolved == null ? null : numbered(value.resolved)
    if ((status === 'resolved' && !resolved) || (planted !== null && ((due !== null && due < planted) ||
      (resolved !== null && resolved < planted)))) {
      throw new ApiError(400, '请检查埋设、预计回收及实际回收的章号')
    }
    const values = [title, body, kind, status, planted, due, resolved]
    project(pid)
    if (id) {
      const changed = run(`
        UPDATE narrative_threads SET title=?,body=?,kind=?,status=?,planted=?,due=?,resolved=?,rev=rev+1,updated=?
        WHERE id=? AND project_id=? AND rev=?`, ...values, now(), id, pid, revision(value.baseRev))
      if (changed.changes === 0) {
        const old = get('SELECT * FROM narrative_threads WHERE project_id=? AND id=?', pid, id)
        if (!old) throw new ApiError(404, '线索不存在')
        throw new ApiError(409, '另一设备已更新这条线索，请重新打开后核对', old)
      }
    } else {
      id = randomUUID()
      run('INSERT INTO narrative_threads VALUES (?,?,?,?,?,?,?,?,?,1,?)', id, pid, ...values, now())
    }
    return get('SELECT * FROM narrative_threads WHERE id=?', id)
  }

  function addReference(pid, value) {
    project(pid)
    const { title, body } = input(value)
    if (!body.trim()) throw new ApiError(400, '参考资料没有可读取的文字')
    const id = randomUUID()
    run('INSERT INTO reference_material VALUES (?,?,?,?,?)', id, pid, title, body, now())
    return reference(pid, id)
  }

  function search(pid, value) {
    const query = string(value, 100, true).trim()
    return all(`
      WITH materials AS (
        SELECT id,kind,number,title,body FROM documents WHERE project_id=?
        UNION ALL
        SELECT id,'reference',NULL,title,body FROM reference_material WHERE project_id=?
      ), matches AS (
        SELECT id, kind, number, title, body,
          instr(lower(title), lower(?)) title_match, instr(lower(body), lower(?)) body_match
        FROM materials
      )
      SELECT id,kind,number,title,substr(body,max(1,body_match-35),140) excerpt FROM matches
      WHERE title_match>0 OR body_match>0
      ORDER BY title_match=0,kind,number,title,id LIMIT 40`, pid, pid, query, query)
  }

  function checkCandidate(doc, job) {
    match(doc, job.base_rev)
    if (doc.status === 'final') throw new ApiError(422, '请先重新打开定稿')
    const bindings = sources(doc, JSON.parse(job.reference_ids))
    const skill = stageSkill(doc.project_id, job.kind)
    const sourceHash = skillSource(bindings.sourceHash, skill)
    let valid = (skill ? [sourceHash] : [sourceHash, bindings.previousHash, bindings.legacyHash]).includes(job.source_hash)
    if (job.outline_id) {
      const outline = completedOutline(doc, job.outline_id)
      valid = outline.source_hash === skillSource(bindings.sourceHash, stageSkill(doc.project_id, 'outline')) &&
        outlineBinding(sourceHash, outline) === job.source_hash
    }
    if (job.source_hash.startsWith('batch:')) {
      const item = get('SELECT batch_id FROM writing_batch_items WHERE run_id=?', job.id)
      const predecessor = item && batchPredecessor(item.batch_id, doc)
      valid = predecessor && batchBinding(sourceHash, predecessor) === job.source_hash
    }
    if (!valid) throw new ApiError(409, '生成时的资料或写作 Skill 已变化，请核对候选并重新生成')
  }

  function saveCandidate(doc, job, body) {
    checkpoint(doc, 'before-ai')
    const saved = update(doc, { title: doc.title, body }, 'draft', 'ai')
    run('UPDATE runs SET applied_rev=? WHERE id=?', saved.rev, job.id)
    return saved
  }

  function applyRun(pid, id) {
    return tx(() => {
      const job = getRun(pid, id)
      const doc = document(pid, job.document_id)
      if (job.applied_rev !== null) return doc
      if (!['draft', 'revise'].includes(job.kind) || !job.output.trim() || job.status === 'running') {
        throw new ApiError(422, '此任务没有可应用的正文')
      }
      checkCandidate(doc, job)
      return saveCandidate(doc, job, job.output)
    })
  }

  function completedRevision(pid, id) {
    const job = getRun(pid, id)
    if (job.kind !== 'revise' || job.status !== 'done' || !job.output.trim()) {
      throw new ApiError(422, '此任务没有已完成的修稿候选')
    }
    return job
  }

  function revisionPlan(job, body) {
    const changes = revisionChanges(body, job.output)
    return { changes, plan: hash(JSON.stringify([job.id, job.base_rev, changes])) }
  }

  function previewRevision(pid, id) {
    const job = completedRevision(pid, id)
    const doc = document(pid, job.document_id)
    if (job.applied_rev !== null) throw new ApiError(409, '此候选已应用')
    checkCandidate(doc, job)
    const { changes, plan } = revisionPlan(job, doc.body)
    return { plan, changes: changes.map(({ start, end, line, after }) => ({ line, before: doc.body.slice(start, end), after })) }
  }

  function applyRevision(pid, id, value) {
    object(value)
    return tx(() => {
      const job = completedRevision(pid, id)
      const doc = document(pid, job.document_id)
      const applied = job.applied_rev !== null
      if (!applied) checkCandidate(doc, job)
      const original = applied ? get('SELECT body FROM history WHERE document_id=? AND rev=?', doc.id, job.base_rev) : doc
      if (!original) throw new ApiError(409, '缺少修稿使用的正文版本')
      const { changes, plan } = revisionPlan(job, original.body)
      if (value.plan !== plan) throw new ApiError(409, '修稿预览已过期，请重新打开候选')
      const picks = value.picks
      if (!Array.isArray(picks) || !picks.length || picks.length > changes.length || new Set(picks).size !== picks.length ||
          picks.some(i => !Number.isSafeInteger(i) || i < 0 || i >= changes.length)) throw new ApiError(400, '请选择有效的修稿改动')
      const merged = mergeRevision(original.body, changes, new Set(picks))
      if (!merged.trim() || merged === original.body) throw new ApiError(422, '选中的改动未形成可保存的新正文')
      string(merged, 180_000)
      if (!applied) return saveCandidate(doc, job, merged)
      // A lost response can be retried after a later edit without applying a second selection.
      const saved = get('SELECT body FROM history WHERE document_id=? AND rev=?', doc.id, job.applied_rev)
      if (saved?.body !== merged) throw new ApiError(409, '此候选已应用其他改动')
      return doc
    })
  }

  function backup(pid) {
    return tx(() => ({
      format: 'pagekin-web-novel-v1',
      title: project(pid).title,
      documents: all('SELECT * FROM documents WHERE project_id=? ORDER BY created', pid)
        .map(doc => ({ ...doc, history: history(pid, doc.id) })),
      references: all('SELECT title,body FROM reference_material WHERE project_id=? ORDER BY created,id', pid),
      threads: threads(pid).map(({ title, body, kind, status, planted, due, resolved }) => ({ title, body, kind, status, planted, due, resolved })),
      writingSkills: { library: all('SELECT id,title,body FROM writing_skills WHERE project_id=? ORDER BY created,id', pid), bindings: skillProfile(pid).bindings },
      runs: all('SELECT r.* FROM runs r JOIN documents d ON r.document_id=d.id WHERE d.project_id=?', pid),
    }))
  }

  function importSkills(pid, value) {
    object(value)
    if (!Array.isArray(value.library) || value.library.length > 40) throw new ApiError(400, '备份中的 Skill 库无效')
    const ids = new Map()
    for (const source of value.library) {
      const { title, body } = skillInput(source)
      const oldId = string(source.id, 80, true)
      if (ids.has(oldId)) throw new ApiError(400, '备份包含重复 Skill')
      const id = randomUUID()
      ids.set(oldId, id)
      run('INSERT INTO writing_skills VALUES (?,?,?,?,?)', id, pid, title, body, now())
    }
    const bindings = parseSkillBindings(value.bindings)
    for (const [kind, id] of Object.entries(bindings)) {
      if (!id) continue
      if (!ids.has(id)) throw new ApiError(400, '备份中的 Skill 绑定无效')
      bindings[kind] = ids.get(id)
    }
    if (Object.values(bindings).some(Boolean)) run('INSERT INTO writing_skill_profiles VALUES (?,?,1)', pid, JSON.stringify(bindings))
  }

  function importBackup(data) {
    object(data)
    if (data.format !== 'pagekin-web-novel-v1' || !Array.isArray(data.documents) || data.documents.length > 3000 ||
        (data.references !== undefined && (!Array.isArray(data.references) || data.references.length > 3000)) ||
        (data.threads !== undefined && (!Array.isArray(data.threads) || data.threads.length > 3000)) ||
        (data.runs !== undefined && !Array.isArray(data.runs))) throw new ApiError(400, '不支持此 Web 作品备份格式')
    return tx(() => {
      const p = createProject(data.title)
      if (data.writingSkills !== undefined) importSkills(p.id, data.writingSkills)
      for (const source of data.references ?? []) addReference(p.id, source)
      for (const source of data.threads ?? []) saveThread(p.id, null, source)
      const mapping = new Map()
      for (const source of data.documents) {
        object(source)
        string(source.id, 160, true)
        const doc = addDocument(p.id, source)
        if (mapping.has(source.id)) throw new ApiError(400, '备份包含重复文档')
        mapping.set(source.id, doc.id)
        if (!['draft', 'final'].includes(source.status) || (source.status === 'final' && doc.kind !== 'chapter') ||
            !Array.isArray(source.history)) throw new ApiError(400, '备份中的文档状态无效')
        const rev = revision(source.rev)
        run('UPDATE documents SET status=?,rev=? WHERE id=?', source.status, rev, doc.id)
        run('DELETE FROM history WHERE document_id=?', doc.id)
        const seen = new Set()
        for (const entry of source.history) {
          const old = input(entry)
          if (!['draft', 'final'].includes(entry.status) || revision(entry.rev) > rev) throw new ApiError(400, '历史版本无效')
          if (seen.has(entry.rev) || (entry.rev === rev &&
              (entry.status !== source.status || old.title !== doc.title || old.body !== doc.body))) {
            throw new ApiError(400, '备份中的历史版本与当前内容不一致')
          }
          seen.add(entry.rev)
          run('INSERT INTO history VALUES (?,?,?,?,?,?,?)', doc.id, entry.rev,
            old.title, old.body, entry.status, string(entry.reason, 80), string(entry.created, 50))
        }
        checkpoint(document(p.id, doc.id), 'import')
      }
      const importedRuns = new Map()
      for (const source of data.runs ?? []) {
        object(source)
        string(source.id, 160, true)
        const id = mapping.get(source.document_id)
        const status = source.status === 'running' ? 'interrupted' : source.status
        if (!id || !runKinds.includes(source.kind) || importedRuns.has(source.id) ||
            !['done','cancelled','failed','interrupted'].includes(status)) throw new ApiError(400, '备份中的任务无效')
        const runId = randomUUID()
        importedRuns.set(source.id, { id: runId, document: id, kind: source.kind })
        run(`INSERT INTO runs (id,document_id,base_rev,kind,status,output,error,created,applied_rev,request_hash,source_hash)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, runId, id, revision(source.base_rev),
          source.kind, status, string(source.output, 180_000), string(source.error, 500),
          string(source.created, 50), source.applied_rev === null ? null : revision(source.applied_rev), '', '')
      }
      for (const source of data.runs ?? []) {
        if (source.outline_id == null) continue
        const draft = importedRuns.get(source.id)
        const outline = importedRuns.get(source.outline_id)
        if (draft.kind !== 'draft' || outline?.kind !== 'outline' || outline.document !== draft.document) {
          throw new ApiError(400, '备份中的写稿细纲引用无效')
        }
        run('UPDATE runs SET outline_id=? WHERE id=?', outline.id, draft.id)
      }
      return p
    })
  }

  return { db, get, all, run, tx, project, document, createProject, renameProject, addDocument, importChapters, eventHead, projectEvents, pruneEvents,
    save, chapters, search, addReference, reference, threads, saveThread,
    transition, history, restore, getRun, runDetail, startRun, previewRun, applyRun, previewRevision, applyRevision, backup, importBackup,
    listBatches, batchChapters, getBatch, createBatch, changeBatch, nextBatchRun, pauseBatch,
    listSkills, writingSkill, installSkill, bindSkills, deleteSkill }
}
