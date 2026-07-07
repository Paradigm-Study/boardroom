import { describe, expect, it } from 'vitest'
import { deriveSessionStatus } from './sessionStatus.js'
import type { Card } from './card.js'

const NOW = Date.parse('2026-07-02T12:00:00.000Z')
const mk = (over: Partial<Card>): Card => ({
  id: 'c', stage: 'clarify', session: { agent: 'a', project: 'p' }, headline: 'h',
  blocks: [], decisions: [{ id: 'd', prompt: 'q', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] }],
  status: 'pending', createdAt: '2026-07-02T11:59:00.000Z', ...over,
} as Card)

describe('deriveSessionStatus', () => {
  it('pending results card → awaiting-review (outranks needs-decision)', () => {
    const cards = [mk({ stage: 'results' }), mk({ id: 'c2' })]
    expect(deriveSessionStatus({ status: 'alive' }, cards, NOW)).toBe('awaiting-review')
  })
  it('pending non-results card → needs-decision', () => {
    expect(deriveSessionStatus({ status: 'alive' }, [mk({})], NOW)).toBe('needs-decision')
  })
  it('ended session with nothing pending → ended', () => {
    expect(deriveSessionStatus({ status: 'ended' }, [mk({ status: 'decided', decidedAt: '2026-07-02T11:00:00.000Z' })], NOW)).toBe('ended')
  })
  it('alive + recent decided activity → running', () => {
    expect(deriveSessionStatus({ status: 'alive' }, [mk({ status: 'decided', decidedAt: '2026-07-02T11:45:00.000Z' })], NOW)).toBe('running')
  })
  it('alive + stale activity → idle; alive + no cards → idle', () => {
    expect(deriveSessionStatus({ status: 'alive' }, [mk({ status: 'decided', decidedAt: '2026-07-02T09:00:00.000Z' })], NOW)).toBe('idle')
    expect(deriveSessionStatus({ status: 'alive' }, [], NOW)).toBe('idle')
  })
})
