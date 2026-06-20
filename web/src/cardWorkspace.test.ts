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
  it('drops the plan verdict from the visible decisions and links each decision to its blocks', () => {
    const workspace = prepareCardWorkspace(card)

    expect(workspace.choiceDecisions.map(d => d.id)).toEqual(['shape'])
    expect(workspace.globalBlocks.map(b => b.id)).toEqual(['intro'])
    expect(workspace.linkedBlocksFor('shape').map(b => b.id)).toEqual(['graph', 'risk'])
  })

  it('summarizes the block counts', () => {
    const workspace = prepareCardWorkspace(card)

    expect(workspace.visualSummary).toEqual({
      totalBlocks: 3,
      linkedBlocks: 2,
    })
  })

  it('drops the results verdict from the visible decisions (it is driven by the submit bar)', () => {
    const results: Card = {
      ...card, id: 'r1', stage: 'results',
      blocks: [],
      decisions: [
        { id: 'claim:a', prompt: 'A', options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] },
        { id: 'results_verdict', prompt: 'Is the session complete?', options: [{ id: 'complete', label: 'Mark complete' }, { id: 'continue', label: 'Keep going' }] },
      ],
    }
    expect(prepareCardWorkspace(results).choiceDecisions.map(d => d.id)).toEqual(['claim:a'])
  })
})
