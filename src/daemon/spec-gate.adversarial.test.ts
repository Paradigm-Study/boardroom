import { describe, expect, it } from 'vitest'
import type { Card, Criterion } from '../shared/card.js'
import { SPEC_VERDICT_ID } from '../shared/card.js'
import { compileResults } from './compile.js'
import { buildSummary } from './summary.js'

// Adversarial coverage for the spec gate, mirroring the results-gate adversarial
// suites: the awkward shapes a real agent/human can produce that must degrade
// gracefully rather than crash or silently lie.

const crit = (id: string, behavior: string): Criterion =>
  ({ id, behavior, good: `${behavior} holds`, bad: `${behavior} regressed`, tracesTo: 'd1' })

function specCard(criteria: Criterion[]): Card {
  return {
    id: 's1', stage: 'spec',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'definition of done', blocks: [],
    criteria,
    decisions: [
      ...criteria.map(c => ({
        id: `crit:${c.id}`, prompt: c.behavior, criterionId: c.id,
        options: [{ id: 'keep', label: 'Keep' }, { id: 'adjust', label: 'Adjust' }, { id: 'drop', label: 'Drop' }],
        noteRequiredOn: ['adjust', 'drop'],
      })),
      { id: SPEC_VERDICT_ID, prompt: 'Lock?', options: [{ id: 'lock', label: 'Lock spec' }, { id: 'revise', label: 'Revise' }] },
    ],
    specRef: '/tmp/spec.md',
    status: 'pending', createdAt: '2026-06-23T00:00:00.000Z',
  }
}

describe('spec gate — adversarial', () => {
  it('locking with EVERY criterion dropped does not tell the agent to "build to this contract"', () => {
    const card = specCard([crit('cr1', 'a'), crit('cr2', 'b')])
    const s = buildSummary(card, {
      'crit:cr1': { chosen: ['drop'], note: 'out of scope' },
      'crit:cr2': { chosen: ['drop'], note: 'also out' },
      spec_verdict: { chosen: ['lock'] },
    })
    expect(s.split('\n')[0]).toMatch(/LOCKED/)
    expect(s).not.toMatch(/build to this contract/)
    expect(s).toMatch(/no .*criteria|nothing to build|every criterion was dropped/i)
    // and it should NOT instruct writing an empty contract to specRef
    expect(s).not.toContain('/tmp/spec.md')
  })

  it('a criterion satisfied by ANY approved claim is MET even if another claim for it was rejected', () => {
    const criteria = [crit('cr1', 'tokens secure')]
    const card = compileResults({
      project: 'demo', headline: 'done',
      spec: { criteria },
      claims: [
        { id: 'a', criterionId: 'cr1', claim: 'cookie path verified', evidence: [{ id: 'e', type: 'markdown' as const, text: 'x' }] },
        { id: 'b', criterionId: 'cr1', claim: 'older draft attempt', evidence: [{ id: 'e', type: 'markdown' as const, text: 'y' }] },
      ],
    }, { agent: 'claude-code' })
    const s = buildSummary(card, {
      'claim:a': { chosen: ['approve'] },
      'claim:b': { chosen: ['reject'], note: 'ignore this one' },
      results_verdict: { chosen: ['continue'] },
    })
    // cr1 has an approved claim → met → not in the UNMET list
    expect(s).not.toMatch(/UNMET CRITERIA/)
    expect(s).toMatch(/all 1 acceptance criteria met/i)
  })

  it('a criterion with NO claim at all is UNMET', () => {
    const criteria = [crit('cr1', 'tokens secure'), crit('cr2', 'tests pass')]
    const card = compileResults({
      project: 'demo', headline: 'done',
      spec: { criteria },
      claims: [{ id: 'a', criterionId: 'cr1', claim: 'cookie path verified', evidence: [{ id: 'e', type: 'markdown' as const, text: 'x' }] }],
    }, { agent: 'claude-code' })
    const s = buildSummary(card, {
      'claim:a': { chosen: ['approve'] },
      results_verdict: { chosen: ['continue'] },
    })
    expect(s).toMatch(/UNMET CRITERIA \(1\)/)
    expect(s).toContain('tests pass') // cr2, which never got a claim
  })

  it('compileResults + buildSummary survive a claim whose criterionId is not in the spec (defense in depth)', () => {
    // The schema rejects this at the boundary, but the daemon must still not crash
    // if a stray id slips through (e.g. a hand-built card): the orphaned claim is
    // simply not counted toward any criterion, which stays UNMET.
    const criteria = [crit('cr1', 'tokens secure')]
    const card = compileResults({
      project: 'demo', headline: 'done',
      spec: { criteria },
      claims: [{ id: 'a', criterionId: 'ghost', claim: 'mislabeled', evidence: [{ id: 'e', type: 'markdown' as const, text: 'x' }] }],
    }, { agent: 'claude-code' })
    const s = buildSummary(card, {
      'claim:a': { chosen: ['approve'] },
      results_verdict: { chosen: ['continue'] },
    })
    expect(s).toMatch(/UNMET CRITERIA \(1\)/) // cr1 never got a real claim
    expect(s).toMatch(/not tied to any criterion/i) // the stray claim is flagged unscoped
  })
})
