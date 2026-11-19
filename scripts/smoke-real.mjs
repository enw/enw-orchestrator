#!/usr/bin/env node
// Real-harness smoke: one throwaway repo, one worker per harness.
// Requires `npm run build` and git, opencode, pi on PATH.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'eoctl-smoke-'))
const cli = path.resolve('dist/cli.js')
const repo = path.join(root, 'repo')
const home = path.join(root, 'home')
const env = { ...process.env, ORCH_HOME: home }
const ids = []
const keep = Boolean(process.env.EOCTL_SMOKE_KEEP)
const harnesses = (process.env.EOCTL_SMOKE_HARNESSES ?? 'opencode,pi')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const cliRun = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8' })
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
const commits = (cwd) =>
  Number(execFileSync('git', ['-C', cwd, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim())

try {
  mkdirSync(repo, { recursive: true })
  git('init', '-q')
  git('config', 'user.email', 'smoke@example.com')
  git('config', 'user.name', 'smoke')
  writeFileSync(path.join(repo, 'README.md'), 'smoke repo\n')
  git('add', 'README.md')
  git('commit', '-q', '-m', 'init')
  cliRun('project', 'add', repo)

  for (const harness of harnesses) {
    const prompt = `Create a file named ${harness}.txt in the current directory containing 'smoke'. Commit it with git.`
    const output = cliRun(
      'spawn',
      '--name',
      `smoke-${harness}`,
      '--harness',
      harness,
      '--prompt',
      prompt,
    )
    ids.push(output.trim().split(/\s+/)[0])
  }

  let board
  for (let attempt = 0; attempt < 120; attempt++) {
    board = JSON.parse(cliRun('board', '--json'))
    const ready =
      board.sessions.length === harnesses.length &&
      board.sessions.every((entry) => entry.lastActivity && entry.uncommitted === 0 && commits(entry.worktreePath) >= 2)
    if (ready) break
    await sleep(2000)
  }

  if (board.sessions.length !== harnesses.length) throw new Error(`expected ${harnesses.length} sessions`)
  for (const entry of board.sessions) {
    if (!entry.lastActivity || entry.uncommitted !== 0 || commits(entry.worktreePath) < 2) {
      throw new Error(`${entry.harness} did not finish with a clean worktree and a commit`)
    }
    const raw = readFileSync(path.join(home, 'logs', `${entry.id}.raw.log`), 'utf8')
    const events = []
    for (const line of raw.split('\n')) {
      if (!line.startsWith('[stdout] ')) continue
      try {
        events.push(JSON.parse(line.slice(9)))
      } catch {
        // Harness diagnostics are not JSONL; only the event stream is checked.
      }
    }
    if (!events.some((record) => typeof record?.type === 'string')) {
      throw new Error(`${entry.harness} emitted no parseable JSONL events`)
    }
    console.log(`PASS ${entry.harness} ${entry.id} commits=${commits(entry.worktreePath)} jsonl=${events.length}`)
  }
  if (commits(repo) !== 1) throw new Error('source repo was modified')
  console.log(`PASS source repo untouched; one commit per harness (${harnesses.join(', ')}); JSONL parseable`)
} finally {
  for (const id of ids) {
    try {
      cliRun('session', 'done', id)
    } catch {
      // Best-effort cleanup; the throwaway root is removed below.
    }
  }
  if (keep) console.log(`smoke artifacts kept at ${root}`)
  else rmSync(root, { recursive: true, force: true })
}
