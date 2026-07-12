import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PLAN_VERDICT_ID,
  RESULTS_VERDICT_ID,
  SPEC_VERDICT_ID,
  type Card,
} from '../src/shared/card.js'
import type { Config } from '../src/daemon/config.js'
import { createMeshForwarder, type MeshForwarder } from '../src/daemon/meshForward.js'
import { Queue } from '../src/daemon/queue.js'
import { Store } from '../src/daemon/store.js'

const PROJECT = 'mesh-demo'
const SECRET_PLAN_BODY = 'SECRET_PLAN_BODY'
const SECRET_PLAN_HEADLINE = 'SECRET_PLAN_HEADLINE'
const SECRET_PLAN_PROMPT = 'SECRET_PLAN_PROMPT'
const SECRET_NOTE = 'SECRET_NOTE'
const noopWaiter = { resolve: () => {}, reject: () => {} }

interface CapturedRequest {
  method: string | undefined
  url: string | undefined
  auth: string | undefined
  raw: string
  body: Record<string, unknown>
}

type RelayServer = ReturnType<typeof createServer>

function relay(requests: CapturedRequest[]): RelayServer {
  return createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        raw,
        body: JSON.parse(raw) as Record<string, unknown>,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, seq: requests.length }))
    })
  })
}

async function listen(server: RelayServer, port = 0): Promise<{ port: number; url: string }> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return { port: address.port, url: `http://127.0.0.1:${address.port}` }
}

async function close(server: RelayServer): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
}

function planCard(id: string, fingerprint = `fp-${id}`): Card {
  return {
    id,
    stage: 'plan',
    session: { agent: 'claude-code', project: PROJECT },
    headline: SECRET_PLAN_HEADLINE,
    blocks: [
      {
        id: 'changed-files',
        type: 'diff_stat',
        files: [
          { path: 'src/a.ts', additions: 12, deletions: 1 },
          { path: 'src/b.ts', additions: 3, deletions: 2 },
        ],
      },
      { id: 'plan-body', type: 'markdown', text: SECRET_PLAN_BODY },
    ],
    decisions: [{
      id: PLAN_VERDICT_ID,
      prompt: SECRET_PLAN_PROMPT,
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'revise', label: 'Revise' },
        { id: 'reject', label: 'Reject' },
      ],
    }],
    status: 'pending',
    createdAt: new Date().toISOString(),
    fingerprint,
  }
}

function specCard(id: string, fingerprint = `fp-${id}`): Card {
  const criterionDecision = (criterionId: string, prompt: string): Card['decisions'][number] => ({
    id: `crit:${criterionId}`,
    prompt,
    criterionId,
    options: [
      { id: 'keep', label: 'Keep' },
      { id: 'adjust', label: 'Adjust' },
      { id: 'drop', label: 'Drop' },
    ],
    noteRequiredOn: ['adjust', 'drop'],
  })

  return {
    id,
    stage: 'spec',
    session: { agent: 'claude-code', project: PROJECT },
    headline: 'Lock the mesh contract',
    blocks: [],
    criteria: [
      {
        id: 'c1',
        behavior: 'A plan decision is enforced',
        good: 'The decision is honored',
        bad: 'The decision is ignored',
        tracesTo: 'd1',
        check: 'Inspect the implementation',
      },
      {
        id: 'c2',
        behavior: 'The ADR remains linked',
        good: 'The ADR is discoverable',
        bad: 'The rationale is lost',
        tracesTo: 'docs/adr/0007.md',
      },
    ],
    decisions: [
      criterionDecision('c1', 'Keep criterion one?'),
      criterionDecision('c2', 'Keep criterion two?'),
      {
        id: SPEC_VERDICT_ID,
        prompt: 'Lock this acceptance contract?',
        options: [
          { id: 'lock', label: 'Lock spec' },
          { id: 'revise', label: 'Revise' },
        ],
        noteRequiredOn: ['revise'],
      },
    ],
    status: 'pending',
    createdAt: new Date().toISOString(),
    fingerprint,
  }
}

function resultsCard(id: string, fingerprint = `fp-${id}`): Card {
  return {
    id,
    stage: 'results',
    session: { agent: 'claude-code', project: PROJECT },
    headline: 'Review the implementation',
    blocks: [],
    decisions: [{
      id: RESULTS_VERDICT_ID,
      prompt: 'Is the session complete?',
      options: [
        { id: 'complete', label: 'Mark complete' },
        { id: 'continue', label: 'Keep going' },
      ],
    }],
    status: 'pending',
    createdAt: new Date().toISOString(),
    fingerprint,
  }
}

describe('createMeshForwarder', () => {
  let dir: string
  let store: Store
  let queue: Queue
  let requests: CapturedRequest[]
  let servers: RelayServer[]
  let server: RelayServer
  let relayPort: number
  let config: Config
  let forwarder: MeshForwarder | undefined

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'boardroom-mesh-'))
    store = new Store(join(dir, 'test.sqlite'))
    queue = new Queue(store)
    requests = []
    servers = []
    server = relay(requests)
    servers.push(server)
    const listening = await listen(server)
    relayPort = listening.port
    config = {
      port: 0,
      remindEveryMinutes: 10,
      notifications: false,
      openOnPending: false,
      reattachWindowMs: 60_000,
      dbPath: join(dir, 'x.sqlite'),
      configDir: dir,
      mesh: { url: listening.url, token: 'tok-a', person: 'alice' },
    }
  })

  afterEach(async () => {
    forwarder?.stop()
    await forwarder?.flush()
    for (const activeServer of servers) await close(activeServer)
    store.close()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function arm(override = config): MeshForwarder {
    const armed = createMeshForwarder(queue, override)
    if (!armed) throw new Error('expected mesh forwarder to be configured')
    forwarder = armed
    return armed
  }

  it('maps a raised plan card to the canonical private wire record', async () => {
    const card = planCard('plan-raised')
    const armed = arm()

    queue.submit(card, noopWaiter)
    await armed.flush()

    expect(requests).toHaveLength(1)
    const request = requests[0]
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/outbox/alice')
    expect(request.auth).toBe('Bearer tok-a')
    expect(request.body).toEqual({
      v: 0,
      kind: 'card_event',
      person: 'alice',
      device: expect.any(String),
      project: PROJECT,
      ts: card.createdAt,
      cardId: card.id,
      stage: 'plan',
      event: 'raised',
      artifacts: [
        { repo: PROJECT, path: 'src/a.ts' },
        { repo: PROJECT, path: 'src/b.ts' },
      ],
    })
    expect(request.body.device).not.toBe('')
    expect(request.raw).not.toContain(SECRET_PLAN_BODY)
    expect(request.raw).not.toContain(SECRET_PLAN_HEADLINE)
    expect(request.raw).not.toContain(SECRET_PLAN_PROMPT)
  })

  it('forwards a locked spec with stripped criteria and file-like traces', async () => {
    const card = specCard('spec-locked')
    const armed = arm()

    queue.submit(card, noopWaiter)
    await armed.flush()
    const { card: decided } = queue.decide(card.id, {
      'crit:c1': { chosen: ['keep'] },
      'crit:c2': { chosen: ['keep'] },
      [SPEC_VERDICT_ID]: { chosen: ['lock'] },
    })
    await armed.flush()

    expect(requests).toHaveLength(2)
    const expectedCriteria = [
      { id: 'c1', behavior: 'A plan decision is enforced' },
      { id: 'c2', behavior: 'The ADR remains linked' },
    ]
    expect(requests[0].body.specCriteria).toEqual(expectedCriteria)
    expect(requests[1].body).toEqual({
      v: 0,
      kind: 'card_event',
      person: 'alice',
      device: expect.any(String),
      project: PROJECT,
      ts: decided.decidedAt,
      cardId: card.id,
      stage: 'spec',
      event: 'decided',
      verdict: 'lock',
      artifacts: [{ repo: PROJECT, path: 'docs/adr/0007.md' }],
      specCriteria: expectedCriteria,
    })
    expect(requests[1].raw).not.toContain('"d1"')
    expect(requests[1].raw).not.toContain('The decision is honored')
    expect(requests[1].raw).not.toContain('The decision is ignored')
  })

  it('redacts free-text criteria and drops secret-looking artifact paths at the wire boundary', async () => {
    const card = specCard('spec-redacted')
    card.criteria![0]!.behavior = 'Contact owner@example.com with sk-supersecretvalue123'
    card.blocks.push({
      id: 'secret-files',
      type: 'diff_stat',
      files: [
        { path: '.env.production', additions: 1, deletions: 0 },
        { path: 'certs/private.pem', additions: 1, deletions: 0 },
        { path: 'src/safe.ts', additions: 1, deletions: 0 },
      ],
    })
    const armed = arm()

    queue.submit(card, noopWaiter)
    await armed.flush()

    expect(requests).toHaveLength(1)
    expect(requests[0].raw).not.toContain('owner@example.com')
    expect(requests[0].raw).not.toContain('sk-supersecretvalue123')
    expect(requests[0].raw).not.toContain('.env.production')
    expect(requests[0].raw).not.toContain('private.pem')
    expect(requests[0].raw).toContain('src/safe.ts')
    expect(requests[0].raw).toContain('[redacted]')
  })

  it('forwards a completed results verdict without answer notes', async () => {
    const card = resultsCard('results-complete')
    const armed = arm()

    queue.submit(card, noopWaiter)
    await armed.flush()
    const { card: decided } = queue.decide(card.id, {
      [RESULTS_VERDICT_ID]: { chosen: ['complete'], note: SECRET_NOTE },
    })
    await armed.flush()

    expect(requests).toHaveLength(2)
    expect(requests[1].body).toEqual({
      v: 0,
      kind: 'card_event',
      person: 'alice',
      device: expect.any(String),
      project: PROJECT,
      ts: decided.decidedAt,
      cardId: card.id,
      stage: 'results',
      event: 'decided',
      verdict: 'complete',
      artifacts: [],
    })
    expect(requests[1].raw).not.toContain(SECRET_NOTE)
  })

  it('spools while the relay is down and retries oldest-first on the next event', async () => {
    const relayUrl = config.mesh!.url
    await close(server)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const armed = arm({ ...config, mesh: { ...config.mesh!, url: relayUrl } })
    const first = planCard('spooled-a')

    queue.submit(first, noopWaiter)
    await armed.flush()

    const spoolPath = join(dir, 'mesh-spool.ndjson')
    expect(existsSync(spoolPath)).toBe(true)
    const lines = readFileSync(spoolPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'raised', cardId: first.id })
    expect(warn).toHaveBeenCalledTimes(1)

    const replacement = relay(requests)
    servers.push(replacement)
    await listen(replacement, relayPort)
    const second = planCard('spooled-b')
    queue.submit(second, noopWaiter)
    await armed.flush()

    expect(requests.map(request => request.body.cardId)).toEqual([first.id, second.id])
    expect(!existsSync(spoolPath) || readFileSync(spoolPath, 'utf8').trim() === '').toBe(true)
  })

  it('does not emit a second raised record when an orphan is revived', async () => {
    const armed = arm()
    const first = planCard('revive-original', 'shared-revive-fingerprint')
    const submitted = queue.submit(first, noopWaiter)
    queue.disconnect(submitted.cardId, submitted.gen)
    queue.submit(planCard('revive-retry', 'shared-revive-fingerprint'), noopWaiter)

    await armed.flush()

    expect(requests).toHaveLength(1)
    expect(requests[0].body).toMatchObject({ event: 'raised', cardId: first.id })
  })

  it('attaches nothing when mesh configuration is absent', () => {
    const silent = createMeshForwarder(queue, { ...config, mesh: undefined })

    expect(silent).toBeUndefined()
    expect(queue.listenerCount('card')).toBe(0)
  })

  it('detaches its card listener when stopped', async () => {
    const armed = arm()
    queue.submit(planCard('before-stop'), noopWaiter)
    await armed.flush()
    expect(requests).toHaveLength(1)

    armed.stop()
    queue.submit(planCard('after-stop'), noopWaiter)
    await armed.flush()

    expect(requests).toHaveLength(1)
    expect(queue.listenerCount('card')).toBe(0)
  })
})
