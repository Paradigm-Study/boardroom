import type { Card } from './card.js'
import type { CapturedSession } from './session.js'
import { needsHuman } from './needsHuman.js'

export type SessionStatus = 'needs-decision' | 'awaiting-review' | 'running' | 'idle' | 'ended'

const RUNNING_WINDOW_MS = 30 * 60 * 1000

// Inbox status tag for one session — a pure aggregate over its cards + liveness.
// Ranked: the human's obligations outrank liveness (a dead session with an
// undecided card still needs the human).
export function deriveSessionStatus(
  session: Pick<CapturedSession, 'status'>,
  cards: Card[],
  nowMs: number,
): SessionStatus {
  const pendingOnHuman = cards.filter(c => needsHuman(c, nowMs))
  if (pendingOnHuman.some(c => c.stage === 'results')) return 'awaiting-review'
  if (pendingOnHuman.length > 0) return 'needs-decision'
  if (session.status === 'ended') return 'ended'
  const lastActivity = Math.max(0, ...cards.map(c => Date.parse(c.decidedAt ?? c.createdAt)))
  return nowMs - lastActivity < RUNNING_WINDOW_MS ? 'running' : 'idle'
}
