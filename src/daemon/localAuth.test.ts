import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApiRouter } from './api.js'
import { localBearerAuth } from './localAuth.js'
import { Queue } from './queue.js'
import { Store } from './store.js'

describe('install-scoped local bearer', () => {
  let dir: string
  let store: Store
  let app: express.Express

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boardroom-local-auth-'))
    store = new Store(join(dir, 'boardroom.sqlite'))
    const queue = new Queue(store)
    app = express()
    app.use(localBearerAuth('install-secret'))
    app.use(express.json())
    app.use(buildApiRouter(queue, store, {
      attachmentDir: join(dir, 'attachments'),
      configDir: dir,
    }))
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('guards data, status, publish, admin-write, and SSE routes without reflecting the secret', async () => {
    for (const path of ['/api/cards', '/api/mesh/status', '/api/mesh/publishes', '/events']) {
      const response = await request(app).get(path)
      expect(response.status, path).toBe(401)
      expect(response.body).toEqual({ error: 'unauthorized' })
      expect(response.text).not.toContain('install-secret')
    }
    const admin = await request(app).put('/api/device').send({ deviceLabel: 'renamed' })
    expect(admin.status).toBe(401)
    expect((await request(app).get('/api/mesh/status').set('authorization', 'Bearer wrong')).status).toBe(401)
    expect((await request(app).get('/api/mesh/status').set('authorization', 'Bearer install-secret')).status).toBe(200)
  })

  it('keeps legacy development compatibility when the token is unset', async () => {
    const legacy = express()
    legacy.use(localBearerAuth(undefined))
    legacy.get('/ok', (_req, res) => res.json({ ok: true }))
    expect((await request(legacy).get('/ok')).status).toBe(200)
  })
})
