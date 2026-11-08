import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../electron/migrations/desktop-registry'

const driver = path.resolve(import.meta.dirname, '../f05-u02-migration-journey.mjs')

it('packaged U02 migration journey expects imported copies at the current desktop schema', () => {
  const source = readFileSync(driver, 'utf8')
  const asserted = [...source.matchAll(/pragma\('user_version', \{ simple: true \}\), (\d+)\)/gu)].map(match => Number(match[1]))
  expect(asserted).toEqual([0, CURRENT_DESKTOP_SCHEMA_VERSION])
  const receiptSchemas = [...source.matchAll(/into schema(\d+)|imported schema(\d+) copy/gu)].map(match => Number(match[1] ?? match[2]))
  expect(receiptSchemas).toEqual([CURRENT_DESKTOP_SCHEMA_VERSION, CURRENT_DESKTOP_SCHEMA_VERSION])
})
