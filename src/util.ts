import { access, constants } from 'node:fs/promises'
import path from 'node:path'

export async function findOnPath(name: string): Promise<string | null> {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const entry of entries) {
    const candidate = path.join(entry, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function relativeTime(value: string | null): string {
  if (!value) return 'never'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}
