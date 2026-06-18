import { describe, expect, it } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { prepareCardWorkspace } from './cardWorkspace.js'

const card: Card = {
  id: 'c1',
  stage: 'plan',
  session: { agent: 'codex', project: 'boardroom' },
  headline: 'Ship the cockpit',
  blocks: [
    { id: 'intro', type: 'markdown', text: 'Short setup' },
    { id: 'graph', type: 'graph', nodes: [{ id: 'a', label: 'A' }], edges: [] },
    { id: 'risk', type: 'table', columns: ['Risk'], rows: [['Overflow']] },
  ],
  decisions: [
    {
      id: 'shape',
      prompt: 'Card shape?',
      blockRefs: ['graph', 'risk'],
      options: [
        { id: 'cockpit', label: 'Cockpit', recommended: true },
        { id: 'wizard', label: 'Wizard' },
      ],
    },
    {
      id: 'plan_verdict',
      prompt: 'Plan verdict?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'revise', label: 'Revise' },
      ],
    },
  ],
  status: 'pending',
  createdAt: '2026-06-16T12:00:00.000Z',
}

describe('prepareCardWorkspace', () => {
  it('separates plan verdict from visible decisions and preserves visual block order', () => {
    const workspace = prepareCardWorkspace(card)

    expect(workspace.choiceDecisions.map(d => d.id)).toEqual(['shape'])
    expect(workspace.planVerdict?.id).toBe('plan_verdict')
    expect(workspace.visualBlocks.map(b => b.id)).toEqual(['graph', 'risk', 'intro'])
    expect(workspace.globalBlocks.map(b => b.id)).toEqual(['intro'])
    expect(workspace.backgroundBlocks.map(b => b.id)).toEqual(['intro'])
    expect(workspace.linkedBlocksFor('shape').map(b => b.id)).toEqual(['graph', 'risk'])
  })

  it('exposes the recommended choice for quick decision paths', () => {
    const workspace = prepareCardWorkspace(card)

    expect(workspace.recommendedByDecision.get('shape')?.id).toBe('cockpit')
    expect(workspace.visualSummary).toEqual({
      totalBlocks: 3,
      linkedBlocks: 2,
      backgroundBlocks: 1,
    })
  })
})
