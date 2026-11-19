# eoctl

A standalone, daemonless, terminal-first orchestrator for parallel coding agents.
It reimplements the workflow of [orchestrator.inc](https://orchestrator.inc/):
register a repo, spawn workers in git worktrees, read a derived board, queue
follow-ups, and clean up safely.

Independent project. MIT licensed. **Not affiliated with or endorsed by
orchestrator.inc.** The official `ao` CLI is not used, required, or reimplemented
as a controller; `eoctl` shares no code, daemon, or API with it.

## Status

Slice 1 (CLI + worktree workers), slice 2 (`board --watch` + key actions),
slice 3a (read-only PR/CI observation), and slice 3b (review feedback routing)
are implemented. See [PROPOSAL.md](PROPOSAL.md) for the approved design and
slice-1 acceptance criteria.

## Requirements

- Node >= 22
- git
- `opencode` and/or `pi` on `PATH` (only the harnesses you use)

## Install / run

```bash
npm install
npm run build
node dist/cli.js --help
```

## Quick start

```bash
node dist/cli.js doctor
node dist/cli.js project add .
node dist/cli.js spawn --name fix-tests --harness opencode --prompt "Fix the failing tests"
node dist/cli.js spawn --name docs --harness pi --prompt-file ./prompt.md
node dist/cli.js board
node dist/cli.js board --watch            # in-place refresh + keyboard actions
node dist/cli.js send s_ab12cd34 --message "Also update the changelog"
node dist/cli.js session log s_ab12cd34 --follow
node dist/cli.js session done s_ab12cd34
node dist/cli.js session cleanup --dry-run
node dist/cli.js session cleanup
```

## Commands

```
eoctl doctor
eoctl project add <path> [--name <name>]
eoctl project ls
eoctl spawn --name <name> --harness opencode|pi \
            --prompt <text>|--prompt-file <path> \
            [--project <id>] [--branch <branch>] [--model <model>]
eoctl board [--json] [--watch] [--interval <seconds>]
eoctl pr refresh [id...]       # snapshot PR/CI state via gh (read-only)
eoctl pr route [id...]         # queue new review feedback into session inboxes
eoctl session ls | get <id> [--json] | log <id> [--raw] [--follow] |
            done <id> | kill <id> | restore <id> | cleanup [--dry-run]
eoctl send <id> --message <text>|--message-file <path>
eoctl version
```

`spawn` requires exactly one of `--prompt` / `--prompt-file`; `send` requires
exactly one of `--message` / `--message-file`. Prompts are passed as argv, never
through a shell. Follow-ups are queued, not steered into a running turn.

## How it works

- State lives in `~/.orchestrator-cli` (override with `ORCH_HOME`): projects,
  one session record per worker, an appended normalized-event log, an inbox,
  raw harness logs, and per-session Pi storage.
- Display status is never stored. The board derives lanes from runner PID
  liveness, the active-run flag, last event, inbox depth, and git state.
- One detached Node runner per active session polls its inbox and runs the
  harness one-shot with a stable session ID. There is no central daemon,
  listener, HTTP server, account, or Electron app.
- Each worker gets its own git worktree and `orch/<slug>` branch from the
  current `HEAD`. The runner appends this to every prompt:
  "Commit your changes with a descriptive message when done; do not push."
- `cleanup` removes worktrees only for `done` sessions with a clean worktree.
  Dirty worktrees are refused with a reason. Branches, metadata, logs, and
  inbox are kept; `project rm` and hard delete do not exist.
- `pr refresh` runs `gh pr view <branch>` from each project root (falling back
  to `gh pr list --head`) and stores a snapshot in `~/.orchestrator-cli/pr/`.
  The board and `session get` read that snapshot; only `pr refresh` calls gh.
- `pr route` queues unseen review/comment bodies from the last snapshot into
  the owning session's inbox. Delivered note keys are kept in
  `~/.orchestrator-cli/pr/<id>.routed.json` so reruns do not duplicate feedback.
- Logs are capped at 1 MB per session and redact common token patterns.

Config: `~/.orchestrator-cli/config.json` with `maxWorkers` (default 4, global
cap) and `defaultHarness`, plus `ORCH_MAX_WORKERS` and `ORCH_DEFAULT_HARNESS`
environment overrides.

Exit codes: `0` ok, `1` usage, `2` prerequisite missing, `3` busy/cap reached,
`4` not found.

## Slice 1 limits / non-goals

These are deliberate and will not work in slice 1:

- No PR creation. PR/CI state is observed read-only with `pr refresh`; review
  feedback is queued with `pr route`, never applied directly to a worktree.
- No planning agent that splits an outcome into workers.
- No `needs-you` detection. Harness questions and permission denials are
  fail-safe (auto-denied/cancelled) and visible only in `session log --raw`.
- No steering of an in-flight turn, no automatic retry, and no auto-relaunch
  after a crash or reboot. Use `session restore` manually.
- No full-screen interactive TUI (multi-pane log/inbox, mouse, themes);
  `board --watch` is the slice-2 in-place view only.
- No `codex` adapter or generic command-template adapter.
- No browser preview, mobile, cloud, automations, cues, or multi-repo
  workspaces.
- No `project rm` and no hard delete.
- JSON state suits one user with a handful of workers, not dozens. SQLite is
  the intended upgrade path.
- `done` is human-declared; a harness exiting normally does not mark a session
  done. `kill` leaves the session in `error`.

## Watch mode

`eoctl board --watch` redraws the board in place (default every 1s, override
with `--interval`). It requires a TTY; without one it exits 2 with a message.
Keys: `j`/`k` or arrows to select, `m` to type a follow-up (Enter sends, Esc
cancels), `d` done, `x` kill, `r` restore, `q`/Ctrl-C quit. Actions use the same
state functions as the CLI commands. Raw mode and the cursor are restored on
every exit path. Selection is tracked by session id so it survives lane changes.

OpenCode runs against the shared service (no `--standalone`, no `--auto`);
Pi sessions are pinned with an absolute `--session-dir` plus `--session-id`.

## PR/CI observation

`eoctl pr refresh [id...]` snapshots GitHub PR state for active sessions using
`gh`. It never creates or edits PRs. With no ids it refreshes all non-done
sessions with a live worktree. It tries `gh pr view <branch>` from the project
root and falls back to `gh pr list --head <branch> --state all` if positional
branch lookup is unsupported. No PR is a normal `none` snapshot; a gh failure
becomes an `error` snapshot with redacted stderr and does not block other
sessions. Missing `gh` exits 2.

Snapshots live in `~/.orchestrator-cli/pr/<id>.json` and include check counts,
review decision, and redacted review/comment bodies. `board`, `board --json`,
and `session get` show the last snapshot without calling gh, so PR data stays
stale until you refresh. `board --watch` does not auto-refresh.

`eoctl pr route [id...]` reads the last snapshot and queues one grouped message
per session containing every review or comment body not yet routed. Notes are
identified by GitHub id (falling back to a content hash), so reruns are
idempotent and later refreshes queue only genuinely new feedback. With no ids
it routes all active sessions that have a snapshot; empty bodies, done sessions,
and sessions without snapshots are skipped with a reason. Routing makes no gh
calls and does not change lanes. A crash between writing the inbox message and
the routed-key file can duplicate a message, never lose one.

## Development

```bash
npm test          # build + integration tests with fake harnesses
npm run smoke:real # real opencode + pi workers in a throwaway repo
```

`npm run smoke:real` requires real `git`, `opencode`, and `pi` on `PATH` (plus
any provider auth those harnesses need). It asserts one commit per worker,
parseable JSONL event lines, and an untouched source repo, then removes the
throwaway directory. Set `EOCTL_SMOKE_HARNESSES=opencode` (or `pi`) to smoke a
subset when a harness has no configured provider; `EOCTL_SMOKE_KEEP=1` keeps
the artifacts for inspection.

Slice 1 acceptance calls for one real smoke run per harness. The `opencode`
run passes here: it emitted parseable JSONL and left a commit in its own
worktree with the source repo untouched, verified by
`EOCTL_SMOKE_HARNESSES=opencode npm run smoke:real`. The `pi` run could not be
verified in this environment because the local Pi provider has no usable model
or API key; it needs provider auth before that half of the criterion can pass.
Reproduce both with `npm run smoke:real`. Slice 2 was verified with a real
PTY run: a follow-up typed in watch mode landed as a new worker commit, and the
cursor was restored on quit. Slice 3a was verified with six fake-`gh` integration
tests covering found/no-PR/failing/fallback observations, argv-only branch
passing, redaction, and zero gh calls from board or `session get`. Slice 3b was
verified with three fake-`gh` tests covering grouped delivery, idempotency,
new-note-only routing, hash fallback, and runner delivery of queued feedback.
