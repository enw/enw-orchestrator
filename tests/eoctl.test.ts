import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeHarnesses, createRepo, runCli, tempDir, waitFor } from './helpers.js'

const exec = promisify(execFileCallback)

interface BoardData {
  sessions: Array<{
    id: string
    lane: string
    worktreePath: string
    uncommitted: number
    lastActivity: string | null
    worktreeRemoved: boolean
  }>
}

async function commitCount(cwd: string): Promise<number> {
  const { stdout } = await exec('git', ['rev-list', '--count', 'HEAD'], { cwd, encoding: 'utf8' })
  return Number(stdout.trim())
}

async function board(env: NodeJS.ProcessEnv, cwd: string): Promise<BoardData> {
  const result = await runCli(['board', '--json'], { cwd, env })
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout) as BoardData
}

describe('eoctl slice 1', () => {
  let root: string
  let repo: string
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    root = await tempDir()
    repo = await createRepo(path.join(root, 'repo'))
    const bin = await createFakeHarnesses(path.join(root, 'bin'))
    env = { ...process.env, ORCH_HOME: path.join(root, 'home'), PATH: `${bin}:${process.env.PATH}` }
  })

  afterEach(async () => {
    const result = await runCli(['session', 'ls'], { cwd: repo, env })
    for (const line of result.stdout.split('\n')) {
      const id = line.trim().split(/\s+/)[0]
      if (id?.startsWith('s_')) await runCli(['session', 'done', id], { cwd: repo, env })
    }
  })

  it('registers and lists a project', async () => {
    const added = await runCli(['project', 'add', repo], { cwd: repo, env })
    expect(added.code).toBe(0)
    const listed = await runCli(['project', 'ls'], { cwd: repo, env })
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain(repo)
  })

  it('spawns two harness workers, derives lanes, delivers follow-ups, and cleans up safely', async () => {
    expect((await runCli(['project', 'add', repo], { cwd: repo, env })).code).toBe(0)

    const first = await runCli(['spawn', '--name', 'alpha', '--harness', 'opencode', '--prompt', 'do work'], {
      cwd: repo,
      env,
    })
    const second = await runCli(['spawn', '--name', 'beta', '--harness', 'pi', '--prompt', 'do work'], {
      cwd: repo,
      env,
    })
    expect(first.code).toBe(0)
    expect(second.code).toBe(0)

    const firstId = first.stdout.trim().split(/\s+/)[0]
    await waitFor(async () => {
      const data = await board(env, repo)
      return (
        data.sessions.length === 2 &&
        data.sessions.every((entry) => entry.lastActivity !== null && entry.uncommitted === 0)
      )
    })

    const data = await board(env, repo)
    expect(data.sessions.map((entry) => entry.harness).sort()).toEqual(['opencode', 'pi'])
    expect(data.sessions.every((entry) => entry.lane === 'idle')).toBe(true)

    for (const entry of data.sessions) {
      const pwd = (await readFile(path.join(entry.worktreePath, '.eoctl-pwd'), 'utf8')).trim()
      expect(pwd).toBe(entry.worktreePath)
    }

    const worktree = data.sessions.find((entry) => entry.id === firstId)?.worktreePath as string
    const before = await commitCount(worktree)
    const sent = await runCli(['send', firstId, '--message', 'follow up'], { cwd: repo, env })
    expect(sent.code).toBe(0)
    await waitFor(async () => (await commitCount(worktree)) === before + 1)

    expect((await runCli(['session', 'done', firstId], { cwd: repo, env })).code).toBe(0)
    const dirtyFile = path.join(worktree, 'dirty.txt')
    await writeFile(dirtyFile, 'dirty\n')
    const dryRun = await runCli(['session', 'cleanup', '--dry-run'], { cwd: repo, env })
    expect(dryRun.stdout).toContain('refused: dirty worktree')

    await unlink(dirtyFile)
    const cleaned = await runCli(['session', 'cleanup'], { cwd: repo, env })
    expect(cleaned.stdout).toContain('removed')
    const final = await board(env, repo)
    expect(final.sessions.find((entry) => entry.id === firstId)?.worktreeRemoved).toBe(true)
  })

  it('uses documented exit codes for missing records and invalid input', async () => {
    const missing = await runCli(['send', 's_missing', '--message', 'hello'], { cwd: repo, env })
    expect(missing.code).toBe(4)
    const noPrompt = await runCli(['spawn', '--name', 'x', '--harness', 'opencode'], { cwd: repo, env })
    expect(noPrompt.code).toBe(1)
    const doctor = await runCli(['doctor'], { cwd: repo, env })
    expect(doctor.code).toBe(0)
  })

  it('rejects session ids that could escape the state directory', async () => {
    const traversal = await runCli(['session', 'get', '../../etc/passwd'], { cwd: repo, env })
    expect(traversal.code).toBe(4)
    expect(traversal.stderr).toContain('not found')
  })

  it('doctor skips harnesses that are not configured or in use', async () => {
    const bin = path.join(root, 'opencode-only')
    await mkdir(bin, { recursive: true })
    const harness = path.join(bin, 'opencode')
    await writeFile(harness, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await chmod(harness, 0o755)
    const doctorEnv = { ...env, PATH: `${bin}:/usr/bin:/bin`, ORCH_DEFAULT_HARNESS: 'opencode' }
    const doctor = await runCli(['doctor'], { cwd: repo, env: doctorEnv })
    expect(doctor.code).toBe(0)
    expect(doctor.stdout).toContain('OK  opencode')
    expect(doctor.stdout).toContain('SKIP  pi')
  })
})
