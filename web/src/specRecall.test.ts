import { describe, expect, it } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { buildSpecRecall } from './specRecall.js'

const crit = (id: string, behavior: string) =>
  ({ id, behavior, good: `${behavior} good`, bad: `${behavior} bad`, tracesTo: 'd1' })

const keepAdjustDrop = [{ id: 'keep', label: 'Keep' }, { id: 'adjust', label: 'Adjust' }, { id: 'drop', label: 'Drop' }]

function specCard(project = 'demo'): Card {
  return {
    id: 'spec1', stage: 'spec',
    session: { agent: 'claude-code', project },
    headline: 'definition of done',
    blocks: [{ id: 'spec_contract', type: 'acceptance', goal: 'ship safely', criteria: [crit('cr1', 'a'), crit('cr2', 'b'), crit('cr3', 'c')] }],
    criteria: [crit('cr1', 'a'), crit('cr2', 'b'), crit('cr3', 'c')],
    decisions: [
      { id: 'crit:cr1', prompt: 'a', criterionId: 'cr1', options: keepAdjustDrop },
      { id: 'crit:cr2', prompt: 'b', criterionId: 'cr2', options: keepAdjustDrop },
      { id: 'crit:cr3', prompt: 'c', criterionId: 'cr3', options: keepAdjustDrop },
      { id: 'spec_verdict', prompt: 'Lock?', options: [{ id: 'lock', label: 'Lock' }, { id: 'revise', label: 'Revise' }] },
    ],
    status: 'decided', createdAt: '2026-06-26T00:00:00.000Z', decidedAt: '2026-06-26T00:01:00.000Z',
    answers: {
      'crit:cr1': { chosen: ['keep'] },
      'crit:cr2': { chosen: ['adjust'], note: 'must also cover refresh tokens' },
      'crit:cr3': { chosen: ['drop'], note: 'out of scope this milestone' },
      spec_verdict: { chosen: ['lock'] },
    },
  }
}

// A results card voting on criteria by id → vote.
function resultsCard(id: string, createdAt: string, votes: Record<string, 'approve' | 'revise' | 'reject'>, project = 'demo'): Card {
  const ids = Object.keys(votes)
  const decisions = ids.map((cid, i) => ({
    id: `claim:c${i}`, prompt: `claim about ${cid}`, criterionId: cid,
    options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }],
    blockRefs: [`c${i}/e`],
  }))
  return {
    id, stage: 'results', session: { agent: 'claude-code', project },
    headline: 'results',
    blocks: ids.map((_, i) => ({ id: `c${i}/e`, type: 'evidence' as const, output: 'proof' })),
    criteria: [crit('cr1', 'a'), crit('cr2', 'b')],
    decisions: [...decisions, { id: 'results_verdict', prompt: 'complete?', options: [{ id: 'complete', label: 'x' }, { id: 'continue', label: 'y' }] }],
    status: 'decided', createdAt, decidedAt: createdAt,
    answers: Object.fromEntries([
      ...ids.map((cid, i) => [`claim:c${i}`, { chosen: [votes[cid]] }]),
      ['results_verdict', { chosen: ['continue'] }],
    ]),
  }
}

describe('buildSpecRecall', () => {
  it('returns undefined for a project with no locked spec card', () => {
    expect(buildSpecRecall([resultsCard('r1', '2026-06-26T01:00:00.000Z', { cr1: 'approve' })], 'demo')).toBeUndefined()
    expect(buildSpecRecall([specCard('other')], 'demo')).toBeUndefined()
  })

  it('reconstructs the locked contract: kept / adjusted / dropped', () => {
    const recall = buildSpecRecall([specCard()], 'demo')!
    expect(recall.goal).toBe('ship safely')
    const byId = Object.fromEntries(recall.criteria.map(c => [c.id, c]))
    expect(byId.cr1.status).toBe('unmet')        // kept, no claims yet
    expect(byId.cr2.adjustedNote).toBe('must also cover refresh tokens')
    expect(byId.cr3.status).toBe('dropped')      // dropped at lock
    // dropped criteria don't count toward the contract total
    expect(recall.total).toBe(2)
    expect(recall.metCount).toBe(0)
  })

  it('marks a criterion MET when any results claim for it was approved, and maps the claims', () => {
    const cards = [
      specCard(),
      resultsCard('r1', '2026-06-26T01:00:00.000Z', { cr1: 'reject', cr2: 'approve' }),
    ]
    const recall = buildSpecRecall(cards, 'demo')!
    const byId = Object.fromEntries(recall.criteria.map(c => [c.id, c]))
    expect(byId.cr1.status).toBe('unmet')   // its only claim was rejected
    expect(byId.cr2.status).toBe('met')     // approved
    expect(recall.metCount).toBe(1)
    // claims are attached with their vote + evidence ref + source card
    expect(byId.cr2.claims[0]).toMatchObject({ vote: 'approve', resultsCardId: 'r1' })
    expect(byId.cr2.claims[0].evidenceRefs).toContain('c1/e')
  })

  it('orders a criterion\'s claims newest results-card first', () => {
    const cards = [
      specCard(),
      resultsCard('older', '2026-06-26T01:00:00.000Z', { cr1: 'reject' }),
      resultsCard('newer', '2026-06-26T02:00:00.000Z', { cr1: 'approve' }),
    ]
    const recall = buildSpecRecall(cards, 'demo')!
    const cr1 = recall.criteria.find(c => c.id === 'cr1')!
    expect(cr1.claims.map(c => c.resultsCardId)).toEqual(['newer', 'older'])
    expect(cr1.status).toBe('met') // approved in the newer card
  })

  it('does NOT recall a spec the human sent back with Revise — only a locked verdict is a contract', () => {
    const revised = specCard()
    revised.answers = { ...revised.answers, spec_verdict: { chosen: ['revise'], note: 'tighten cr2' } }
    expect(buildSpecRecall([revised], 'demo')).toBeUndefined()
  })

  it('recalls the newest LOCKED spec even when a newer revised one exists', () => {
    const locked = specCard()
    const revised = { ...specCard(), id: 'spec2', createdAt: '2026-06-27T00:00:00.000Z', decidedAt: '2026-06-27T00:01:00.000Z' }
    revised.answers = { ...revised.answers, spec_verdict: { chosen: ['revise'], note: 'no' } }
    expect(buildSpecRecall([locked, revised], 'demo')!.specCardId).toBe('spec1')
  })

  it('ignores results cards that predate the locked contract (claims bind to THIS spec, not project history)', () => {
    const cards = [
      specCard(), // decided 2026-06-26T00:01
      resultsCard('ancient', '2026-06-25T00:00:00.000Z', { cr1: 'approve' }), // an older generation's approval
    ]
    const recall = buildSpecRecall(cards, 'demo')!
    const cr1 = recall.criteria.find(c => c.id === 'cr1')!
    expect(cr1.claims).toEqual([])
    expect(cr1.status).toBe('unmet')
  })

  it('carries an "Other…" free-text criterion answer as the adjusted note — the human\'s instruction never vanishes', () => {
    const spec = specCard()
    spec.answers = { ...spec.answers, 'crit:cr1': { chosen: ['__other__'], custom: 'measure it on staging instead' } }
    const recall = buildSpecRecall([spec], 'demo')!
    const cr1 = recall.criteria.find(c => c.id === 'cr1')!
    expect(cr1.status).toBe('unmet') // still in the contract
    expect(cr1.adjustedNote).toBe('measure it on staging instead')
  })
})
