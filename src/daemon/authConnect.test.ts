import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthConnector, type ConnectSpawnFn, extractLoginUrl, extractOauthToken, stripAnsi } from './authConnect.js'
import { AuthStore } from './authStore.js'

describe('extractOauthToken', () => {
  it('extracts a Claude setup-token OAuth token from noisy output', () => {
    const out = 'Opening browser...\nAuthorize, then:\nsk-ant-oat01-AbC_123-def456\nDone.'
    expect(extractOauthToken(out)).toBe('sk-ant-oat01-AbC_123-def456')
  })
  it('returns the LAST token if several appear (the final printed one is the real result)', () => {
    expect(extractOauthToken('sk-ant-oat01-first\n...\nsk-ant-oat01-final')).toBe('sk-ant-oat01-final')
  })
  it('sees through ANSI color codes', () => {
    expect(extractOauthToken('[32msk-ant-oat01-colored[0m')).toBe('sk-ant-oat01-colored')
  })
  it('returns undefined when there is no token', () => {
    expect(extractOauthToken('Login cancelled.')).toBeUndefined()
  })
})

describe('extractLoginUrl', () => {
  it('pulls the Claude login URL the flow prints', () => {
    expect(extractLoginUrl('Open this to log in: https://claude.ai/oauth/authorize?x=1 then wait'))
      .toBe('https://claude.ai/oauth/authorize?x=1')
  })
  it('accepts an anthropic.com console URL too', () => {
    expect(extractLoginUrl('visit https://console.anthropic.com/oauth/authorize?y=2 now'))
      .toBe('https://console.anthropic.com/oauth/authorize?y=2')
  })
  it('accepts the claude.com OAuth URL setup-token actually prints', () => {
    expect(extractLoginUrl('sign in: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz done'))
      .toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz')
  })
  it('IGNORES the ink "raw mode not supported" doc URL — a real bug that surfaced as a bogus login link', () => {
    expect(extractLoginUrl('ERROR Raw mode is not supported ... https://github.com/vadimdemedes/ink/#israwmodesupported'))
      .toBeUndefined()
  })
  it('is undefined when no login URL is present', () => {
    expect(extractLoginUrl('no url here')).toBeUndefined()
  })
})

describe('stripAnsi', () => {
  it('removes color escape sequences', () => {
    expect(stripAnsi('[1;32mhi[0m')).toBe('hi')
  })
})

let dir: string
let authStore: AuthStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-connect-'))
  authStore = new AuthStore(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// A controllable stand-in for the real node-pty `claude setup-token` child.
function fakeSpawn(): {
  fn: ConnectSpawnFn; emit(chunk: string): void; exit(code: number | null): void; error(e: Error): void
  killed: boolean; writes: string[]
} {
  const box = { hooks: undefined as undefined | Parameters<ConnectSpawnFn>[2], killed: false, writes: [] as string[] } as {
    hooks?: Parameters<ConnectSpawnFn>[2]; killed: boolean; writes: string[]
    fn: ConnectSpawnFn; emit(c: string): void; exit(c: number | null): void; error(e: Error): void
  }
  box.fn = (_bin, _args, hooks) => {
    box.hooks = hooks
    return { kill: () => { box.killed = true }, write: (d: string) => { box.writes.push(d) } }
  }
  box.emit = c => box.hooks?.onData(c)
  box.exit = c => box.hooks?.onExit(c)
  box.error = e => box.hooks?.onError(e)
  return box
}

describe('AuthConnector', () => {
  it('captures the token on a clean login and stores it as an oauth credential', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    expect(c.start().state).toBe('running')
    spawn.emit('Open https://claude.ai/oauth to log in\n')
    expect(c.getStatus()).toMatchObject({ state: 'running', url: 'https://claude.ai/oauth' })
    spawn.emit('sk-ant-oat01-the-real-token\n')
    spawn.exit(0)
    expect(c.getStatus().state).toBe('connected')
    expect(authStore.get()).toMatchObject({ type: 'oauth', value: 'sk-ant-oat01-the-real-token' })
  })

  it('surfaces the code prompt (awaitingCode) so the UI can ask the user to paste the browser code', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    c.start()
    spawn.emit('Opening browser...\nhttps://claude.com/cai/oauth/authorize?code=true&state=x\n')
    expect(c.getStatus()).toMatchObject({ state: 'running', url: expect.stringContaining('claude.com') })
    expect(c.getStatus().awaitingCode).toBeUndefined() // not yet — no code prompt seen
    spawn.emit('Paste code here if prompted >')
    expect(c.getStatus().awaitingCode).toBe(true)
  })

  it('relays a pasted code into the child (with a carriage return) and clears awaitingCode', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    c.start()
    spawn.emit('Paste code here if prompted >')
    expect(c.getStatus().awaitingCode).toBe(true)
    c.sendInput('the-auth-code#state')
    expect(spawn.writes).toEqual(['the-auth-code#state\r'])
    expect(c.getStatus().awaitingCode).toBeUndefined()
  })

  it('completes after the code is pasted: captures the token setup-token then prints', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    c.start()
    spawn.emit('Paste code here if prompted >')
    c.sendInput('auth-code')
    spawn.emit('\nsk-ant-oat01-post-code-token\n')
    spawn.exit(0)
    expect(c.getStatus().state).toBe('connected')
    expect(authStore.get()?.value).toBe('sk-ant-oat01-post-code-token')
  })

  it('keeps the paste field hidden after the code is submitted, even as setup-token keeps printing (no duplicate-paste re-prompt)', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    c.start()
    spawn.emit('Paste code here if prompted >')
    expect(c.getStatus().awaitingCode).toBe(true)
    c.sendInput('the-code')
    expect(c.getStatus().awaitingCode).toBeUndefined()
    // The "Paste code here" prompt still sits in buf; setup-token echoes/redraws and
    // streams token-exchange output. The field must STAY hidden — a reappearance would
    // invite a second paste that corrupts the interactive stdin.
    spawn.emit('the-code\nExchanging the code for a token...\n')
    expect(c.getStatus().awaitingCode).toBeUndefined()
  })

  it('corrects a login URL split across two PTY reads instead of locking the truncated prefix', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    c.start()
    spawn.emit('Open https://claude.com/cai/oauth/authorize?code=true&sta') // read splits mid-URL
    spawn.emit('te=xyz&client_id=abc\n')                                    // remainder arrives next read
    expect(c.getStatus().url).toBe('https://claude.com/cai/oauth/authorize?code=true&state=xyz&client_id=abc')
  })

  it('sendInput is a no-op when no login is running (nothing to write)', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    c.sendInput('stray') // never started
    expect(spawn.writes).toEqual([])
  })

  it('fails (and stores nothing) when the login exits non-zero', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    c.start()
    spawn.exit(1)
    expect(c.getStatus().state).toBe('failed')
    expect(authStore.get()).toBeUndefined()
  })

  it('fails when it exits 0 but no token was ever printed (e.g. user closed the browser)', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    c.start()
    spawn.exit(0)
    expect(c.getStatus().state).toBe('failed')
    expect(authStore.get()).toBeUndefined()
  })

  it('surfaces a spawn error as a failed status', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    c.start()
    spawn.error(new Error('script not found'))
    expect(c.getStatus().state).toBe('failed')
    expect(c.getStatus().detail).toContain('script not found')
  })

  it('does not start a second login while one is already running', () => {
    let spawns = 0
    const spawn = fakeSpawn()
    const counting: ConnectSpawnFn = (b, a, h) => { spawns++; return spawn.fn(b, a, h) }
    const c = new AuthConnector(authStore, { spawn: counting })
    c.start(); c.start()
    expect(spawns).toBe(1)
  })

  it('cancel() kills the child and returns to idle', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    c.start()
    c.cancel()
    expect(spawn.killed).toBe(true)
    expect(c.getStatus().state).toBe('idle')
  })

  it('the killed child\'s late exit does NOT overwrite a cancel back to failed (observed live)', () => {
    const spawn = fakeSpawn()
    const c = new AuthConnector(authStore, { spawn: spawn.fn })
    c.start()
    c.cancel()
    spawn.exit(1) // the SIGKILLed relay exits after cancel already reset to idle
    expect(c.getStatus().state).toBe('idle')
  })

  it('times out a login that never completes — kills the child and reports failed (no more forever-hang)', () => {
    vi.useFakeTimers()
    try {
      const spawn = fakeSpawn()
      const c = new AuthConnector(authStore, { spawn: spawn.fn, timeoutMs: 5_000 })
      c.start()
      spawn.emit('Open https://claude.ai/oauth\n') // browser opened, user never finishes
      expect(c.getStatus().state).toBe('running')
      vi.advanceTimersByTime(5_000)
      expect(c.getStatus().state).toBe('failed')
      expect(c.getStatus().detail).toMatch(/tim(e|ed) ?out/i)
      expect(spawn.killed).toBe(true)
      expect(authStore.get()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a successful capture cancels the timeout (no late failed-overwrite of a connected status)', () => {
    vi.useFakeTimers()
    try {
      const spawn = fakeSpawn()
      const c = new AuthConnector(authStore, { spawn: spawn.fn, timeoutMs: 5_000 })
      c.start()
      spawn.emit('sk-ant-oat01-quick\n')
      spawn.exit(0)
      expect(c.getStatus().state).toBe('connected')
      vi.advanceTimersByTime(10_000) // the timer must not fire and flip us to failed
      expect(c.getStatus().state).toBe('connected')
    } finally {
      vi.useRealTimers()
    }
  })

  // NOTE: the real defaultConnectSpawn drives a python PTY relay (/usr/bin/python3
  // running the stdlib `pty` module — NOT the node-pty npm package), which cannot
  // allocate a PTY in this test sandbox. Its spawn→capture→store wiring is covered
  // above via the injected fake; the relay itself is verified on the deployed daemon
  // (a launchd process CAN allocate a PTY) plus the human's real login.
})
