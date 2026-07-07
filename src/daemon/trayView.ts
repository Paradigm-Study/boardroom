import type { Stage } from '../shared/card.js'
import { isReconnecting } from '../shared/needsHuman.js'
import type { Store } from './store.js'

export interface TrayItem {
  id: string
  stage: Stage
  headline: string
  project: string
  // The Claude Code session this card is bound to (session spine key), so the
  // tray can deep-link a click into that session's view. Optional — pre-spine
  // cards and legacy, un-hooked agents never set Card.claudeSessionId.
  claudeSessionId?: string
}

export interface TrayVM {
  total: number
  byStage: Record<Stage, number>
  items: TrayItem[]
}

// Precompute the menu-bar tray's entire view in the daemon — the single owner of
// state — so the tray is a dumb renderer with no business logic. Counts what is still
// on the human's plate: live pending cards plus restart-orphaned ("reconnecting")
// cards within the reattach window (the same predicate the dashboard uses), so the
// badge reflects "lost the daemon, decision survived" rather than dropping to zero.
// Queries by status so a long decided history is never scanned.
export function buildTrayVM(store: Store, nowMs: number, windowMs: number): TrayVM {
  const pending = store.list('pending')
  const reconnecting = store.list('orphaned').filter(c => isReconnecting(c, nowMs, windowMs))
  const actionable = [...pending, ...reconnecting]

  const byStage: Record<Stage, number> = { clarify: 0, plan: 0, spec: 0, results: 0 }
  const items: TrayItem[] = []
  for (const c of actionable) {
    byStage[c.stage]++
    items.push({ id: c.id, stage: c.stage, headline: c.headline, project: c.session.project, claudeSessionId: c.claudeSessionId })
  }

  return { total: actionable.length, byStage, items }
}
