import { open, stat, unlink } from 'node:fs/promises'
import { CliError } from './errors.js'
import { ensureDir } from './jsonio.js'
import path from 'node:path'

const STALE_MS = 30_000

export async function withLock<T>(lockFile: string, fn: () => Promise<T>): Promise<T> {
  await ensureDir(path.dirname(lockFile))
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      const handle = await open(lockFile, 'wx')
      try {
        return await fn()
      } finally {
        await handle.close()
        await unlink(lockFile).catch(() => {})
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const info = await stat(lockFile).catch(() => null)
      if (info && Date.now() - info.mtimeMs > STALE_MS) {
        await unlink(lockFile).catch(() => {})
        continue
      }
      if (Date.now() > deadline) throw new CliError(`Timed out waiting for lock ${lockFile}`, 3)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}
