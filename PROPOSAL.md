# eoctl — approved design proposal

Status: design approved, no code written.

## Goal

A standalone, daemonless, terminal-first orchestrator that reimplements the workflow of [orchestrator.inc](https://orchestrator.inc/):

`add project → spawn parallel workers in git worktrees → board shows derived status → send follow-ups → cleanup`

Independent project, MIT, "not affiliated with orchestrator.inc" in the README. No Electron app, no Go daemon, no local HTTP server, no account. TypeScript + Node.

The official `ao` CLI is the CLI of the product being reimplemented; `eoctl` is not a controller for it and shares no code, daemon, or API.

Explicit non-goals for slice 1: PR creation, CI/review feedback routing, planning agent that splits an outcome into workers, `needs-you` detection, watch mode, browser preview, mobile, cloud, automations, multi-repo workspaces, `project rm`, hard delete.

## Research findings

Sources: [site](https://orchestrator.inc/), [docs](https://docs.orchestrator.inc/), [CLI reference](https://docs.orchestrator.inc/cli/), [architecture](https://docs.orchestrator.inc/architecture/), [OpenCode CLI](https://opencode.ai/docs/cli), [OpenCode API](https://opencode.ai/docs/api), [Pi CLI](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/cli.md), [Pi JSON events](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/json.md), local `--help` output and public source of both harnesses.

1. The shipped `ao` CLI is a thin HTTP client for the Electron app's Go daemon (`127.0.0.1:3001`, state in `~/.ao`). Reusing it does not meet "standalone CLI".
2. The load-bearing idea is conceptual, not code: **never store display status; derive it from durable facts** (agent activity + git state).
3. Isolation is a git worktree + branch per session. Cleanup must never force-remove a dirty worktree.
4. Local versions: Node v22.22.3, `opencode` v2.3.0, `pi` v1.5.2 (`@earendil-works/pi-coding-agent`), git 2.56.1.
5. `opencode run --format json` emits JSONL events (`text`, `tool_use`, `step_finish`, `error`, …) on stdout, diagnostics on stderr. There is no `done` event — completion is process exit. The event vocabulary is not a published schema.
6. `opencode run --session <id>` resumes across separate invocations, including with `--standalone`; location comes from OpenCode's DB, not cwd. `--worktree` does not allow a deterministic directory, so worktrees are created with `git worktree add` directly. Use the shared service; do not pass `--standalone` or `--auto`.
7. OpenCode one-shot runs never wait: permission asks are auto-rejected to stderr, questions are cancelled. Nothing structured reaches JSONL.
8. `pi --mode json` is one-shot and emits documented JSONL events (`tool_execution_*`, `agent_settled`, `message_end`, `auto_retry_*`). No `needs-input` event exists; questions appear only as assistant text. No native per-tool approval prompts; extension gates auto-deny in print mode.
9. Pi sessions must be pinned with absolute `--session-dir` plus `--session-id`; `--session-id` alone does not choose storage. No steering in print/JSON mode.
10. Conclusion: slice 1 has no `needs-you` lane and no steering. Permission denials are fail-safe and visible only in logs.

## CLI surface

```
eoctl doctor
eoctl project add <path> [--name <name>]
eoctl project ls
eoctl spawn --name <name> --harness opencode|pi \
            --prompt <text>|--prompt-file <path> \
            [--project <id>] [--branch <branch>] [--model <model>]
eoctl board [--json]
eoctl session ls|get <id>|log <id> [--raw] [--follow]|
            done <id>|kill <id>|restore <id>|cleanup [--dry-run]
eoctl send <id> --message <text>|--message-file <path>
eoctl version
```

- Exactly one of `--prompt` / `--prompt-file` is required by `spawn`; exactly one of `--message` / `--message-file` by `send`. No positional prompts, no stdin reads.
- Human output is lane-grouped. `--json` emits `{ schemaVersion: 1, ... }`.
- Exit codes: `0` ok, `1` usage, `2` prerequisite missing, `3` busy/cap reached, `4` not found.
- `doctor` checks Node version, git, `opencode`/`pi` on PATH, and state directory writability. No provider-auth checks.

## Architecture

```
CLI command ──writes──> state files (~/.orchestrator-cli)
                            ├── config.json
                            ├── projects.json
                            ├── sessions/<id>.json      (durable facts only)
                            ├── events/<id>.jsonl       (normalized event append log)
                            ├── inbox/<id>.jsonl        (queued follow-ups)
                            ├── harness/pi/<id>/        (Pi session storage)
                            └── worktrees/<project>/<slug>/
                                  │
session runner (1 detached Node process per session)
  cwd = worktree
  loop: poll inbox every 1s → run harness one-shot with session ID → normalize events
        → append events → update session facts → wait for next inbox item
                                  │
                    opencode run / pi --mode json ──> worktree files
```

- **No central daemon.** One detached runner per active session. It exists so `send` can queue a follow-up that lands after the current turn. It does no scheduling beyond its own session.
- State is JSON with atomic replace + a per-session lock file. Runner appends only to its own event log; `done`, `kill`, `restore`, and `cleanup` take the same lock.
- Status is computed at read time from runner PID liveness, active-run flag, last normalized event, inbox depth, and git state. Nothing writes a `status` field.
- Config: `~/.orchestrator-cli/config.json` with `maxWorkers: 4`, `defaultHarness`, plus `ORCH_*` env overrides. Cap is global, not per project. No project-local config.
- Identifiers: project ID is a slug derived from the absolute repo path. Session CLI reference is `s_<8 chars>`; branch/worktree slug is `<name>-<suffix>`. Duplicate names are allowed; ID disambiguates. Branch is `orch/<slug>` from current `HEAD`; an existing branch is an error unless `--branch` is given.
- Prompts are passed as argv, never interpolated into a shell string. The runner appends this footer to every prompt and follow-up: "Commit your changes with a descriptive message when done; do not push." Logs are capped at 1 MB per session, redact token patterns, and never dump env.

## Harness adapters

```ts
interface HarnessAdapter {
  name: 'opencode' | 'pi' | 'codex'
  check(): Promise<{ ready: boolean; reason?: string }>
  run(ctx: {
    cwd: string
    sessionId: string
    prompt: string
    model?: string
  }): AsyncIterable<NormalizedEvent> & { exit: Promise<number>; cancel(): void }
}
```

`NormalizedEvent` = `{ at, kind: 'activity' | 'error', detail }`. Unknown harness event types are counted but not interpreted. Completion is signalled by process exit, not by an event.

- OpenCode: `opencode run --session <id> --format json <prompt>` in the worktree. Shared service, no `--standalone`, no `--auto`, no `--worktree`. Permission denials are captured from stderr into `session log --raw`.
- Pi: `pi --mode json --session-dir ~/.orchestrator-cli/harness/pi/<id> --session-id <id> <prompt>` in the worktree.
- `codex` and a generic command-template adapter are later slices.

Board lanes: `working | idle | done | error`. Annotations: harness, branch, uncommitted file count, last activity, age. No file list in `board`.

## Lifecycle

- Harness exit `0` → `idle`. Non-zero exit → `error`, runner stops, no automatic retry.
- `send` queues while busy and is delivered when the turn ends. No `--steer`.
- `done` stops the runner and marks the lane `done`. `kill` stops the runner and leaves `error`. Both preserve the worktree.
- `restore <id>` relaunches the runner for a non-`done` session with the stored harness session ID and worktree. No auto-relaunch after crash or reboot.
- `cleanup` removes worktrees only for `done` sessions whose worktree is clean; dirty worktrees are refused with a reason. Branches are kept. Session metadata, event log, and inbox are kept with `worktreeRemoved: true`. Undelivered inbox messages are preserved and counted in `session get`.
- `session log <id>` shows the normalized timeline by default; `--raw` adds redacted harness stdout/stderr; `--follow` tails.

## Slice 1 acceptance criteria

1. `eoctl project add .` registers this repo; `eoctl project ls` shows it with its derived ID.
2. One `opencode` worker and one `pi` worker spawn concurrently, each in its own worktree + branch, each with a detached runner.
3. `eoctl board` shows both in the correct lane with harness, branch, uncommitted count, last activity, and age. `eoctl board --json` validates against `schemaVersion: 1`.
4. `eoctl send <id> --message "..."` queues while busy and is delivered when the turn ends.
5. `eoctl session done|kill|restore` behave as specified; `eoctl session cleanup --dry-run` refuses dirty worktrees with a reason.
6. Tests: fake harness binaries + temp dirs cover project add, spawn, lane derivation, queue/delivery, dirty-cleanup refusal, exit codes. One real smoke run per harness in a throwaway repo must emit parseable JSONL and leave at least one commit in the worktree.
7. No HTTP listener, no Electron, no daemon binary.

## Later slices (outcomes, not implementation tickets)

- PR + CI + review feedback routed back to the owning session (needs `gh` observation).
- `--watch` / interactive TUI board.
- `codex` adapter, then a generic command-template adapter.
- Reliable `needs-you` detection via OpenCode event stream / Pi RPC.
- `project rm`, hard delete, automations, cues, previews, multi-repo workspaces.

## Trade-offs surfaced

- Daemonless buys simplicity but costs one process per session and file-based coordination. A real daemon would make queueing and live events cleaner but recreates the thing being avoided.
- JSON state suits one user and a handful of sessions; it is not a good fit for 50 workers. SQLite is the upgrade path.
- One-shot harness invocations mean session continuity depends on each harness persisting sessions correctly.
- Auto-rejected permissions are fail-safe but can silently cost a worker a tool call; this is documented rather than hidden.

## Open questions

None. All decisions are locked.
