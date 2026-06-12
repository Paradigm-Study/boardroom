import type { Card } from '../../src/shared/card.js'

export type SessionStatus = 'waiting' | 'working' | 'disconnected' | 'quiet'

export interface SessionEntry {
  project: string
  title?: string
  agent: string
  pending: number
  total: number
  status: SessionStatus
  latestAt: string
}

const WORKING_WINDOW_MS = 30 * 60_000

export function deriveSessions(cards: Card[], now: number = Date.now()): SessionEntry[] {
  const byProject = new Map<string, Card[]>()
  for (const c of cards) {
    const list = byProject.get(c.session.project) ?? []
    list.push(c)
    byProject.set(c.session.project, list)
  }

  const entries: SessionEntry[] = []
  for (const [project, list] of byProject) {
    const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const latest = sorted[0]
    const pending = list.filter(c => c.status === 'pending').length

    let status: SessionStatus
    if (pending > 0) status = 'waiting'
    else if (latest.status === 'orphaned') status = 'disconnected'
    else {
      const lastActivity = new Date(latest.decidedAt ?? latest.createdAt).getTime()
      status = now - lastActivity < WORKING_WINDOW_MS ? 'working' : 'quiet'
    }

    entries.push({
      project,
      title: latest.session.title,
      agent: latest.session.agent,
      pending,
      total: list.length,
      status,
      latestAt: latest.createdAt,
    })
  }

  const rank: Record<SessionStatus, number> = { waiting: 0, working: 1, disconnected: 2, quiet: 3 }
  return entries.sort((a, b) =>
    rank[a.status] - rank[b.status] || b.latestAt.localeCompare(a.latestAt),
  )
}

export function statusLabel(s: SessionEntry): string {
  switch (s.status) {
    case 'waiting': return `waiting on you · ${s.pending}`
    case 'working': return 'agent working'
    case 'disconnected': return 'disconnected'
    case 'quiet': return 'quiet'
  }
}
