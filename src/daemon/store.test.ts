import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { compilePlan } from './compile.js'
import { loadConfig } from './config.js'
import { Queue } from './queue.js'
import { CapturedSession } from '../shared/session.js'
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

  it('windows the reattach on ORPHAN time, not createdAt: orphanAllPending stamps a fresh clock', () => {
    // A long-lived pending card (created 2 years ago) re-orphaned on boot must
    // remain reattachable — its clock should restart at orphan time, not stay
    // anchored to its ancient createdAt.
    store.insert(fpCard('c1', 'pending', { createdAt: '2020-01-01T00:00:00.000Z' }))
    store.orphanAllPending()
    expect(store.findReattachable('fp', now)?.id).toBe('c1')
  })

  it('falls back to createdAt for legacy orphans that have no orphanedAt', () => {
    store.insert(fpCard('recent', 'orphaned', { createdAt: new Date(now - 60_000).toISOString() }))
    expect(store.findReattachable('fp', now)?.id).toBe('recent') // recent createdAt, no orphanedAt → still in window
  })

  it('honors a custom reattach window (config-tunable)', () => {
    store.insert(fpCard('c1', 'orphaned', { createdAt: new Date(now - 100).toISOString() }))
    expect(store.findReattachable('fp', now, 1)).toBeUndefined()                 // 1ms window excludes
    expect(store.findReattachable('fp', now, 24 * 60 * 60_000)?.id).toBe('c1')   // 24h window includes
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

describe('Store session registry — cwd-keyed (worktree-safe)', () => {
  it('does NOT collapse two worktrees that share a basename', () => {
    store.recordSession('demo', 'sid-A', '/abs/wt-a/demo')
    store.recordSession('demo', 'sid-B', '/abs/wt-b/demo')
    expect(store.getSessionByCwd('/abs/wt-a/demo')?.sessionId).toBe('sid-A')
    expect(store.getSessionByCwd('/abs/wt-b/demo')?.sessionId).toBe('sid-B')
  })

  it('getSessionByProject is fail-closed when the basename is ambiguous (>1 worktree)', () => {
    store.recordSession('demo', 'sid-A', '/abs/wt-a/demo')
    store.recordSession('demo', 'sid-B', '/abs/wt-b/demo')
    expect(store.getSessionByProject('demo')).toBeUndefined()
  })

  it('getSessionByProject returns the unique row when a basename is unambiguous', () => {
    store.recordSession('demo', 'sid-A', '/abs/wt-a/demo')
    expect(store.getSessionByProject('demo')).toEqual(
      expect.objectContaining({ sessionId: 'sid-A', cwd: '/abs/wt-a/demo' }),
    )
  })

  it('getSessionById resolves the exact session by its Claude session id', () => {
    store.recordSession('demo', 'sid-A', '/abs/wt-a/demo', 'cc-A')
    store.recordSession('demo', 'sid-B', '/abs/wt-b/demo', 'cc-B')
    expect(store.getSessionById('cc-B')).toEqual(
      expect.objectContaining({ sessionId: 'sid-B', cwd: '/abs/wt-b/demo' }),
    )
  })

  it('getSessionById is fail-closed when a Claude session id maps to more than one row', () => {
    // Two distinct worktrees somehow carrying the same claude id → resuming either
    // could be the wrong tree, so resolve to undefined (mirrors getSessionByProject).
    store.recordSession('demo', 'sid-A', '/abs/wt-a/demo', 'cc-X')
    store.recordSession('demo', 'sid-B', '/abs/wt-b/demo', 'cc-X')
    expect(store.getSessionById('cc-X')).toBeUndefined()
  })

  it('re-registering the same cwd updates in place (no duplicate row)', () => {
    store.recordSession('demo', 'sid-A', '/abs/wt-a/demo')
    store.recordSession('demo', 'sid-A2', '/abs/wt-a/demo')
    expect(store.getSessionByCwd('/abs/wt-a/demo')?.sessionId).toBe('sid-A2')
    expect(store.getSessionByProject('demo')?.sessionId).toBe('sid-A2') // still unique
  })

  it('preserves a stored Claude session id when a later re-register of the same cwd omits it', () => {
    store.recordSession('demo', 'sid-A', '/abs/wt-a/demo', 'cc-A')
    store.recordSession('demo', 'sid-A2', '/abs/wt-a/demo') // re-register, no claude id
    expect(store.getSessionById('cc-A')).toEqual(
      expect.objectContaining({ sessionId: 'sid-A2', cwd: '/abs/wt-a/demo' }),
    )
  })

  it('backfill never clobbers an existing sessions_v2 row and is idempotent across reboots', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'br-backfill2-')), 'db.sqlite')
    const s1 = new Store(dbPath)
    s1.recordSession('demo', 'sid-new', '/abs/demo') // writes BOTH sessions + sessions_v2
    // Simulate a STALE legacy row for the same cwd (older session id) drifting in.
    const raw = new Database(dbPath)
    raw.prepare("UPDATE sessions SET session_id = 'sid-stale' WHERE cwd = '/abs/demo'").run()
    raw.close()
    s1.close()
    const s2 = new Store(dbPath) // reboot re-runs the backfill (ON CONFLICT DO NOTHING)
    expect(s2.getSessionByCwd('/abs/demo')?.sessionId).toBe('sid-new') // authoritative v2 row wins
    s2.close()
  })

  it('backfills legacy project-keyed rows into sessions_v2 on boot (auto-wake survives the upgrade)', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'br-backfill-')), 'db.sqlite')
    const old = new Database(dbPath)
    old.exec('CREATE TABLE sessions (project TEXT PRIMARY KEY, session_id TEXT NOT NULL, cwd TEXT NOT NULL, updated_at TEXT NOT NULL)')
    old.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('proj', 'sid', '/abs/proj', 'T')
    old.close()
    const migrated = new Store(dbPath) // boot should backfill sessions_v2 from the legacy table
    expect(migrated.getSessionByProject('proj')).toEqual(
      expect.objectContaining({ sessionId: 'sid', cwd: '/abs/proj' }),
    )
    migrated.close()
  })
})

describe('captured_sessions', () => {
  const make = (over: Partial<CapturedSession> = {}): CapturedSession => CapturedSession.parse({
    sessionId: 's1', machineId: 'm1', pid: 100, cwd: '/Users/x/proj', project: 'proj',
    status: 'alive', capturedAt: '2026-06-21T00:00:00.000Z', lastSeenAt: '2026-06-21T00:00:00.000Z',
    ...over,
  })

  it('upserts and reads back a captured session', () => {
    const store = new Store(':memory:')
    store.upsertCaptured(make())
    expect(store.getCaptured('s1')?.cwd).toBe('/Users/x/proj')
  })

  it('does NOT collide on same project basename (the bug being fixed)', () => {
    const store = new Store(':memory:')
    store.upsertCaptured(make({ sessionId: 's1', cwd: '/a/proj' }))
    store.upsertCaptured(make({ sessionId: 's2', cwd: '/b/proj' }))
    expect(store.listCaptured()).toHaveLength(2)
  })

  it('preserves capturedAt across upserts but updates lastSeenAt/status', () => {
    const store = new Store(':memory:')
    store.upsertCaptured(make({ capturedAt: 'T0', lastSeenAt: 'T0' }))
    store.upsertCaptured(make({ capturedAt: 'T9', lastSeenAt: 'T1', status: 'ended' }))
    const row = store.getCaptured('s1')!
    expect(row.capturedAt).toBe('T0')
    expect(row.lastSeenAt).toBe('T1')
    expect(row.status).toBe('ended')
  })
})

describe('captured_sessions read robustness', () => {
  // Mirror the card path's read robustness: a corrupt captured row (partial write,
  // disk corruption, hand-edit) must be skipped, never thrown, so one bad row can't
  // take down GET /api/sessions or block upsert's self-heal.
  function poisonCaptured(sessionId: string, json: string): void {
    const raw = new Database(join(dir, 'test.sqlite'))
    raw.prepare('INSERT INTO captured_sessions (session_id, json, updated_at) VALUES (?, ?, ?)')
      .run(sessionId, json, new Date().toISOString())
    raw.close()
  }

  it('skips a captured row with malformed JSON without throwing', () => {
    store.upsertCaptured(CapturedSession.parse({
      sessionId: 'ok', machineId: 'm', pid: 1, cwd: '/c', project: 'p',
      status: 'alive', capturedAt: 'T', lastSeenAt: 'T',
    }))
    poisonCaptured('bad', '{not json')
    expect(() => store.listCaptured()).not.toThrow()
    expect(store.listCaptured().map(s => s.sessionId)).toEqual(['ok'])
    expect(() => store.getCaptured('bad')).not.toThrow()
    expect(store.getCaptured('bad')).toBeUndefined()
  })
})

describe('safe storage perms', () => {
  it('locks the sqlite file to 0600 on open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'br-store-'))
    const dbPath = join(dir, 'boardroom.sqlite')
    new Store(dbPath)
    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
  })

  it('keeps the WAL sibling 0600 under the production umask', () => {
    const prev = process.umask(0o077)
    try {
      const dbPath = join(mkdtempSync(join(tmpdir(), 'br-wal-')), 'db.sqlite')
      const store = new Store(dbPath)
      store.insert(card('w1'))                 // forces -wal creation
      expect(statSync(dbPath + '-wal').mode & 0o777).toBe(0o600)
      store.close()
    } finally {
      process.umask(prev)
    }
  })

  it('boots against a DB that still has the old project-keyed sessions table', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'br-mig-')), 'db.sqlite')
    const old = new Database(dbPath)
    old.exec('CREATE TABLE sessions (project TEXT PRIMARY KEY, session_id TEXT NOT NULL, cwd TEXT NOT NULL, updated_at TEXT NOT NULL)')
    old.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('proj', 'sid', '/cwd', 'T')
    old.close()
    const store = new Store(dbPath)   // must not throw
    store.upsertCaptured(CapturedSession.parse({
      sessionId: 'm1', machineId: 'x', pid: 1, cwd: '/c', project: 'p',
      status: 'alive', capturedAt: 'T', lastSeenAt: 'T',
    }))
    expect(store.getCaptured('m1')?.cwd).toBe('/c')
    expect(store.getSession('proj')).toEqual({ sessionId: 'sid', cwd: '/cwd' }) // old data untouched
  })
})
