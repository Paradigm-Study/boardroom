import type { Entry } from '../../src/shared/entry.js'

// Local (per-browser) read-tracking for report entries, mirroring the sessionScroll
// read/write pattern in App.tsx (readSessionScroll / writeSessionScroll): try/catch
// everywhere, so a full or unavailable localStorage never breaks the dashboard —
// it just means nothing is remembered as read.
const STORAGE_KEY = 'boardroom.readEntries.v1'
const READ_TTL_MS = 14 * 24 * 60 * 60_000
const READ_MAX_ENTRIES = 200

function readStore(now = Date.now()): Map<string, number> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()

    const ids = new Map<string, number>()
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      if (now - value > READ_TTL_MS) continue
      ids.set(id, value)
    }
    return ids
  } catch {
    return new Map()
  }
}

function writeStore(ids: Map<string, number>, now = Date.now()): void {
  try {
    for (const [id, markedAt] of ids) {
      if (now - markedAt > READ_TTL_MS) ids.delete(id)
    }
    const ordered = [...ids.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, READ_MAX_ENTRIES)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(ordered)))
  } catch {
    // Read tracking is a convenience; the dashboard must keep working if storage
    // is unavailable or quota-restricted.
  }
}

export function markRead(entryId: string): void {
  const ids = readStore()
  ids.set(entryId, Date.now())
  writeStore(ids)
}

export function isRead(entryId: string): boolean {
  return readStore().has(entryId)
}

// Unread count for the report feed. Tag entries are ambient annotations on a card
// (not a standalone item the human must act on or dismiss) — they never count
// toward "unread", regardless of read-state.
export function unreadCount(entries: Entry[]): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type !== 'report') continue
    if (!isRead(entry.id)) count++
  }
  return count
}
