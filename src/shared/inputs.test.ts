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
const localBlock = { id: 'local', type: 'markdown', text: 'Decision-specific context' }
const globalBlock = { id: 'global', type: 'markdown', text: 'Whole-card context' }
const decisionWithContext = { ...decision, blockRefs: ['local'] }

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

  it('requires each decision to reference local context', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [localBlock, globalBlock],
      decisions: [decision],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toMatch(/local context/)
  })

  it('requires one global context block', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [localBlock],
      decisions: [decisionWithContext],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toMatch(/global context/)
  })

  it('accepts a valid input with question-local and global context', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [localBlock, globalBlock],
      decisions: [decisionWithContext],
    })
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
    const bad = { ...decisionWithContext, options: decision.options.map(o => ({ ...o, recommended: true })) }
    const r = PresentPlanInput.safeParse({ project: 'demo', headline: 'h', blocks: [structural, globalBlock], decisions: [bad] })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toMatch(/recommended/)
  })

  it('accepts a plan with structural block and zero extra decisions', () => {
    const r = PresentPlanInput.safeParse({ project: 'demo', headline: 'h', blocks: [structural], planRef: '/tmp/plan.md' })
    expect(r.success).toBe(true)
  })

  it('requires local context for every plan decision and global plan context', () => {
    const noLocal = PresentPlanInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [structural, globalBlock],
      decisions: [decision],
    })
    expect(noLocal.success).toBe(false)
    if (!noLocal.success) expect(noLocal.error.issues[0].message).toMatch(/local context/)

    const noGlobal = PresentPlanInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [structural],
      decisions: [{ ...decision, blockRefs: ['ph'] }],
    })
    expect(noGlobal.success).toBe(false)
    if (!noGlobal.success) expect(noGlobal.error.issues[0].message).toMatch(/global context/)
  })

  it('accepts a plan decision with question-local context plus global context', () => {
    const r = PresentPlanInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [structural, globalBlock],
      decisions: [{ ...decision, blockRefs: ['ph'] }],
    })
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
