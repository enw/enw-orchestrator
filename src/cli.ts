#!/usr/bin/env node
import { Command } from 'commander'
import { access, constants, readFile } from 'node:fs/promises'
import path from 'node:path'
import { killSession, launchRunner, markDone, restoreSession, sendMessage } from './actions.js'
import { checkHarness } from './adapters.js'
import { buildEntries, boardJson, formatPr, renderBoard } from './board.js'
import { isHarness, loadConfig } from './config.js'
import { errorSnapshot, observePr } from './gh.js'
import { CliError } from './errors.js'
import { branchExists, createWorktree, removeWorktree, repoRoot, uncommittedCount } from './git.js'
import { newHarnessSessionId, newSessionId, projectIdFor, sessionSlug } from './ids.js'
import { home } from './paths.js'
import { runSessionRunner } from './runner.js'
import {
  activeRunnerCount,
  addProject,
  ensureHome,
  findProject,
  getSession,
  listProjects,
  listSessions,
  readEvents,
  readInbox,
  readPrSnapshot,
  readRaw,
  resolveProject,
  savePrSnapshot,
  saveSession,
  projectWorktreesDir,
} from './state.js'
import type { Harness, Session } from './types.js'
import { findOnPath } from './util.js'
import { runWatch } from './watch.js'

const VERSION = '0.1.0'
const LANE_LABEL = (lane: string) => lane.toUpperCase()

function action<T extends unknown[]>(fn: (...args: T) => Promise<void>) {
  return async (...args: T) => {
    try {
      await ensureHome()
      await fn(...args)
    } catch (error) {
      const cliError = error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error))
      process.stderr.write(`eoctl: ${cliError.message}\n`)
      process.exitCode = cliError.exitCode
    }
  }
}

async function readChoice(inline: string | undefined, file: string | undefined, label: string): Promise<string> {
  if (Boolean(inline) === Boolean(file)) throw new CliError(`Provide exactly one of ${label}`, 1)
  return inline ?? (await readFile(file as string, 'utf8')).trim()
}

const program = new Command()
program.name('eoctl').description('Standalone CLI orchestrator for parallel coding agents').version(VERSION)

program
  .command('doctor')
  .description('Check local prerequisites')
  .action(
    action(async () => {
      const checks: Array<[string, boolean]> = [
        ['node >= 22', Number(process.versions.node.split('.')[0]) >= 22],
        ['git', Boolean(await findOnPath('git'))],
        ['opencode', Boolean(await findOnPath('opencode'))],
        ['pi', Boolean(await findOnPath('pi'))],
        [
          'state directory',
          await access(home(), constants.W_OK)
            .then(() => true)
            .catch(() => false),
        ],
      ]
      for (const [name, ok] of checks) console.log(`${ok ? 'OK' : 'MISSING'}  ${name}`)
      if (checks.some(([, ok]) => !ok)) process.exitCode = 2
    }),
  )

const project = program.command('project').description('Manage registered projects')

project
  .command('add')
  .description('Register a git repository')
  .argument('<path>')
  .option('--name <name>')
  .action(
    action(async (target: string, options: { name?: string }) => {
      const root = await repoRoot(path.resolve(target))
      const id = projectIdFor(root)
      const record = {
        id,
        name: options.name ?? path.basename(root),
        path: root,
        createdAt: new Date().toISOString(),
      }
      await addProject(record)
      console.log(`${id}  ${record.name}  ${root}`)
    }),
  )

project
  .command('ls')
  .description('List registered projects')
  .action(
    action(async () => {
      const projects = await listProjects()
      if (!projects.length) console.log('No projects registered')
      for (const item of projects) console.log(`${item.id}  ${item.name}  ${item.path}`)
    }),
  )

program
  .command('spawn')
  .description('Create a worker session in its own worktree')
  .requiredOption('--name <name>')
  .option('--harness <harness>')
  .option('--prompt <text>')
  .option('--prompt-file <path>')
  .option('--project <id>')
  .option('--branch <name>')
  .option('--model <model>')
  .action(
    action(async (options: {
      name: string
      harness?: string
      prompt?: string
      promptFile?: string
      project?: string
      branch?: string
      model?: string
    }) => {
      const config = await loadConfig()
      const harness = options.harness ?? config.defaultHarness
      if (!isHarness(harness)) throw new CliError('--harness must be opencode or pi', 1)
      const prompt = await readChoice(options.prompt, options.promptFile, '--prompt or --prompt-file')
      if (!prompt) throw new CliError('Prompt must not be empty', 1)
      await checkHarness(harness)
      if ((await activeRunnerCount()) >= config.maxWorkers) throw new CliError('Worker cap reached', 3)

      const selected = await resolveProject(options.project)
      const id = newSessionId()
      const slug = sessionSlug(options.name, id)
      const branch = options.branch ?? `orch/${slug}`
      if (await branchExists(selected.path, branch)) throw new CliError(`Branch ${branch} already exists`, 1)

      const worktreePath = path.join(await projectWorktreesDir(selected.id), slug)
      await createWorktree(selected.path, worktreePath, branch)

      const session: Session = {
        id,
        slug,
        name: options.name,
        projectId: selected.id,
        harness: harness as Harness,
        worktreePath,
        branch,
        harnessSessionId: newHarnessSessionId(harness as Harness, id),
        createdAt: new Date().toISOString(),
        model: options.model,
        pendingPrompt: prompt,
        activeRun: false,
        worktreeRemoved: false,
      }
      await saveSession(session)
      const pid = await launchRunner(session)
      await saveSession({ ...session, pid })
      console.log(`${id}  ${session.name}  [${session.harness}]  ${branch}  ${worktreePath}`)
    }),
  )

program
  .command('board')
  .description('Show the fleet grouped by derived lane')
  .option('--json')
  .option('--watch', 'Refresh the board in place with keyboard actions')
  .option('--interval <seconds>', 'Watch refresh interval in seconds', '1')
  .action(
    action(async (options: { json?: boolean; watch?: boolean; interval?: string }) => {
      if (options.watch) {
        const seconds = Number(options.interval)
        if (!Number.isFinite(seconds) || seconds < 1) throw new CliError('--interval must be a positive number', 1)
        await runWatch({ intervalMs: seconds * 1000 })
        return
      }
      const entries = await buildEntries(await listSessions())
      console.log(options.json ? JSON.stringify(boardJson(entries), null, 2) : renderBoard(entries))
    }),
  )

const prCommand = program.command('pr').description('Observe pull requests and CI via gh')

prCommand
  .command('refresh')
  .description('Snapshot PR/CI state for sessions (read-only)')
  .argument('[id...]')
  .action(
    action(async (ids: string[]) => {
      const records = ids.length
        ? await Promise.all(ids.map((id) => getSession(id)))
        : (await listSessions()).filter((record) => record.laneOverride !== 'done' && !record.worktreeRemoved)
      if (!records.length) {
        console.log('No sessions to observe')
        return
      }
      for (const record of records) {
        let snapshot
        try {
          const project = await findProject(record.projectId)
          if (!project) throw new Error(`project ${record.projectId} not found`)
          snapshot = await observePr(record, project)
        } catch (error) {
          if (error instanceof CliError && error.exitCode === 2) throw error
          snapshot = errorSnapshot(error instanceof Error ? error.message : String(error))
        }
        await savePrSnapshot(record.id, snapshot)
        const checks = snapshot.checks.total ? `${snapshot.checks.pass}/${snapshot.checks.total}` : '-'
        const summary = `#${snapshot.number ?? '-'}  checks:${checks}  review:${snapshot.reviewDecision ?? '-'}`
        console.log(
          snapshot.state === 'error'
            ? `${record.id}  error  ${snapshot.error ?? ''}`.trimEnd()
            : `${record.id}  ${snapshot.state}  ${summary}  ${snapshot.url ?? ''}`.trimEnd(),
        )
      }
    }),
  )

const sessionCommand = program.command('session').description('Inspect and control sessions')

sessionCommand
  .command('ls')
  .description('List sessions')
  .action(
    action(async () => {
      const sessions = await listSessions()
      if (!sessions.length) console.log('No sessions')
      const entries = await buildEntries(sessions)
      for (const entry of entries) {
        console.log(`${entry.id}  ${LANE_LABEL(entry.lane)}  ${entry.name}  [${entry.harness}]  ${entry.branch}`)
      }
    }),
  )

sessionCommand
  .command('get')
  .description('Show one session')
  .argument('<id>')
  .option('--json')
  .action(
    action(async (id: string, options: { json?: boolean }) => {
      const record = await getSession(id)
      const entry = (await buildEntries([record]))[0]
      if (options.json) {
        console.log(JSON.stringify({ session: record, board: entry }, null, 2))
        return
      }
      const inbox = await readInbox(id)
      console.log(`id: ${record.id}`)
      console.log(`name: ${record.name}`)
      console.log(`lane: ${entry.lane}`)
      console.log(`harness: ${record.harness}`)
      console.log(`branch: ${record.branch}`)
      console.log(`worktree: ${record.worktreePath}${record.worktreeRemoved ? ' (removed)' : ''}`)
      console.log(`runner: ${record.pid ?? 'none'}`)
      console.log(`queued: ${inbox.filter((message) => !message.delivered).length}`)
      const pr = await readPrSnapshot(id)
      if (pr) {
        console.log(`pr: ${formatPr(pr)}`)
        if (pr.url) console.log(`pr url: ${pr.url}`)
        console.log(
          `pr checks: ${pr.checks.pass} pass, ${pr.checks.fail} fail, ${pr.checks.pending} pending (${pr.checks.total} total)`,
        )
        console.log(
          `pr notes: ${pr.notes.filter((note) => note.source === 'review').length} reviews, ${pr.notes.filter((note) => note.source === 'comment').length} comments`,
        )
        if (pr.error) console.log(`pr error: ${pr.error}`)
      }
    }),
  )

sessionCommand
  .command('log')
  .description('Show normalized session events')
  .argument('<id>')
  .option('--raw')
  .option('--follow')
  .action(
    action(async (id: string, options: { raw?: boolean; follow?: boolean }) => {
      await getSession(id)
      let shown = 0
      const render = async () => {
        const events = await readEvents(id)
        for (const event of events.slice(shown)) {
          console.log(`${event.at}  ${event.kind}  ${event.detail}`)
        }
        shown = events.length
        if (options.raw) for (const line of await readRaw(id)) console.log(line)
      }
      await render()
      if (options.follow) {
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          await render()
        }
      }
    }),
  )

sessionCommand
  .command('done')
  .description('Stop a runner and mark the session done')
  .argument('<id>')
  .action(
    action(async (id: string) => {
      await markDone(id)
      console.log(`${id} done`)
    }),
  )

sessionCommand
  .command('kill')
  .description('Stop a runner, leaving the session in error')
  .argument('<id>')
  .action(
    action(async (id: string) => {
      await killSession(id)
      console.log(`${id} killed`)
    }),
  )

sessionCommand
  .command('restore')
  .description('Relaunch a runner for a non-done session')
  .argument('<id>')
  .action(
    action(async (id: string) => {
      await restoreSession(id)
      console.log(`${id} restored`)
    }),
  )

sessionCommand
  .command('cleanup')
  .description('Remove worktrees for done sessions with clean worktrees')
  .option('--dry-run')
  .action(
    action(async (options: { dryRun?: boolean }) => {
      for (const record of await listSessions()) {
        if (record.worktreeRemoved) continue
        if (record.laneOverride !== 'done') {
          console.log(`${record.id} skipped: not done`)
          continue
        }
        const count = await uncommittedCount(record.worktreePath)
        if (count !== 0) {
          console.log(`${record.id} refused: dirty worktree (${count} entries)`)
          continue
        }
        if (options.dryRun) {
          console.log(`${record.id} would remove ${record.worktreePath}`)
          continue
        }
        const project = await findProject(record.projectId)
        if (!project) throw new CliError(`Project ${record.projectId} not found`, 4)
        await removeWorktree(project.path, record.worktreePath)
        await saveSession({ ...record, pid: undefined, worktreeRemoved: true })
        console.log(`${record.id} removed`)
      }
    }),
  )

program
  .command('send')
  .description('Queue a follow-up message for a session')
  .argument('<id>')
  .option('--message <text>')
  .option('--message-file <path>')
  .action(
    action(async (id: string, options: { message?: string; messageFile?: string }) => {
      const message = await readChoice(options.message, options.messageFile, '--message or --message-file')
      const pending = await sendMessage(id, message)
      console.log(`queued for ${id} (${pending} pending)`)
    }),
  )

program
  .command('_run')
  .description('Internal session runner')
  .argument('<id>')
  .action(action(async (id: string) => runSessionRunner(id)))

await program.parseAsync(process.argv)
