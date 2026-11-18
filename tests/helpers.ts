import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFileCallback)

export async function tempDir(prefix = 'eoctl-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

export async function createRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  await exec('git', ['init', '-q'], { cwd: dir })
  await exec('git', ['config', 'user.email', 'eoctl@example.com'], { cwd: dir })
  await exec('git', ['config', 'user.name', 'eoctl'], { cwd: dir })
  await writeFile(path.join(dir, 'README.md'), 'test repo\n')
  await exec('git', ['add', 'README.md'], { cwd: dir })
  await exec('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
  return dir
}

const script = (kind: 'opencode' | 'pi') => `#!/usr/bin/env node
const fs = require('node:fs')
const cp = require('node:child_process')
const lines = ${JSON.stringify(
  kind === 'opencode'
    ? [
        { type: 'step_start' },
        { type: 'tool_use', part: { tool: 'write' } },
        { type: 'step_finish' },
      ]
    : [
        { type: 'tool_execution_start', toolName: 'write' },
        { type: 'agent_settled', aborted: false },
      ],
)}
for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n')
fs.writeFileSync('.eoctl-pwd', process.env.PWD + '\\n')
fs.writeFileSync('work-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.txt', 'work\\n')
cp.execFileSync('git', ['add', '-A'], { cwd: process.cwd() })
cp.execFileSync('git', ['-c', 'user.name=eoctl', '-c', 'user.email=eoctl@example.com', 'commit', '-q', '-m', 'fake work'], {
  cwd: process.cwd(),
})
`

export async function createFakeHarnesses(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  for (const kind of ['opencode', 'pi'] as const) {
    const file = path.join(dir, kind)
    await writeFile(file, script(kind), { mode: 0o755 })
    await chmod(file, 0o755)
  }
  return dir
}

export interface CliResult {
  stdout: string
  stderr: string
  code: number
}

export async function runCli(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CliResult> {
  const cli = path.resolve(process.cwd(), 'dist/cli.js')
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
    })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 }
  }
}

export async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for condition')
}
