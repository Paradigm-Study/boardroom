import express, { type Express } from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApiRouter } from './api.js'
import type { Config } from './config.js'
import { buildMcpRouter } from './mcp.js'
import { Queue } from './queue.js'
import { Store } from './store.js'

export interface Daemon {
  app: Express
  queue: Queue
  store: Store
  orphanedOnBoot: number
}

export function createDaemon(config: Config): Daemon {
  const store = new Store(config.dbPath)
  const orphanedOnBoot = store.orphanAllPending()
  const queue = new Queue(store)

  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use(buildMcpRouter(queue))
  app.use(buildApiRouter(queue, store, { attachmentDir: join(config.configDir, 'attachments') }))

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  if (existsSync(webDist)) app.use(express.static(webDist))

  return { app, queue, store, orphanedOnBoot }
}
