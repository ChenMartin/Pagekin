import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../electron/migrations/desktop-registry'
import { PORTABLE_SOURCE_SCHEMA_VERSION } from '../../electron/services/portable-project-format'
import { CURRENT_PROJECT_SCHEMA_VERSION } from '../lib/current-project-schema.mjs'

const scriptsRoot = path.resolve(import.meta.dirname, '..')

const projectSchemaRead = /user_version|schemaVersion\(|schema\.version|sourceSchemaVersion/u
const literalLastArgument = /,\s*\d+\s*,?\s*\)$/u
const schemaNumberInText = /\bschema[- ]?\d+/iu

const legacySchemaAllowlist = [
  { file: 'f05-u02-migration-journey.mjs', pattern: /pragma\('user_version', \{ simple: true \}\), 0\)/u,
    reason: '断言的是 schema 0 旧项目夹具导入前的状态' },
  { file: 'f05-u02-migration-journey.mjs', pattern: /schema0/u,
    reason: '导入来源就是 schema 0 旧项目' },
  { file: 'f05-u02-migration-journey.mjs', pattern: /schema7-(import|save|reopen)/u,
    reason: '回执步骤 ID，只在本脚本内引用，不是版本断言' },
]

function journeyScripts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : journeyScripts(full)
    return /\.(mjs|cjs)$/u.test(entry.name) ? [full] : []
  })
}

function sources() {
  return journeyScripts(scriptsRoot).map(file =>
    ({ file: path.relative(scriptsRoot, file).replaceAll('\\', '/'), text: readFileSync(file, 'utf8') }))
}

function assertCalls(source: string) {
  return [...source.matchAll(/\bassert(?:\.\w+)?\(/gu)].map(match => {
    let depth = 0
    let end = match.index + match[0].length - 1
    do {
      if (source[end] === '(') depth += 1
      else if (source[end] === ')') depth -= 1
      end += 1
    } while (depth > 0 && end < source.length)
    return { index: match.index, text: source.slice(match.index, end) }
  })
}

function hardCodedSchemaVersions(file: string, source: string) {
  const lineOf = (index: number) => source.slice(0, index).split('\n').length
  const report = (line: number, text: string) => `${file}:${line}: ${text.replace(/\s+/gu, ' ').trim().slice(0, 120)}`
  const assertions = assertCalls(source).filter(call => {
    const rest = stripAllowed(file, call.text)
    return projectSchemaRead.test(rest) && literalLastArgument.test(rest)
  }).map(call => report(lineOf(call.index), call.text))
  const texts = source.split('\n').flatMap((text, index) =>
    schemaNumberInText.test(stripAllowed(file, text)) ? [report(index + 1, text)] : [])
  return [...assertions, ...texts]
}

function stripAllowed(file: string, text: string) {
  return legacySchemaAllowlist.filter(entry => entry.file === file).reduce((rest, entry) =>
    rest.replace(new RegExp(entry.pattern.source, 'gu'), ''), text)
}

describe('journey scripts take the project schema version from one source', () => {
  it('matches the desktop registry and the portable archive source version', () => {
    expect(CURRENT_PROJECT_SCHEMA_VERSION).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    expect(PORTABLE_SOURCE_SCHEMA_VERSION).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
  })

  it('flags a literal version in an assertion written across several lines', () => {
    const source = [
      'assert.equal(',
      "  schemaVersion(path.join(copy, 'project.db')),",
      '  9,',
      ')',
      'assert.equal(',
      "  db.pragma('user_version', { simple: true }),",
      '  9)',
    ].join('\n')
    expect(hardCodedSchemaVersions('example.mjs', source)).toHaveLength(2)
  })

  it('has no hard-coded project schema version outside the allowlist', () => {
    expect(sources().flatMap(({ file, text }) => hardCodedSchemaVersions(file, text))).toEqual([])
  })

  it('keeps every allowlist entry pointing at a real line', () => {
    const all = sources()
    const stale = legacySchemaAllowlist.filter(entry => !all.some(({ file, text }) => file === entry.file && entry.pattern.test(text)))
    expect(stale).toEqual([])
  })
})
