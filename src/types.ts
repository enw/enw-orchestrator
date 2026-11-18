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
}
