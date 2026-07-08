import { describe, expect, it } from 'vitest'
import { Card, RESULTS_VERDICT_ID, SPEC_VERDICT_ID } from '../shared/card.js'
import { Entry } from '../shared/entry.js'
import { compileClarify, compilePlan, compileReport, compileResults, compileSpec, PLAN_VERDICT } from './compile.js'

const decision = {
  id: 'd1',
  prompt: 'Approach?',
  options: [
    { id: 'a', label: 'A', recommended: true },
    { id: 'b', label: 'B' },
  ],
}

const criterion = (id: string, behavior: string) => ({
  id, behavior, good: `${behavior} holds`, bad: `${behavior} fails`, tracesTo: 'd1',
})

describe('compileClarify', () => {
  it('builds a pending clarify card with session attribution', () => {
    const card = compileClarify(
      { project: 'demo', title: 'auth work', headline: 'h', blocks: [], decisions: [decision] },
      { agent: 'claude-code' },
    )
    expect(Card.parse(card).stage).toBe('clarify')
    expect(card.status).toBe('pending')
    expect(card.session).toEqual({ agent: 'claude-code', project: 'demo', title: 'auth work' })
    expect(card.id).toBeTruthy()
    expect(card.createdAt).toMatch(/^\d{4}-/)
  })
})

describe('sections threading', () => {
  const sections = [{ id: 's1', kind: 'decide' as const, decisionRefs: ['d1'] }]
  const planBlocks = [{ id: 'ph', type: 'phases' as const, phases: [{ title: 'P' }] }]

  it('copies sections onto a clarify card when present and omits the key when absent', () => {
    const withS = compileClarify({ project: 'demo', headline: 'h', blocks: [], decisions: [decision], sections }, { agent: 'cc' })
    expect(withS.sections).toEqual(sections)
    const withoutS = compileClarify({ project: 'demo', headline: 'h', blocks: [], decisions: [decision] }, { agent: 'cc' })
    expect('sections' in withoutS).toBe(false)
  })

  it('copies sections onto a plan card', () => {
    const card = compilePlan({ project: 'demo', headline: 'h', blocks: planBlocks, decisions: [decision], sections }, { agent: 'cc' })
    expect(card.sections).toEqual(sections)
  })

  it('keeps the fingerprint identical with and without sections', () => {
    const a = compileClarify({ project: 'demo', headline: 'same', blocks: [], decisions: [decision] }, { agent: 'cc' })
    const b = compileClarify({ project: 'demo', headline: 'same', blocks: [], decisions: [decision], sections }, { agent: 'cc' })
    expect(a.fingerprint).toBe(b.fingerprint)
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
    const card = compilePlan(input, { agent: 'codex' })
    const verdict = card.decisions.find(d => d.id === 'plan_verdict')
    expect(verdict).toBeDefined()
    expect(verdict!.noteRequiredOn).toEqual(['revise', 'reject'])
    expect(card.decisions).toHaveLength(2)
    expect(card.planRef).toBe('/tmp/plan.md')
  })

  it('does not duplicate a verdict the agent already included', () => {
    const card = compilePlan({ ...input, decisions: [PLAN_VERDICT] }, { agent: 'codex' })
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
    }, { agent: 'claude-code' })

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
    }, { agent: 'claude-code' })

    // One claim decision + the appended verdict.
    expect(card.decisions.map(d => d.id)).toEqual(['claim:c1', RESULTS_VERDICT_ID])
    const verdict = card.decisions.find(d => d.id === RESULTS_VERDICT_ID)!
    expect(verdict.options.map(o => o.id)).toEqual(['complete', 'continue'])
    // The verdict's own note is the optional card-level add-on, so it is NOT required.
    expect(verdict.noteRequiredOn ?? []).toEqual([])
    // The verdict carries no evidence blocks of its own.
    expect(verdict.blockRefs ?? []).toEqual([])
  })

  it('with an echoed spec, stores the criteria and tags each claim with its criterionId', () => {
    const card = compileResults({
      project: 'demo', headline: 'done',
      spec: { goal: 'ship securely', criteria: [criterion('cr1', 'tokens secure'), criterion('cr2', 'tests pass')] },
      claims: [{ id: 'c1', criterionId: 'cr1', claim: 'tokens in httpOnly cookie', evidence: [{ id: 'e1', type: 'markdown' as const, text: 'x' }] }],
    }, { agent: 'claude-code' })

    expect(card.criteria?.map(c => c.id)).toEqual(['cr1', 'cr2'])
    expect(card.decisions.find(d => d.id === 'claim:c1')!.criterionId).toBe('cr1')
  })

  it('without a spec, carries no criteria (backward compatible)', () => {
    const card = compileResults({
      project: 'demo', headline: 'done',
      claims: [{ id: 'c1', claim: 'tests pass', evidence: [{ id: 'e1', type: 'markdown' as const, text: 'x' }] }],
    }, { agent: 'claude-code' })
    expect(card.criteria).toBeUndefined()
  })
})

describe('compileSpec', () => {
  const input = {
    project: 'demo', headline: 'definition of done', goal: 'ship securely',
    criteria: [criterion('cr1', 'tokens secure'), criterion('cr2', 'tests pass')],
    specRef: '/tmp/spec.md',
    blocks: [],
  }

  it('builds a pending spec card carrying the contract and a specRef', () => {
    const card = compileSpec(input, { agent: 'claude-code' })
    expect(Card.parse(card).stage).toBe('spec')
    expect(card.status).toBe('pending')
    expect(card.specRef).toBe('/tmp/spec.md')
    expect(card.criteria?.map(c => c.id)).toEqual(['cr1', 'cr2'])
  })

  it('renders one keep/adjust/drop decision per criterion, wired to its acceptance block', () => {
    const card = compileSpec(input, { agent: 'claude-code' })
    const d1 = card.decisions.find(d => d.id === 'crit:cr1')!
    expect(d1.options.map(o => o.id)).toEqual(['keep', 'adjust', 'drop'])
    expect(d1.noteRequiredOn).toEqual(['adjust', 'drop'])
    expect(d1.blockRefs).toEqual(['crit/cr1'])
    expect(d1.criterionId).toBe('cr1')
    // the referenced block exists and is an acceptance block
    expect(card.blocks.find(b => b.id === 'crit/cr1')?.type).toBe('acceptance')
  })

  it('includes a global (unreferenced) acceptance overview block carrying the goal', () => {
    const card = compileSpec(input, { agent: 'claude-code' })
    const referenced = new Set(card.decisions.flatMap(d => d.blockRefs ?? []))
    const globals = card.blocks.filter(b => !referenced.has(b.id))
    const overview = globals.find(b => b.type === 'acceptance')
    expect(overview).toBeDefined()
    expect(overview!.type === 'acceptance' && overview!.goal).toBe('ship securely')
  })

  it('appends a lock/revise verdict with a required revise note', () => {
    const card = compileSpec(input, { agent: 'codex' })
    const verdict = card.decisions.find(d => d.id === SPEC_VERDICT_ID)!
    expect(verdict.options.map(o => o.id)).toEqual(['lock', 'revise'])
    expect(verdict.noteRequiredOn).toEqual(['revise'])
    expect(verdict.blockRefs ?? []).toEqual([])
  })
})

describe('compileReport', () => {
  const input = {
    project: 'demo',
    title: 'investigation',
    headline: 'interim findings',
    blocks: [{ id: 'b1', type: 'markdown' as const, text: 'summary of what was found' }],
  }

  it('builds a valid report entry with session attribution', () => {
    const entry = compileReport(input, { agent: 'claude-code' })
    const parsed = Entry.parse(entry)
    expect(parsed.type).toBe('report')
    expect(entry.session).toEqual({ agent: 'claude-code', project: 'demo', title: 'investigation' })
    expect(entry.id).toBeTruthy()
    expect(entry.createdAt).toMatch(/^\d{4}-/)
    if (entry.type !== 'report') throw new Error('expected report entry')
    expect(entry.headline).toBe('interim findings')
    expect(entry.blocks).toEqual(input.blocks)
  })

  it('carries meta.claudeSessionId when present', () => {
    const entry = compileReport(input, { agent: 'claude-code', claudeSessionId: 'cc-1' })
    expect(entry.claudeSessionId).toBe('cc-1')
  })

  it('omits claudeSessionId when meta has none (unbound legacy caller)', () => {
    const entry = compileReport(input, { agent: 'claude-code' })
    expect('claudeSessionId' in entry).toBe(false)
  })

  it('carries NO fingerprint field — reports are not reattachable', () => {
    const entry = compileReport(input, { agent: 'claude-code' })
    expect('fingerprint' in entry).toBe(false)
  })

  it('mints a distinct id and createdAt on every call, even with identical input (no dedup)', () => {
    const a = compileReport(input, { agent: 'claude-code' })
    const b = compileReport(input, { agent: 'claude-code' })
    expect(a.id).not.toBe(b.id)
  })
})
