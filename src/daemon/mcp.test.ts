import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDaemon, type Daemon } from './app.js'
import type { Config } from './config.js'
import type { Queue } from './queue.js'
import type { Store } from './store.js'

// A minimal, schema-valid clarify payload: one global (unreferenced) block plus
// one question-local block referenced by the single decision.
const CLARIFY_ARGS = {
  project: 'keepalive-test',
  headline: 'does the stream stay warm?',
  blocks: [
    { id: 'g', type: 'markdown', text: 'global context' },
    { id: 'q', type: 'markdown', text: 'question context' },
  ],
  decisions: [
    {
      id: 'pick',
      prompt: 'Pick one?',
      blockRefs: ['q'],
      options: [
        { id: 'a', label: 'A', recommended: true },
        { id: 'b', label: 'B' },
      ],
    },
  ],
}

// A minimal, schema-valid present_plan payload (structural block + one decision).
const PLAN_ARGS = {
  project: 'keepalive-test',
  headline: 'ship it?',
  blocks: [
    { id: 'g', type: 'phases', phases: [{ title: 'Phase 1' }] },
    { id: 'q', type: 'markdown', text: 'question context' },
  ],
  decisions: [
    {
      id: 'pick',
      prompt: 'Pick one?',
      blockRefs: ['q'],
      options: [
        { id: 'a', label: 'A', recommended: true },
        { id: 'b', label: 'B' },
      ],
    },
  ],
}

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

let dir: string
let daemon: Daemon
let store: Store
let queue: Queue
let server: Server
let base: string

beforeEach(async () => {
  process.env.BOARDROOM_STREAM_HEARTBEAT_MS = '150'
  dir = mkdtempSync(join(tmpdir(), 'boardroom-mcp-'))
  const config: Config = {
    port: 0,
    remindEveryMinutes: 10,
    notifications: false,
    openOnPending: false,
    dbPath: join(dir, 'test.sqlite'),
    configDir: dir,
  }
  daemon = createDaemon(config)
  store = daemon.store
  queue = daemon.queue
  server = await new Promise<Server>(resolve => {
    const s = daemon.app.listen(0, '127.0.0.1', () => resolve(s))
  })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
})

afterEach(async () => {
  daemon.capturer.stop()
  // Force-drop any lingering sockets so the server's res 'close' handlers (which
  // call queue.disconnect -> store.get) run now, while the DB is still open.
  server.closeAllConnections?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await delay(60)
  store.close()
  rmSync(dir, { recursive: true, force: true })
  // Don't leak a tiny block window into the keepalive tests (which expect the
  // call to keep hanging through their collection window).
  delete process.env.BOARDROOM_BLOCK_MS
})

function post(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  })
}

// Reads an SSE body for `ms`, returning every JSON-RPC message it carries.
async function collectMessages(body: ReadableStream<Uint8Array> | null, ms: number): Promise<Record<string, unknown>[]> {
  if (!body) return []
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const messages: Record<string, unknown>[] = []
  let buffer = ''
  const deadline = Date.now() + ms
  try {
    while (Date.now() < deadline) {
      const { value, done } = (await Promise.race([
        reader.read(),
        delay(deadline - Date.now()).then(() => ({ value: undefined, done: true })),
      ])) as { value?: Uint8Array; done: boolean }
      if (done || !value) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of event.split('\n')) {
          const m = /^data:\s?(.*)$/.exec(line)
          if (!m || !m[1]) continue
          try {
            messages.push(JSON.parse(m[1]))
          } catch {
            /* non-JSON data line (e.g. priming event) */
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return messages
}

async function handshake(): Promise<string> {
  const res = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-http', version: '0' } },
  })
  const sessionId = res.headers.get('mcp-session-id')
  await res.body?.cancel().catch(() => {})
  if (!sessionId) throw new Error('no mcp-session-id returned from initialize')
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sessionId })
  return sessionId
}

describe('hanging tool calls keep their SSE stream warm', () => {
  // Root cause of the Claude-Code-vs-Codex instability: a boardroom tool call
  // holds its HTTP/SSE response open while waiting (often for many minutes) for
  // the human. The SDK has no built-in heartbeat, so the only thing keeping the
  // stream from going silent is the app-level keepalive — which used to fire
  // ONLY when the client supplied a progressToken. Claude Code does not, and its
  // Node/undici HTTP stack aborts a silent body after its idle timeout, so the
  // card orphaned. Codex's HTTP stack has no such idle timeout, so it survived.
  // The fix: emit the keepalive unconditionally. This test sends a tool call
  // with NO progressToken and asserts the server still heartbeats the stream.
  it('heartbeats a no-progressToken client with logging notifications (silently ignorable, no unknown-token errors)', async () => {
    process.env.BOARDROOM_KEEPALIVE_MS = '150'
    const sessionId = await handshake()

    const ac = new AbortController()
    // Note: no `_meta.progressToken` in params — mirrors the failing client.
    const callRes = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'clarify', arguments: CLARIFY_ARGS } },
      { 'mcp-session-id': sessionId },
      ac.signal,
    )
    expect(callRes.status).toBe(200)

    // Collect ~700ms of the stream while the call hangs awaiting a decision.
    const messages = await collectMessages(callRes.body, 700)
    ac.abort()

    // No-token clients get logging heartbeats, NOT unsolicited progress (which
    // would trip a per-beat "unknown progress token" error in a conformant client).
    const logBeats = messages.filter(m => m.method === 'notifications/message')
    const progressBeats = messages.filter(m => m.method === 'notifications/progress')
    expect(logBeats.length).toBeGreaterThanOrEqual(2)
    expect(progressBeats.length).toBe(0)

    // And the card really is sitting pending the whole time (not resolved/errored).
    expect(store.list('pending').length).toBe(1)
  }, 15_000)

  it('heartbeats a progressToken client with progress notifications echoing its token', async () => {
    process.env.BOARDROOM_KEEPALIVE_MS = '150'
    const sessionId = await handshake()

    const ac = new AbortController()
    // This client opted into progress, so it gets progress heartbeats (which also
    // reset its own SDK progress-timeout) — unchanged from before the fix.
    const callRes = await post(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'clarify', arguments: CLARIFY_ARGS, _meta: { progressToken: 77 } },
      },
      { 'mcp-session-id': sessionId },
      ac.signal,
    )
    expect(callRes.status).toBe(200)

    const messages = await collectMessages(callRes.body, 700)
    ac.abort()

    const progressBeats = messages.filter(m => m.method === 'notifications/progress')
    expect(progressBeats.length).toBeGreaterThanOrEqual(2)
    for (const beat of progressBeats) {
      expect((beat.params as { progressToken?: unknown }).progressToken).toBe(77)
    }
  }, 15_000)

  it('keeps the standalone GET SSE stream warm with a global heartbeat', async () => {
    // Regression for the Claude Code drop: its standalone notification stream
    // timed out at ~300s ("SSE stream disconnected: TimeoutError") and, after 3
    // such timeouts, it closed the whole transport. The global heartbeat must
    // push bytes onto that standalone stream so its idle timer never fires.
    const sessionId = await handshake()

    const ac = new AbortController()
    const res = await fetch(base, {
      method: 'GET',
      headers: { 'mcp-session-id': sessionId, accept: 'text/event-stream' },
      signal: ac.signal,
    })
    expect(res.status).toBe(200)

    // BOARDROOM_STREAM_HEARTBEAT_MS=150 (set in beforeEach) → several beats in 700ms.
    const messages = await collectMessages(res.body, 700)
    ac.abort()

    const beats = messages.filter(m => m.method === 'notifications/message')
    expect(beats.length).toBeGreaterThanOrEqual(2)
  }, 15_000)

  it('announces the opened gate with a transcript-friendly info notification', async () => {
    process.env.BOARDROOM_KEEPALIVE_MS = '1000'
    const sessionId = await handshake()

    const ac = new AbortController()
    const callRes = await post(
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'clarify', arguments: CLARIFY_ARGS } },
      { 'mcp-session-id': sessionId },
      ac.signal,
    )
    expect(callRes.status).toBe(200)

    const messages = await collectMessages(callRes.body, 250)
    ac.abort()

    const notice = messages.find(m => {
      if (m.method !== 'notifications/message') return false
      const params = m.params as { level?: string; logger?: string; data?: unknown } | undefined
      return params?.level === 'info' && params.logger === 'boardroom'
    }) as { params?: { data?: unknown } } | undefined

    expect(notice).toBeDefined()
    const text = String(notice?.params?.data)
    expect(text).toContain('Boardroom gate opened: clarify')
    expect(text).toContain('does the stream stay warm?')
    expect(text).toContain('Pick one?')
    expect(text).toContain('A')
  }, 15_000)

  it('PARKS a clarify call after the bounded window: returns a STOP sentinel and leaves the card reattachable', async () => {
    process.env.BOARDROOM_BLOCK_MS = '200'
    process.env.BOARDROOM_KEEPALIVE_MS = '50'
    const sessionId = await handshake()

    const ac = new AbortController()
    const callRes = await post(
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'clarify', arguments: CLARIFY_ARGS } },
      { 'mcp-session-id': sessionId },
      ac.signal,
    )
    expect(callRes.status).toBe(200)

    // No decision; let the 200ms window elapse and collect the resolved result.
    const messages = await collectMessages(callRes.body, 1200)
    ac.abort()

    const result = messages.find(m => m.id === 8 && 'result' in m) as
      | { result?: { content?: { type: string; text?: string }[] } }
      | undefined
    expect(result).toBeDefined() // the call RETURNED (parked), not hung forever
    const texts = (result?.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
    expect(texts).toMatch(/parked|STOP|re-issue/i)

    // Parked == orphaned: reattachable, decidable, no live waiter.
    expect(store.list('orphaned').length).toBe(1)
    expect(store.list('pending').length).toBe(0)
  }, 15_000)

  it('does NOT park present_plan — its approval gate keeps blocking past the window', async () => {
    process.env.BOARDROOM_BLOCK_MS = '200'
    process.env.BOARDROOM_KEEPALIVE_MS = '50'
    const sessionId = await handshake()

    const ac = new AbortController()
    const callRes = await post(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'present_plan', arguments: PLAN_ARGS } },
      { 'mcp-session-id': sessionId },
      ac.signal,
    )
    expect(callRes.status).toBe(200)

    // Collect well past the 200ms window — it must still be hanging, card still pending.
    const messages = await collectMessages(callRes.body, 800)
    ac.abort()

    const result = messages.find(m => m.id === 9 && 'result' in m)
    expect(result).toBeUndefined()             // never returned — present_plan never parks
    expect(store.list('pending').length).toBe(1)
    expect(store.list('orphaned').length).toBe(0)
  }, 15_000)

  it('still resolves the call with the human decision', async () => {
    process.env.BOARDROOM_KEEPALIVE_MS = '150'
    const sessionId = await handshake()

    const ac = new AbortController()
    const callRes = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'clarify', arguments: CLARIFY_ARGS } },
      { 'mcp-session-id': sessionId },
      ac.signal,
    )

    // Let it hang briefly (keepalive flowing), then the human decides.
    await delay(500)
    const pending = store.list('pending')
    expect(pending.length).toBe(1)
    queue.decide(pending[0].id, { pick: { chosen: ['a'] } })

    const messages = await collectMessages(callRes.body, 1000)
    ac.abort()

    const result = messages.find(m => m.id === 3 && 'result' in m) as
      | { result?: { content?: { type: string; text?: string }[] } }
      | undefined
    expect(result).toBeDefined()
    const texts = (result?.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
    expect(texts).toContain('Boardroom gate resolved: clarify')
    expect(texts).toContain('does the stream stay warm?')
    expect(texts).toContain('Pick one?')
    expect(texts).toContain('Human response:')
    expect(texts).toContain('pick')
  }, 15_000)
})
