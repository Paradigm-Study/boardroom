import { describe, expect, it } from 'vitest'
import { Card } from '../shared/card.js'
import { compileClarify, compilePlan, compileResults, PLAN_VERDICT } from './compile.js'

const decision = {
  id: 'd1',
  prompt: 'Approach?',
  options: [
    { id: 'a', label: 'A', recommended: true },
    { id: 'b', label: 'B' },
  ],
}

describe('compileClarify', () => {
  it('builds a pending clarify card with session attribution', () => {
    const card = compileClarify(
      { project: 'demo', title: 'auth work', headline: 'h', blocks: [], decisions: [decision] },
      'claude-code',
    )
    expect(Card.parse(card).stage).toBe('clarify')
    expect(card.status).toBe('pending')
    expect(card.session).toEqual({ agent: 'claude-code', project: 'demo', title: 'auth work' })
    expect(card.id).toBeTruthy()
    expect(card.createdAt).toMatch(/^\d{4}-/)
  })
})

describe('compilePlan', () => {
  const input = {
    project: 'demo', headline: 'the plan',
    blocks: [{ id: 'ph', type: 'phases' as const, phases: [{ title: 'Phase 1' }] }],
    decisions: [decision],
    planRef: '/tmp/plan.md',
  }

  it('auto-appends the plan verdict decision', () => {
    const card = compilePlan(input, 'codex')
    const verdict = card.decisions.find(d => d.id === 'plan_verdict')
    expect(verdict).toBeDefined()
    expect(verdict!.noteRequiredOn).toEqual(['revise', 'reject'])
    expect(card.decisions).toHaveLength(2)
    expect(card.planRef).toBe('/tmp/plan.md')
  })

  it('does not duplicate a verdict the agent already included', () => {
    const card = compilePlan({ ...input, decisions: [PLAN_VERDICT] }, 'codex')
    expect(card.decisions.filter(d => d.id === 'plan_verdict')).toHaveLength(1)
  })
})

describe('compileResults', () => {
  it('turns claims into approve/deny decisions wired to prefixed evidence blocks', () => {
    const card = compileResults({
      project: 'demo', headline: 'done',
      claims: [
        { id: 'c1', claim: 'tests pass', evidence: [{ id: 'e1', type: 'evidence' as const, output: '42 passed' }] },
        { id: 'c2', claim: 'docs updated', evidence: [{ id: 'e1', type: 'markdown' as const, text: 'see README' }] },
      ],
    }, 'claude-code')

    expect(Card.parse(card).stage).toBe('results')
    expect(card.blocks.map(b => b.id)).toEqual(['c1/e1', 'c2/e1'])
    const d1 = card.decisions[0]
    expect(d1.id).toBe('claim:c1')
    expect(d1.prompt).toBe('tests pass')
    expect(d1.options.map(o => o.id)).toEqual(['approve', 'deny'])
    expect(d1.noteRequiredOn).toEqual(['deny'])
    expect(d1.blockRefs).toEqual(['c1/e1'])
  })
})
