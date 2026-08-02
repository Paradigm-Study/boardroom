import express, { type Express } from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApiRouter } from './api.js'
import type { Config } from './config.js'
import { loadMachineIdentity } from './machine.js'
import { buildMcpRouter } from './mcp.js'
import { Queue } from './queue.js'
import { dashboardCookie, hostGuard, originGuard, requireToken } from './security.js'
import { SessionCapturer } from '../harness/claude-code/sessionCapturer.js'
import { Store } from './store.js'
import { Waker } from '../harness/claude-code/waker.js'

export interface Daemon {
  app: Express
  queue: Queue
  store: Store
  capturer: SessionCapturer
  orphanedOnBoot: number
  // The loopback token gating /api and /events (undefined only when a caller built
  // a Config without one — production always has it). Exposed for tests/tooling.
  token?: string
}

export function createDaemon(config: Config): Daemon {
  const store = new Store(config.dbPath)
  const orphanedOnBoot = store.orphanAllPending()
  const queue = new Queue(store, config.reattachWindowMs)

  const machine = loadMachineIdentity(config.configDir)
  const capturer = new SessionCapturer(store, machine.machineId)

  // Phase 2 auto-wake: when a parked/orphaned card is decided, resume the
  // agent's Claude Code session (claude --resume) so the work continues. No-ops
  // unless the SessionStart hook has registered that project's session.
  // Resume-failure popups honor the same notifications opt-out as every other
  // OS notification (console.warn diagnostics inside the waker stay regardless).
  const waker = new Waker(store, config.notifications ? {} : { onResumeFailure: () => {} })
  queue.on('card', card => waker.onCard(card))

  const app = express()
  const token = config.authToken

  // Anti-DNS-rebinding: refuse any request whose Host is not loopback, on EVERY
  // route (a rebound page cannot forge the Host header). This is the control that
  // makes the 127.0.0.1 bind actually mean "this machine only".
  app.use(hostGuard())
  app.use(express.json({ limit: '4mb' }))
  // Serve the dashboard with the token as a locked-down same-origin cookie so the
  // browser SPA + Electron window authenticate transparently (no web/src changes).
  if (token) app.use(dashboardCookie(token))

  // /mcp is token-free (zero-setup `claude mcp add`) but Origin-guarded: a real MCP
  // client sends no Origin, while a cross-origin browser POST is refused. It cannot
  // decide cards or drive the waker regardless.
  app.use('/mcp', originGuard())
  app.use(buildMcpRouter(queue))

  // /api + /events carry all card content and the decide/session-registry writes
  // that feed the waker, so they require the loopback token; /api also keeps the
  // Origin guard as defense-in-depth (the same-origin SPA sends a loopback Origin).
  if (token) {
    app.use('/api', originGuard())
    app.use(['/api', '/events'], requireToken(token))
  }
  app.use(buildApiRouter(queue, store, {
    attachmentDir: join(config.configDir, 'attachments'),
    configDir: config.configDir,
    reattachWindowMs: config.reattachWindowMs,
  }))

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  if (existsSync(webDist)) app.use(express.static(webDist))

  // Start capture LAST: it arms fs.watch + a setInterval. Only turn those on once
  // all setup above has succeeded, so a throw mid-setup can't leak a watcher/timer
  // with no returned Daemon handle to stop() them.
  capturer.start()
  return { app, queue, store, capturer, orphanedOnBoot, token }
}
