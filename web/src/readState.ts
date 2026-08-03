import type { Entry } from '../../src/shared/entry.js'

// Local (per-browser) read-tracking for report entries, mirroring the sessionScroll
// read/write pattern in App.tsx (readSessionScroll / writeSessionScroll): try/catch
// everywhere, so a full or unavailable localStorage never breaks the dashboard —
// it just means nothing is remembered as read.
const STORAGE_KEY = 'boardroom.readEntries.v1'
// Exported: also the age-implies-read threshold (see isImplicitlyRead below) — a
// single constant governs both "how long we remember an explicit read" and "how
// old before we stop caring whether it was ever explicitly read".
export const READ_TTL_MS = 14 * 24 * 60 * 60_000
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

// ── Reactivity ─────────────────────────────────────────────────────────────
// markRead is the only writer, but it fires deep in the tree (ReportDrawer's
// mount effect) while the surfaces showing unread state (stream dots, the
// sidebar aggregate) read localStorage during THEIR render — without a change
// signal they'd stay stale until some unrelated re-render. A version counter +
// listener set is the whole store; React surfaces subscribe via
// useSyncExternalStore(subscribeReadState, readStateVersion).
let version = 0
const listeners = new Set<() => void>()

export function subscribeReadState(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function readStateVersion(): number {
  return version
}

export function markRead(entryId: string): void {
  const ids = readStore()
  ids.set(entryId, Date.now())
  writeStore(ids)
  version++
  for (const listener of listeners) listener()
}

export function isRead(entryId: string): boolean {
  return readStore().has(entryId)
}

// One localStorage read for callers that need read-state for MANY entries in a
// single render pass (e.g. the sidebar computing an unread dot per session) —
// isRead()/unreadCount() each re-read+re-parse localStorage per call, which is
// fine for a single entry but O(entries × storage-read) across a whole sidebar.
// Call this once per render and check membership against the returned Set instead.
export function readEntrySet(): Set<string> {
  return new Set(readStore().keys())
}

// Age-implies-read: the read-tracking store below has a READ_TTL_MS cap (both a
// TTL and a 200-id cap), so it forgets explicit reads over time — but entries
// themselves are permanent. Without this, a report read >14 days ago would fall
// out of storage and flip back to "unread" forever, re-lighting old dots. Once an
// entry is older than READ_TTL_MS, treat it as read regardless of stored state —
// nothing that old should still be nagging the human as fresh/unread.
export function isImplicitlyRead(entry: Entry, now = Date.now()): boolean {
  const createdAt = Date.parse(entry.createdAt)
  if (!Number.isFinite(createdAt)) return false
  return now - createdAt > READ_TTL_MS
}

// Unread count for the report feed. Tag entries are ambient annotations on a card
// (not a standalone item the human must act on or dismiss) — they never count
// toward "unread", regardless of read-state.
export function unreadCount(entries: Entry[], now = Date.now()): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type !== 'report') continue
    if (isImplicitlyRead(entry, now)) continue
    if (!isRead(entry.id)) count++
  }
  return count
}
