import Database from 'better-sqlite3'
import { Card, type CardStatus } from '../shared/card.js'

export class Store {
  private db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
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
  }

  recordSession(project: string, sessionId: string, cwd: string): void {
    this.db.prepare(
      `INSERT INTO sessions (project, session_id, cwd, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project) DO UPDATE SET session_id = excluded.session_id, cwd = excluded.cwd, updated_at = excluded.updated_at`,
    ).run(project, sessionId, cwd, new Date().toISOString())
  }

  getSession(project: string): { sessionId: string; cwd: string } | undefined {
    const row = this.db.prepare('SELECT session_id, cwd FROM sessions WHERE project = ?').get(project) as
      | { session_id: string; cwd: string }
      | undefined
    return row ? { sessionId: row.session_id, cwd: row.cwd } : undefined
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
    for (const card of pending) this.update({ ...card, status: 'orphaned' })
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
      (c.status === 'orphaned' && nowMs - Date.parse(c.createdAt) < windowMs),
    )
    return eligible.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  }

  close(): void {
    this.db.close()
  }
}
