import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const windowsIt = process.platform === 'win32' ? it : it.skip
const PROCESS_BOUND_TIMEOUT_MS = 60_000
const LEAK_SENTINEL = 'pr-ci-env-value-must-not-be-logged'
const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/pr-ci.yml'), 'utf8')
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stepBlock(name: string): string {
  const lines = workflow.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`)
  expect(start, `workflow step "${name}"`).toBeGreaterThanOrEqual(0)
  const nextStep = lines.findIndex((line, index) => index > start && line.trim().startsWith('- name: '))
  return lines.slice(start, nextStep).join('\n')
}

function retryScript(): string {
  const lines = stepBlock('Download Electron binary').split('\n')
  const runLine = lines.findIndex((line) => line.trim() === 'run: |')
  expect(runLine).toBeGreaterThanOrEqual(0)
  const body = lines.slice(runLine + 1).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  const indent = Math.min(...body.map((line) => line.length - line.trimStart().length))
  return body.map((line) => line.slice(indent)).join('\n')
}

function runRetryStep(failuresBeforeSuccess: number) {
  const root = mkdtempSync(join(tmpdir(), 'pr-ci-electron-'))
  temporaryRoots.push(root)
  const attemptsFile = join(root, 'attempts.log')
  const sleepsFile = join(root, 'sleeps.log')
  mkdirSync(join(root, 'node_modules/electron'), { recursive: true })
  writeFileSync(join(root, 'node_modules/electron/install.js'), `
    const fs = require('node:fs')
    fs.appendFileSync(${JSON.stringify(attemptsFile)}, 'x')
    if (fs.readFileSync(${JSON.stringify(attemptsFile)}, 'utf8').length <= ${failuresBeforeSuccess}) {
      console.error('HTTPError: Response code 504 (Gateway Timeout)')
      process.exit(1)
    }
  `)
  const scriptPath = join(root, 'step.ps1')
  writeFileSync(scriptPath, [
    `function Start-Sleep { param([int]$Seconds) Add-Content -LiteralPath '${sleepsFile}' -Value $Seconds }`,
    "$ErrorActionPreference = 'stop'",
    retryScript(),
    'if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }',
  ].join('\n'))
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', `. '${scriptPath}'`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PR_CI_LEAK_SENTINEL: LEAK_SENTINEL },
    timeout: PROCESS_BOUND_TIMEOUT_MS - 5_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    attempts: readFileSync(attemptsFile, 'utf8').length,
    sleeps: existsSync(sleepsFile) ? readFileSync(sleepsFile, 'utf8').trim().split(/\r?\n/).map(Number) : [],
  }
}

describe('PR CI Electron download', () => {
  it('keeps the download out of pnpm install and restores build scripts after it', () => {
    expect(stepBlock('Install locked dependencies')).toContain('pnpm install --frozen-lockfile --ignore-scripts')
    expect(stepBlock('Run dependency build scripts')).toContain('pnpm rebuild')
    const order = ['Install locked dependencies', 'Download Electron binary', 'Run dependency build scripts']
      .map((name) => workflow.indexOf(`- name: ${name}`))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  windowsIt('does not wait when the first download succeeds', { timeout: PROCESS_BOUND_TIMEOUT_MS }, () => {
    const run = runRetryStep(0)
    expect(run.status, run.output).toBe(0)
    expect(run.attempts).toBe(1)
    expect(run.sleeps).toEqual([])
  })

  windowsIt('exits 0 when a later attempt succeeds and logs each attempt and wait', { timeout: PROCESS_BOUND_TIMEOUT_MS }, () => {
    const run = runRetryStep(2)
    expect(run.status, run.output).toBe(0)
    expect(run.attempts).toBe(3)
    expect(run.sleeps).toHaveLength(2)
    expect(run.output).toContain('attempt 1/5 failed')
    expect(run.output).toContain('attempt 2/5 failed')
    expect(run.output).toContain(`Waiting ${run.sleeps[0]} seconds before attempt 2/5`)
    expect(run.output).toContain(`Waiting ${run.sleeps[1]} seconds before attempt 3/5`)
    expect(run.output).not.toContain(LEAK_SENTINEL)
  })

  windowsIt('exits non-zero after five failures, reports each one, and stays within five minutes of waiting', { timeout: PROCESS_BOUND_TIMEOUT_MS }, () => {
    const run = runRetryStep(Number.MAX_SAFE_INTEGER)
    expect(run.status, run.output).not.toBe(0)
    expect(run.attempts).toBe(5)
    for (const attempt of [1, 2, 3, 4, 5]) expect(run.output).toContain(`attempt ${attempt}/5 failed`)
    expect(run.output.match(/Response code 504/g)).toHaveLength(5)
    expect(run.sleeps).toEqual([10, 20, 40, 80])
    expect(run.output).not.toContain(LEAK_SENTINEL)
  })

  it('bounds the whole download step', () => {
    expect(stepBlock('Download Electron binary')).toMatch(/timeout-minutes: [1-5]\b/)
  })
})
