import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeHarnesses, createRepo, runCli, tempDir, waitFor } from './helpers.js'

const exec = promisify(execFileCallback)

const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n')
const mode = process.env.FAKE_GH_MODE || 'ok'
const branch = args[2] || ''
if ((mode === 'mixed' && branch.includes('bad')) || mode === 'fail') {
  process.stderr.write('gh: ghp_abcdefghijklmnopqrstuvwxyz denied\\n')
  process.exit(1)
}
if (mode === 'none') {
  process.stderr.write('no pull requests found for branch "' + branch + '"\\n')
  process.exit(1)
}
if (mode === 'fallback' && args[1] === 'view') {
  process.stderr.write('Error: accepts 0 arg(s), received 1\\n')
  process.exit(1)
}
const pr = {
  number: 42,
  url: 'https://github.com/acme/repo/pull/42',
  title: 'fake PR',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'CHANGES_REQUESTED',
  mergeable: 'MERGEABLE',
  updatedAt: '2026-01-02T00:00:00Z',
  statusCheckRollup: [
    { __typename: 'CheckRun', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', conclusion: 'FAILURE' },
    { __typename: 'StatusContext', state: 'PENDING' },
  ],
  reviews: [{
    author: { login: '\\x1b[31mreviewer\\x1b[0m' },
    body: '\\x1b[31mghp_abcdefghijklmnop\\x1b[0m please revise',
    submittedAt: '2026-01-01T00:00:00Z',
    state: 'CHANGES_REQUESTED',
  }],
  comments: [{
    author: { login: 'commenter' },
    body: 'update the changelog',
    createdAt: '2026-01-02T00:00:00Z',
    path: 'src/a.ts',
    line: 12,
  }],
}
process.stdout.write(JSON.stringify(args[1] === 'list' ? [pr] : pr))
`

interface PrData {
  at: string
  state: string
  number?: number
  url?: string
  reviewDecision: string | null
  checks: { total: number; pass: number; fail: number; pending: number }
  notes: Array<{ at: string; author: string; body: string; source: string; state?: string }>
  error?: string
}

interface BoardData {
  schemaVersion: number
  sessions: Array<{ id: string; branch: string; lastActivity: string | null; pr: PrData | null }>
}

describe('eoctl PR/CI observation', () => {
  let root: string
  let repo: string
  let env: NodeJS.ProcessEnv
  let ghLog: string

  async function ghCalls(): Promise<string[][]> {
    let text: string
    try {
      text = await readFile(ghLog, 'utf8')
    } catch {
      return []
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
  }

  async function spawnWorker(name: string): Promise<string> {
    const result = await runCli(['spawn', '--name', name, '--harness', 'opencode', '--prompt', 'do work'], {
      cwd: repo,
      env,
    })
    expect(result.code).toBe(0)
    return result.stdout.trim().split(/\s+/)[0]
  }

  beforeEach(async () => {
    root = await tempDir()
    repo = await createRepo(path.join(root, 'repo'))
    const bin = await createFakeHarnesses(path.join(root, 'bin'))
    await writeFile(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
    await exec('chmod', ['+x', path.join(bin, 'gh')])
    ghLog = path.join(root, 'gh-calls.jsonl')
    env = {
      ...process.env,
      ORCH_HOME: path.join(root, 'home'),
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_GH_LOG: ghLog,
      FAKE_GH_MODE: 'ok',
    }
    expect((await runCli(['project', 'add', repo], { cwd: repo, env })).code).toBe(0)
  })

  afterEach(async () => {
    const result = await runCli(['session', 'ls'], { cwd: repo, env })
    for (const line of result.stdout.split('\n')) {
      const id = line.trim().split(/\s+/)[0]
      if (id?.startsWith('s_')) await runCli(['session', 'done', id], { cwd: repo, env })
    }
  })

  it('snapshots an open PR, surfaces it everywhere, and never calls gh from board', async () => {
    const id = await spawnWorker('alpha')
    const refreshed = await runCli(['pr', 'refresh'], { cwd: repo, env })
    expect(refreshed.code).toBe(0)
    expect(refreshed.stdout).toContain('#42')
    expect(refreshed.stdout).toContain('checks:1/3')

    const calls = await ghCalls()
    expect(calls).toHaveLength(1)
    const branch = JSON.parse((await runCli(['board', '--json'], { cwd: repo, env })).stdout).sessions[0].branch as string
    expect(calls[0]).toEqual(['pr', 'view', branch, '--json', expect.stringContaining('statusCheckRollup')])

    const listed = await runCli(['board', '--json'], { cwd: repo, env })
    const data = JSON.parse(listed.stdout) as BoardData
    expect(data.schemaVersion).toBe(1)
    expect(data.sessions).toHaveLength(1)
    const pr = data.sessions[0].pr as PrData
    expect(pr.state).toBe('open')
    expect(pr.number).toBe(42)
    expect(pr.url).toBe('https://github.com/acme/repo/pull/42')
    expect(pr.reviewDecision).toBe('CHANGES_REQUESTED')
    expect(pr.checks).toEqual({ total: 3, pass: 1, fail: 1, pending: 1 })
    expect(pr.notes.map((note) => note.source)).toEqual(['review', 'comment'])
    expect(pr.notes[0].author).toBe('reviewer')
    expect(pr.notes[0].body).not.toContain('\x1b')
    expect(pr.notes[0].body).toContain('[REDACTED]')
    expect(pr.notes[1].path).toBe('src/a.ts')
    expect(pr.notes[1].line).toBe(12)
    expect(await ghCalls()).toHaveLength(1)

    const human = await runCli(['board'], { cwd: repo, env })
    expect(human.stdout).toContain('pr:#42/open/checks:1/3/review:CHANGES_REQUESTED')

    const detail = await runCli(['session', 'get', id], { cwd: repo, env })
    expect(detail.stdout).toContain('pr url: https://github.com/acme/repo/pull/42')
    expect(detail.stdout).toContain('pr checks: 1 pass, 1 fail, 1 pending (3 total)')
    expect(detail.stdout).toContain('pr notes: 1 reviews, 1 comments')
    expect(await ghCalls()).toHaveLength(1)
  })

  it('records no-PR as a normal observation', async () => {
    await spawnWorker('alpha')
    const refreshed = await runCli(['pr', 'refresh'], {
      cwd: repo,
      env: { ...env, FAKE_GH_MODE: 'none' },
    })
    expect(refreshed.code).toBe(0)
    expect(refreshed.stdout).toContain('none')
    const data = JSON.parse((await runCli(['board', '--json'], { cwd: repo, env })).stdout) as BoardData
    expect(data.sessions[0].pr?.state).toBe('none')
    expect((await runCli(['board'], { cwd: repo, env })).stdout).toContain('pr:none')
  })

  it('isolates a failing observation and redacts its stderr', async () => {
    await spawnWorker('good')
    await spawnWorker('bad')
    const refreshed = await runCli(['pr', 'refresh'], {
      cwd: repo,
      env: { ...env, FAKE_GH_MODE: 'mixed' },
    })
    expect(refreshed.code).toBe(0)
    const data = JSON.parse((await runCli(['board', '--json'], { cwd: repo, env })).stdout) as BoardData
    const states = data.sessions.map((entry) => entry.pr?.state).sort()
    expect(states).toEqual(['error', 'open'])
    const failed = data.sessions.find((entry) => entry.pr?.state === 'error')?.pr as PrData
    expect(failed.error).toContain('[REDACTED]')
    expect(failed.error).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz')
    expect((await runCli(['board'], { cwd: repo, env })).stdout).toContain('pr:error/')
  })

  it('falls back to pr list when positional branch lookup is unsupported', async () => {
    await spawnWorker('alpha')
    const refreshed = await runCli(['pr', 'refresh'], {
      cwd: repo,
      env: { ...env, FAKE_GH_MODE: 'fallback' },
    })
    expect(refreshed.code).toBe(0)
    const calls = await ghCalls()
    expect(calls).toHaveLength(2)
    expect(calls[0][1]).toBe('view')
    expect(calls[1][0]).toBe('pr')
    expect(calls[1][1]).toBe('list')
    expect(calls[1]).toContain('--head')
    expect(calls[1]).toContain('--state')
    expect(calls[1]).toContain('all')
    const data = JSON.parse((await runCli(['board', '--json'], { cwd: repo, env })).stdout) as BoardData
    expect(data.sessions[0].pr?.state).toBe('open')
  })

  it('exits 2 when gh is unavailable without touching snapshots', async () => {
    const id = await spawnWorker('alpha')
    const emptyBin = path.join(root, 'empty-bin')
    await mkdir(emptyBin, { recursive: true })
    const result = await runCli(['pr', 'refresh', id], {
      cwd: repo,
      env: { ...env, PATH: emptyBin },
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('gh not found')
    const data = JSON.parse((await runCli(['board', '--json'], { cwd: repo, env })).stdout) as BoardData
    expect(data.sessions[0].pr).toBeNull()
  })

  it('skips done sessions by default but accepts an explicit id', async () => {
    const id = await spawnWorker('alpha')
    await waitFor(async () => {
      const data = JSON.parse((await runCli(['board', '--json'], { cwd: repo, env })).stdout) as BoardData
      return data.sessions[0]?.lastActivity !== null && data.sessions[0]?.lastActivity !== undefined
    })
    expect((await runCli(['session', 'done', id], { cwd: repo, env })).code).toBe(0)
    expect((await runCli(['pr', 'refresh'], { cwd: repo, env })).stdout).toContain('No sessions to observe')
    expect((await runCli(['pr', 'refresh', id], { cwd: repo, env })).code).toBe(0)
    expect(await ghCalls()).toHaveLength(1)
  })
})
