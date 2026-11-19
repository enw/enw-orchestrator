import { homedir } from 'node:os'
import path from 'node:path'

export function home(): string {
  return process.env.ORCH_HOME ?? path.join(homedir(), '.orchestrator-cli')
}

export const configPath = () => path.join(home(), 'config.json')
export const projectsPath = () => path.join(home(), 'projects.json')
export const sessionsDir = () => path.join(home(), 'sessions')
export const eventsDir = () => path.join(home(), 'events')
export const inboxDir = () => path.join(home(), 'inbox')
export const logsDir = () => path.join(home(), 'logs')
export const prDir = () => path.join(home(), 'pr')
export const worktreesDir = () => path.join(home(), 'worktrees')
export const piSessionsDir = (id: string) => path.join(home(), 'harness', 'pi', id)

export const sessionPath = (id: string) => path.join(sessionsDir(), `${id}.json`)
export const eventsPath = (id: string) => path.join(eventsDir(), `${id}.jsonl`)
export const inboxPath = (id: string) => path.join(inboxDir(), `${id}.jsonl`)
export const logPath = (id: string) => path.join(logsDir(), `${id}.log`)
export const rawLogPath = (id: string) => path.join(logsDir(), `${id}.raw.log`)
export const prPath = (id: string) => path.join(prDir(), `${id}.json`)
export const prRoutedPath = (id: string) => path.join(prDir(), `${id}.routed.json`)
export const lockPath = (file: string) => `${file}.lock`
