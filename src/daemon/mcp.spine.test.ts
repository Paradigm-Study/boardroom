import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDaemon, type Daemon } from './app.js'
import type { Config } from './config.js'
import { resolveClaudeSessionId } from './mcp.js'
import type { Store } from './store.js'

describe('resolveClaudeSessionId', () => {
  it('prefers explicit input.sessionKey and records the binding', () => {
    const bindings = new Map<string, string>()
    const got = resolveClaudeSessionId({ sessionId: 'mcp-1' } as never, { sessionKey: 'cc-1' }, bindings)
    expect(got).toBe('cc-1')
    expect(bindings.get('mcp-1')).toBe('cc-1')
  })
  it('falls back to the connection binding when sessionKey omitted', () => {
    const bindings = new Map([['mcp-1', 'cc-1']])
    expect(resolveClaudeSessionId({ sessionId: 'mcp-1' } as never, {}, bindings)).toBe('cc-1')
  })
  it('returns undefined with no key and no binding (legacy caller)', () => {
    expect(resolveClaudeSessionId({ sessionId: 'mcp-2' } as never, {}, new Map())).toBeUndefined()
  })
})

// A minimal, schema-valid clarify payload: one global (unreferenced) block plus
// one question-local block referenced by the single decision.
function clarifyArgs(headline: string, sessionKey?: string): Record<string, unknown> {
  return {
    project: 'spine-e2e',
    headline,
    ...(sessionKey ? { sessionKey } : {}),
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
}

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

let dir: string
let daemon: Daemon
let store: Store
let server: Server
let base: string
let apiBase: string

beforeEach(async () => {
  delete process.env.BOARDROOM_BLOCK_MS
  dir = mkdtempSync(join(tmpdir(), 'boardroom-mcp-spine-'))
  const config: Config = {
    port: 0,
    remindEveryMinutes: 10,
    notifications: false,
    openOnPending: false,
    reattachWindowMs: 24 * 60 * 60_000,
    dbPath: join(dir, 'test.sqlite'),
    configDir: dir,
  }
  daemon = createDaemon(config)
  store = daemon.store
  server = await new Promise<Server>(resolve => {
    const s = daemon.app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const port = (server.address() as { port: number }).port
  base = `http://127.0.0.1:${port}/mcp`
  apiBase = `http://127.0.0.1:${port}/api`
})

afterEach(async () => {
  daemon.capturer.stop()
  server.closeAllConnections?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await delay(60)
  store.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.BOARDROOM_BLOCK_MS
})

async function pollPendingCard(headline: string, timeoutMs = 5000): Promise<{ id: string; claudeSessionId?: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${apiBase}/cards?status=pending`)
    const cards = (await res.json()) as { id: string; headline: string; claudeSessionId?: string }[]
    const match = cards.find(c => c.headline === headline)
    if (match) return match
    await delay(25)
  }
  throw new Error(`no pending card with headline "${headline}" within ${timeoutMs}ms`)
}

async function decide(cardId: string): Promise<void> {
  const res = await fetch(`${apiBase}/cards/${cardId}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answers: { pick: { chosen: ['a'] } } }),
  })
  if (!res.ok) throw new Error(`decide failed: ${res.status} ${await res.text()}`)
}

describe('binding inheritance end-to-end (per-connection sessionKey cache)', () => {
  it('binds claudeSessionId from an explicit sessionKey, then inherits it on a later call with none', async () => {
    const client = new Client({ name: 'boardroom-spine-e2e', version: '0.1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(base)))

    const first = client.callTool(
      { name: 'clarify', arguments: clarifyArgs('spine e2e first call', 'cc-e2e') },
      { resetTimeoutOnProgress: true, maxTotalTimeout: 15_000, timeout: 15_000 },
    )
    const firstCard = await pollPendingCard('spine e2e first call')
    expect(firstCard.claudeSessionId).toBe('cc-e2e')

    // Decide the first card so the first tool call returns before we issue the
    // second (same MCP client/transport, same underlying mcp-session-id).
    await decide(firstCard.id)
    await first

    const second = client.callTool(
      { name: 'clarify', arguments: clarifyArgs('spine e2e second call — no sessionKey') },
      { resetTimeoutOnProgress: true, maxTotalTimeout: 15_000, timeout: 15_000 },
    )
    const secondCard = await pollPendingCard('spine e2e second call — no sessionKey')
    expect(secondCard.claudeSessionId).toBe('cc-e2e')

    await decide(secondCard.id)
    await second
    await client.close()
  }, 20_000)
})
