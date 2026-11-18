import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { CliError } from './errors.js'
import { appendLine, ensureDir, readJson, readLines, rewriteLines, writeJsonAtomic, fileSize } from './jsonio.js'
import { withLock } from './lock.js'
import {
  eventsDir,
  eventsPath,
  inboxDir,
  inboxPath,
  lockPath,
  projectsPath,
  rawLogPath,
  sessionPath,
  sessionsDir,
  home,
  logsDir,
  worktreesDir,
  piSessionsDir,
} from './paths.js'
import { isHarness } from './config.js'
import { redact } from './redact.js'
import type { InboxMessage, NormalizedEvent, Project, Session } from './types.js'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isString = (value: unknown): value is string => typeof value === 'string'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

export const isProject = (value: unknown): value is Project =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.name) &&
  isString(value.path) &&
  isString(value.createdAt)

export const isSession = (value: unknown): value is Session =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.slug) &&
  isString(value.name) &&
  isString(value.projectId) &&
  isHarness(value.harness) &&
  isString(value.worktreePath) &&
  isString(value.branch) &&
  isString(value.harnessSessionId) &&
  isString(value.createdAt) &&
  (value.model === undefined || isString(value.model)) &&
  (value.pendingPrompt === undefined || isString(value.pendingPrompt)) &&
  isBoolean(value.activeRun) &&
  (value.pid === undefined || typeof value.pid === 'number') &&
  (value.laneOverride === undefined || value.laneOverride === 'done') &&
  isBoolean(value.worktreeRemoved)

export const isEvent = (value: unknown): value is NormalizedEvent =>
  isRecord(value) &&
  isString(value.at) &&
  (value.kind === 'activity' || value.kind === 'error') &&
  isString(value.detail) &&
  (value.source === undefined || isString(value.source))

export const isInboxMessage = (value: unknown): value is InboxMessage =>
  isRecord(value) && isString(value.at) && isString(value.text) && isBoolean(value.delivered)

export async function ensureHome(): Promise<void> {
  await Promise.all(
    [home(), sessionsDir(), eventsDir(), inboxDir(), logsDir(), worktreesDir()].map((dir) => ensureDir(dir)),
  )
}

export async function listProjects(): Promise<Project[]> {
  return readJson(projectsPath(), [], (value): value is Project[] => Array.isArray(value) && value.every(isProject))
}

export async function addProject(project: Project): Promise<void> {
  await withLock(lockPath(projectsPath()), async () => {
    const projects = await listProjects()
    if (projects.some((item) => item.id === project.id)) throw new CliError(`Project ${project.id} already exists`, 1)
    await writeJsonAtomic(projectsPath(), [...projects, project])
  })
}

export async function findProject(id: string): Promise<Project | null> {
  return (await listProjects()).find((project) => project.id === id) ?? null
}

export async function resolveProject(explicitId?: string, cwd = process.cwd()): Promise<Project> {
  if (explicitId) {
    const project = await findProject(explicitId)
    if (!project) throw new CliError(`Project ${explicitId} not found`, 4)
    return project
  }
  const projects = await listProjects()
  const matches = projects
    .filter((project) => cwd === project.path || cwd.startsWith(`${project.path}${path.sep}`))
    .sort((a, b) => b.path.length - a.path.length)
  if (!matches.length) throw new CliError('No registered project contains the current directory; use --project', 4)
  return matches[0]
}

export async function getSession(id: string): Promise<Session> {
  let text: string
  try {
    text = await readFile(sessionPath(id), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError(`Session ${id} not found`, 4)
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new CliError(`Malformed session record ${id}`, 2)
  }
  if (!isSession(value)) throw new CliError(`Invalid session record ${id}`, 2)
  return value
}

export async function listSessions(): Promise<Session[]> {
  let files: string[]
  try {
    files = await readdir(sessionsDir())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const sessions: Session[] = []
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    sessions.push(await getSession(file.slice(0, -'.json'.length)))
  }
  return sessions
}

export async function saveSession(session: Session): Promise<void> {
  await withLock(lockPath(sessionPath(session.id)), () => writeJsonAtomic(sessionPath(session.id), session))
}

export async function appendEvent(id: string, event: NormalizedEvent): Promise<void> {
  await appendLine(eventsPath(id), JSON.stringify(event))
}

export async function readEvents(id: string): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = []
  for (const line of await readLines(eventsPath(id))) {
    try {
      const value: unknown = JSON.parse(line)
      if (isEvent(value)) events.push(value)
    } catch {
      continue
    }
  }
  return events
}

export async function readInbox(id: string): Promise<InboxMessage[]> {
  const messages: InboxMessage[] = []
  for (const line of await readLines(inboxPath(id))) {
    try {
      const value: unknown = JSON.parse(line)
      if (isInboxMessage(value)) messages.push(value)
    } catch {
      continue
    }
  }
  return messages
}

export async function appendMessage(id: string, text: string): Promise<void> {
  await withLock(lockPath(inboxPath(id)), async () => {
    const messages = await readInbox(id)
    messages.push({ at: new Date().toISOString(), text, delivered: false })
    await rewriteLines(inboxPath(id), messages.map((message) => JSON.stringify(message)))
  })
}

export async function claimNextMessage(id: string): Promise<InboxMessage | null> {
  return withLock(lockPath(inboxPath(id)), async () => {
    const messages = await readInbox(id)
    const index = messages.findIndex((message) => !message.delivered)
    if (index === -1) return null
    const message = { ...messages[index], delivered: true }
    messages[index] = message
    await rewriteLines(inboxPath(id), messages.map((item) => JSON.stringify(item)))
    return message
  })
}

export function isAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function activeRunnerCount(): Promise<number> {
  const sessions = await listSessions()
  return sessions.filter((session) => session.laneOverride !== 'done' && isAlive(session.pid)).length
}

export async function appendRaw(id: string, stream: 'stdout' | 'stderr', line: string): Promise<void> {
  const file = rawLogPath(id)
  if ((await fileSize(file)) > 1_000_000) return
  await appendLine(file, `[${stream}] ${redact(line)}`)
}

export async function readRaw(id: string): Promise<string[]> {
  return (await readLines(rawLogPath(id))).map(redact)
}

export async function piSessionDirFor(id: string): Promise<string> {
  await ensureDir(piSessionsDir(id))
  return piSessionsDir(id)
}

export async function projectWorktreesDir(projectId: string): Promise<string> {
  const dir = path.join(worktreesDir(), projectId)
  await ensureDir(dir)
  return dir
}
