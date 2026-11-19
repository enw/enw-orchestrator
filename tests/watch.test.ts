import { execFile as execFileCallback } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeHarnesses, createRepo, runCli, tempDir, waitFor } from './helpers.js'
import { parseKey, reduceWatchKey, renderWatchFrame, runWatch, type WatchIO, type WatchState } from '../src/watch.js'

const exec = promisify(execFileCallback)

function makeIO(): WatchIO & { emit: (chunk: string) => void; output: () => string; raw: () => boolean } {
  let listener: ((chunk: Buffer | string) => void) | undefined
  let text = ''
  let rawMode = false
  return {
    stdin: {
      isTTY: true,
      setRawMode: (enabled: boolean) => {
        rawMode = enabled
      },
      resume: () => {},
      pause: () => {},
      on: (_event: string, handler: (chunk: Buffer | string) => void) => {
        listener = handler
      },
      off: () => {
        listener = undefined
      },
    },
    stdout: {
      isTTY: true,
      write: (chunk: string) => {
        text += chunk
      },
    },
    emit: (chunk: string) => listener?.(chunk),
    output: () => text,
    raw: () => rawMode,
  }
}

async function commitCount(cwd: string): Promise<number> {
  const { stdout } = await exec('git', ['rev-list', '--count', 'HEAD'], { cwd, encoding: 'utf8' })
  return Number(stdout.trim())
}

describe('watch TUI', () => {
  it('parses navigation and message-mode keys', () => {
    expect(parseKey('j', 'nav')).toEqual({ kind: 'down' })
    expect(parseKey('\x1b[A', 'nav')).toEqual({ kind: 'up' })
    expect(parseKey('m', 'nav')).toEqual({ kind: 'message' })
    expect(parseKey('m', 'message')).toEqual({ kind: 'char', value: 'm' })
    expect(parseKey('\r', 'message')).toEqual({ kind: 'enter' })
    expect(parseKey('\x03', 'nav')).toEqual({ kind: 'quit' })
  })

  it('reduces selection, message send, and lifecycle actions', () => {
    const base: WatchState = { ids: ['s_a', 's_b'], selectedId: 's_a', mode: 'nav', buffer: '', status: '' }
    expect(reduceWatchKey(base, { kind: 'down' }).state.selectedId).toBe('s_b')
    expect(reduceWatchKey(base, { kind: 'up' }).state.selectedId).toBe('s_b')
    expect(reduceWatchKey(base, { kind: 'done' }).action).toEqual({ type: 'done', id: 's_a' })
    expect(reduceWatchKey(base, { kind: 'restore' }).action).toEqual({ type: 'restore', id: 's_a' })

    let state = reduceWatchKey(base, { kind: 'message' }).state
    state = reduceWatchKey(state, { kind: 'char', value: 'hello' }).state
    expect(reduceWatchKey(state, { kind: 'enter' }).action).toEqual({ type: 'send', id: 's_a', text: 'hello' })
    expect(reduceWatchKey(state, { kind: 'escape' }).state.buffer).toBe('')
  })

  it('renders lanes, selection marker, and message buffer', () => {
    const state: WatchState = { ids: ['s_a'], selectedId: 's_a', mode: 'message', buffer: 'hi', status: '' }
    const frame = renderWatchFrame(
      [
        {
          id: 's_a',
          name: 'alpha',
          lane: 'working',
          harness: 'opencode',
          branch: 'orch/alpha',
          worktreePath: '/x',
          uncommitted: 1,
          lastActivity: null,
          age: '1s',
          queued: 0,
          worktreeRemoved: false,
          pr: null,
        },
      ],
      state,
      new Date('2026-01-01T00:00:00Z'),
    )
    expect(frame).toContain('WORKING (1)')
    expect(frame).toContain('> s_a  alpha')
    expect(frame).toContain('message> hi_')
  })

  describe('fake-stream run', () => {
    let root: string
    let repo: string
    let env: NodeJS.ProcessEnv
    let savedHome: string | undefined

    beforeEach(async () => {
      root = await tempDir()
      repo = await createRepo(path.join(root, 'repo'))
      const bin = await createFakeHarnesses(path.join(root, 'bin'))
      env = { ...process.env, ORCH_HOME: path.join(root, 'home'), PATH: `${bin}:${process.env.PATH}` }
      savedHome = process.env.ORCH_HOME
      process.env.ORCH_HOME = path.join(root, 'home')
      await runCli(['project', 'add', repo], { cwd: repo, env })
      await runCli(['spawn', '--name', 'alpha', '--harness', 'opencode', '--prompt', 'do work'], { cwd: repo, env })
      await runCli(['spawn', '--name', 'beta', '--harness', 'pi', '--prompt', 'do work'], { cwd: repo, env })
      await waitFor(async () => {
        const result = await runCli(['board', '--json'], { cwd: repo, env })
        const data = JSON.parse(result.stdout) as { sessions: Array<{ lastActivity: string | null; uncommitted: number }> }
        return data.sessions.length === 2 && data.sessions.every((s) => s.lastActivity !== null && s.uncommitted === 0)
      })
    })

    afterEach(async () => {
      const result = await runCli(['session', 'ls'], { cwd: repo, env })
      for (const line of result.stdout.split('\n')) {
        const id = line.trim().split(/\s+/)[0]
        if (id?.startsWith('s_')) await runCli(['session', 'done', id], { cwd: repo, env })
      }
      if (savedHome === undefined) delete process.env.ORCH_HOME
      else process.env.ORCH_HOME = savedHome
    })

    it('requires a TTY', async () => {
      const io = makeIO()
      Object.assign(io.stdin, { isTTY: false })
      await expect(runWatch({ intervalMs: 1000 }, io)).rejects.toMatchObject({ exitCode: 2 })
    })

    it('sends a follow-up, marks done, kills, restores, and quits', async () => {
      const listed = JSON.parse((await runCli(['board', '--json'], { cwd: repo, env })).stdout) as {
        sessions: Array<{ id: string; worktreePath: string }>
      }
      const [alpha, beta] = listed.sessions
      const io = makeIO()
      const done = runWatch({ intervalMs: 100 }, io)
      await new Promise((resolve) => setTimeout(resolve, 200))

      io.emit('m')
      await waitFor(() => Promise.resolve(io.output().includes('message>')))
      io.emit('follow up from tui')
      io.emit('\r')
      await waitFor(async () => (await commitCount(alpha.worktreePath)) === 2)

      io.emit('d')
      await waitFor(async () => {
        const data = JSON.parse((await runCli(['board', '--json'], { cwd: repo, env })).stdout) as {
          sessions: Array<{ id: string; lane: string }>
        }
        return data.sessions.find((s) => s.id === alpha.id)?.lane === 'done'
      })

      io.emit('j')
      io.emit('x')
      await waitFor(async () => {
        const data = JSON.parse((await runCli(['board', '--json'], { cwd: repo, env })).stdout) as {
          sessions: Array<{ id: string; lane: string }>
        }
        return data.sessions.find((s) => s.id === beta.id)?.lane === 'error'
      })

      io.emit('r')
      await waitFor(async () => {
        const result = await runCli(['session', 'get', beta.id, '--json'], { cwd: repo, env })
        const data = JSON.parse(result.stdout) as { session: { pid?: number } }
        return typeof data.session.pid === 'number'
      })

      io.emit('q')
      await done

      expect(io.output()).toContain('message>')
      expect(io.output()).toContain('m message')
      expect(io.raw()).toBe(false)
    })
  })
})
