import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../electron/migrations/desktop-registry'
import { PORTABLE_SOURCE_SCHEMA_VERSION } from '../../electron/services/portable-project-format'
import { CURRENT_PROJECT_SCHEMA_VERSION } from '../lib/current-project-schema.mjs'

const scriptsRoot = path.resolve(import.meta.dirname, '..')

const literalSchemaAssertions = [
  /user_version[^\n]*,\s*\d+\s*\)/u,
  /schemaVersion\(.*\)\s*,\s*\d+\s*\)/u,
  /schema\.version\s*,\s*\d+\s*\)/u,
  /sourceSchemaVersion\s*,\s*\d+\s*\)/u,
  /\bschema[- ]?\d+/iu,
]

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

function lines() {
  return journeyScripts(scriptsRoot).flatMap(file => readFileSync(file, 'utf8').split('\n').map((text, index) =>
    ({ file: path.relative(scriptsRoot, file).replaceAll('\\', '/'), line: index + 1, text })))
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

  it('has no hard-coded project schema version outside the allowlist', () => {
    const offenders = lines().filter(({ file, text }) =>
      literalSchemaAssertions.some(pattern => pattern.test(stripAllowed(file, text))))
      .map(({ file, line, text }) => `${file}:${line}: ${text.trim().slice(0, 120)}`)
    expect(offenders).toEqual([])
  })

  it('keeps every allowlist entry pointing at a real line', () => {
    const all = lines()
    const stale = legacySchemaAllowlist.filter(entry => !all.some(({ file, text }) => file === entry.file && entry.pattern.test(text)))
    expect(stale).toEqual([])
  })
})
