import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CliError } from './errors.js'

const exec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return stdout.trim()
}

export async function repoRoot(dir: string): Promise<string> {
  try {
    return await git(dir, ['rev-parse', '--show-toplevel'])
  } catch {
    throw new CliError(`${dir} is not a git repository`, 2)
  }
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

export async function createWorktree(repo: string, target: string, branch: string): Promise<void> {
  await git(repo, ['worktree', 'add', '-b', branch, target, 'HEAD'])
}

export async function uncommittedCount(cwd: string): Promise<number> {
  try {
    const output = await git(cwd, ['status', '--porcelain'])
    return output ? output.split('\n').length : 0
  } catch {
    return -1
  }
}

export async function removeWorktree(repo: string, target: string): Promise<void> {
  await git(repo, ['worktree', 'remove', target])
}
