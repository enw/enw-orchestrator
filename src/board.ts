import { uncommittedCount } from './git.js'
import { readEvents, readInbox, readPrSnapshot, isAlive } from './state.js'
import { relativeTime } from './util.js'
import type { BoardEntry, Lane, PrSnapshot, Session } from './types.js'

export const LANES: Lane[] = ['working', 'idle', 'done', 'error']

export function deriveLane(session: Session): Lane {
  if (session.laneOverride === 'done') return 'done'
  if (session.activeRun) return 'working'
  if (!isAlive(session.pid)) return 'error'
  return 'idle'
}

export function formatPr(snapshot: PrSnapshot | null): string {
  if (!snapshot) return '-'
  if (snapshot.state === 'error') return `error/${snapshot.error ?? 'unknown'}`
  if (snapshot.state === 'none') return 'none'
  const checks = snapshot.checks.total ? `${snapshot.checks.pass}/${snapshot.checks.total}` : '-'
  return `#${snapshot.number ?? '?'}/${snapshot.state}/checks:${checks}/review:${snapshot.reviewDecision ?? '-'}`
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
    pr: await readPrSnapshot(session.id),
  }
}

export function renderEntryLine(entry: BoardEntry, prefix = '  '): string {
  const dirty = entry.uncommitted < 0 ? '?' : String(entry.uncommitted)
  const removed = entry.worktreeRemoved ? ' removed' : ''
  return `${prefix}${entry.id}  ${entry.name}  [${entry.harness}]  ${entry.branch}  dirty:${dirty}  last:${relativeTime(entry.lastActivity)}  age:${entry.age}  queued:${entry.queued}  pr:${formatPr(entry.pr)}${removed}`
}

export async function buildEntries(sessions: Session[]): Promise<BoardEntry[]> {
  return Promise.all(sessions.map(buildEntry))
}

export function renderBoard(entries: BoardEntry[]): string {
  const lines: string[] = []
  for (const lane of LANES) {
    const group = entries.filter((entry) => entry.lane === lane)
    lines.push(`${lane.toUpperCase()} (${group.length})`)
    for (const entry of group) lines.push(renderEntryLine(entry))
  }
  return lines.join('\n')
}

export function boardJson(entries: BoardEntry[]) {
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, entries.filter((entry) => entry.lane === lane)]))
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), lanes, sessions: entries }
}
