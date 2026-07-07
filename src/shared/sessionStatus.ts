import type { Card } from './card.js'
import type { CapturedSession } from './session.js'
import { needsHuman, REATTACH_WINDOW_MS } from './needsHuman.js'

export type SessionStatus = 'needs-decision' | 'awaiting-review' | 'running' | 'idle' | 'ended'

const RUNNING_WINDOW_MS = 30 * 60 * 1000

// Inbox status tag for one session — a pure aggregate over its cards + liveness.
// Ranked: the human's obligations outrank liveness (a dead session with an
// undecided card still needs the human). windowMs defaults to the 24h REATTACH_WINDOW_MS
// but callers with access to the daemon's configured reattach window (e.g. the
// /api/sessions route) should pass it through, so a "reconnecting" boot-orphan card
// is judged against the SAME window the queue actually reattaches against (see the
// tray view-model wiring in daemon/api.ts, which threads options.reattachWindowMs).
export function deriveSessionStatus(
  session: Pick<CapturedSession, 'status'>,
  cards: Card[],
  nowMs: number,
  windowMs: number = REATTACH_WINDOW_MS,
): SessionStatus {
  const pendingOnHuman = cards.filter(c => needsHuman(c, nowMs, windowMs))
  if (pendingOnHuman.some(c => c.stage === 'results')) return 'awaiting-review'
  if (pendingOnHuman.length > 0) return 'needs-decision'
  if (session.status === 'ended') return 'ended'
  const lastActivity = Math.max(0, ...cards.map(c => Date.parse(c.decidedAt ?? c.createdAt)))
  return nowMs - lastActivity < RUNNING_WINDOW_MS ? 'running' : 'idle'
}
