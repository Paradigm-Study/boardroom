import { chmodSync } from 'node:fs'
import Database from 'better-sqlite3'
import { openRecoveringDatabase, ownerOnlyDatabase, refreshLastGood, runMigrations } from './reliability.js'

export type MeshPublishState = 'queued' | 'delivered' | 'terminal'

export interface MeshOutboxEntry {
  idempotencyKey: string
  cardId: string
  event: 'raised' | 'decided'
  record: Record<string, unknown>
  state: MeshPublishState
  attempts: number
  seq?: number
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface MeshOutboxStatus {
  queued: number
  delivered: number
  terminal: number
  lastDeliveredAt?: string
  lastError?: string
}

function toEntry(row: {
  idempotency_key: string
  card_id: string
  event: string
  record_json: string
  state: string
  attempts: number
  seq: number | null
  last_error: string | null
  created_at: string
  updated_at: string
}): MeshOutboxEntry {
  return {
    idempotencyKey: row.idempotency_key,
    cardId: row.card_id,
    event: row.event as MeshOutboxEntry['event'],
    record: JSON.parse(row.record_json) as Record<string, unknown>,
    state: row.state as MeshPublishState,
    attempts: row.attempts,
    ...(row.seq === null ? {} : { seq: row.seq }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Durable, ordered local publisher queue. SQLite owns crash consistency. */
export class MeshOutbox {
  private readonly db: Database.Database
  private readonly path: string
  private closed = false

  constructor(path: string) {
    this.path = path
    this.db = openRecoveringDatabase(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    ownerOnlyDatabase(path)
    runMigrations(this.db, path, 'mesh-outbox', [{
      version: 1,
      name: 'create durable publish outbox',
      up: db => db.exec(`
        CREATE TABLE IF NOT EXISTS mesh_outbox (
          idempotency_key TEXT PRIMARY KEY,
          card_id        TEXT NOT NULL,
          event          TEXT NOT NULL,
          record_json    TEXT NOT NULL,
          state          TEXT NOT NULL DEFAULT 'queued',
          attempts       INTEGER NOT NULL DEFAULT 0,
          seq            INTEGER,
          last_error     TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mesh_outbox_state_order
          ON mesh_outbox(state, created_at);
      `),
    }])
    this.pruneDelivered(new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString())
    refreshLastGood(this.db, path)
    try { chmodSync(path, 0o600) } catch { /* best effort */ }
  }

  /** Insert-before-send. Stable key makes reconciliation/restarts idempotent. */
  enqueue(input: {
    idempotencyKey: string
    cardId: string
    event: MeshOutboxEntry['event']
    record: Record<string, unknown>
    createdAt: string
  }): boolean {
    const result = this.db.prepare(`
      INSERT INTO mesh_outbox
        (idempotency_key, card_id, event, record_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      input.idempotencyKey,
      input.cardId,
      input.event,
      JSON.stringify(input.record),
      input.createdAt,
      new Date().toISOString(),
    )
    return result.changes === 1
  }

  nextQueued(): MeshOutboxEntry | undefined {
    const row = this.db.prepare(`
      SELECT idempotency_key, card_id, event, record_json, state, attempts,
             seq, last_error, created_at, updated_at
        FROM mesh_outbox WHERE state = 'queued'
       ORDER BY created_at ASC, rowid ASC LIMIT 1
    `).get() as Parameters<typeof toEntry>[0] | undefined
    return row ? toEntry(row) : undefined
  }

  markDelivered(key: string, seq?: number): void {
    this.db.prepare(`
      UPDATE mesh_outbox
         SET state = 'delivered', attempts = attempts + 1, seq = ?,
             last_error = NULL, updated_at = ?
       WHERE idempotency_key = ?
    `).run(seq ?? null, new Date().toISOString(), key)
  }

  markTransient(key: string, error: string): void {
    this.db.prepare(`
      UPDATE mesh_outbox
         SET attempts = attempts + 1, last_error = ?, updated_at = ?
       WHERE idempotency_key = ?
    `).run(error.slice(0, 500), new Date().toISOString(), key)
  }

  markTerminal(key: string, error: string): void {
    this.db.prepare(`
      UPDATE mesh_outbox
         SET state = 'terminal', attempts = attempts + 1,
             last_error = ?, updated_at = ?
       WHERE idempotency_key = ?
    `).run(error.slice(0, 500), new Date().toISOString(), key)
  }

  list(limit = 100): MeshOutboxEntry[] {
    const rows = this.db.prepare(`
      SELECT idempotency_key, card_id, event, record_json, state, attempts,
             seq, last_error, created_at, updated_at
        FROM mesh_outbox ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, limit))) as Array<Parameters<typeof toEntry>[0]>
    return rows.map(toEntry)
  }

  status(): MeshOutboxStatus {
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN state = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN state = 'terminal' THEN 1 ELSE 0 END) AS terminal
      FROM mesh_outbox
    `).get() as { queued: number | null; delivered: number | null; terminal: number | null }
    const last = this.db.prepare(`
      SELECT updated_at, last_error FROM mesh_outbox
       WHERE state = 'delivered' OR last_error IS NOT NULL
       ORDER BY updated_at DESC, rowid DESC LIMIT 1
    `).get() as { updated_at: string; last_error: string | null } | undefined
    return {
      queued: counts.queued ?? 0,
      delivered: counts.delivered ?? 0,
      terminal: counts.terminal ?? 0,
      ...(last?.last_error ? { lastError: last.last_error } : {}),
      ...(last && !last.last_error ? { lastDeliveredAt: last.updated_at } : {}),
    }
  }

  /** Delivered receipts are bounded; queued/terminal rows are never pruned. */
  pruneDelivered(beforeIso: string): number {
    return this.db.prepare(
      "DELETE FROM mesh_outbox WHERE state = 'delivered' AND updated_at < ?",
    ).run(beforeIso).changes
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    refreshLastGood(this.db, this.path)
    ownerOnlyDatabase(this.path)
    this.db.close()
  }
}
