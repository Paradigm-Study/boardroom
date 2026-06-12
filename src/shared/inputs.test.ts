import { describe, expect, it } from 'vitest'
import { ClarifyInput, PresentPlanInput, ReviewResultsInput } from './inputs.js'

const decision = {
  id: 'd1',
  prompt: 'Approach?',
  options: [
    { id: 'a', label: 'Option A', recommended: true },
    { id: 'b', label: 'Option B' },
  ],
}

describe('ClarifyInput', () => {
  it('requires at least one decision', () => {
    const r = ClarifyInput.safeParse({ project: 'demo', headline: 'h', decisions: [] })
    expect(r.success).toBe(false)
  })

  it('rejects blockRefs pointing at unknown blocks', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [{ id: 'b1', type: 'markdown', text: 'x' }],
      decisions: [{ ...decision, blockRefs: ['nope'] }],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(JSON.stringify(r.error.issues[0].path)).toContain('blockRefs')
  })

  it('accepts a minimal valid input', () => {
    const r = ClarifyInput.safeParse({ project: 'demo', headline: 'h', decisions: [decision] })
    expect(r.success).toBe(true)
  })
})

describe('PresentPlanInput', () => {
  const structural = { id: 'ph', type: 'phases', phases: [{ title: 'Phase 1' }] }

  it('requires at least one structural block', () => {
    const r = PresentPlanInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [{ id: 'b1', type: 'markdown', text: 'x' }],
      decisions: [decision],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toMatch(/structural/)
  })

  it('requires exactly one recommended option per plan decision', () => {
    const bad = { ...decision, options: decision.options.map(o => ({ ...o, recommended: true })) }
    const r = PresentPlanInput.safeParse({ project: 'demo', headline: 'h', blocks: [structural], decisions: [bad] })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toMatch(/recommended/)
  })

  it('accepts a plan with structural block and zero extra decisions', () => {
    const r = PresentPlanInput.safeParse({ project: 'demo', headline: 'h', blocks: [structural], planRef: '/tmp/plan.md' })
    expect(r.success).toBe(true)
  })
})

describe('ReviewResultsInput', () => {
  it('requires at least one evidence block per claim', () => {
    const r = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      claims: [{ id: 'c1', claim: 'tests pass', evidence: [] }],
    })
    expect(r.success).toBe(false)
  })

  it('accepts a claim with evidence', () => {
    const r = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      claims: [{ id: 'c1', claim: 'tests pass', evidence: [{ id: 'e1', type: 'evidence', output: '42 passed', exitCode: 0 }] }],
    })
    expect(r.success).toBe(true)
  })
})
