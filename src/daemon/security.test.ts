import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDaemon, type Daemon } from './app.js'
import type { Config } from './config.js'
import {
  extractToken,
  hostnameOf,
  isAllowedOrigin,
  isLoopbackHost,
  parseCookie,
  TOKEN_COOKIE,
} from './security.js'

describe('security policy (pure)', () => {
  it('hostnameOf strips port and IPv6 brackets', () => {
    expect(hostnameOf('127.0.0.1:4040')).toBe('127.0.0.1')
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1')
    expect(hostnameOf('localhost:4040')).toBe('localhost')
    expect(hostnameOf('[::1]:4040')).toBe('::1')
    expect(hostnameOf('[::1]')).toBe('::1')
    expect(hostnameOf(undefined)).toBeUndefined()
    expect(hostnameOf('')).toBeUndefined()
  })

  it('isLoopbackHost accepts loopback names only', () => {
    for (const h of ['127.0.0.1:4040', 'localhost', '[::1]:4040']) expect(isLoopbackHost(h)).toBe(true)
    for (const h of ['evil.com', 'evil.com:4040', '10.0.0.5:4040', undefined]) expect(isLoopbackHost(h)).toBe(false)
  })

  it('isAllowedOrigin allows absent + loopback, rejects remote/null', () => {
    expect(isAllowedOrigin(undefined)).toBe(true) // non-browser client
    expect(isAllowedOrigin('http://127.0.0.1:4040')).toBe(true)
    expect(isAllowedOrigin('http://localhost:4040')).toBe(true)
    expect(isAllowedOrigin('http://[::1]:4040')).toBe(true)
    expect(isAllowedOrigin('https://evil.com')).toBe(false)
    expect(isAllowedOrigin('null')).toBe(false)
    expect(isAllowedOrigin('')).toBe(false)
  })

  it('parseCookie reads a single named cookie', () => {
    expect(parseCookie('a=1; boardroom_token=xyz; b=2', TOKEN_COOKIE)).toBe('xyz')
    expect(parseCookie('other=1', TOKEN_COOKIE)).toBeUndefined()
    expect(parseCookie(undefined, TOKEN_COOKIE)).toBeUndefined()
  })

  it('extractToken prefers Bearer, then cookie, then query', () => {
    expect(extractToken({ headers: { authorization: 'Bearer aaa' }, query: {} } as never)).toBe('aaa')
    expect(extractToken({ headers: { cookie: `${TOKEN_COOKIE}=bbb` }, query: {} } as never)).toBe('bbb')
    expect(extractToken({ headers: {}, query: { token: 'ccc' } } as never)).toBe('ccc')
    expect(extractToken({ headers: {}, query: {} } as never)).toBeUndefined()
  })
})

describe('security policy (wired into the daemon)', () => {
  const TOKEN = 'test-token-0123456789abcdef'
  let dir: string
  let daemon: Daemon

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boardroom-sec-'))
    const config: Config = {
      port: 0,
      remindEveryMinutes: 10,
      notifications: false,
      openOnPending: false,
      reattachWindowMs: 24 * 60 * 60_000,
      dbPath: join(dir, 'sec.sqlite'),
      configDir: dir,
      authToken: TOKEN,
    }
    daemon = createDaemon(config)
  })

  afterEach(() => {
    daemon.capturer.stop()
    daemon.store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects /api with no token', async () => {
    await request(daemon.app).get('/api/cards').expect(401)
  })

  it('accepts /api with the Bearer token', async () => {
    const res = await request(daemon.app).get('/api/cards').set('Authorization', `Bearer ${TOKEN}`).expect(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  it('accepts /api with the cookie', async () => {
    await request(daemon.app).get('/api/cards').set('Cookie', `${TOKEN_COOKIE}=${TOKEN}`).expect(200)
  })

  it('accepts /api with the ?token= query param', async () => {
    await request(daemon.app).get(`/api/cards?token=${TOKEN}`).expect(200)
  })

  it('rejects /api with the wrong token', async () => {
    await request(daemon.app).get('/api/cards').set('Authorization', 'Bearer nope').expect(401)
  })

  it('serves the dashboard with a locked-down token cookie', async () => {
    const res = await request(daemon.app).get('/')
    const rawSetCookie = res.headers['set-cookie'] as unknown
    const setCookie = Array.isArray(rawSetCookie) ? rawSetCookie.join('; ') : String(rawSetCookie ?? '')
    expect(setCookie).toContain(`${TOKEN_COOKIE}=${TOKEN}`)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Strict/i)
  })

  it('rejects a cross-origin request even with a valid token', async () => {
    await request(daemon.app)
      .get('/api/cards')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Origin', 'https://evil.com')
      .expect(403)
  })

  it('rejects a non-loopback Host (DNS rebinding) even with a valid token', async () => {
    await request(daemon.app)
      .get('/api/cards')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Host', 'evil.com')
      .expect(403)
  })

  it('leaves /mcp reachable without a token but blocks a cross-origin browser', async () => {
    // Cross-origin POST to /mcp → refused by the Origin guard.
    await request(daemon.app).post('/mcp').set('Origin', 'https://evil.com').send({}).expect(403)
    // A loopback POST with no token is NOT an auth failure (the MCP handshake owns
    // the response); it must not be 401/403.
    const res = await request(daemon.app).post('/mcp').send({})
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })
})
