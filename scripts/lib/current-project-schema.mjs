import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 旅程脚本是 .mjs，导入不了 desktop-registry.ts（它用无扩展名相对导入），所以从源码读常量。
const registry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../electron/migrations/desktop-registry.ts')
const declared = fs.readFileSync(registry, 'utf8').match(/^export const CURRENT_DESKTOP_SCHEMA_VERSION = (\d+)$/m)?.[1]
if (declared === undefined) throw new Error(`CURRENT_DESKTOP_SCHEMA_VERSION not found in ${registry}`)

export const CURRENT_PROJECT_SCHEMA_VERSION = Number(declared)
