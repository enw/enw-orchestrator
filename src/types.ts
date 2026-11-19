export type Harness = 'opencode' | 'pi'
export type Lane = 'working' | 'idle' | 'done' | 'error'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
}

export interface Session {
  id: string
  slug: string
  name: string
  projectId: string
  harness: Harness
  worktreePath: string
  branch: string
  harnessSessionId: string
  createdAt: string
  model?: string
  pendingPrompt?: string
  activeRun: boolean
  pid?: number
  laneOverride?: 'done'
  worktreeRemoved: boolean
}

export interface NormalizedEvent {
  at: string
  kind: 'activity' | 'error'
  detail: string
  source?: string
}

export interface InboxMessage {
  at: string
  text: string
  delivered: boolean
}

export interface Config {
  maxWorkers: number
  defaultHarness: Harness
}

export type PrState = 'open' | 'merged' | 'closed' | 'none' | 'error'

export interface PrCheckSummary {
  total: number
  pass: number
  fail: number
  pending: number
}

export interface PrNote {
  id?: string
  at: string
  author: string
  body: string
  source: 'review' | 'comment'
  state?: string
  path?: string
  line?: number
}

export interface PrSnapshot {
  at: string
  state: PrState
  number?: number
  url?: string
  title?: string
  isDraft?: boolean
  reviewDecision: string | null
  mergeable: string | null
  checks: PrCheckSummary
  notes: PrNote[]
  error?: string
}

export interface BoardEntry {
  id: string
  name: string
  lane: Lane
  harness: Harness
  branch: string
  worktreePath: string
  uncommitted: number
  lastActivity: string | null
  age: string
  queued: number
  worktreeRemoved: boolean
  pr: PrSnapshot | null
}
