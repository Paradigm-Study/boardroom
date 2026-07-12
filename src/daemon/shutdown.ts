import type { Server } from 'node:http'

interface Closable {
  close(): void
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
  // Mesh forwarder (optional, mesh-v0): stop() detaches its queue listeners early
  // in the drain (like the capturer) so no new lifecycle records enqueue
  // mid-shutdown, and flush() is awaited after the server drains so an in-flight
  // relay POST / spool write completes before the process exits. A wedged flush
  // cannot pin the daemon — the force-exit watchdog still fires.
  meshForwarder?: { stop(): void; flush(): Promise<void> }
  // Injected so the real process is never touched in unit tests. Defaults wire to
  // the live process in production (index.ts).
  proc?: NodeJS.EventEmitter
  exit?: (code?: number) => never
  log?: (...args: unknown[]) => void
  // Watchdog: if server.close() never calls back (a wedged socket), force the exit
  // anyway so launchd KeepAlive can respawn from a known state instead of leaving a
  // half-dead daemon bound to the port.
  forceExitMs?: number
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

    // Detach the mesh forwarder's queue listeners now so nothing new enqueues a
    // relay POST while we drain; already-enqueued records are flushed below.
    try { opts.meshForwarder?.stop() } catch (err) { log('[shutdown] mesh forwarder stop failed:', err) }

    // Orphan in-flight gates as 'boot' while the store is still open and BEFORE
    // closeAllConnections() destroys their sockets — see ShutdownOpts.quiesce.
    try { opts.quiesce?.() } catch (err) { log('[shutdown] quiesce failed:', err) }

    let exited = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (exited) return
      exited = true
      if (timer !== undefined) clearTimeout(timer)
      // try/finally so a future cleanup throw can never skip the exit — a daemon
      // that fails to exit on SIGTERM would block the redeploy it was asked to make.
      try { opts.store.close() } catch (err) { log('[shutdown] store close failed:', err) } finally { exit(code) }
    }

    // Force-exit watchdog so a wedged connection (or a wedged mesh flush) can't
    // pin the daemon forever.
    const ms = opts.forceExitMs ?? 5_000
    timer = setTimeout(() => {
      log('[shutdown] server did not close in time — forcing exit')
      finish()
    }, ms)
    timer.unref?.()

    opts.server.close((err?: Error) => {
      if (err) log('[shutdown] server close error:', err)
      // Let an in-flight mesh relay POST / spool write settle before exiting.
      // flush() never rejects by construction; the rejection arm only guards a
      // future regression from stranding the drain. The watchdog above stays
      // armed (cleared in finish, not here) so a wedged flush is still bounded.
      const flushed = opts.meshForwarder ? opts.meshForwarder.flush() : Promise.resolve()
      flushed.then(finish, finish)
    })
    // A hanging gate call's SSE connection never ends on its own, so a bare
    // server.close() would wait out the full watchdog on every redeploy-during-a-gate
    // (the common case) and risk the respawn racing the still-held port. Forcibly end
    // open sockets so close() completes in ms. This drops the agent's connection — it
    // recovers the human's REAL decision by re-issuing; nothing is fabricated here.
    opts.server.closeAllConnections?.()
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
