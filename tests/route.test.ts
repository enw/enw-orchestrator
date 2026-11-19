import { execFile as execFileCallback } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeHarnesses, createRepo, runCli, tempDir, waitFor } from './helpers.js'

const exec = promisify(execFileCallback)

const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n')
let round = 0
try { round = Number(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8')) } catch {}
const reviews = [
  { id: 'PRR_1', author: { login: 'alice' }, body: 'please fix the null check', submittedAt: '2026-01-01T00:00:00Z', state: 'CHANGES_REQUESTED' },
]
const comments = [
  { id: 'PRC_1', author: { login: 'bob' }, body: 'update the changelog', createdAt: '2026-01-02T00:00:00Z', path: 'src/a.ts', line: 12 },
]
if (round >= 1) {
  reviews.push({ id: 'PRR_2', author: { login: 'carol' }, body: 'add a test', submittedAt: '2026-01-03T00:00:00Z', state: 'COMMENTED' })
  comments.push({ id: 'PRC_2', author: { login: 'erin' }, body: '   ', createdAt: '2026-01-04T00:00:00Z' })
}
const pr = {
  number: 7,
  url: 'https://github.com/acme/repo/pull/7',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'CHANGES_REQUESTED',
  mergeable: 'MERGEABLE',
  statusCheckRollup: [],
  reviews,
  comments,
}
process.stdout.write(JSON.stringify(pr))
fs.writeFileSync(process.env.FAKE_GH_STATE, String(round + 1))
`

interface InboxMessage {
  at: string
  text: string
  delivered: boolean
}

interface BoardData {
  sessions: Array<{ id: string; lastActivity: string | null }>
}

describe('eoctl PR review routing', () => {
  let root: string
  let repo: string
  let env: NodeJS.ProcessEnv
  let ghLog: string
  let stateFile: string

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

  async function inbox(id: string): Promise<InboxMessage[]> {
    let text: string
    try {
      text = await readFile(path.join(root, 'home', 'inbox', `${id}.jsonl`), 'utf8')
    } catch {
      return []
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as InboxMessage)
  }

  async function routedKeys(id: string): Promise<string[]> {
    return JSON.parse(await readFile(path.join(root, 'home', 'pr', `${id}.routed.json`), 'utf8')) as string[]
  }

  async function spawnWorker(name: string): Promise<string> {
    const result = await runCli(['spawn', '--name', name, '--harness', 'opencode', '--prompt', 'do work'], {
      cwd: repo,
      env,
    })
    expect(result.code).toBe(0)
    const id = result.stdout.trim().split(/\s+/)[0]
    await waitFor(async () => {
      const data = JSON.parse((await runCli(['board', '--json'], { cwd: repo, env })).stdout) as BoardData
      return data.sessions[0]?.lastActivity !== null && data.sessions[0]?.lastActivity !== undefined
    })
    return id
  }

  beforeEach(async () => {
    root = await tempDir()
    repo = await createRepo(path.join(root, 'repo'))
    const bin = await createFakeHarnesses(path.join(root, 'bin'))
    await writeFile(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
    await exec('chmod', ['+x', path.join(bin, 'gh')])
    ghLog = path.join(root, 'gh-calls.jsonl')
    stateFile = path.join(root, 'gh-state')
    await writeFile(stateFile, '0\n')
    env = {
      ...process.env,
      ORCH_HOME: path.join(root, 'home'),
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_GH_LOG: ghLog,
      FAKE_GH_STATE: stateFile,
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

  it('routes new feedback once, stays idempotent, and queues only later notes', async () => {
    const id = await spawnWorker('alpha')

    const unobserved = await runCli(['pr', 'route'], { cwd: repo, env })
    expect(unobserved.stdout).toContain('no PR snapshot')
    expect(await inbox(id)).toHaveLength(0)

    expect((await runCli(['pr', 'refresh'], { cwd: repo, env })).code).toBe(0)
    expect(await ghCalls()).toHaveLength(1)

    const first = await runCli(['pr', 'route'], { cwd: repo, env })
    expect(first.stdout).toContain('queued 2')
    let messages = await inbox(id)
    expect(messages).toHaveLength(1)
    expect(messages[0].text).toContain('GitHub PR feedback #7')
    expect(messages[0].text).toContain('https://github.com/acme/repo/pull/7')
    expect(messages[0].text).toContain('please fix the null check')
    expect(messages[0].text).toContain('state:CHANGES_REQUESTED')
    expect(messages[0].text).toContain('update the changelog')
    expect(messages[0].text).toContain('src/a.ts:12')

    const repeat = await runCli(['pr', 'route'], { cwd: repo, env })
    expect(repeat.stdout).toContain('queued 0')
    expect(await inbox(id)).toHaveLength(1)
    expect(await ghCalls()).toHaveLength(1)

    expect((await runCli(['pr', 'refresh'], { cwd: repo, env })).code).toBe(0)
    expect(await ghCalls()).toHaveLength(2)
    const second = await runCli(['pr', 'route'], { cwd: repo, env })
    expect(second.stdout).toContain('queued 1')
    messages = await inbox(id)
    expect(messages).toHaveLength(2)
    expect(messages[1].text).toContain('add a test')
    expect(messages[1].text).not.toContain('please fix the null check')
    expect(messages[1].text).not.toContain('update the changelog')
    expect(messages[1].text).not.toContain('erin')
    expect(await ghCalls()).toHaveLength(2)
    expect(await routedKeys(id)).toEqual(['review:PRR_1', 'comment:PRC_1', 'review:PRR_2'])

    await waitFor(async () => (await inbox(id)).every((message) => message.delivered))
  })

  it('skips done sessions and sessions without snapshots', async () => {
    const id = await spawnWorker('alpha')
    expect((await runCli(['pr', 'refresh'], { cwd: repo, env })).code).toBe(0)
    expect((await runCli(['session', 'done', id], { cwd: repo, env })).code).toBe(0)

    const explicit = await runCli(['pr', 'route', id], { cwd: repo, env })
    expect(explicit.stdout).toContain('session is done')
    expect(await inbox(id)).toHaveLength(0)

    const all = await runCli(['pr', 'route'], { cwd: repo, env })
    expect(all.stdout).toContain('No sessions to route')
    expect(await ghCalls()).toHaveLength(1)
  })

  it('dedups notes without GitHub ids by content hash', async () => {
    const id = await spawnWorker('alpha')
    const snapshot = {
      at: new Date().toISOString(),
      state: 'open',
      number: 9,
      url: 'https://github.com/acme/repo/pull/9',
      reviewDecision: null,
      mergeable: null,
      checks: { total: 0, pass: 0, fail: 0, pending: 0 },
      notes: [{ at: '2026-01-01T00:00:00Z', author: 'alice', body: 'hash-based note', source: 'comment' }],
    }
    await writeFile(path.join(root, 'home', 'pr', `${id}.json`), JSON.stringify(snapshot))

    expect((await runCli(['pr', 'route', id], { cwd: repo, env })).stdout).toContain('queued 1')
    expect((await runCli(['pr', 'route', id], { cwd: repo, env })).stdout).toContain('queued 0')
    expect(await inbox(id)).toHaveLength(1)
    expect((await routedKeys(id))[0]).toMatch(/^hash:/)
    expect(await ghCalls()).toHaveLength(0)
  })
})
