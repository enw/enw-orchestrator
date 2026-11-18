import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import path from 'node:path'
import { CliError } from './errors.js'
import { logPath } from './paths.js'
import { appendMessage, getSession, isAlive, readInbox, saveSession } from './state.js'
import type { Session } from './types.js'

export async function launchRunner(session: Session): Promise<number | undefined> {
  const entry = path.resolve(process.argv[1] ?? 'dist/cli.js')
  const fd = openSync(logPath(session.id), 'a')
  const child = spawn(process.execPath, [entry, '_run', session.id], {
    cwd: session.worktreePath,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, PWD: session.worktreePath },
  })
  closeSync(fd)
  child.unref()
  return child.pid
}

function stopRunner(pid: number | undefined): void {
  if (!isAlive(pid)) return
  try {
    process.kill(pid as number, 'SIGTERM')
  } catch {
    // Already gone.
  }
}

export async function markDone(id: string): Promise<void> {
  const record = await getSession(id)
  stopRunner(record.pid)
  await saveSession({ ...record, activeRun: false, pid: undefined, laneOverride: 'done' })
}

export async function killSession(id: string): Promise<void> {
  const record = await getSession(id)
  stopRunner(record.pid)
  await saveSession({ ...record, activeRun: false, pid: undefined })
}

export async function restoreSession(id: string): Promise<void> {
  const record = await getSession(id)
  if (record.laneOverride === 'done') throw new CliError('Done sessions cannot be restored', 3)
  if (record.worktreeRemoved) throw new CliError('Worktree has been removed', 3)
  if (isAlive(record.pid)) throw new CliError('Runner is already active', 3)
  const pid = await launchRunner(record)
  await saveSession({ ...record, pid, activeRun: false })
}

export async function sendMessage(id: string, text: string): Promise<number> {
  const record = await getSession(id)
  if (record.laneOverride === 'done') throw new CliError('Session is done', 3)
  if (!text.trim()) throw new CliError('Message must not be empty', 1)
  await appendMessage(id, text)
  return (await readInbox(id)).filter((message) => !message.delivered).length
}
