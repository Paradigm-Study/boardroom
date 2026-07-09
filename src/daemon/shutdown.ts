import type { Server } from 'node:http'

interface Closable {
  close(): void
}

const DEFAULT_DRAIN_GRACE_MS = 300

// Resolve the flush grace: explicit opt wins, else BOARDROOM_DRAIN_GRACE_MS, else
// the default. A negative/non-numeric env value falls back; an explicit 0 opt is
// honored (synchronous force-close), so `?? ` on the opt — not `||` — is required.
function drainGraceMs(opt: number | undefined): number {
  if (opt !== undefined) return opt
  const env = Number(process.env.BOARDROOM_DRAIN_GRACE_MS)
  return Number.isFinite(env) && env >= 0 ? env : DEFAULT_DRAIN_GRACE_MS
}

export interface ShutdownOpts {
  server: Server
  store: Closable
  // The session capturer arms an fs.watch + setInterval that write to the store.
  // Stop it FIRST on shutdown so a watcher/interval tick can't drive a write into an
  // already-closed DB during the drain window. Optional: a daemon without capture omits it.
  capturer?: { stop(): void }
  // Runs after the capturer stops and BEFORE open sockets are destroyed. Used to
  // orphan still-pending gates as 'boot' (store.orphanAllPending) so the socket-close
  // handlers that closeAllConnections() fires find them already non-pending and
  // no-op — otherwise queue.disconnect would tag them 'disconnect', which the
  // reconnecting surfaces (tray, dashboard Needs-you) deliberately exclude, and the
  // gate would silently vanish from the actionable view across the redeploy.
  quiesce?: () => void
  // Injected so the real process is never touched in unit tests. Defaults wire to
  // the live process in production (index.ts).
  proc?: NodeJS.EventEmitter
  exit?: (code?: number) => never
  log?: (...args: unknown[]) => void
  // Watchdog: if server.close() never calls back (a wedged socket), force the exit
  // anyway so launchd KeepAlive can respawn from a known state instead of leaving a
  // half-dead daemon bound to the port.
  forceExitMs?: number
  // Flush window between quiesce (which resolves live gates with a PARKED sentinel)
  // and the hard closeAllConnections that destroys their sockets. Resolving a gate
  // schedules an async MCP tool-result write; without a brief grace the socket dies
  // before it lands and the agent gets a raw drop instead of the STOP. Idle
  // keep-alives are closed immediately regardless. 0 = force-close synchronously
  // (no live gates to flush, or tests). Defaults to BOARDROOM_DRAIN_GRACE_MS or 300ms.
  drainGraceMs?: number
}

// Bind the daemon's lifecycle to clean process signals. The daemon has no hot
// reload, so every redeploy is `launchctl kickstart`, which SIGTERMs us and lets
// KeepAlive respawn. Without a handler that exit is abrupt: in-flight sockets are
// killed mid-frame and the respawn races the old process's port hold. Here we
// stop accepting, drain the HTTP server, close the store cleanly, then exit — so
// the restart is deterministic and the respawn's orphanAllPending('boot') runs
// against a quiescent DB.
//
// This does NOT preserve an in-flight hanging tool call — a process death cannot
// (the in-memory waiter dies with us). Recovery of the human's REAL decision is
// the agent's job: it re-issues the identical call and findReattachable revives
// the orphaned card. We NEVER fabricate or infer a verdict here.
export function installSignalHandlers(opts: ShutdownOpts): void {
  const proc = opts.proc ?? process
  const exit = opts.exit ?? (((code?: number) => process.exit(code)) as (code?: number) => never)
  const log = opts.log ?? console.error
  let shuttingDown = false

  const shutdown = (code: number, why: string): void => {
    if (shuttingDown) return // idempotent: a second signal mid-drain is a no-op
    shuttingDown = true
    log(`[shutdown] ${why} — draining and exiting (${code})`)

    // Quiesce the DB writers BEFORE closing the store: the capturer's fs.watch /
    // interval would otherwise tick mid-drain and write into an already-closed DB.
    try { opts.capturer?.stop() } catch (err) { log('[shutdown] capturer stop failed:', err) }

    // Orphan in-flight gates as 'boot' while the store is still open and BEFORE
    // closeAllConnections() destroys their sockets — see ShutdownOpts.quiesce.
    try { opts.quiesce?.() } catch (err) { log('[shutdown] quiesce failed:', err) }

    let exited = false
    const finish = (): void => {
      if (exited) return
      exited = true
      // try/finally so a future cleanup throw can never skip the exit — a daemon
      // that fails to exit on SIGTERM would block the redeploy it was asked to make.
      try { opts.store.close() } catch (err) { log('[shutdown] store close failed:', err) } finally { exit(code) }
    }

    // Force-exit watchdog so a wedged connection can't pin the daemon forever.
    const ms = opts.forceExitMs ?? 5_000
    const timer = setTimeout(() => {
      log('[shutdown] server did not close in time — forcing exit')
      finish()
    }, ms)
    timer.unref?.()

    let graceTimer: ReturnType<typeof setTimeout> | undefined
    opts.server.close((err?: Error) => {
      if (err) log('[shutdown] server close error:', err)
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      finish()
    })
    // A hanging gate call's SSE connection never ends on its own, so a bare
    // server.close() would wait out the full watchdog on every redeploy-during-a-gate
    // (the common case) and risk the respawn racing the still-held port. Idle
    // keep-alive sockets can be dropped at once; the ACTIVE gate sockets get a brief
    // flush window first so the PARKED sentinel that quiesce just resolved reaches
    // the agent before the socket is destroyed (clean sever, not a raw drop). After
    // the grace we force-end whatever remains so close() completes in ms. The agent
    // recovers the human's REAL decision by re-issuing regardless; nothing is
    // fabricated here, and the outer watchdog still bounds a wedged drain.
    opts.server.closeIdleConnections?.()
    // Clamp the grace strictly under the watchdog: a grace >= forceExitMs would let
    // the watchdog fire first and skip closeAllConnections entirely, silently
    // degrading the clean sever back to a raw drop. Keep a margin so the forced
    // close still lands before the exit.
    const graceMs = Math.min(drainGraceMs(opts.drainGraceMs), Math.max(0, ms - 500))
    if (graceMs <= 0) {
      opts.server.closeAllConnections?.()
    } else {
      graceTimer = setTimeout(() => opts.server.closeAllConnections?.(), graceMs)
      graceTimer.unref?.()
    }
  }

  proc.on('SIGTERM', () => shutdown(0, 'SIGTERM'))
  proc.on('SIGINT', () => shutdown(0, 'SIGINT'))

  // A thrown error that escapes every handler would otherwise crash Node with no
  // cleanup. Log it and shut down gracefully with a non-zero code so KeepAlive
  // respawns from a clean state rather than from a half-torn-down process.
  proc.on('uncaughtException', (err: unknown) => {
    log('[uncaughtException]', err)
    shutdown(1, 'uncaughtException')
  })

  // A stray rejection must NOT take down a daemon that may be holding a human's
  // in-flight decision. Log it loudly (so it stays diagnosable) but keep serving.
  proc.on('unhandledRejection', (reason: unknown) => {
    log('[unhandledRejection]', reason)
  })
}
