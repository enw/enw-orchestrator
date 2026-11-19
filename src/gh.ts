import { spawn } from 'node:child_process'
import { CliError } from './errors.js'
import { redact } from './redact.js'
import type { PrCheckSummary, PrNote, PrSnapshot, Project, Session } from './types.js'
import { findOnPath } from './util.js'

const FIELDS = 'number,url,title,state,isDraft,reviewDecision,mergeable,updatedAt,statusCheckRollup,reviews,comments'
const NO_PR = /no pull requests? found|could not find (a )?pull request|no pull request matches/i
const USAGE = /accepts \d+ arg|unknown command|unexpected argument|unknown flag|invalid argument|required flag/i
const TIMEOUT_MS = 20_000
const MAX_CAPTURE = 2_000_000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Strip terminal escapes and control bytes, then redact secrets. */
export function sanitizePrText(value: unknown, max = 2000): string {
  if (typeof value !== 'string') return ''
  return redact(value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')).slice(0, max)
}

export function emptyCheckSummary(): PrCheckSummary {
  return { total: 0, pass: 0, fail: 0, pending: 0 }
}

export function errorSnapshot(message: string): PrSnapshot {
  return {
    at: new Date().toISOString(),
    state: 'error',
    reviewDecision: null,
    mergeable: null,
    checks: emptyCheckSummary(),
    notes: [],
    error: sanitizePrText(message, 300),
  }
}

type GhResult = { ok: true; stdout: string } | { ok: false; stderr: string; code: number | null }

async function runGh(args: string[], cwd: string): Promise<GhResult> {
  const gh = await findOnPath('gh')
  if (!gh) throw new CliError('gh not found on PATH', 2)
  return new Promise((resolve, reject) => {
    const child = spawn(gh, args, { cwd, env: process.env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const cap = (current: string, chunk: Buffer | string) => (current.length < MAX_CAPTURE ? current + chunk.toString() : current)
    const timer = setTimeout(() => {
      stderr += '\ngh timed out'
      child.kill('SIGKILL')
    }, TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = cap(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = cap(stderr, chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve(code === 0 ? { ok: true, stdout } : { ok: false, stderr, code })
    })
  })
}

function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('gh returned invalid JSON')
  }
}

function checkSummary(value: unknown): PrCheckSummary {
  const summary = emptyCheckSummary()
  if (!Array.isArray(value)) return summary
  for (const raw of value) {
    if (!isRecord(raw)) continue
    summary.total++
    const conclusion = typeof raw.conclusion === 'string' ? raw.conclusion.toUpperCase() : ''
    const state = typeof raw.state === 'string' ? raw.state.toUpperCase() : ''
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion) || state === 'SUCCESS') summary.pass++
    else if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE', 'ERROR'].includes(conclusion) || ['FAILURE', 'ERROR'].includes(state)) summary.fail++
    else summary.pending++
  }
  return summary
}

function authorLogin(value: unknown): string {
  return isRecord(value) && typeof value.login === 'string' ? sanitizePrText(value.login, 100) || 'unknown' : 'unknown'
}

function reviewNotes(value: unknown): PrNote[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((item) => ({
    at: sanitizePrText(item.submittedAt, 50),
    author: authorLogin(item.author),
    body: sanitizePrText(item.body),
    source: 'review' as const,
    state: typeof item.state === 'string' ? sanitizePrText(item.state, 50) : undefined,
    path: typeof item.path === 'string' ? sanitizePrText(item.path, 300) : undefined,
    line: typeof item.line === 'number' ? item.line : undefined,
  }))
}

function commentNotes(value: unknown): PrNote[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((item) => ({
    at: sanitizePrText(item.createdAt, 50),
    author: authorLogin(item.author),
    body: sanitizePrText(item.body),
    source: 'comment' as const,
    path: typeof item.path === 'string' ? sanitizePrText(item.path, 300) : undefined,
    line: typeof item.line === 'number' ? item.line : undefined,
  }))
}

function normalize(raw: Record<string, unknown>, at: string): PrSnapshot {
  const state = typeof raw.state === 'string' ? raw.state.toUpperCase() : 'OPEN'
  return {
    at,
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    number: typeof raw.number === 'number' ? raw.number : undefined,
    url: sanitizePrText(raw.url, 500) || undefined,
    title: sanitizePrText(raw.title, 300) || undefined,
    isDraft: typeof raw.isDraft === 'boolean' ? raw.isDraft : undefined,
    reviewDecision: typeof raw.reviewDecision === 'string' ? sanitizePrText(raw.reviewDecision, 100) : null,
    mergeable: typeof raw.mergeable === 'string' ? sanitizePrText(raw.mergeable, 100) : null,
    checks: checkSummary(raw.statusCheckRollup),
    notes: [...reviewNotes(raw.reviews), ...commentNotes(raw.comments)],
  }
}

/** Read-only PR observation for a session's branch. gh missing propagates as exit 2. */
export async function observePr(session: Session, project: Project): Promise<PrSnapshot> {
  const at = new Date().toISOString()
  try {
    let payload: unknown
    const view = await runGh(['pr', 'view', session.branch, '--json', FIELDS], project.path)
    if (view.ok) {
      payload = parsePayload(view.stdout)
    } else if (USAGE.test(view.stderr)) {
      const list = await runGh(
        ['pr', 'list', '--head', session.branch, '--state', 'all', '--json', FIELDS, '--limit', '1'],
        project.path,
      )
      if (!list.ok) throw new Error(sanitizePrText(list.stderr, 300) || `gh exited ${list.code}`)
      const rows: unknown = parsePayload(list.stdout)
      payload = Array.isArray(rows) ? rows[0] : null
    } else if (NO_PR.test(view.stderr)) {
      payload = null
    } else {
      throw new Error(sanitizePrText(view.stderr, 300) || `gh exited ${view.code}`)
    }
    return isRecord(payload) ? normalize(payload, at) : { at, state: 'none', reviewDecision: null, mergeable: null, checks: emptyCheckSummary(), notes: [] }
  } catch (error) {
    if (error instanceof CliError) throw error
    return errorSnapshot(error instanceof Error ? error.message : String(error))
  }
}
