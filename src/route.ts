import { createHash } from 'node:crypto'
import { appendMessage, getSession, readPrSnapshot, readRoutedKeys, saveRoutedKeys } from './state.js'
import type { PrNote, PrSnapshot } from './types.js'

export interface RouteResult {
  queued: number
  skipped: number
  reason?: string
}

export function noteKey(note: PrNote): string {
  if (note.id) return `${note.source}:${note.id}`
  const material = `${note.source}|${note.at}|${note.author}|${note.body}`
  return `hash:${createHash('sha256').update(material).digest('hex').slice(0, 16)}`
}

export function buildFeedbackMessage(snapshot: PrSnapshot, notes: PrNote[]): string {
  const header = `GitHub PR feedback${snapshot.number ? ` #${snapshot.number}` : ''}${snapshot.url ? ` (${snapshot.url})` : ''}`
  const lines = [header]
  for (const note of notes) {
    const parts = [`${note.source} by ${note.author || 'unknown'}`]
    if (note.state) parts.push(`state:${note.state}`)
    if (note.path) parts.push(`${note.path}${note.line ? `:${note.line}` : ''}`)
    if (note.at) parts.push(`at:${note.at}`)
    lines.push('', `- ${parts.join(' | ')}`, note.body.trim())
  }
  return lines.join('\n')
}

/** Queue notes not yet routed. Message is appended before keys are saved so a crash duplicates rather than loses feedback. */
export async function routePrFeedback(id: string): Promise<RouteResult> {
  const session = await getSession(id)
  if (session.laneOverride === 'done') return { queued: 0, skipped: 0, reason: 'session is done' }
  if (session.worktreeRemoved) return { queued: 0, skipped: 0, reason: 'worktree removed' }
  const snapshot = await readPrSnapshot(id)
  if (!snapshot) return { queued: 0, skipped: 0, reason: 'no PR snapshot; run pr refresh first' }
  if (snapshot.state === 'error') return { queued: 0, skipped: 0, reason: snapshot.error ?? 'PR observation failed' }
  if (snapshot.state === 'none') return { queued: 0, skipped: 0, reason: 'no PR found' }

  const routed = new Set(await readRoutedKeys(id))
  const fresh = snapshot.notes.filter((note) => note.body.trim() && !routed.has(noteKey(note)))
  if (!fresh.length) return { queued: 0, skipped: snapshot.notes.length }

  await appendMessage(id, buildFeedbackMessage(snapshot, fresh))
  await saveRoutedKeys(id, [...routed, ...fresh.map(noteKey)])
  return { queued: fresh.length, skipped: snapshot.notes.length - fresh.length }
}
