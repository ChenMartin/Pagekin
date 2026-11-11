import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { hash, now, string } from './store.mjs'
import { novelGoals } from './public/novel-goals.mjs'
import { desktopCharacterEvents } from './desktop-character-import.mjs'

const schemas = new Set([7, 8, 9])
const working = new Set(['draft', 'reviewed', 'revised'])
const retained = new Set([...working, 'finalized', 'superseded', 'archived'])
const settingsFields = [
  ['genre', '类型'], ['sub_genre', '子类型'], ['target_audience', '受众'],
  ['writing_language', '写作语言'], ['total_chapters', '预计章节'], ['words_per_chapter', '单章字数'],
  ['narrative_pov', '叙事视角'], ['plot_structure', '结构'], ['writing_style', '文风'],
  ['reference_works', '参考作品'], ['global_guidance', '全局指导'], ['golden_finger', '金手指'],
  ['core_outline', '核心大纲'], ['world_setting', '世界设定'], ['protagonist_profile', '主角档案'],
  ['premise', '故事前提'], ['worldbuilding', '世界观'], ['characters_arch', '人物群像'], ['synopsis', '情节大纲'],
]
const characterFields = [
  ['role', '角色定位'], ['gender', '性别'], ['age', '年龄'], ['appearance', '外貌'],
  ['personality', '性格'], ['background', '背景'], ['abilities', '能力'], ['motivation', '动机'],
  ['relationships', '关系'], ['arc', '人物弧光'], ['notes', '备注'],
]
const blueprintFields = [
  ['role', '章节作用'], ['purpose', '目的'], ['key_events', '事件'], ['characters', '出场角色'],
  ['suspense_hook', '悬念钩子'], ['user_guidance', '作者指导'],
]

function sections(row, fields) {
  return fields.filter(([field]) => row[field] != null && row[field] !== '' && row[field] !== '[]')
    .map(([field, heading]) => `## ${heading}\n\n${row[field]}`).join('\n\n')
}

function liveReopen(draft, final) {
  if (!working.has(draft.status) || draft.version <= final.version) return false
  let refs
  try { refs = JSON.parse(draft.source_dependencies) } catch { return false }
  if (!Array.isArray(refs) || refs.length !== 1) return false
  const [ref] = refs
  return ref?.chapterNumber === final.chapter_number && ref.draftId === final.id && ref.contentHash === hash(final.body)
    && (final.finalization_id
      ? ref.kind === 'finalized' && ref.finalizationId === final.finalization_id
      : ref.kind === 'legacy-finalized')
}

function withCopy(source, action, stagingRoot) {
  const sidecars = ['-wal', '-journal']
  if (sidecars.some(suffix => existsSync(source + suffix))) {
    throw new Error('项目数据库有 WAL 或日志文件，请关闭桌面版后再导出，或从桌面版恢复一份独立副本')
  }
  const before = statSync(source)
  if (!before.isFile() || before.size > 128_000_000) throw new Error('需要小于 128 MB 的桌面项目数据库')
  const directory = mkdtempSync(join(stagingRoot, 'pagekin-desktop-copy-'))
  try {
    const target = join(directory, 'project.db')
    copyFileSync(source, target)
    const after = statSync(source)
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        sidecars.some(suffix => existsSync(source + suffix))) {
      throw new Error('复制时桌面项目发生变化，请关闭桌面版后重试')
    }
    const db = new DatabaseSync(target, { readOnly: true, allowExtension: false })
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF')
      return action(db)
    } finally { db.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

export function desktopCopy(source, stagingRoot = tmpdir()) {
  return withCopy(resolve(source), db => {
    if (!schemas.has(db.prepare('PRAGMA user_version').get().user_version)) {
      throw new Error('仅支持 Pagekin 桌面数据库 schema 7、8、9')
    }
    const project = db.prepare("SELECT * FROM project_core WHERE id='main'").get()
    if (!project) throw new Error('桌面项目缺少作品元数据')
    const documents = []
    function add(id, kind, title, body, number = null, status = 'draft', rev = 1, history = []) {
      if (number !== null && (!Number.isInteger(number) || number < 1 || number > 99999)) throw new Error('桌面章节号超出范围')
      documents.push({ id, kind, title: string(title, 160, true), body: string(body, 180_000), number, status, rev, history })
    }
    add('settings', 'settings', '作品设定与架构', sections(project, settingsFields))
    const characters = db.prepare('SELECT * FROM characters ORDER BY name,rowid').all()
      .map((row, index) => ({ id: `character-${index}`, row }))
    for (const { id, row } of characters) add(id, 'character', row.name, sections(row, characterFields))
    const blueprints = db.prepare('SELECT * FROM blueprints ORDER BY chapter_number').all()
    const titles = new Map(blueprints.map(row => [row.chapter_number, row.title?.trim()]))
    for (const row of blueprints) {
      add(`blueprint-${row.chapter_number}`, 'blueprint', row.title?.trim() || `第 ${row.chapter_number} 章蓝图`,
        sections(row, blueprintFields), row.chapter_number)
    }
    const chapters = new Map()
    for (const row of db.prepare(`
      SELECT d.*,c.body,f.finalization_id,f.chapter_title,f.content_hash,f.content_snapshot
      FROM drafts d LEFT JOIN contents c ON c.id=d.content_id
      LEFT JOIN finalization_outbox f ON f.draft_id=d.id
      WHERE d.status IS NOT 'deleted' ORDER BY d.chapter_number,d.version DESC,d.id DESC`).iterate()) {
      if (!retained.has(row.status) || !Number.isSafeInteger(row.version) || row.version < 1 ||
          typeof row.body !== 'string' || (row.finalization_id &&
            (row.content_hash !== hash(row.body) || row.content_snapshot !== row.body))) {
        throw new Error(`第 ${row.chapter_number} 章的草稿或定稿收据不完整`)
      }
      if (!chapters.has(row.chapter_number)) chapters.set(row.chapter_number, [])
      chapters.get(row.chapter_number).push(row)
    }
    for (const [number, rows] of chapters) {
      const final = rows.find(row => row.status === 'finalized')
      const head = final ? rows.find(row => liveReopen(row, final)) ?? final : rows.find(row => working.has(row.status))
      if (!head) throw new Error(`第 ${number} 章只剩归档稿件。请在桌面版恢复或单独导出该章后重试`)
      const heading = row => row.chapter_title?.trim() || titles.get(number) || `第 ${number} 章`
      const highest = rows[0].version
      const history = rows.map(row => ({
        rev: row.version, title: string(heading(row), 160, true), body: string(row.body, 180_000),
        status: row.status === 'finalized' ? 'final' : 'draft',
        reason: 'desktop-' + row.status, created: row.updated_at || row.created_at || now(),
      }))
      const rev = head.version === highest ? highest : highest + 1
      add(`chapter-${number}`, 'chapter', heading(head), head.body, number,
        head.status === 'finalized' ? 'final' : 'draft', rev, history)
    }
    if (documents.length > 3000) throw new Error('作品超过单次导入的文档数量上限')
    const goals = {}
    for (const field of novelGoals) {
      const value = project[field.desktop]
      if (field.max) {
        if (Number.isInteger(value) && value > 0 && value <= field.max) goals[field.key] = value
      } else if (typeof value === 'string' && value.trim()) {
        goals[field.key] = value.trim().slice(0, field.maxLength)
      }
    }
    const desktopContinuity = desktopCharacterEvents(db, characters, chapters, hash)
    return { format: 'pagekin-web-novel-v1', title: string(project.project_name, 160, true), goals, documents, desktopContinuity, runs: [] }
  }, stagingRoot)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [source, output] = process.argv.slice(2)
    if (!source || !output) throw new Error('用法：node desktop-copy.mjs <.ai-novel/project.db> <作品副本.json>')
    const content = JSON.stringify(desktopCopy(source))
    if (Buffer.byteLength(content) > 24_000_000) throw new Error('转换结果超过 Web 导入的 24 MB 上限')
    writeFileSync(output, content, { flag: 'wx', mode: 0o600 })
    console.log('已生成 Web 作品副本。请在书房中选择“恢复备份”导入。')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
