import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { manuscriptChapterLimit } from './public/manuscript.mjs'
import { schemaVersion } from './version.mjs'

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

export const kinds = ['settings', 'character', 'blueprint', 'chapter']
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
  db.prepare("UPDATE runs SET status='interrupted',error='服务重启，已保留收到的内容' WHERE status='running'").run()
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

  function parseRun(value) {
    object(value)
    const kind = value.kind
    if (!['draft', 'review', 'revise'].includes(kind)) throw new ApiError(400, 'AI 操作无效')
    const guidance = string(value.guidance ?? '', 6000)
    const baseRev = revision(value.baseRev)
    const refs = value.referenceIds ?? []
    if (!Array.isArray(refs) || refs.length > 5 || new Set(refs).size !== refs.length ||
        refs.some(ref => typeof ref !== 'string' || !/^[a-f0-9-]{36}$/i.test(ref))) {
      throw new ApiError(400, '每次可引用最多五份不同的参考资料')
    }
    const referenceQuery = string(value.referenceQuery ?? '', 100).trim()
    return { kind, guidance, baseRev, refs, referenceQuery }
  }

  function runContext(doc, request) {
    match(doc, request.baseRev)
    if (doc.kind !== 'chapter' || doc.status !== 'draft') throw new ApiError(422, 'AI 操作需要未定稿章节')
    if (request.kind !== 'draft' && !doc.body.trim()) throw new ApiError(422, '请先填写正文')
    return { doc, ...sources(doc, request.refs), guidance: request.guidance, referenceQuery: request.referenceQuery }
  }

  function previewRun(pid, id, value, prepare) {
    const request = parseRun(value)
    return prepare(request.kind, runContext(document(pid, id), request))
  }

  function startRun(pid, id, value, prepare) {
    const request = parseRun(value)
    const { kind, baseRev, guidance, refs, referenceQuery } = request
    const fingerprint = [id, baseRev, kind, guidance]
    if (refs.length || referenceQuery) fingerprint.push(refs)
    if (referenceQuery) fingerprint.push(referenceQuery)
    const requestHash = hash(JSON.stringify(fingerprint))
    return tx(() => {
      const doc = document(pid, id)
      const jobId = string(value.mutationId, 80, true)
      if (!/^[a-f0-9-]{36}$/i.test(jobId)) throw new ApiError(400, '任务编号无效')
      const existing = get('SELECT * FROM runs WHERE id=?', jobId)
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new ApiError(409, '任务编号已被使用')
        }
        return { job: existing }
      }
      if (get("SELECT id FROM runs WHERE status='running'")) throw new ApiError(409, '已有生成任务正在运行')
      const context = runContext(doc, request)
      const messages = prepare(kind, context)
      run("INSERT INTO runs (id,document_id,base_rev,kind,status,created,request_hash,source_hash,reference_ids) VALUES (?,?,?,?,'running',?,?,?,?)",
        jobId, id, doc.rev, kind, now(), requestHash, context.sourceHash, JSON.stringify(refs))
      return { job: getRun(pid, jobId), messages }
    })
  }

  function sources(doc, refs) {
    const materials = all(`
      SELECT id, rev, kind, title, body, number FROM documents WHERE project_id=? AND
        (kind IN ('settings','character') OR (kind='blueprint' AND number=?))
      ORDER BY CASE kind WHEN 'blueprint' THEN 0 WHEN 'settings' THEN 1 ELSE 2 END, created, id LIMIT 100`,
      doc.project_id, doc.number)
    const [previous, ...earlier] = all(finalizedSelect + ' AND d.number<? ORDER BY d.number DESC LIMIT 3', doc.project_id, doc.number)
    const selected = refs.map(id => ({ ...reference(doc.project_id, id), kind: 'reference', rev: 1 }))
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

  function applyRun(pid, id) {
    return tx(() => {
      const job = getRun(pid, id)
      const doc = document(pid, job.document_id)
      if (job.applied_rev !== null) return doc
      if (job.kind === 'review' || !job.output.trim() || job.status === 'running') throw new ApiError(422, '此任务没有可应用的正文')
      match(doc, job.base_rev)
      if (doc.status === 'final') throw new ApiError(422, '请先重新打开定稿')
      const bindings = sources(doc, JSON.parse(job.reference_ids))
      if (![bindings.sourceHash, bindings.previousHash, bindings.legacyHash].includes(job.source_hash)) {
        throw new ApiError(409, '生成时的设定、蓝图或前文已变化，请核对候选并重新生成')
      }
      checkpoint(doc, 'before-ai')
      const saved = update(doc, { title: doc.title, body: job.output }, 'draft', 'ai')
      run('UPDATE runs SET applied_rev=? WHERE id=?', saved.rev, id)
      return saved
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
      runs: all('SELECT r.* FROM runs r JOIN documents d ON r.document_id=d.id WHERE d.project_id=?', pid),
    }))
  }

  function importBackup(data) {
    object(data)
    if (data.format !== 'pagekin-web-novel-v1' || !Array.isArray(data.documents) || data.documents.length > 3000 ||
        (data.references !== undefined && (!Array.isArray(data.references) || data.references.length > 3000)) ||
        (data.threads !== undefined && (!Array.isArray(data.threads) || data.threads.length > 3000)) ||
        (data.runs !== undefined && !Array.isArray(data.runs))) throw new ApiError(400, '不支持此 Web 作品备份格式')
    return tx(() => {
      const p = createProject(data.title)
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
      for (const source of data.runs ?? []) {
        object(source)
        const id = mapping.get(source.document_id)
        const status = source.status === 'running' ? 'interrupted' : source.status
        if (!id || !['draft','review','revise'].includes(source.kind) ||
            !['done','cancelled','failed','interrupted'].includes(status)) throw new ApiError(400, '备份中的任务无效')
        run(`INSERT INTO runs (id,document_id,base_rev,kind,status,output,error,created,applied_rev,request_hash,source_hash)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, randomUUID(), id, revision(source.base_rev),
          source.kind, status, string(source.output, 180_000), string(source.error, 500),
          string(source.created, 50), source.applied_rev === null ? null : revision(source.applied_rev), '', '')
      }
      return p
    })
  }

  return { db, get, all, run, tx, project, document, createProject, renameProject, addDocument, importChapters, eventHead, projectEvents, pruneEvents,
    save, chapters, search, addReference, reference, threads, saveThread,
    transition, history, restore, getRun, startRun, previewRun, applyRun, backup, importBackup }
}
