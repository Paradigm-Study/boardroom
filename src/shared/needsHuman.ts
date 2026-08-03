import type { Card } from './card.js'

// How long a daemon-restart-orphaned card stays reattachable, measured from the
// orphan time. The daemon's configured value (config.reattachWindowMs) is
// authoritative and is passed in explicitly by daemon-side callers (the tray
// view-model); this default mirrors it for callers that have no access to the
// configured value (the web dashboard).
export const REATTACH_WINDOW_MS = 24 * 60 * 60_000

// "Reconnecting": a card a daemon restart orphaned (orphanedReason 'boot') out from
// under a live waiter while it was still awaiting a decision, still within the
// reattach window. Surfaced as actionable rather than buried in history, so a
// deploy/restart never silently drops a decision — deciding one still reaches the
// agent via the existing reattach + waker (claude --resume). Disconnect/park orphans
// are deliberately excluded (they stay in history).
// The instant the reattach window is measured from: prefer orphanedAt (when the
// restart orphaned the card), rescue via createdAt. Returns NaN when neither
// parses — callers fail OPEN on that (a corrupt clock is never treated as expired).
// Single source of truth so isReconnecting (the predicate) and the dashboard's
// reattach countdown bar can never disagree about the window's anchor.
export function orphanClockMs(card: Card): number {
  const orphanedAtMs = Date.parse(card.orphanedAt ?? '')
  return Number.isFinite(orphanedAtMs) ? orphanedAtMs : Date.parse(card.createdAt)
}

export function isReconnecting(
  card: Card,
  nowMs: number = Date.now(),
  windowMs: number = REATTACH_WINDOW_MS,
): boolean {
  if (card.status !== 'orphaned' || card.orphanedReason !== 'boot') return false
  // A corrupt/unparseable timestamp must fail OPEN (still reconnecting): NaN would
  // otherwise make the comparison false and silently drop a boot-orphaned gate from
  // every needs-you surface — the exact failure this predicate exists to prevent.
  const t = orphanClockMs(card)
  return !Number.isFinite(t) || nowMs - t < windowMs
}

// The single source of truth for "this card is still on the human's plate": live
// pending, or reconnecting after a restart. Drives the dashboard's Needs-you bucket,
// the badge count, and the menu-bar tray view-model.
export function needsHuman(
  card: Card,
  nowMs: number = Date.now(),
  windowMs: number = REATTACH_WINDOW_MS,
): boolean {
  return card.status === 'pending' || isReconnecting(card, nowMs, windowMs)
}
