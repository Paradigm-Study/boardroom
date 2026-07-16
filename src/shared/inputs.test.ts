import { describe, expect, it } from 'vitest'
import { ClarifyInput, PresentPlanInput, PresentReportInput, ReviewResultsInput, SpecInput } from './inputs.js'

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

  // Decision ids key the answers map: two decisions sharing an id would leave one
  // answer silently covering both questions (or the gate permanently undecidable).
  it('rejects duplicate decision ids', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [localBlock, globalBlock],
      decisions: [decisionWithContext, { ...decisionWithContext, prompt: 'A second question, same id' }],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /duplicate decision ids/.test(i.message))).toBe(true)
  })

  // "card_addon" keys the global card-level add-on in the answers map: an
  // agent-authored decision with that id would be silently overwritten by the
  // human's add-on text (and vice versa) at decide time.
  it('rejects a decision using the reserved card_addon id', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [localBlock, globalBlock],
      decisions: [{ ...decisionWithContext, id: 'card_addon' }],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /card_addon.*reserved/i.test(i.message))).toBe(true)
  })

  it('rejects duplicate block ids', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [localBlock, { ...globalBlock, id: 'local' }],
      decisions: [decisionWithContext],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /duplicate block ids/.test(i.message))).toBe(true)
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

  it('rejects a decision using the reserved card_addon id', () => {
    const r = PresentPlanInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [structural, localBlock, globalBlock],
      decisions: [{ ...decisionWithContext, id: 'card_addon' }],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /card_addon.*reserved/i.test(i.message))).toBe(true)
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

describe('PresentReportInput', () => {
  const validBlock = { id: 'b1', type: 'markdown', text: 'summary of findings' }

  it('accepts a minimal valid report (project, headline, one block)', () => {
    const r = PresentReportInput.safeParse({ project: 'demo', headline: 'findings', blocks: [validBlock] })
    expect(r.success).toBe(true)
  })

  it('rejects zero blocks', () => {
    const r = PresentReportInput.safeParse({ project: 'demo', headline: 'findings', blocks: [] })
    expect(r.success).toBe(false)
  })

  it('rejects a missing headline', () => {
    const r = PresentReportInput.safeParse({ project: 'demo', blocks: [validBlock] })
    expect(r.success).toBe(false)
  })

  it('rejects duplicate block ids', () => {
    const r = PresentReportInput.safeParse({
      project: 'demo', headline: 'findings',
      blocks: [validBlock, { ...validBlock }],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /duplicate block ids/.test(i.message))).toBe(true)
  })

  it('has NO decisions field and NO sections field (P1: summary blocks only)', () => {
    const r = PresentReportInput.safeParse({
      project: 'demo', headline: 'findings', blocks: [validBlock],
      decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
      sections: [{ id: 's1', kind: 'decide' }],
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect('decisions' in r.data).toBe(false)
      expect('sections' in r.data).toBe(false)
    }
  })

  it('accepts and preserves sessionKey; accepts omission', () => {
    const withKey = PresentReportInput.safeParse({ project: 'demo', headline: 'findings', blocks: [validBlock], sessionKey: 'cc-1' })
    expect(withKey.success).toBe(true)
    if (withKey.success) expect(withKey.data.sessionKey).toBe('cc-1')

    const withoutKey = PresentReportInput.safeParse({ project: 'demo', headline: 'findings', blocks: [validBlock] })
    expect(withoutKey.success).toBe(true)
  })
})

describe('mixable sections', () => {
  const phasesBlock = { id: 'g', type: 'phases', phases: [{ title: 'P' }] }

  it('skips the global-context requirement when sections are present', () => {
    // `decision` has empty blockRefs + both blocks are unreferenced — this FAILS
    // checkQuestionAndGlobalContext today, but PASSES when a valid sections array
    // places every non-verdict decision in exactly one decide-section.
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [localBlock, globalBlock],
      decisions: [decision],
      sections: [{ id: 's1', kind: 'decide', decisionRefs: ['d1'] }],
    })
    expect(r.success).toBe(true)
  })

  it('rejects a decision placed in zero decide-sections (strict on decisions)', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h', blocks: [globalBlock],
      decisions: [decision],
      sections: [{ id: 's1', kind: 'explain', blockRefs: ['global'] }],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /not placed in any decide-section/.test(i.message))).toBe(true)
  })

  it('rejects a decision placed in two decide-sections', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h', blocks: [globalBlock],
      decisions: [decision],
      sections: [
        { id: 's1', kind: 'decide', decisionRefs: ['d1'] },
        { id: 's2', kind: 'decide', decisionRefs: ['d1'] },
      ],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /placed in 2 decide-sections/.test(i.message))).toBe(true)
  })

  it('rejects a context block placed in more than one section (anchor uniqueness)', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h', blocks: [globalBlock, localBlock],
      decisions: [decision],
      sections: [
        { id: 'decide', kind: 'decide', decisionRefs: ['d1'] },
        { id: 'ctx1', kind: 'explain', blockRefs: ['global'] },
        { id: 'ctx2', kind: 'report', blockRefs: ['global'] },
      ],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /placed in 2 sections/.test(i.message))).toBe(true)
  })

  it('rejects decisionRefs on a non-decide section', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h', blocks: [globalBlock],
      decisions: [decision],
      sections: [
        { id: 'decide', kind: 'decide', decisionRefs: ['d1'] },
        { id: 'ctx', kind: 'explain', decisionRefs: ['d1'] },
      ],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /only meaningful on a decide-section/.test(i.message))).toBe(true)
  })

  it('rejects a duplicate section id', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h', blocks: [globalBlock],
      decisions: [decision],
      sections: [{ id: 's1', kind: 'decide', decisionRefs: ['d1'] }, { id: 's1', kind: 'explain' }],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /duplicate section id/.test(i.message))).toBe(true)
  })

  it('rejects a decision listed twice within one decide-section', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h', blocks: [globalBlock],
      decisions: [decision],
      sections: [{ id: 'decide', kind: 'decide', decisionRefs: ['d1', 'd1'] }],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some(i => /listed more than once/.test(i.message))).toBe(true)
  })

  it('allows an unplaced block (lenient) but rejects refs to unknown ids', () => {
    expect(ClarifyInput.safeParse({
      project: 'demo', headline: 'h', blocks: [localBlock, globalBlock],
      decisions: [decision],
      sections: [{ id: 's1', kind: 'decide', decisionRefs: ['d1'], blockRefs: ['local'] }], // 'global' unplaced — fine
    }).success).toBe(true)

    expect(ClarifyInput.safeParse({
      project: 'demo', headline: 'h', blocks: [globalBlock],
      decisions: [decision],
      sections: [{ id: 's1', kind: 'decide', decisionRefs: ['d1'], blockRefs: ['nope'] }],
    }).success).toBe(false)
  })

  it('rejects a section decisionRef pointing at a verdict id, and a reserved section id', () => {
    expect(ClarifyInput.safeParse({
      project: 'demo', headline: 'h', blocks: [globalBlock],
      decisions: [decision],
      sections: [
        { id: 's1', kind: 'decide', decisionRefs: ['d1'] },
        { id: 's2', kind: 'decide', decisionRefs: ['plan_verdict'] },
      ],
    }).success).toBe(false)

    const reserved = ClarifyInput.safeParse({
      project: 'demo', headline: 'h', blocks: [globalBlock],
      decisions: [decision],
      sections: [{ id: '__decisions__', kind: 'decide', decisionRefs: ['d1'] }],
    })
    expect(reserved.success).toBe(false)
    if (!reserved.success) expect(reserved.error.issues.some(i => /reserved/.test(i.message))).toBe(true)
  })

  it('still enforces structural + exactly-one-recommended + blockRefs on a sectioned plan', () => {
    // missing structural block
    expect(PresentPlanInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [{ id: 'm', type: 'markdown', text: 'x' }],
      decisions: [decisionWithContext],
      sections: [{ id: 's1', kind: 'decide', decisionRefs: ['d1'] }],
    }).success).toBe(false)

    // two recommended options
    expect(PresentPlanInput.safeParse({
      project: 'demo', headline: 'h', blocks: [phasesBlock],
      decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B', recommended: true }], blockRefs: ['g'] }],
      sections: [{ id: 's1', kind: 'decide', decisionRefs: ['d1'] }],
    }).success).toBe(false)

    // decision.blockRefs to an unknown block — checkBlockRefs runs even when sections are present
    expect(PresentPlanInput.safeParse({
      project: 'demo', headline: 'h', blocks: [phasesBlock],
      decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B' }], blockRefs: ['nope'] }],
      sections: [{ id: 's1', kind: 'decide', decisionRefs: ['d1'] }],
    }).success).toBe(false)
  })

  it('does not require a pre-included plan_verdict decision to be placed in a section', () => {
    const r = PresentPlanInput.safeParse({
      project: 'demo', headline: 'h', blocks: [phasesBlock],
      decisions: [
        { id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B' }], blockRefs: ['g'] },
        { id: 'plan_verdict', prompt: 'v', options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }] },
      ],
      sections: [{ id: 's1', kind: 'decide', decisionRefs: ['d1'] }],
    })
    expect(r.success).toBe(true)
  })

  it('strips a stray sections field from SpecInput and ReviewResultsInput', () => {
    const spec = SpecInput.safeParse({
      project: 'demo', headline: 'h', goal: 'g',
      criteria: [{ id: 'c1', behavior: 'b', good: 'good', bad: 'bad', tracesTo: 't' }],
      sections: [{ id: 's1', kind: 'decide' }],
    })
    expect(spec.success).toBe(true)
    if (spec.success) expect('sections' in spec.data).toBe(false)

    const results = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      claims: [{ id: 'cl1', claim: 'works', evidence: [{ id: 'e', type: 'markdown', text: 'proof' }] }],
      sections: [{ id: 's1', kind: 'decide' }],
    })
    expect(results.success).toBe(true)
    if (results.success) expect('sections' in results.data).toBe(false)
  })
})
