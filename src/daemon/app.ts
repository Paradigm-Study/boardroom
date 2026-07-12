import express, { type Express } from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApiRouter } from './api.js'
import type { Config } from './config.js'
import { loadMachineIdentity } from './machine.js'
import { buildMcpRouter } from './mcp.js'
import { notifyWakeFailed } from './notify.js'
import { Queue } from './queue.js'
import { SessionCapturer } from '../harness/claude-code/sessionCapturer.js'
import { Store } from './store.js'
import { Waker } from '../harness/claude-code/waker.js'
import { createMeshForwarder, type MeshForwarder } from './meshForward.js'
import { localBearerAuth } from './localAuth.js'

export interface Daemon {
  app: Express
  queue: Queue
  store: Store
  capturer: SessionCapturer
  orphanedOnBoot: number
  meshForwarder?: MeshForwarder
}

export function createDaemon(config: Config): Daemon {
  const store = new Store(config.dbPath)
  const orphanedOnBoot = store.orphanAllPending()
  const queue = new Queue(store, config.reattachWindowMs)
  // Construct the durable publisher before exposing the API so status and SSE
  // subscribers observe its boot reconciliation from a single shared instance.
  let meshForwarder: MeshForwarder | undefined
  try {
    meshForwarder = createMeshForwarder(queue, config, store)
  } catch (error) {
    console.warn('[mesh] durable publisher failed to initialize; Boardroom remains local-only:', error)
  }

  const machine = loadMachineIdentity(config.configDir)
  const capturer = new SessionCapturer(store, machine.machineId)

  // Phase 2 auto-wake: when a parked/orphaned card is decided, resume the
  // agent's Claude Code session (claude --resume) so the work continues. No-ops
  // unless the SessionStart hook has registered that project's session. A failed
  // wake leaves the decision claimable and tells the human via notification.
  const waker = new Waker(store, {
    onWakeFailed: config.notifications ? card => notifyWakeFailed(card, config.port) : undefined,
  })
  queue.on('card', card => waker.onCard(card))

  const app = express()
  app.use(localBearerAuth(config.localToken))
  app.use(express.json({ limit: '4mb' }))
  app.use(buildMcpRouter(queue))
  app.use(buildApiRouter(queue, store, {
    attachmentDir: join(config.configDir, 'attachments'),
    configDir: config.configDir,
    reattachWindowMs: config.reattachWindowMs,
    meshForwarder,
  }))

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  if (existsSync(webDist)) app.use(express.static(webDist))

  // Start capture LAST: it arms fs.watch + a setInterval. Only turn those on once
  // all setup above has succeeded, so a throw mid-setup can't leak a watcher/timer
  // with no returned Daemon handle to stop() them.
  capturer.start()
  return { app, queue, store, capturer, orphanedOnBoot, meshForwarder }
}
