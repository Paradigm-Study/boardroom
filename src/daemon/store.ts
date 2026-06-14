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
  }

  insert(card: Card): void {
    this.db.prepare('INSERT INTO cards (id, status, created_at, json) VALUES (?, ?, ?, ?)')
      .run(card.id, card.status, card.createdAt, JSON.stringify(card))
  }

  update(card: Card): void {
    this.db.prepare('UPDATE cards SET status = ?, json = ? WHERE id = ?')
      .run(card.status, JSON.stringify(card), card.id)
  }

  get(id: string): Card | undefined {
    const row = this.db.prepare('SELECT json FROM cards WHERE id = ?').get(id) as { json: string } | undefined
    return row ? Card.parse(JSON.parse(row.json)) : undefined
  }

  list(status?: CardStatus): Card[] {
    const rows = (status
      ? this.db.prepare('SELECT json FROM cards WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.db.prepare('SELECT json FROM cards ORDER BY created_at DESC').all()) as { json: string }[]
    return rows.map(r => Card.parse(JSON.parse(r.json)))
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
