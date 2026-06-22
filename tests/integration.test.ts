import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Card } from '../src/shared/card.js'
import { createDaemon, type Daemon } from '../src/daemon/app.js'
import { SessionCapturer } from '../src/daemon/sessionCapturer.js'

let dir: string
let daemon: Daemon
let baseUrl: string
let httpServer: ReturnType<Daemon['app']['listen']>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-int-'))
  daemon = createDaemon({
    port: 0, remindEveryMinutes: 10, notifications: false, openOnPending: false,
    dbPath: join(dir, 'int.sqlite'), configDir: dir,
  })
  await new Promise<void>(resolve => {
    httpServer = daemon.app.listen(0, '127.0.0.1', () => resolve())
  })
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
})

afterAll(async () => {
  daemon.capturer.stop()
  await new Promise<void>(resolve => httpServer.close(() => resolve()))
  daemon.store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function connect(): Promise<Client> {
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)))
  return client
}

async function pollPendingCard(): Promise<Card> {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${baseUrl}/api/cards?status=pending`)
    const cards = (await res.json()) as Card[]
    if (cards.length > 0) return cards[0]
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('no pending card appeared')
}

describe('present_plan end-to-end', () => {
  it('hangs until the human decides, then returns the summary', async () => {
    const client = await connect()

    const pending = client.callTool({
      name: 'present_plan',
      arguments: {
        project: 'demo',
        headline: 'Auth refactor plan',
        blocks: [
          { id: 'ph', type: 'phases', phases: [{ title: 'Tokens' }, { title: 'Cutover' }] },
          { id: 'global', type: 'markdown', text: 'Applies to the whole auth refactor.' },
        ],
        decisions: [{
          id: 'storage',
          prompt: 'Token storage?',
          blockRefs: ['ph'],
          options: [
            { id: 'cookie', label: 'Cookie + refresh', recommended: true },
            { id: 'local', label: 'LocalStorage' },
          ],
        }],
      },
    })

    const card = await pollPendingCard()
    expect(card.stage).toBe('plan')
    expect(card.session.agent).toBe('claude-code')
    expect(card.decisions.map(d => d.id)).toEqual(['storage', 'plan_verdict'])

    const decideRes = await fetch(`${baseUrl}/api/cards/${card.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: {
          storage: { chosen: ['cookie'] },
          plan_verdict: { chosen: ['approve'] },
        },
      }),
    })
    expect(decideRes.status).toBe(200)

    const result = await pending
    const text = (result.content as { type: string; text: string }[])
      .filter(c => c.type === 'text').map(c => c.text).join('\n')
    expect(text).toContain('Plan verdict: approve')
    expect(text).toContain('Token storage?: Cookie + refresh')

    await client.close()
  })

  it('rejects an invalid payload with the offending field named', async () => {
    const client = await connect()
    let message: string
    try {
      const result = await client.callTool({
        name: 'present_plan',
        arguments: { project: 'demo', blocks: [], decisions: [] },
      })
      message = JSON.stringify(result)
    } catch (err) {
      message = String(err)
    }
    expect(message).toMatch(/headline/i)
    await client.close()
  })
})

describe('session capture', () => {
  it('captures a session dropped into a watched ~/.claude/sessions dir', () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'br-claude-int-'))
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true })
    writeFileSync(join(claudeDir, 'sessions', '4242.json'),
      JSON.stringify({ pid: 4242, sessionId: 'int-1', cwd: '/tmp/proj', version: '2.1.181' }))
    const probe = new SessionCapturer(daemon.store, 'm-int', { claudeDir, isAlive: () => true })
    probe.reconcile()
    probe.stop()
    rmSync(claudeDir, { recursive: true, force: true })
    expect(daemon.store.listCaptured().map(s => s.sessionId)).toContain('int-1')
  })
})
