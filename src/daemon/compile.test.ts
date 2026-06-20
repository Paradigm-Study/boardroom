import { describe, expect, it } from 'vitest'
import { Card, RESULTS_VERDICT_ID } from '../shared/card.js'
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
  it('turns claims into approve/changes/deny decisions wired to prefixed evidence blocks', () => {
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
    // A middle "revise" verdict sits between approve and reject so the human can
    // say "on the right track, just revise" instead of only accept/drop.
    expect(d1.options.map(o => o.id)).toEqual(['approve', 'revise', 'reject'])
    // Both the revise note and the reject note become the agent's instructions, so
    // both are required; a plain approval needs no note.
    expect(d1.noteRequiredOn).toEqual(['revise', 'reject'])
    expect(d1.blockRefs).toEqual(['c1/e1'])
  })

  it('appends a complete/continue session verdict the human sets explicitly', () => {
    const card = compileResults({
      project: 'demo', headline: 'done',
      claims: [{ id: 'c1', claim: 'tests pass', evidence: [{ id: 'e1', type: 'markdown' as const, text: 'x' }] }],
    }, 'claude-code')

    // One claim decision + the appended verdict.
    expect(card.decisions.map(d => d.id)).toEqual(['claim:c1', RESULTS_VERDICT_ID])
    const verdict = card.decisions.find(d => d.id === RESULTS_VERDICT_ID)!
    expect(verdict.options.map(o => o.id)).toEqual(['complete', 'continue'])
    // The verdict's own note is the optional card-level add-on, so it is NOT required.
    expect(verdict.noteRequiredOn ?? []).toEqual([])
    // The verdict carries no evidence blocks of its own.
    expect(verdict.blockRefs ?? []).toEqual([])
  })
})
