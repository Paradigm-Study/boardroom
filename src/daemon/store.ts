import { chmodSync, existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { Card, type CardStatus } from '../shared/card.js'
import { CapturedSession } from '../shared/session.js'

export class Store {
  private db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    // Lock the DB (and WAL/SHM siblings, if present) so other local users can't
    // read captured paths / card contents. :memory: has no file. Production also
    // sets a 0077 umask (index.ts) so lazily-created WAL/SHM are born locked.
    if (path !== ':memory:') {
      try {
        chmodSync(path, 0o600)
        for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) chmodSync(path + ext, 0o600)
      } catch { /* best-effort */ }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
      )
    `)
    // Maps a project to the Claude Code session that last reported it (via the
    // SessionStart hook), so the Phase 2 waker can `claude --resume <sessionId>`
    // from the correct absolute cwd when a parked card is decided. One row per
    // project (most recent session wins).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        project TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    // Worktree-safe registry, keyed on the ABSOLUTE cwd (not basename). Two
    // checkouts of one repo share `basename(cwd)` but never a cwd, so they get
    // distinct rows here — where the legacy `sessions` table (project PK) would
    // clobber one with the other and let the waker resume into the wrong tree.
    // `claude_session_id` is RESERVED for Part 2 (exact-session disambiguation):
    // no producer populates it yet — the SessionStart hook posts only
    // sessionId/cwd/project — so it is currently always NULL and the waker
    // resolves by project. See docs/superpowers/specs (session-capture design).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_v2 (
        cwd TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        claude_session_id TEXT,
        updated_at TEXT NOT NULL
      )
    `)
    // One-time backfill so a DB written by a pre-cwd-keyed daemon keeps auto-wake
    // working immediately after upgrade (the waker reads sessions_v2 only). Each
    // legacy row carries a cwd, so it maps cleanly; idempotent (DO NOTHING) and a
    // no-op once the row is registered fresh. `WHERE true` disambiguates the
    // INSERT…SELECT…ON CONFLICT grammar in SQLite.
    this.db.exec(`
      INSERT INTO sessions_v2 (cwd, session_id, project, claude_session_id, updated_at)
      SELECT cwd, session_id, project, NULL, updated_at FROM sessions WHERE true
      ON CONFLICT(cwd) DO NOTHING
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS captured_sessions (
        session_id TEXT PRIMARY KEY,
        json       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  recordSession(project: string, sessionId: string, cwd: string, claudeSessionId?: string): void {
    const ts = new Date().toISOString()
    // Both writes in one transaction so the legacy and cwd-keyed tables can never
    // drift if the second INSERT throws (SQLITE_FULL/IOERR).
    this.db.transaction(() => {
      // Legacy project-keyed table, preserved for back-compat (callers of getSession).
      this.db.prepare(
        `INSERT INTO sessions (project, session_id, cwd, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd, updated_at = excluded.updated_at`,
      ).run(project, sessionId, cwd, ts)
      // Worktree-safe cwd-keyed table — the authoritative one for resume targeting.
      this.db.prepare(
        `INSERT INTO sessions_v2 (cwd, session_id, project, claude_session_id, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cwd) DO UPDATE SET session_id = excluded.session_id, project = excluded.project,
           claude_session_id = COALESCE(excluded.claude_session_id, claude_session_id), updated_at = excluded.updated_at`,
      ).run(cwd, sessionId, project, claudeSessionId ?? null, ts)
    })()
  }

  getSession(project: string): { sessionId: string; cwd: string } | undefined {
    const row = this.db.prepare('SELECT session_id, cwd FROM sessions WHERE project = ?').get(project) as
      | { session_id: string; cwd: string }
      | undefined
    return row ? { sessionId: row.session_id, cwd: row.cwd } : undefined
  }

  getSessionByCwd(cwd: string): SessionRow | undefined {
    return toSessionRow(
      this.db.prepare('SELECT session_id, cwd, claude_session_id FROM sessions_v2 WHERE cwd = ?').get(cwd),
    )
  }

  // FAIL-CLOSED like getSessionByProject: a claude session id that maps to more
  // than one row is ambiguous (resuming either could be the wrong tree), so return
  // undefined rather than a nondeterministic .get() row.
  getSessionById(claudeSessionId: string): SessionRow | undefined {
    const rows = this.db
      .prepare('SELECT session_id, cwd, claude_session_id FROM sessions_v2 WHERE claude_session_id = ?')
      .all(claudeSessionId)
    return rows.length === 1 ? toSessionRow(rows[0]) : undefined
  }

  // FAIL-CLOSED resolve-by-basename: returns a row only when EXACTLY ONE session
  // maps to this project name. Two same-basename worktrees → undefined, so the
  // waker declines to auto-resume (copy-paste fallback) rather than resume into a
  // guessed/wrong tree. The card carries only `project` (basename), so this is the
  // best safe resolution when no Claude session id is available.
  getSessionByProject(project: string): SessionRow | undefined {
    const rows = this.db
      .prepare('SELECT session_id, cwd, claude_session_id FROM sessions_v2 WHERE project = ?')
      .all(project)
    return rows.length === 1 ? toSessionRow(rows[0]) : undefined
  }

  // Validate on the way in so a malformed card can never reach SQLite — the read
  // path then trusts that every stored row started life as a well-formed Card.
  insert(card: Card): void {
    const valid = Card.parse(card)
    this.db.prepare('INSERT INTO cards (id, status, created_at, json) VALUES (?, ?, ?, ?)')
      .run(valid.id, valid.status, valid.createdAt, JSON.stringify(valid))
  }

  update(card: Card): void {
    const valid = Card.parse(card)
    this.db.prepare('UPDATE cards SET status = ?, json = ? WHERE id = ?')
      .run(valid.status, JSON.stringify(valid), valid.id)
  }

  // Skip — never throw on — a row that fails validation (a legacy/schema-drifted
  // or hand-edited/corrupt row). A single bad row must not crash boot
  // (orphanAllPending) or the inbox (GET /api/cards); it is logged and omitted.
  private parseRow(json: string): Card | undefined {
    let raw: unknown
    try {
      raw = JSON.parse(json)
    } catch {
      console.warn('[store] skipping a card row with invalid JSON')
      return undefined
    }
    const result = Card.safeParse(raw)
    if (result.success) return result.data
    const id = (raw as { id?: string } | null)?.id
    console.warn(`[store] skipping card ${id ?? '<unknown>'} that failed schema validation: ${result.error.issues[0]?.message}`)
    return undefined
  }

  get(id: string): Card | undefined {
    const row = this.db.prepare('SELECT json FROM cards WHERE id = ?').get(id) as { json: string } | undefined
    return row ? this.parseRow(row.json) : undefined
  }

  list(status?: CardStatus): Card[] {
    const rows = (status
      ? this.db.prepare('SELECT json FROM cards WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.db.prepare('SELECT json FROM cards ORDER BY created_at DESC').all()) as { json: string }[]
    return rows.map(r => this.parseRow(r.json)).filter((c): c is Card => c !== undefined)
  }

  orphanAllPending(): number {
    const pending = this.list('pending')
    const ts = new Date().toISOString()
    for (const card of pending) this.update({ ...card, status: 'orphaned', orphanedAt: ts })
    return pending.length
  }

  // A retried/reconnecting tool call reattaches to a prior card with the same
  // fingerprint when it is either decided-but-never-delivered (claim the answer
  // made while the agent was away — any age) or orphaned within the window (the
  // agent dropped, e.g. machine slept, and came back before a decision). Pending
  // cards are never targets — they still have a live waiter; stealing it would be
  // wrong. Most recent match wins.
  findReattachable(fingerprint: string | undefined, nowMs: number, windowMs = 24 * 60 * 60_000): Card | undefined {
    if (!fingerprint) return undefined
    const matches = this.list().filter(c => c.fingerprint === fingerprint)
    const eligible = matches.filter(c =>
      (c.status === 'decided' && !c.deliveredAt) ||
      (c.status === 'orphaned' && nowMs - Date.parse(c.orphanedAt ?? c.createdAt) < windowMs),
    )
    return eligible.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  }

  // Observe-all session capture (separate from the hook-fed `sessions` table the
  // waker reads — registry capture must never influence `claude --resume`).
  upsertCaptured(session: CapturedSession): void {
    const valid = CapturedSession.parse(session)
    const existing = this.getCaptured(valid.sessionId)
    const toStore: CapturedSession = existing
      ? { ...valid, capturedAt: existing.capturedAt } // first-capture time is sticky
      : valid
    this.db.prepare(
      `INSERT INTO captured_sessions (session_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    ).run(toStore.sessionId, JSON.stringify(toStore), new Date().toISOString())
  }

  // Mirror parseRow for captured rows: a corrupt/hand-edited JSON row (partial
  // write on SQLITE_FULL/IOERR, disk corruption) must be skipped, never thrown —
  // a SyntaxError here would otherwise 500 GET /api/sessions and block
  // upsertCaptured's overwrite-to-self-heal.
  private parseCapturedRow(json: string): CapturedSession | undefined {
    let raw: unknown
    try {
      raw = JSON.parse(json)
    } catch {
      console.warn('[store] skipping a captured_sessions row with invalid JSON')
      return undefined
    }
    const result = CapturedSession.safeParse(raw)
    return result.success ? result.data : undefined
  }

  getCaptured(sessionId: string): CapturedSession | undefined {
    const row = this.db.prepare('SELECT json FROM captured_sessions WHERE session_id = ?').get(sessionId) as
      | { json: string } | undefined
    return row ? this.parseCapturedRow(row.json) : undefined
  }

  listCaptured(): CapturedSession[] {
    const rows = this.db.prepare(
      'SELECT json FROM captured_sessions ORDER BY updated_at DESC, session_id ASC',
    ).all() as { json: string }[]
    return rows
      .map(r => this.parseCapturedRow(r.json))
      .filter((c): c is CapturedSession => c !== undefined)
  }

  close(): void {
    this.db.close()
  }
}

export interface SessionRow {
  sessionId: string
  cwd: string
  claudeSessionId?: string
}

function toSessionRow(row: unknown): SessionRow | undefined {
  if (!row || typeof row !== 'object') return undefined
  const r = row as { session_id?: unknown; cwd?: unknown; claude_session_id?: unknown }
  if (typeof r.session_id !== 'string' || typeof r.cwd !== 'string') return undefined
  return {
    sessionId: r.session_id,
    cwd: r.cwd,
    ...(typeof r.claude_session_id === 'string' ? { claudeSessionId: r.claude_session_id } : {}),
  }
}
