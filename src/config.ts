import { configPath } from './paths.js'
import { readJson } from './jsonio.js'
import { CliError } from './errors.js'
import type { Config, Harness } from './types.js'

const defaults: Config = { maxWorkers: 4, defaultHarness: 'opencode' }

export function isHarness(value: unknown): value is Harness {
  return value === 'opencode' || value === 'pi'
}

export function isConfig(value: unknown): value is Config {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.maxWorkers === 'number' &&
    Number.isInteger(candidate.maxWorkers) &&
    candidate.maxWorkers > 0 &&
    isHarness(candidate.defaultHarness)
  )
}

export async function loadConfig(): Promise<Config> {
  const stored = await readJson(configPath(), defaults, isConfig)
  const maxWorkers = process.env.ORCH_MAX_WORKERS
  const defaultHarness = process.env.ORCH_DEFAULT_HARNESS
  const resolved: Config = { ...stored }
  if (maxWorkers !== undefined) {
    const parsed = Number(maxWorkers)
    if (!Number.isInteger(parsed) || parsed < 1) throw new CliError('ORCH_MAX_WORKERS must be a positive integer', 1)
    resolved.maxWorkers = parsed
  }
  if (defaultHarness !== undefined) {
    if (!isHarness(defaultHarness)) throw new CliError('ORCH_DEFAULT_HARNESS must be opencode or pi', 1)
    resolved.defaultHarness = defaultHarness
  }
  return resolved
}
