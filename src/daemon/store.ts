import { chmodSync, existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { Card, type CardStatus } from '../shared/card.js'
import { Entry } from '../shared/entry.js'
import { REATTACH_WINDOW_MS } from '../shared/needsHuman.js'
import { CapturedSession } from '../shared/session.js'
import { openRecoveringDatabase, refreshLastGood, runMigrations } from './reliability.js'

// How long a sessions_v3 row outlives its last SessionStart before the boot
// sweep drops it. Far beyond REATTACH_WINDOW_MS (24h, measured from decision
// time): a card can park for days before the human decides, and the waker still
// needs the row then. 30 idle days safely exceeds any real park while keeping
// the one-row-per-session table from growing forever.
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60_000

export class Store {
  private db: Database.Database
  private path: string

  constructor(path: string) {
    this.path = path
    this.db = openRecoveringDatabase(path)
    this.db.pragma('journal_mode = WAL')
    runMigrations(this.db, path, 'boardroom', [{
      version: 1,
      name: 'baseline card session and entry schema',
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS cards (
          id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          project TEXT PRIMARY KEY, session_id TEXT NOT NULL, cwd TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions_v2 (
          cwd TEXT PRIMARY KEY, session_id TEXT NOT NULL, project TEXT NOT NULL,
          claude_session_id TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions_v3 (
          session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, project TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS captured_sessions (
          session_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, session_id TEXT,
          created_at TEXT NOT NULL, json TEXT NOT NULL
        );
      `),
    }])
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
    // `claude_session_id` is a DEAD column: it was reserved for exact-session
    // disambiguation, which sessions_v3 (session-id PK, below) now provides.
    // Nothing reads or writes it; it stays in the schema only so fresh and
    // pre-existing DBs keep identical shapes (a rolled-back daemon still boots).
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
      INSERT INTO sessions_v2 (cwd, session_id, project, updated_at)
      SELECT cwd, session_id, project, updated_at FROM sessions WHERE true
      ON CONFLICT(cwd) DO NOTHING
    `)
    // Session-id-keyed registry (the session spine). Unlike sessions_v2 (cwd PK,
    // where a re-launch in the same cwd overwrites the previous session's row —
    // the cross-session steal), one row PER SESSION survives concurrent and
    // sequential sessions sharing a cwd. The waker resolves resume targets here
    // by the card's claudeSessionId.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_v3 (
        session_id TEXT PRIMARY KEY,
        cwd        TEXT NOT NULL,
        project    TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      INSERT INTO sessions_v3 (session_id, cwd, project, updated_at)
      SELECT session_id, cwd, project, updated_at FROM sessions_v2 WHERE true
      ON CONFLICT(session_id) DO NOTHING
    `)
    // One row per session id means unbounded growth (unlike the project/cwd-keyed
    // tables, which upsert in place). Sweep rows idle past the retention window at
    // boot — after the backfill, so ancient migrated rows are pruned too. ISO-8601
    // UTC strings compare correctly as text. Losing a row only disables auto-wake
    // (`claude --resume`) for that session; reattach-by-fingerprint still works,
    // and a session that starts again simply re-registers.
    this.db.prepare('DELETE FROM sessions_v3 WHERE updated_at < ?')
      .run(new Date(Date.now() - SESSION_RETENTION_MS).toISOString())
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS captured_sessions (
        session_id TEXT PRIMARY KEY,
        json       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id         TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL,
        json       TEXT NOT NULL
      )
    `)
    refreshLastGood(this.db, path)
  }

  recordSession(project: string, sessionId: string, cwd: string): void {
    const ts = new Date().toISOString()
    // All writes in one transaction so the legacy, cwd-keyed, and session-id-keyed
    // tables can never drift if a later INSERT throws (SQLITE_FULL/IOERR).
    this.db.transaction(() => {
      // Legacy project-keyed table, preserved for back-compat (callers of getSession).
      this.db.prepare(
        `INSERT INTO sessions (project, session_id, cwd, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd, updated_at = excluded.updated_at`,
      ).run(project, sessionId, cwd, ts)
      // Worktree-safe cwd-keyed table — the authoritative one for resume targeting.
      this.db.prepare(
        `INSERT INTO sessions_v2 (cwd, session_id, project, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(cwd) DO UPDATE SET session_id = excluded.session_id, project = excluded.project,
           updated_at = excluded.updated_at`,
      ).run(cwd, sessionId, project, ts)
      // Session-id-keyed registry: immune to same-cwd overwrite, one row per session.
      this.db.prepare(
        `INSERT INTO sessions_v3 (session_id, cwd, project, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET cwd = excluded.cwd, project = excluded.project, updated_at = excluded.updated_at`,
      ).run(sessionId, cwd, project, ts)
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
      this.db.prepare('SELECT session_id, cwd FROM sessions_v2 WHERE cwd = ?').get(cwd),
    )
  }

  // FAIL-CLOSED resolve-by-basename: returns a row only when EXACTLY ONE session
  // maps to this project name. Two same-basename worktrees → undefined, so the
  // waker declines to auto-resume (copy-paste fallback) rather than resume into a
  // guessed/wrong tree. The card carries only `project` (basename), so this is the
  // best safe resolution when no Claude session id is available.
  getSessionByProject(project: string): SessionRow | undefined {
    const rows = this.db
      .prepare('SELECT session_id, cwd FROM sessions_v2 WHERE project = ?')
      .all(project)
    return rows.length === 1 ? toSessionRow(rows[0]) : undefined
  }

  // Exact spine lookup: the card carries claudeSessionId, this returns where to
  // `claude --resume` it. No ambiguity possible — session_id is the PK.
  getRegisteredSession(claudeSessionId: string): { sessionId: string; cwd: string; project: string } | undefined {
    const row = this.db
      .prepare('SELECT session_id, cwd, project FROM sessions_v3 WHERE session_id = ?')
      .get(claudeSessionId) as { session_id: string; cwd: string; project: string } | undefined
    return row ? { sessionId: row.session_id, cwd: row.cwd, project: row.project } : undefined
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
    // Tag the reason 'boot' so the dashboard can resurface these as actionable
    // ("reconnecting") instead of burying them in history — a deploy/restart must
    // never silently drop a decision the human was still on the hook for.
    for (const card of pending) {
      this.update({ ...card, status: 'orphaned', orphanedAt: ts, orphanedReason: 'boot' })
    }
    return pending.length
  }

  // A retried/reconnecting tool call reattaches to a prior card with the same
  // fingerprint AND the same session scope when it is either
  // decided-but-never-delivered within the window measured from DECISION time
  // (claim the answer made while the agent was away — a card parked for days
  // stays claimable for a full window after the human finally decides) or
  // orphaned within the window measured from orphan time (the agent dropped,
  // e.g. machine slept, and came back before a decision). Decided claims are
  // deliberately NOT unbounded: fingerprints are formulaic (project+stage+
  // headline), so a stale undelivered verdict left claimable forever would
  // eventually resolve an UNRELATED session's identical-looking gate with
  // weeks-old answers — an auto-accept the human never made. Pending cards are
  // never targets — they still have a live waiter; stealing it would be wrong.
  //
  // Session scope (session-scoped reattach): a caller bound to Claude session S
  // (caller.claudeSessionId === S) may only reclaim cards ALSO bound to S — a
  // fingerprint collision from a different session (or a different repo clone
  // hitting the same project+stage+headline) is no longer enough to steal a
  // card, because that card was never this caller's to begin with. A caller
  // with no claudeSessionId (a legacy, un-hooked agent) may only reclaim cards
  // that ALSO have no claudeSessionId — preserving the original fingerprint-only
  // behavior for agents that predate session binding, without letting them
  // reach into a session-bound card or vice versa. Most recent match wins.
  findReattachable(
    caller: Pick<Card, 'fingerprint' | 'claudeSessionId'>,
    nowMs: number,
    windowMs = REATTACH_WINDOW_MS,
  ): Card | undefined {
    if (!caller.fingerprint) return undefined
    const matches = this.list().filter(c =>
      c.fingerprint === caller.fingerprint &&
      (caller.claudeSessionId ? c.claudeSessionId === caller.claudeSessionId : c.claudeSessionId === undefined),
    )
    const eligible = matches.filter(c =>
      (c.status === 'decided' && !c.deliveredAt && nowMs - Date.parse(c.decidedAt ?? c.createdAt) < windowMs) ||
      (c.status === 'orphaned' && nowMs - Date.parse(c.orphanedAt ?? c.createdAt) < windowMs),
    )
    return eligible.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  }

  // The session's LIVE-or-reattachable gate of a given stage — the reconnect target
  // `findReattachable` deliberately misses. Boardroom runs one gate per stage at a
  // time per session, so a still-PENDING same-session+stage card (the caller re-issued
  // before the daemon observed the previous request's socket close — the pending-race)
  // or an orphaned one whose HEADLINE changed (an adjusted re-issue → a different
  // fingerprint) is the SAME logical gate, not a duplicate. Matched by session id +
  // stage (not fingerprint), so both cases coalesce onto the one card.
  //
  // Session-scoped ONLY: an un-hooked caller (no claudeSessionId) has no durable
  // identity, so it gets no match here — its "no stealing a live pending card"
  // guarantee (findReattachable's fingerprint-only, orphaned-only path) is preserved.
  // Most recent wins, mirroring findReattachable's tiebreak.
  findSessionGate(
    caller: Pick<Card, 'claudeSessionId' | 'stage'>,
    nowMs: number,
    windowMs = REATTACH_WINDOW_MS,
  ): Card | undefined {
    if (!caller.claudeSessionId) return undefined
    const matches = this.list().filter(c =>
      c.claudeSessionId === caller.claudeSessionId &&
      c.stage === caller.stage &&
      (c.status === 'pending' ||
        (c.status === 'orphaned' && nowMs - Date.parse(c.orphanedAt ?? c.createdAt) < windowMs)),
    )
    return matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
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
    if (result.success) return result.data
    const sid = (raw as { sessionId?: string } | null)?.sessionId
    console.warn(`[store] skipping captured session ${sid ?? '<unknown>'} that failed schema validation: ${result.error.issues[0]?.message}`)
    return undefined
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

  // Validate on the way in so a malformed entry can never reach SQLite — the read
  // path then trusts that every stored row started life as a well-formed Entry.
  insertEntry(entry: Entry): void {
    const valid = Entry.parse(entry)
    this.db.prepare('INSERT INTO entries (id, type, session_id, created_at, json) VALUES (?, ?, ?, ?, ?)')
      .run(valid.id, valid.type, valid.claudeSessionId ?? null, valid.createdAt, JSON.stringify(valid))
  }

  // Skip — never throw on — a row that fails validation (a legacy/schema-drifted
  // or hand-edited/corrupt row). A single bad row must not crash boot or listing;
  // it is logged and omitted.
  private parseEntryRow(json: string): Entry | undefined {
    let raw: unknown
    try {
      raw = JSON.parse(json)
    } catch {
      console.warn('[store] skipping an entries row with invalid JSON')
      return undefined
    }
    const result = Entry.safeParse(raw)
    if (result.success) return result.data
    const id = (raw as { id?: string } | null)?.id
    console.warn(`[store] skipping entry ${id ?? '<unknown>'} that failed schema validation: ${result.error.issues[0]?.message}`)
    return undefined
  }

  listEntries(): Entry[] {
    const rows = this.db.prepare(
      'SELECT json FROM entries ORDER BY created_at ASC, id ASC',
    ).all() as { json: string }[]
    return rows
      .map(r => this.parseEntryRow(r.json))
      .filter((e): e is Entry => e !== undefined)
  }

  listEntriesBySession(claudeSessionId: string): Entry[] {
    const rows = this.db.prepare(
      'SELECT json FROM entries WHERE session_id = ? ORDER BY created_at ASC, id ASC',
    ).all(claudeSessionId) as { json: string }[]
    return rows
      .map(r => this.parseEntryRow(r.json))
      .filter((e): e is Entry => e !== undefined)
  }

  close(): void {
    if (!this.db.open) return
    refreshLastGood(this.db, this.path)
    this.db.close()
  }
}

export interface SessionRow {
  sessionId: string
  cwd: string
}

function toSessionRow(row: unknown): SessionRow | undefined {
  if (!row || typeof row !== 'object') return undefined
  const r = row as { session_id?: unknown; cwd?: unknown }
  if (typeof r.session_id !== 'string' || typeof r.cwd !== 'string') return undefined
  return { sessionId: r.session_id, cwd: r.cwd }
}
