import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Harness } from './types.js'

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function shortId(): string {
  return randomBytes(4).toString('hex')
}

export function projectIdFor(repoPath: string): string {
  const hash = createHash('sha256').update(repoPath).digest('hex').slice(0, 6)
  return `${slugify(path.basename(repoPath)) || 'project'}-${hash}`
}

export function newSessionId(): string {
  return `s_${shortId()}`
}

export function isSessionId(value: string): boolean {
  return /^s_[0-9a-f]{8}$/.test(value)
}

export function newHarnessSessionId(harness: Harness, cliId: string): string {
  return harness === 'opencode' ? `ses_${randomBytes(12).toString('hex')}` : cliId
}

export function sessionSlug(name: string, id: string): string {
  return `${slugify(name) || 'worker'}-${id.slice(2, 6)}`
}
