import { killSession, markDone, restoreSession, sendMessage } from './actions.js'
import { buildEntries, LANES, renderEntryLine } from './board.js'
import { CliError } from './errors.js'
import { listSessions } from './state.js'
import type { BoardEntry } from './types.js'

export type WatchMode = 'nav' | 'message'

export interface WatchState {
  ids: string[]
  selectedId: string | null
  mode: WatchMode
  buffer: string
  status: string
}

export type WatchKey =
  | { kind: 'up' | 'down' | 'message' | 'enter' | 'escape' | 'done' | 'kill' | 'restore' | 'quit' | 'backspace' | 'unknown' }
  | { kind: 'char'; value: string }

export type WatchAction =
  | { type: 'quit' }
  | { type: 'send'; id: string; text: string }
  | { type: 'done' | 'kill' | 'restore'; id: string }

export interface WatchIO {
  stdin: {
    isTTY?: boolean
    setRawMode?: (enabled: boolean) => void
    resume?: () => void
    pause?: () => void
    on: (event: string, listener: (chunk: Buffer | string) => void) => void
    off?: (event: string, listener: (chunk: Buffer | string) => void) => void
  }
  stdout: { isTTY?: boolean; write: (text: string) => void }
}

export function parseKey(chunk: string, mode: WatchMode): WatchKey {
  if (chunk === '\x1b[A' || chunk === '\x1b[D') return { kind: 'up' }
  if (chunk === '\x1b[B' || chunk === '\x1b[C') return { kind: 'down' }
  if (chunk === '\r' || chunk === '\n') return { kind: 'enter' }
  if (chunk === '\x7f' || chunk === '\b') return { kind: 'backspace' }
  if (chunk === '\x1b') return { kind: 'escape' }
  if (chunk === '\x03') return { kind: 'quit' }
  if (mode === 'message') {
    if (chunk.length > 0 && /^[\x20-\x7e]+$/.test(chunk)) return { kind: 'char', value: chunk }
    return { kind: 'unknown' }
  }
  switch (chunk.toLowerCase()) {
    case 'j':
      return { kind: 'down' }
    case 'k':
      return { kind: 'up' }
    case 'm':
      return { kind: 'message' }
    case 'd':
      return { kind: 'done' }
    case 'x':
      return { kind: 'kill' }
    case 'r':
      return { kind: 'restore' }
    case 'q':
      return { kind: 'quit' }
    default:
      return { kind: 'unknown' }
  }
}

export function reduceWatchKey(state: WatchState, key: WatchKey): { state: WatchState; action?: WatchAction } {
  if (state.mode === 'message') {
    switch (key.kind) {
      case 'char':
        return { state: { ...state, buffer: state.buffer + key.value } }
      case 'backspace':
        return { state: { ...state, buffer: state.buffer.slice(0, -1) } }
      case 'escape':
        return { state: { ...state, mode: 'nav', buffer: '', status: 'cancelled' } }
      case 'enter':
        if (!state.buffer.trim()) return { state: { ...state, mode: 'nav', buffer: '', status: 'empty message' } }
        return {
          state: { ...state, mode: 'nav', buffer: '', status: `queued for ${state.selectedId ?? '?'}` },
          action: state.selectedId ? { type: 'send', id: state.selectedId, text: state.buffer } : undefined,
        }
      case 'quit':
        return { state, action: { type: 'quit' } }
      default:
        return { state }
    }
  }

  const index = state.selectedId ? state.ids.indexOf(state.selectedId) : -1
  const move = (delta: number): WatchState => {
    if (!state.ids.length) return state
    const next = (index + delta + state.ids.length) % state.ids.length
    return { ...state, selectedId: state.ids[next], status: '' }
  }
  switch (key.kind) {
    case 'down':
      return { state: move(1) }
    case 'up':
      return { state: move(-1) }
    case 'message':
      return state.selectedId ? { state: { ...state, mode: 'message', buffer: '', status: '' } } : { state }
    case 'done':
    case 'kill':
    case 'restore':
      return state.selectedId ? { state, action: { type: key.kind, id: state.selectedId } } : { state }
    case 'quit':
      return { state, action: { type: 'quit' } }
    default:
      return { state }
  }
}

export function renderWatchFrame(entries: BoardEntry[], state: WatchState, at: Date = new Date()): string {
  const lines = [
    `eoctl watch  ${at.toISOString()}  sessions:${entries.length}`,
    '',
  ]
  for (const lane of LANES) {
    const group = entries.filter((entry) => entry.lane === lane)
    lines.push(`${lane.toUpperCase()} (${group.length})`)
    for (const entry of group) {
      const marker = entry.id === state.selectedId ? '>' : ' '
      lines.push(renderEntryLine(entry, `${marker} `))
    }
  }
  lines.push('')
  if (state.mode === 'message') {
    lines.push(`message> ${state.buffer}_\x1b[0K`)
    lines.push('Enter send · Esc cancel')
  } else {
    lines.push(state.status || 'ready')
    lines.push('j/k select · m message · d done · x kill · r restore · q quit')
  }
  return lines.join('\n')
}

function defaultIO(): WatchIO {
  return { stdin: process.stdin, stdout: process.stdout }
}

export async function runWatch(options: { intervalMs: number }, io: WatchIO = defaultIO()): Promise<void> {
  if (!io.stdin.isTTY || !io.stdout.isTTY) throw new CliError('watch requires a TTY', 2)

  let state: WatchState = { ids: [], selectedId: null, mode: 'nav', buffer: '', status: '' }
  let stopped = false
  let cleaned = false
  let resolveStop: (() => void) | null = null
  let rendering: Promise<void> = Promise.resolve()
  let timer: NodeJS.Timeout | undefined
  let dataAttached = false
  let rawSet = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (timer) clearInterval(timer)
    if (dataAttached) io.stdin.off?.('data', onData)
    if (rawSet) io.stdin.setRawMode?.(false)
    io.stdin.pause?.()
    io.stdout.write('\x1b[?25h\n')
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    cleanup()
    resolveStop?.()
  }
  function onData(chunk: Buffer | string) {
    const text = chunk.toString()
    const key = parseKey(text, state.mode)
    const reduced = reduceWatchKey(state, key)
    state = reduced.state
    rendering = rendering
      .then(async () => {
        if (reduced.action?.type === 'quit') {
          stop()
          return
        }
        if (reduced.action) {
          try {
            if (reduced.action.type === 'send') await sendMessage(reduced.action.id, reduced.action.text)
            else if (reduced.action.type === 'done') await markDone(reduced.action.id)
            else if (reduced.action.type === 'kill') await killSession(reduced.action.id)
            else await restoreSession(reduced.action.id)
          } catch (error) {
            state = { ...state, status: `error: ${error instanceof Error ? error.message : String(error)}` }
          }
        }
        await refresh()
      })
      .catch(() => {})
  }
  const refresh = async () => {
    const entries = await buildEntries(await listSessions())
    const ids = entries.map((entry) => entry.id)
    if (!ids.includes(state.selectedId ?? '')) state = { ...state, selectedId: ids[0] ?? null }
    state = { ...state, ids }
    io.stdout.write(`\x1b[2J\x1b[H${renderWatchFrame(entries, state)}\x1b[?25l`)
  }

  try {
    rawSet = true
    io.stdin.setRawMode?.(true)
    io.stdin.resume?.()
    io.stdout.write('\x1b[?25l')
    io.stdin.on('data', onData)
    dataAttached = true
    timer = setInterval(() => {
      rendering = rendering.then(refresh).catch(() => {})
    }, options.intervalMs)
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    await refresh()
    if (!stopped) await new Promise<void>((resolve) => { resolveStop = resolve })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    cleanup()
  }
}
