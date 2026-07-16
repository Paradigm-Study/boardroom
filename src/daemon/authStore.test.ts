import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthStore, credentialEnvFromStored } from './authStore.js'

let dir: string
let store: AuthStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-auth-'))
  store = new AuthStore(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('AuthStore', () => {
  it('reports not-connected when nothing is stored', () => {
    expect(store.get()).toBeUndefined()
    expect(store.status()).toEqual({ connected: false })
  })

  it('stores and reads back a subscription OAuth token', () => {
    store.set({ type: 'oauth', value: 'tok-123' })
    expect(store.get()).toMatchObject({ type: 'oauth', value: 'tok-123' })
    const s = store.status()
    expect(s.connected).toBe(true)
    expect(s.type).toBe('oauth')
    expect(s.updatedAt).toBeTruthy()
    // status must NEVER leak the secret value
    expect(JSON.stringify(s)).not.toContain('tok-123')
  })

  it('writes the token file locked to 0600', () => {
    store.set({ type: 'oauth', value: 'tok-123' })
    const files = ['claude-auth.json'].map(f => join(dir, f)).filter(p => {
      try { statSync(p); return true } catch { return false }
    })
    expect(files).toHaveLength(1)
    expect(statSync(files[0]).mode & 0o777).toBe(0o600)
  })

  it('clear() disconnects', () => {
    store.set({ type: 'apiKey', value: 'k' })
    store.clear()
    expect(store.get()).toBeUndefined()
    expect(store.status().connected).toBe(false)
  })

  it('ignores a corrupt or empty token file rather than throwing', () => {
    writeFileSync(join(dir, 'claude-auth.json'), 'not json{')
    expect(store.get()).toBeUndefined()
    writeFileSync(join(dir, 'claude-auth.json'), JSON.stringify({ type: 'oauth', value: '   ' }))
    expect(store.get()).toBeUndefined()
    writeFileSync(join(dir, 'claude-auth.json'), JSON.stringify({ type: 'bogus', value: 'x' }))
    expect(store.get()).toBeUndefined()
  })

  it('persists across instances (a fresh AuthStore on the same dir sees the token)', () => {
    store.set({ type: 'oauth', value: 'tok-persist' })
    expect(new AuthStore(dir).get()?.value).toBe('tok-persist')
  })

  it('the stored file never contains a trailing newline or extra keys that could confuse a parser', () => {
    store.set({ type: 'oauth', value: 'tok-123' })
    const raw = JSON.parse(readFileSync(join(dir, 'claude-auth.json'), 'utf8'))
    expect(Object.keys(raw).sort()).toEqual(['type', 'updatedAt', 'value'])
  })
})

// A token can go bad AFTER connect (expiry, revocation). When a wake 401s, the
// waker marks it stale: the credential stops being injected, status flips to
// disconnected+stale, and the dashboard's gate re-engages with "expired" wording.
describe('stale credentials', () => {
  it('markStale flips status to disconnected + stale, and get() stops returning the credential', () => {
    store.set({ type: 'oauth', value: 'tok-old' })
    expect(store.status().connected).toBe(true)
    store.markStale()
    expect(store.get()).toBeUndefined() // never inject a known-bad token again
    expect(store.status()).toMatchObject({ connected: false, stale: true, type: 'oauth' })
  })

  it('a fresh set() after markStale clears the staleness (reconnect works)', () => {
    store.set({ type: 'oauth', value: 'tok-old' })
    store.markStale()
    store.set({ type: 'oauth', value: 'tok-new' })
    expect(store.get()?.value).toBe('tok-new')
    expect(store.status()).toMatchObject({ connected: true })
    expect(store.status().stale).toBeUndefined()
  })

  it('markStale on an empty store is a no-op', () => {
    store.markStale()
    expect(store.status()).toEqual({ connected: false })
  })

  it('markStale(expectedValue) no-ops when the stored token was already rotated (a reconnect won the race)', () => {
    store.set({ type: 'oauth', value: 'v1' })
    store.set({ type: 'oauth', value: 'v2' })   // a reconnect rotated the token
    store.markStale('v1')                        // a straggler wake still referencing the old value
    expect(store.status()).toMatchObject({ connected: true })  // v2 is untouched
    expect(store.get()?.value).toBe('v2')
    store.markStale('v2')                        // the token that actually failed
    expect(store.status()).toMatchObject({ connected: false, stale: true })
  })

  it('staleness persists across instances (a daemon restart still shows reconnect)', () => {
    store.set({ type: 'oauth', value: 'tok' })
    store.markStale()
    expect(new AuthStore(dir).status()).toMatchObject({ connected: false, stale: true })
  })
})

describe('credentialEnvFromStored', () => {
  it('maps an oauth credential to CLAUDE_CODE_OAUTH_TOKEN', () => {
    expect(credentialEnvFromStored({ type: 'oauth', value: 't', updatedAt: 'x' }))
      .toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 't' })
  })
  it('maps an apiKey credential to ANTHROPIC_API_KEY', () => {
    expect(credentialEnvFromStored({ type: 'apiKey', value: 'k', updatedAt: 'x' }))
      .toEqual({ ANTHROPIC_API_KEY: 'k' })
  })
})
