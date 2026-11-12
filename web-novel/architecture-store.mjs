import { ApiError, object, revision, string } from './input.mjs'
import { architectureSections, joinArchitecture, splitArchitecture } from './public/architecture.mjs'

export const architectureSchema = `
  CREATE TABLE architecture_sections (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    section TEXT NOT NULL, document_id TEXT NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    confirmed_rev INTEGER, PRIMARY KEY(project_id,section)
  );
`

export function openArchitecture({ all, get, run, tx, document, addDocument }) {
  const list = pid => all(`SELECT a.section,a.document_id,a.confirmed_rev,d.title,d.rev,
    CASE WHEN a.confirmed_rev=d.rev THEN 'confirmed' ELSE 'draft' END status
    FROM architecture_sections a JOIN documents d ON d.id=a.document_id WHERE a.project_id=?`, pid)
  const sectionFor = id => get('SELECT section FROM architecture_sections WHERE document_id=?', id)?.section

  function bind(pid, key, documentId) {
    const { title, headings } = architectureSections[key]
    const current = list(pid).find(row => row.section === key)
    if (current) {
      if (documentId && current.document_id !== documentId) throw new ApiError(409, '此架构模块已绑定文档', current)
      return current
    }
    const doc = documentId ? document(pid, documentId) : addDocument(pid, {
      kind: 'settings', title, body: joinArchitecture('', headings),
    })
    if (doc.kind !== 'settings' || sectionFor(doc.id)) throw new ApiError(422, '请选择尚未绑定的设定文档')
    run('INSERT INTO architecture_sections (project_id,section,document_id) VALUES (?,?,?)', pid, key, doc.id)
    return list(pid).find(row => row.section === key)
  }

  function change(pid, key, value) {
    object(value)
    if (!Object.hasOwn(architectureSections, key)) throw new ApiError(404, '架构模块不存在')
    return tx(() => {
      if (value.action === 'bind') return bind(pid, key, value.documentId == null ? null : string(value.documentId, 80, true))
      if (!['confirm', 'reopen'].includes(value.action)) throw new ApiError(400, '架构操作无效')
      const row = list(pid).find(item => item.section === key)
      if (!row) throw new ApiError(404, '请先绑定架构文档')
      if (row.rev !== revision(value.baseRev)) throw new ApiError(409, '架构文档已更新，请核对后再确认', row)
      if (value.action === 'confirm') {
        const fields = splitArchitecture(document(pid, row.document_id).body, architectureSections[key].headings)
        if (!fields || fields.values.some(text => !text.trim())) throw new ApiError(422, '请先填写所有架构字段')
      }
      run('UPDATE architecture_sections SET confirmed_rev=? WHERE project_id=? AND section=?',
        value.action === 'confirm' ? row.rev : null, pid, key)
      return list(pid).find(item => item.section === key)
    })
  }

  function importBackup(pid, rows, mapping) {
    if (!Array.isArray(rows) || rows.length > Object.keys(architectureSections).length) throw new ApiError(400, '备份中的架构模块无效')
    const seen = new Set()
    for (const source of rows) {
      object(source)
      const { section: key, confirmed_rev: confirmed } = source
      const id = mapping.get(source.document_id)
      if (!Object.hasOwn(architectureSections, key) || !id || seen.has(key)) throw new ApiError(400, '备份中的架构绑定无效')
      seen.add(key)
      const row = bind(pid, key, id)
      if (confirmed == null) continue
      if (revision(confirmed) > row.rev) throw new ApiError(400, '备份中的架构确认版本无效')
      if (confirmed === row.rev) {
        const fields = splitArchitecture(document(pid, id).body, architectureSections[key].headings)
        if (!fields || fields.values.some(text => !text.trim())) throw new ApiError(400, '备份中的已确认架构缺少字段')
      }
      run('UPDATE architecture_sections SET confirmed_rev=? WHERE project_id=? AND section=?', confirmed, pid, key)
    }
  }
  return { list, sectionFor, change, importBackup }
}
