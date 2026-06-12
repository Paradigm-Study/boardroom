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

  close(): void {
    this.db.close()
  }
}
