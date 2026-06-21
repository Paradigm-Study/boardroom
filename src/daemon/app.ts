import express, { type Express } from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApiRouter } from './api.js'
import type { Config } from './config.js'
import { loadMachineIdentity } from './machine.js'
import { buildMcpRouter } from './mcp.js'
import { Queue } from './queue.js'
import { SessionCapturer } from './sessionCapturer.js'
import { Store } from './store.js'
import { Waker } from './waker.js'

export interface Daemon {
  app: Express
  queue: Queue
  store: Store
  capturer: SessionCapturer
  orphanedOnBoot: number
}

export function createDaemon(config: Config): Daemon {
  const store = new Store(config.dbPath)
  const orphanedOnBoot = store.orphanAllPending()
  const queue = new Queue(store)

  const machine = loadMachineIdentity(config.configDir)
  const capturer = new SessionCapturer(store, machine.machineId)
  capturer.start()

  // Phase 2 auto-wake: when a parked/orphaned card is decided, resume the
  // agent's Claude Code session (claude --resume) so the work continues. No-ops
  // unless the SessionStart hook has registered that project's session.
  const waker = new Waker(store)
  queue.on('card', card => waker.onCard(card))

  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use(buildMcpRouter(queue))
  app.use(buildApiRouter(queue, store, {
    attachmentDir: join(config.configDir, 'attachments'),
    configDir: config.configDir,
  }))

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  if (existsSync(webDist)) app.use(express.static(webDist))

  return { app, queue, store, capturer, orphanedOnBoot }
}
