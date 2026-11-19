import { runHarness } from './adapters.js'
import { appendEvent, claimNextMessage, getSession, updateSession } from './state.js'
import { sleep } from './util.js'

export const PROMPT_FOOTER = 'Commit your changes with a descriptive message when done; do not push.'

export async function runSessionRunner(id: string): Promise<void> {
  const initial = await getSession(id)
  if (initial.laneOverride === 'done') return

  let pendingPrompt = initial.pendingPrompt
  if (pendingPrompt !== undefined) await updateSession(id, (session) => ({ ...session, pendingPrompt: undefined }))
  await updateSession(id, (session) => ({ ...session, pid: process.pid, activeRun: false }))

  const controller = new AbortController()
  let ending = false
  const stop = () => {
    ending = true
    controller.abort()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)

  while (!ending) {
    const current = await getSession(id)
    if (current.laneOverride === 'done') break

    let prompt: string | undefined
    if (pendingPrompt !== undefined) {
      prompt = pendingPrompt
      pendingPrompt = undefined
    } else {
      const message = await claimNextMessage(id)
      if (message) prompt = message.text
    }
    if (prompt === undefined) {
      await sleep(1000)
      continue
    }

    await updateSession(id, (session) => ({ ...session, activeRun: true, pid: process.pid }))
    try {
      const code = await runHarness(
        {
          harness: current.harness,
          cwd: current.worktreePath,
          sessionId: id,
          harnessSessionId: current.harnessSessionId,
          prompt: `${prompt}\n\n${PROMPT_FOOTER}`,
          model: current.model,
        },
        controller.signal,
      )
      if (code !== 0) {
        await appendEvent(id, {
          at: new Date().toISOString(),
          kind: 'error',
          detail: `harness exited with code ${code}`,
        })
      }
    } catch (error) {
      await appendEvent(id, {
        at: new Date().toISOString(),
        kind: 'error',
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await updateSession(id, (session) => ({ ...session, activeRun: false, pid: process.pid }))
    }
  }
}
