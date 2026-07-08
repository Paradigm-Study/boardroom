import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../shared/entry.js'
import { createDaemon, type Daemon } from './app.js'
import type { Config } from './config.js'
import type { Store } from './store.js'

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function reportArgs(headline: string, sessionKey?: string): Record<string, unknown> {
  return {
    project: 'report-e2e',
    headline,
    ...(sessionKey ? { sessionKey } : {}),
    blocks: [{ id: 'b1', type: 'markdown', text: 'the findings' }],
  }
}

let dir: string
let daemon: Daemon
let store: Store
let server: Server
let base: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-mcp-report-'))
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
})

afterEach(async () => {
  daemon.capturer.stop()
  server.closeAllConnections?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await delay(60)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('present_report — non-blocking MCP tool', () => {
  it('returns immediately (< 2s) with text confirming it is NOT a completion, and persists a session-bound entry', async () => {
    const client = new Client({ name: 'boardroom-report-e2e', version: '0.1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(base)))

    const entries: Entry[] = []
    daemon.queue.on('entry', (e: Entry) => entries.push(e))

    const start = Date.now()
    const result = await client.callTool(
      { name: 'present_report', arguments: reportArgs('bound report', 'cc-report-1') },
      { maxTotalTimeout: 5000, timeout: 5000 },
    ) as { content: { type: string; text: string }[]; isError?: boolean }
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2000)
    expect(result.isError).not.toBe(true)
    const text = result.content.map(c => c.text).join('\n')
    expect(text).toContain('NOT a completion')
    expect(text).toContain('session stream')

    // Poll the queue-emitted entry (no queue.submit / waiter involved for reports).
    expect(entries).toHaveLength(1)
    expect(entries[0].type).toBe('report')
    expect(entries[0].claudeSessionId).toBe('cc-report-1')

    // Also verify directly via the Store handle the harness already has.
    const persisted = store.listEntries()
    expect(persisted).toHaveLength(1)
    expect(persisted[0].claudeSessionId).toBe('cc-report-1')

    await client.close()
  }, 10_000)

  it('without sessionKey on a fresh transport, the entry is unbound (no claudeSessionId)', async () => {
    const client = new Client({ name: 'boardroom-report-e2e-2', version: '0.1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(base)))

    const result = await client.callTool(
      { name: 'present_report', arguments: reportArgs('unbound report') },
      { maxTotalTimeout: 5000, timeout: 5000 },
    ) as { content: { type: string; text: string }[]; isError?: boolean }

    expect(result.isError).not.toBe(true)
    const text = result.content.map(c => c.text).join('\n')
    expect(text).toContain('unbound')
    expect(text).toContain('no sessionKey')

    const persisted = store.listEntries()
    expect(persisted).toHaveLength(1)
    expect(persisted[0].claudeSessionId).toBeUndefined()

    await client.close()
  }, 10_000)

  it('rejects zero blocks with a tool error (schema reject), and persists nothing', async () => {
    const client = new Client({ name: 'boardroom-report-e2e-3', version: '0.1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(base)))

    const result = await client.callTool(
      { name: 'present_report', arguments: { project: 'report-e2e', headline: 'no blocks', blocks: [] } },
      { maxTotalTimeout: 5000, timeout: 5000 },
    ) as { content: { type: string; text: string }[]; isError?: boolean }

    expect(result.isError).toBe(true)
    expect(store.listEntries()).toHaveLength(0)

    await client.close()
  }, 10_000)

  it('maps a postReport/store throw to an MCP error result instead of an uncaught exception', async () => {
    const client = new Client({ name: 'boardroom-report-e2e-4', version: '0.1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(base)))

    const postReportSpy = vi.spyOn(daemon.queue, 'postReport').mockImplementation(() => {
      throw new Error('disk full')
    })

    const result = await client.callTool(
      { name: 'present_report', arguments: reportArgs('will fail to post') },
      { maxTotalTimeout: 5000, timeout: 5000 },
    ) as { content: { type: string; text: string }[]; isError?: boolean }

    expect(result.isError).toBe(true)
    const text = result.content.map(c => c.text).join('\n')
    expect(text).toMatch(/disk full/)

    postReportSpy.mockRestore()
    await client.close()
  }, 10_000)
})
