import { spawn } from 'node:child_process'
import { CliError } from './errors.js'
import { ensureDir } from './jsonio.js'
import { piSessionsDir } from './paths.js'
import { appendEvent, appendRaw } from './state.js'
import { findOnPath } from './util.js'
import type { Harness, NormalizedEvent } from './types.js'

export interface RunContext {
  harness: Harness
  cwd: string
  sessionId: string
  harnessSessionId: string
  prompt: string
  model?: string
}

function lineConsumer(onLine: (stream: 'stdout' | 'stderr', line: string) => void) {
  const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  return (stream: 'stdout' | 'stderr', chunk: string) => {
    buffers[stream] += chunk
    const lines = buffers[stream].split('\n')
    buffers[stream] = lines.pop() ?? ''
    for (const line of lines) onLine(stream, line)
  }
}

function spawnProcess(
  command: string,
  args: string[],
  cwd: string,
  onLine: (stream: 'stdout' | 'stderr', line: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, PWD: cwd }, stdio: ['ignore', 'pipe', 'pipe'] })
    const pending: Promise<void>[] = []
    const consume = lineConsumer((stream, line) => {
      pending.push(onLine(stream, line))
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => consume('stdout', chunk))
    child.stderr.on('data', (chunk: string) => consume('stderr', chunk))
    const abort = () => child.kill('SIGTERM')
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    child.on('error', reject)
    child.on('close', async (code) => {
      signal?.removeEventListener('abort', abort)
      await Promise.all(pending)
      resolve(code ?? 1)
    })
  })
}

function normalizeOpenCode(line: string): NormalizedEvent | null {
  let record: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) return null
    record = value as Record<string, unknown>
  } catch {
    return null
  }
  const type = record.type
  if (type === 'error') {
    const error = record.error
    const detail =
      typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>).message === 'string'
        ? String((error as Record<string, unknown>).message)
        : 'harness error'
    return { at: new Date().toISOString(), kind: 'error', detail }
  }
  if (type === 'tool_use') {
    const part = record.part
    const tool = typeof part === 'object' && part !== null ? (part as Record<string, unknown>).tool : undefined
    return { at: new Date().toISOString(), kind: 'activity', detail: `tool ${String(tool ?? 'unknown')}` }
  }
  if (type === 'step_finish') {
    return { at: new Date().toISOString(), kind: 'activity', detail: 'step finished' }
  }
  if (type === 'retry') {
    return { at: new Date().toISOString(), kind: 'activity', detail: 'retrying' }
  }
  return null
}

function normalizePi(line: string): NormalizedEvent | null {
  let record: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) return null
    record = value as Record<string, unknown>
  } catch {
    return null
  }
  const type = record.type
  if (type === 'tool_execution_start') {
    return { at: new Date().toISOString(), kind: 'activity', detail: `tool ${String(record.toolName ?? 'unknown')}` }
  }
  if (type === 'agent_settled') {
    return { at: new Date().toISOString(), kind: 'activity', detail: 'turn settled' }
  }
  if (type === 'auto_retry_end' && record.success === false) {
    return { at: new Date().toISOString(), kind: 'error', detail: String(record.finalError ?? 'retry failed') }
  }
  return null
}

export async function checkHarness(harness: Harness): Promise<void> {
  if (!(await findOnPath(harness))) throw new CliError(`${harness} is not on PATH`, 2)
}

export async function runHarness(ctx: RunContext, signal?: AbortSignal): Promise<number> {
  await checkHarness(ctx.harness)
  let command: string
  let args: string[]
  let normalize: (line: string) => NormalizedEvent | null

  if (ctx.harness === 'opencode') {
    command = 'opencode'
    args = ['run', '--session', ctx.harnessSessionId, '--format', 'json']
    if (ctx.model) args.push('--model', ctx.model)
    args.push(ctx.prompt)
    normalize = normalizeOpenCode
  } else {
    command = 'pi'
    const sessionDir = piSessionsDir(ctx.harnessSessionId)
    await ensureDir(sessionDir)
    args = ['--mode', 'json', '--session-dir', sessionDir, '--session-id', ctx.harnessSessionId]
    if (ctx.model) args.push('--model', ctx.model)
    args.push(ctx.prompt)
    normalize = normalizePi
  }

  return spawnProcess(command, args, ctx.cwd, async (stream, line) => {
    await appendRaw(ctx.sessionId, stream, line)
    if (stream !== 'stdout') return
    const event = normalize(line)
    if (event) await appendEvent(ctx.sessionId, event)
  }, signal)
}
