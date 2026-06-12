import { describe, expect, it } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { deriveSessions } from './sessions.js'

const NOW = new Date('2026-06-12T12:00:00.000Z').getTime()

function card(project: string, status: Card['status'], createdAt: string, decidedAt?: string): Card {
  return {
    id: `${project}-${createdAt}`, stage: 'clarify',
    session: { agent: 'claude-code', project, title: `${project} work` },
    headline: 'h', blocks: [],
    decisions: [{ id: 'd', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status, createdAt, ...(decidedAt ? { decidedAt } : {}),
  }
}

describe('deriveSessions', () => {
  it('groups by project and derives status', () => {
    const sessions = deriveSessions([
      card('alpha', 'pending', '2026-06-12T11:50:00.000Z'),
      card('alpha', 'decided', '2026-06-12T11:00:00.000Z', '2026-06-12T11:05:00.000Z'),
      card('beta', 'decided', '2026-06-12T11:40:00.000Z', '2026-06-12T11:45:00.000Z'),
      card('gamma', 'orphaned', '2026-06-12T10:00:00.000Z'),
      card('delta', 'decided', '2026-06-12T08:00:00.000Z', '2026-06-12T08:05:00.000Z'),
    ], NOW)

    const byProject = Object.fromEntries(sessions.map(s => [s.project, s]))
    expect(byProject.alpha.status).toBe('waiting')
    expect(byProject.alpha.pending).toBe(1)
    expect(byProject.alpha.total).toBe(2)
    expect(byProject.beta.status).toBe('working')
    expect(byProject.gamma.status).toBe('disconnected')
    expect(byProject.delta.status).toBe('quiet')
  })

  it('sorts waiting first, then working, then the rest', () => {
    const sessions = deriveSessions([
      card('quiet1', 'decided', '2026-06-12T08:00:00.000Z', '2026-06-12T08:00:00.000Z'),
      card('busy', 'pending', '2026-06-12T11:00:00.000Z'),
      card('live', 'decided', '2026-06-12T11:50:00.000Z', '2026-06-12T11:55:00.000Z'),
    ], NOW)
    expect(sessions.map(s => s.project)).toEqual(['busy', 'live', 'quiet1'])
  })
})
