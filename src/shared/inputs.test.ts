import { describe, expect, it } from 'vitest'
import { ClarifyInput, PresentPlanInput, ReviewResultsInput, SpecInput } from './inputs.js'

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

  it('accepts a claim tagged with a criterionId and an echoed spec contract', () => {
    const r = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      spec: { goal: 'secure tokens', criteria: [criterion] },
      claims: [{
        id: 'c1', criterionId: 'cr1', claim: 'tokens land in an httpOnly cookie',
        evidence: [{ id: 'e1', type: 'markdown', text: 'see auth.ts' }],
      }],
    })
    expect(r.success).toBe(true)
  })

  it('stays backward compatible: no spec, no criterionId', () => {
    const r = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      claims: [{ id: 'c1', claim: 'tests pass', evidence: [{ id: 'e1', type: 'markdown', text: 'x' }] }],
    })
    expect(r.success).toBe(true)
  })

  it('rejects an echoed spec with duplicate criterion ids', () => {
    const r = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      spec: { criteria: [criterion, criterion] },
      claims: [{ id: 'c1', claim: 'x', evidence: [{ id: 'e1', type: 'markdown', text: 'y' }] }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects an echoed spec criterion using the reserved verdict id', () => {
    const r = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      spec: { criteria: [{ ...criterion, id: 'spec_verdict' }] },
      claims: [{ id: 'c1', claim: 'x', evidence: [{ id: 'e1', type: 'markdown', text: 'y' }] }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects a claim whose criterionId is absent from the echoed spec', () => {
    const r = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      spec: { criteria: [criterion] }, // only cr1
      claims: [{ id: 'c1', criterionId: 'cr99', claim: 'x', evidence: [{ id: 'e1', type: 'markdown', text: 'y' }] }],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /criterionId/.test(JSON.stringify(i.path)) || /criterion/.test(i.message))).toBe(true)
  })

  it('accepts an untied claim (no criterionId) even when a spec is present', () => {
    const r = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      spec: { criteria: [criterion] },
      claims: [{ id: 'c1', claim: 'an untied claim', evidence: [{ id: 'e1', type: 'markdown', text: 'y' }] }],
    })
    expect(r.success).toBe(true)
  })

  it('ignores a stray criterionId when no spec is echoed (nothing to validate against)', () => {
    const r = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      claims: [{ id: 'c1', criterionId: 'cr1', claim: 'x', evidence: [{ id: 'e1', type: 'markdown', text: 'y' }] }],
    })
    expect(r.success).toBe(true)
  })
})

const criterion = {
  id: 'cr1',
  behavior: 'auth tokens are persisted client-side',
  good: 'tokens live only in httpOnly cookies',
  bad: 'any auth token in localStorage',
  tracesTo: 'token_storage',
}

describe('SpecInput', () => {
  const valid = { project: 'demo', headline: 'what done means', goal: 'secure tokens', criteria: [criterion] }

  it('requires at least one criterion', () => {
    expect(SpecInput.safeParse({ ...valid, criteria: [] }).success).toBe(false)
  })

  it('rejects duplicate criterion ids', () => {
    const r = SpecInput.safeParse({ ...valid, criteria: [criterion, criterion] })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /duplicate/.test(i.message))).toBe(true)
  })

  it('rejects a criterion id that collides with the reserved verdict id', () => {
    const r = SpecInput.safeParse({ ...valid, criteria: [{ ...criterion, id: 'spec_verdict' }] })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /reserved/.test(i.message))).toBe(true)
  })

  it('rejects a criterion missing its good or bad outcome', () => {
    expect(SpecInput.safeParse({ ...valid, criteria: [{ ...criterion, bad: '' }] }).success).toBe(false)
  })

  it('accepts a valid spec with a goal, criteria, and an optional on-disk specRef', () => {
    expect(SpecInput.safeParse({ ...valid, specRef: '/tmp/spec.md' }).success).toBe(true)
  })
})
