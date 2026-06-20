import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { compilePlan } from './compile.js'
import { loadConfig } from './config.js'
import { Queue } from './queue.js'
import { Store } from './store.js'

function card(id: string): Card {
  return {
    id, stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'pending', createdAt: new Date().toISOString(),
  }
}

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-'))
  store = new Store(join(dir, 'test.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Store', () => {
  it('round-trips a card', () => {
    store.insert(card('c1'))
    expect(store.get('c1')?.headline).toBe('h')
    expect(store.get('missing')).toBeUndefined()
  })

  it('lists by status, newest first', () => {
    const a = { ...card('c1'), createdAt: '2026-06-11T00:00:00.000Z' }
    const b = { ...card('c2'), createdAt: '2026-06-11T01:00:00.000Z' }
    store.insert(a)
    store.insert(b)
    store.update({ ...a, status: 'decided' })
    expect(store.list('pending').map(c => c.id)).toEqual(['c2'])
    expect(store.list().map(c => c.id)).toEqual(['c2', 'c1'])
  })

  it('orphans all pending cards on demand (boot recovery)', () => {
    store.insert(card('c1'))
    store.insert({ ...card('c2'), status: 'decided' })
    expect(store.orphanAllPending()).toBe(1)
    expect(store.get('c1')?.status).toBe('orphaned')
    expect(store.get('c2')?.status).toBe('decided')
  })
})

describe('Store validation on write', () => {
  it('throws when inserting a structurally-invalid card', () => {
    // Missing required `headline` (min-length string).
    const { headline, ...noHeadline } = card('bad')
    expect(() => store.insert(noHeadline as unknown as Card)).toThrow()
    // Wrong-typed field: status must be a CardStatus enum, not a number.
    const wrongType = { ...card('bad2'), status: 123 } as unknown as Card
    expect(() => store.insert(wrongType)).toThrow()
    // Nothing leaked into the table.
    expect(store.get('bad')).toBeUndefined()
    expect(store.get('bad2')).toBeUndefined()
  })

  it('throws when updating a structurally-invalid card', () => {
    store.insert(card('c1'))
    const broken = { ...card('c1'), decisions: [] } as unknown as Card
    expect(() => store.update(broken)).toThrow()
    // The original good row is untouched.
    expect(store.get('c1')?.headline).toBe('h')
  })
})

describe('Store read robustness', () => {
  // Inject rows that bypass insert()'s Card.parse by writing straight to the
  // sqlite file with a second handle, simulating a legacy/hand-edited/corrupt row.
  function poison(id: string, status: string, json: string): void {
    const raw = new Database(join(dir, 'test.sqlite'))
    raw.prepare('INSERT INTO cards (id, status, created_at, json) VALUES (?, ?, ?, ?)')
      .run(id, status, new Date().toISOString(), json)
    raw.close()
  }

  it('skips a row with malformed JSON without throwing', () => {
    store.insert(card('good'))
    poison('bad', 'pending', '{not json')
    expect(() => store.list()).not.toThrow()
    expect(store.list().map(c => c.id)).toEqual(['good'])
    expect(store.list('pending').map(c => c.id)).toEqual(['good'])
    expect(store.get('bad')).toBeUndefined()
    expect(store.get('good')?.headline).toBe('h')
  })

  it('skips a row whose JSON does not conform to the Card schema', () => {
    store.insert(card('good'))
    poison('bad', 'pending', '{"id":"bad","status":"pending"}')
    expect(() => store.list()).not.toThrow()
    expect(store.list().map(c => c.id)).toEqual(['good'])
    expect(store.get('bad')).toBeUndefined()
  })
})

describe('Store persists a plan send-back (empty chosen)', () => {
  // Regression: a plan sent back for revision stores a sub-decision answer with
  // `chosen: []`. That must round-trip through the store without failing Card.parse
  // on the next read (which would 500 the whole inbox).
  const planInput = {
    project: 'demo',
    headline: 'the plan',
    blocks: [{ id: 'ph', type: 'phases' as const, phases: [{ title: 'Phase 1' }] }],
    decisions: [{
      id: 'd1',
      prompt: 'Approach?',
      options: [
        { id: 'a', label: 'A', recommended: true },
        { id: 'b', label: 'B' },
      ],
    }],
  }

  it('decides and reads back a revised plan with chosen: [] without throwing', () => {
    const queue = new Queue(store)
    const card = compilePlan(planInput, 'claude-code')
    const noop = { resolve: () => {}, reject: () => {} }
    queue.submit(card, noop)

    expect(() => queue.decide(card.id, {
      d1: { chosen: [] },
      plan_verdict: { chosen: ['revise'], note: 'please tighten the migration step' },
    })).not.toThrow()

    expect(() => store.list()).not.toThrow()
    const fromList = store.list().find(c => c.id === card.id)
    expect(fromList?.status).toBe('decided')
    expect(fromList?.answers?.d1.chosen).toEqual([])
    expect(fromList?.answers?.plan_verdict.chosen).toEqual(['revise'])

    const fromGet = store.get(card.id)
    expect(fromGet?.answers?.d1.chosen).toEqual([])
    expect(fromGet?.answers?.plan_verdict.note).toBe('please tighten the migration step')
  })
})

describe('Store.findReattachable', () => {
  const now = Date.now()
  function fpCard(id: string, status: Card['status'], extra: Partial<Card> = {}): Card {
    return { ...card(id), status, fingerprint: 'fp', createdAt: new Date(now).toISOString(), ...extra }
  }

  it('returns an orphaned card within the window', () => {
    store.insert(fpCard('c1', 'orphaned'))
    expect(store.findReattachable('fp', now)?.id).toBe('c1')
  })

  it('returns a decided-but-undelivered card at any age', () => {
    store.insert(fpCard('c1', 'decided', { createdAt: '2020-01-01T00:00:00.000Z' }))
    expect(store.findReattachable('fp', now)?.id).toBe('c1')
  })

  it('ignores pending cards, delivered cards, and stale orphans', () => {
    store.insert(fpCard('pending', 'pending'))
    store.insert(fpCard('delivered', 'decided', { deliveredAt: new Date(now).toISOString() }))
    store.insert(fpCard('stale', 'orphaned', { createdAt: '2020-01-01T00:00:00.000Z' }))
    expect(store.findReattachable('fp', now)).toBeUndefined()
  })

  it('returns undefined for an unknown or missing fingerprint', () => {
    store.insert(fpCard('c1', 'orphaned'))
    expect(store.findReattachable('other', now)).toBeUndefined()
    expect(store.findReattachable(undefined, now)).toBeUndefined()
  })
})

describe('loadConfig', () => {
  it('uses defaults when no config file exists', () => {
    const cfg = loadConfig(join(dir, 'cfgdir'))
    expect(cfg.port).toBe(4040)
    expect(cfg.remindEveryMinutes).toBe(10)
    expect(cfg.notifications).toBe(true)
    expect(cfg.dbPath).toBe(join(dir, 'cfgdir', 'boardroom.sqlite'))
  })
})

describe('Store session registry (Phase 2 auto-wake)', () => {
  it('records and reads back the session for a project (absolute cwd, for claude --resume)', () => {
    store.recordSession('demo', 'sid-1', '/abs/path/demo')
    expect(store.getSession('demo')).toEqual(
      expect.objectContaining({ sessionId: 'sid-1', cwd: '/abs/path/demo' }),
    )
  })

  it('upserts: a newer session for the same project replaces the older', () => {
    store.recordSession('demo', 'sid-1', '/abs/demo')
    store.recordSession('demo', 'sid-2', '/abs/demo-worktree')
    expect(store.getSession('demo')?.sessionId).toBe('sid-2')
    expect(store.getSession('demo')?.cwd).toBe('/abs/demo-worktree')
  })

  it('returns undefined for an unknown project', () => {
    expect(store.getSession('never-seen')).toBeUndefined()
  })
})
