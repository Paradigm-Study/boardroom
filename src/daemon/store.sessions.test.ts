import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store.js'

let dir: string
let store: Store
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-store-'))
  store = new Store(join(dir, 'test.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('sessions_v3 — session-id-keyed registry', () => {
  it('two sessions in the SAME cwd both stay resolvable (the v2 overwrite bug, fixed)', () => {
    store.recordSession('demo', 'cc-A', '/tmp/demo')
    store.recordSession('demo', 'cc-B', '/tmp/demo')  // same cwd — v2 overwrites, v3 must not
    expect(store.getRegisteredSession('cc-A')).toEqual({ sessionId: 'cc-A', cwd: '/tmp/demo', project: 'demo' })
    expect(store.getRegisteredSession('cc-B')).toEqual({ sessionId: 'cc-B', cwd: '/tmp/demo', project: 'demo' })
  })
  it('re-registering the same session updates its row (resume re-fires the hook)', () => {
    store.recordSession('demo', 'cc-A', '/tmp/demo')
    store.recordSession('demo', 'cc-A', '/tmp/demo2')
    expect(store.getRegisteredSession('cc-A')?.cwd).toBe('/tmp/demo2')
  })
  it('unknown id → undefined', () => {
    expect(store.getRegisteredSession('nope')).toBeUndefined()
  })
})

describe('sessions_v3 age-based pruning', () => {
  const daysAgo = (n: number): string => new Date(Date.now() - n * 24 * 60 * 60_000).toISOString()

  it('boot prunes rows idle past the retention window; fresh rows survive', () => {
    store.recordSession('demo', 'cc-stale', '/tmp/demo-stale')
    store.recordSession('demo', 'cc-fresh', '/tmp/demo-fresh')
    const path = join(dir, 'test.sqlite')
    const raw = new Database(path)
    try {
      raw.prepare('UPDATE sessions_v3 SET updated_at = ? WHERE session_id = ?').run(daysAgo(31), 'cc-stale')
      raw.prepare('UPDATE sessions_v3 SET updated_at = ? WHERE session_id = ?').run(daysAgo(29), 'cc-fresh')
    } finally {
      raw.close()
    }
    store.close()

    const rebooted = new Store(path)
    try {
      expect(rebooted.getRegisteredSession('cc-stale')).toBeUndefined()
      expect(rebooted.getRegisteredSession('cc-fresh')?.cwd).toBe('/tmp/demo-fresh')
    } finally {
      rebooted.close()
    }
  })

  it('a pruned session that starts again simply re-registers', () => {
    const path = join(dir, 'test.sqlite')
    store.recordSession('demo', 'cc-back', '/tmp/demo')
    const raw = new Database(path)
    try {
      raw.prepare('UPDATE sessions_v3 SET updated_at = ? WHERE session_id = ?').run(daysAgo(40), 'cc-back')
    } finally {
      raw.close()
    }
    store.close()

    const rebooted = new Store(path)
    try {
      expect(rebooted.getRegisteredSession('cc-back')).toBeUndefined()
      rebooted.recordSession('demo', 'cc-back', '/tmp/demo')
      expect(rebooted.getRegisteredSession('cc-back')?.cwd).toBe('/tmp/demo')
    } finally {
      rebooted.close()
    }
  })
})

// The constructor's one-time backfills: a DB written by a pre-spine daemon must
// keep auto-wake working immediately after upgrade, without waiting for each
// session's next SessionStart hook to re-register it.
describe('sessions_v3 backfill on upgrade', () => {
  it('a sessions_v2-only DB (pre-v3 daemon) surfaces its rows via getRegisteredSession', () => {
    const path = join(dir, 'v2-only.sqlite')
    const raw = new Database(path)
    try {
      raw.exec(`
        CREATE TABLE sessions_v2 (
          cwd TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          claude_session_id TEXT,
          updated_at TEXT NOT NULL
        )
      `)
      // A recent timestamp: backfilled rows past SESSION_RETENTION_MS are (by
      // design) swept by the boot prune — retention has its own describe above.
      raw.prepare('INSERT INTO sessions_v2 (cwd, session_id, project, claude_session_id, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('/tmp/old-proj', 'cc-old', 'old-proj', null, new Date().toISOString())
    } finally {
      raw.close()
    }

    const upgraded = new Store(path)
    try {
      expect(upgraded.getRegisteredSession('cc-old'))
        .toEqual({ sessionId: 'cc-old', cwd: '/tmp/old-proj', project: 'old-proj' })
    } finally {
      upgraded.close()
    }
  })

  it('a legacy sessions-only DB (pre-v2 daemon) chains through both backfills into v3', () => {
    const path = join(dir, 'v1-only.sqlite')
    const raw = new Database(path)
    try {
      raw.exec(`
        CREATE TABLE sessions (
          project TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      raw.prepare('INSERT INTO sessions (project, session_id, cwd, updated_at) VALUES (?, ?, ?, ?)')
        .run('ancient-proj', 'cc-ancient', '/tmp/ancient-proj', new Date().toISOString())
    } finally {
      raw.close()
    }

    const upgraded = new Store(path)
    try {
      expect(upgraded.getRegisteredSession('cc-ancient'))
        .toEqual({ sessionId: 'cc-ancient', cwd: '/tmp/ancient-proj', project: 'ancient-proj' })
    } finally {
      upgraded.close()
    }
  })

  it('the backfill never clobbers a fresher v3 row for the same session id', () => {
    // Same session id present in BOTH v2 (stale cwd) and v3 (fresh cwd): the
    // ON CONFLICT DO NOTHING must keep the v3 row authoritative. The legacy
    // `sessions` row must go stale TOO: leaving it at /tmp/fresh lets the boot
    // sessions→v2 backfill re-seed a fresh-cwd v2 row (the rename vacated the
    // cwd PK slot), which a clobbering v3 backfill would apply LAST in rowid
    // order — landing back on /tmp/fresh and masking the exact regression this
    // test exists to catch (mutation-verified).
    store.recordSession('demo', 'cc-live', '/tmp/fresh')
    const path = join(dir, 'test.sqlite')
    const raw = new Database(path)
    try {
      raw.prepare('UPDATE sessions_v2 SET cwd = ? WHERE session_id = ?').run('/tmp/stale', 'cc-live')
      raw.prepare('UPDATE sessions SET cwd = ? WHERE session_id = ?').run('/tmp/stale', 'cc-live')
    } finally {
      raw.close()
    }
    store.close()

    const reopened = new Store(path)
    try {
      expect(reopened.getRegisteredSession('cc-live')?.cwd).toBe('/tmp/fresh')
    } finally {
      reopened.close()
    }
  })
})
