import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApiRouter } from './api.js'
import { AuthConnector, type ConnectSpawnFn } from './authConnect.js'
import { AuthStore } from './authStore.js'
import { Queue } from './queue.js'
import { Store } from './store.js'

let dir: string
let store: Store
let queue: Queue
let authStore: AuthStore
let connector: AuthConnector
let app: express.Express
let hooks: Parameters<ConnectSpawnFn>[2] | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-apiauth-'))
  store = new Store(join(dir, 'test.sqlite'))
  queue = new Queue(store)
  authStore = new AuthStore(dir)
  // Real connector, fake child: the test drives login output/exit deterministically.
  connector = new AuthConnector(authStore, { spawn: (_b, _a, h) => { hooks = h; return { kill: () => {}, write: () => {} } } })
  app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use(buildApiRouter(queue, store, { attachmentDir: join(dir, 'attachments'), configDir: dir, authStore, authConnector: connector }))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/auth/status', () => {
  it('reports not-connected initially, and never leaks a secret', async () => {
    const res = await request(app).get('/api/auth/status')
    expect(res.status).toBe(200)
    expect(res.body.connected).toBe(false)
    expect(res.body.login).toEqual({ state: 'idle' })
  })

  it('reflects a connected credential (kind + age, not the value)', async () => {
    authStore.set({ type: 'oauth', value: 'sk-ant-oat01-secret' })
    const res = await request(app).get('/api/auth/status')
    expect(res.body.connected).toBe(true)
    expect(res.body.type).toBe('oauth')
    expect(JSON.stringify(res.body)).not.toContain('secret')
  })
})

describe('POST /api/auth/token (paste path)', () => {
  it('stores a pasted oauth token', async () => {
    const res = await request(app).post('/api/auth/token').send({ type: 'oauth', value: 'sk-ant-oat01-pasted' })
    expect(res.status).toBe(200)
    expect(res.body.connected).toBe(true)
    expect(authStore.get()?.value).toBe('sk-ant-oat01-pasted')
  })

  it('rejects an empty value or unknown type', async () => {
    expect((await request(app).post('/api/auth/token').send({ type: 'oauth', value: '  ' })).status).toBe(400)
    expect((await request(app).post('/api/auth/token').send({ type: 'nope', value: 'x' })).status).toBe(400)
  })
})

describe('POST /api/auth/connect (browser path)', () => {
  it('starts a login, surfaces the URL, then reports connected once the token is captured', async () => {
    const start = await request(app).post('/api/auth/connect')
    expect(start.status).toBe(200)
    expect(start.body.login.state).toBe('running')

    hooks?.onData('Open https://claude.ai/oauth to log in\n')
    const mid = await request(app).get('/api/auth/status')
    expect(mid.body.login).toMatchObject({ state: 'running', url: 'https://claude.ai/oauth' })

    hooks?.onData('sk-ant-oat01-captured\n')
    hooks?.onExit(0)
    const done = await request(app).get('/api/auth/status')
    expect(done.body.connected).toBe(true)
    expect(done.body.login.state).toBe('connected')
    expect(authStore.get()?.value).toBe('sk-ant-oat01-captured')
  })

  it('reports failed when the login exits without a token', async () => {
    await request(app).post('/api/auth/connect')
    hooks?.onExit(1)
    const res = await request(app).get('/api/auth/status')
    expect(res.body.login.state).toBe('failed')
    expect(res.body.connected).toBe(false)
  })

  it('surfaces awaitingCode and relays a pasted code, then reports connected', async () => {
    await request(app).post('/api/auth/connect')
    hooks?.onData('Paste code here if prompted >')
    const mid = await request(app).get('/api/auth/status')
    expect(mid.body.login.awaitingCode).toBe(true)

    const relay = await request(app).post('/api/auth/connect/input').send({ code: 'the-oauth-code' })
    expect(relay.status).toBe(200)
    hooks?.onData('sk-ant-oat01-after-code\n')
    hooks?.onExit(0)
    const done = await request(app).get('/api/auth/status')
    expect(done.body.connected).toBe(true)
    expect(authStore.get()?.value).toBe('sk-ant-oat01-after-code')
  })

  it('rejects an empty code', async () => {
    await request(app).post('/api/auth/connect')
    expect((await request(app).post('/api/auth/connect/input').send({ code: '  ' })).status).toBe(400)
  })
})

describe('POST /api/auth/disconnect', () => {
  it('clears the stored credential', async () => {
    authStore.set({ type: 'oauth', value: 'x' })
    const res = await request(app).post('/api/auth/disconnect')
    expect(res.status).toBe(200)
    expect(res.body.connected).toBe(false)
    expect(authStore.get()).toBeUndefined()
  })
})

describe('auth routes when the daemon has no auth store (legacy/test callers)', () => {
  it('404s rather than crashing', async () => {
    const bare = express()
    bare.use(express.json())
    bare.use(buildApiRouter(queue, store, { attachmentDir: join(dir, 'attachments'), configDir: dir }))
    expect((await request(bare).get('/api/auth/status')).status).toBe(404)
  })
})
