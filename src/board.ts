import { uncommittedCount } from './git.js'
import { readEvents, readInbox, isAlive } from './state.js'
import { relativeTime } from './util.js'
import type { BoardEntry, Lane, Session } from './types.js'

const LANES: Lane[] = ['working', 'idle', 'done', 'error']

export function deriveLane(session: Session): Lane {
  if (session.laneOverride === 'done') return 'done'
  if (session.activeRun) return 'working'
  if (!isAlive(session.pid)) return 'error'
  return 'idle'
}

export async function buildEntry(session: Session): Promise<BoardEntry> {
  const events = await readEvents(session.id)
  const messages = await readInbox(session.id)
  return {
    id: session.id,
    name: session.name,
    lane: deriveLane(session),
    harness: session.harness,
    branch: session.branch,
    worktreePath: session.worktreePath,
    uncommitted: session.worktreeRemoved ? 0 : await uncommittedCount(session.worktreePath),
    lastActivity: events.at(-1)?.at ?? null,
    age: relativeTime(session.createdAt),
    queued: messages.filter((message) => !message.delivered).length,
    worktreeRemoved: session.worktreeRemoved,
  }
}

export async function buildEntries(sessions: Session[]): Promise<BoardEntry[]> {
  return Promise.all(sessions.map(buildEntry))
}

export function renderBoard(entries: BoardEntry[]): string {
  const lines: string[] = []
  for (const lane of LANES) {
    const group = entries.filter((entry) => entry.lane === lane)
    lines.push(`${lane.toUpperCase()} (${group.length})`)
    for (const entry of group) {
      const dirty = entry.uncommitted < 0 ? '?' : String(entry.uncommitted)
      const suffix = entry.worktreeRemoved ? ' removed' : ''
      lines.push(
        `  ${entry.id}  ${entry.name}  [${entry.harness}]  ${entry.branch}  dirty:${dirty}  last:${relativeTime(entry.lastActivity)}  age:${entry.age}  queued:${entry.queued}${suffix}`,
      )
    }
  }
  return lines.join('\n')
}

export function boardJson(entries: BoardEntry[]) {
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, entries.filter((entry) => entry.lane === lane)]))
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), lanes, sessions: entries }
}
