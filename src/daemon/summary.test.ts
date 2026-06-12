import { describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { buildSummary } from './summary.js'

function resultsCard(): Card {
  return {
    id: 'c1', stage: 'results',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'done', blocks: [],
    decisions: [
      { id: 'claim:c1', prompt: 'tests pass', options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }], noteRequiredOn: ['deny'] },
      { id: 'claim:c2', prompt: 'docs updated', options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }], noteRequiredOn: ['deny'] },
    ],
    status: 'pending', createdAt: '2026-06-11T00:00:00.000Z',
  }
}

describe('buildSummary — results', () => {
  it('leads with denied claims and their notes', () => {
    const s = buildSummary(resultsCard(), {
      'claim:c1': { chosen: ['deny'], note: 'tests are flaky, rerun and pin the seed' },
      'claim:c2': { chosen: ['approve'] },
    })
    const lines = s.split('\n')
    expect(lines[0]).toMatch(/DENIED/)
    expect(lines[1]).toContain('tests pass')
    expect(lines[1]).toContain('rerun and pin the seed')
    expect(s.indexOf('DENIED')).toBeLessThan(s.indexOf('Approved'))
  })

  it('says all approved when nothing is denied', () => {
    const s = buildSummary(resultsCard(), {
      'claim:c1': { chosen: ['approve'] },
      'claim:c2': { chosen: ['approve'] },
    })
    expect(s).toMatch(/All claims approved/)
  })
})

describe('buildSummary — plan', () => {
  it('leads with the verdict and lists chosen options with labels', () => {
    const card: Card = {
      ...resultsCard(), stage: 'plan',
      decisions: [
        { id: 'd1', prompt: 'Storage?', options: [{ id: 'a', label: 'Cookie' }, { id: 'b', label: 'Local' }] },
        { id: 'plan_verdict', prompt: 'Verdict on this plan', options: [{ id: 'approve', label: 'Approve plan' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }] },
      ],
    }
    const s = buildSummary(card, {
      d1: { chosen: ['a'], note: 'rotate refresh tokens weekly' },
      plan_verdict: { chosen: ['approve'] },
    })
    const lines = s.split('\n')
    expect(lines[0]).toBe('Plan verdict: approve')
    expect(s).toContain('Storage?: Cookie')
    expect(s).toContain('rotate refresh tokens weekly')
  })
})
