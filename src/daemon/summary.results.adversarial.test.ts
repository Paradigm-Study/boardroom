import { describe, expect, it } from 'vitest'
import type { Card, DecisionAnswer } from '../shared/card.js'
import { buildSummary } from './summary.js'

const claim = (id: string, prompt: string): Card['decisions'][number] => ({
  id, prompt,
  options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }],
  noteRequiredOn: ['revise', 'reject'],
})

function resultsCard(claims: Array<[string, string]>): Card {
  return {
    id: 'c1', stage: 'results',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'done', blocks: [],
    decisions: [
      ...claims.map(([id, prompt]) => claim(id, prompt)),
      { id: 'results_verdict', prompt: 'Is the session complete?', options: [{ id: 'complete', label: 'Mark complete' }, { id: 'continue', label: 'Keep going' }] },
    ],
    status: 'pending', createdAt: '2026-06-11T00:00:00.000Z',
  }
}

const defaultClaims: Array<[string, string]> = [
  ['claim:c1', 'tests pass'],
  ['claim:c2', 'docs updated'],
  ['claim:c3', 'lint is clean'],
]

// A guard reused across cases: nothing in agent-facing output should ever leak
// raw JS coercions. If any of these appear, the renderer touched an undefined or
// an object where it expected a string.
function assertNoLeaks(s: string): void {
  expect(s).not.toMatch(/undefined/)
  expect(s).not.toMatch(/\[object Object\]/)
  expect(s).not.toMatch(/\bnull\b/)
  expect(s).not.toMatch(/NaN/)
}

describe('buildSummary — results (adversarial)', () => {
  it('continue: groups appear strictly Rejected -> Revise -> Approved, all after the NOT-complete lead', () => {
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['approve'] },
      'claim:c2': { chosen: ['revise'], note: 'tighten the index' },
      'claim:c3': { chosen: ['reject'], note: 'drop this entirely' },
      results_verdict: { chosen: ['continue'] },
    })

    expect(s.split('\n')[0]).toMatch(/NOT complete/)
    const leadIdx = s.search(/NOT complete/)
    const rejIdx = s.search(/Rejected \(drop\)/)
    const revIdx = s.search(/Revise \(on the right track\)/)
    const appIdx = s.search(/Approved as-is/)

    expect(leadIdx).toBeGreaterThanOrEqual(0)
    expect(rejIdx).toBeGreaterThanOrEqual(0)
    expect(revIdx).toBeGreaterThanOrEqual(0)
    expect(appIdx).toBeGreaterThanOrEqual(0)
    // strict spec order regardless of the order the claims were voted on
    expect(leadIdx).toBeLessThan(rejIdx)
    expect(rejIdx).toBeLessThan(revIdx)
    expect(revIdx).toBeLessThan(appIdx)
    assertNoLeaks(s)
  })

  it('complete with a rejected claim: still leads COMPLETE, lists the reject AND its note (independence)', () => {
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['reject'], note: 'known-broken, shipping anyway' },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })

    expect(s.split('\n')[0]).toMatch(/COMPLETE/)
    expect(s).not.toMatch(/NOT complete/)
    expect(s).toMatch(/Rejected \(drop\)/)
    expect(s).toContain('tests pass')
    expect(s).toContain('known-broken, shipping anyway')
    assertNoLeaks(s)
  })

  it('add-on note that is ONLY whitespace (no attachments) omits the Added instructions section entirely', () => {
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['approve'] },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['continue'], note: '   \t  \n  ' },
    })

    expect(s).not.toMatch(/Added instructions/)
    assertNoLeaks(s)
  })

  it('add-on attachments present but note empty: Added instructions still appears, with the attachment path, but no dangling note text', () => {
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['approve'] },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: {
        chosen: ['continue'],
        note: '',
        attachments: [{ id: 'a1', name: 'spec.pdf', size: 9, path: '/tmp/spec.pdf', uploadedAt: '2026-06-11T00:00:00.000Z' }],
      },
    })

    expect(s).toContain('Added instructions')
    expect(s).toContain('spec.pdf')
    expect(s).toContain('/tmp/spec.pdf')
    // the line must be exactly "Added instructions:" with no trailing space, since the note is empty
    const addonLine = s.split('\n').find(l => l.startsWith('Added instructions'))
    expect(addonLine).toBe('Added instructions:')
    assertNoLeaks(s)
  })

  it('a rejected claim with NO note (note undefined) renders "(no note)" rather than "undefined"', () => {
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['reject'] }, // note intentionally absent
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['continue'] },
    })

    expect(s).toContain('(no note)')
    // the rejected claim line specifically should carry the placeholder
    const rejLine = s.split('\n').find(l => l.includes('tests pass'))
    expect(rejLine).toMatch(/\(no note\)/)
    assertNoLeaks(s)
  })

  it('a revise claim with NO note also renders "(no note)", not undefined', () => {
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['revise'] }, // note absent
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['continue'] },
    })

    const revLine = s.split('\n').find(l => l.includes('tests pass'))
    expect(revLine).toMatch(/\(no note\)/)
    assertNoLeaks(s)
  })

  it('an APPROVED claim that also carries an optional note: the note is surfaced', () => {
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['approve'], note: 'nice work but watch the flaky retry' },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })

    expect(s).toContain('nice work but watch the flaky retry')
    // and an approved claim WITHOUT a note must NOT emit "(no note)" — that placeholder
    // is only for the note-required groups
    const c2Line = s.split('\n').find(l => l.includes('docs updated'))
    expect(c2Line).not.toMatch(/\(no note\)/)
    assertNoLeaks(s)
  })

  it('an approved claim whose optional note is only whitespace does not emit a dangling " — note:"', () => {
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['approve'], note: '   ' },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })

    const c1Line = s.split('\n').find(l => l.includes('tests pass'))
    expect(c1Line).toBe('- tests pass')
    expect(s).not.toMatch(/— note: *$/m)
    assertNoLeaks(s)
  })

  it('verdict answer entirely missing: does not crash and produces a sane NOT-complete lead', () => {
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['approve'] },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      // results_verdict deliberately omitted
    })

    expect(s.split('\n')[0]).toMatch(/NOT complete/)
    expect(s).not.toMatch(/Added instructions/)
    assertNoLeaks(s)
  })

  it('the results_verdict decision is never itself listed as a claim line, even if it carries claim-shaped votes', () => {
    // Hostile input: someone votes "reject" on the synthetic verdict id. It must
    // not surface as a Rejected claim line, and its prompt must not appear in a group.
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['approve'] },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['continue', 'reject'], note: 'side channel' },
    })

    expect(s).not.toContain('Is the session complete?')
    // It must not be pulled into the Rejected group despite carrying 'reject'.
    expect(s).not.toMatch(/Rejected \(drop\)/)
    assertNoLeaks(s)
  })

  it('hostile note content (object-like / undefined-like strings) round-trips verbatim without breaking the leak guard semantics', () => {
    // Notes that literally contain tricky substrings should pass through as data.
    // We assert the claim note text is present; the global leak guard is intentionally
    // NOT applied here because the human-authored payload legitimately contains them.
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['reject'], note: 'the value was [object Object] in the log' },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['continue'] },
    })
    expect(s).toContain('the value was [object Object] in the log')
  })

  it('claim chosen array is empty (human voted nothing on it): it falls into no group and is silently dropped', () => {
    // An unvoted claim should not appear under approve/revise/reject at all.
    const card = resultsCard(defaultClaims)
    const s = buildSummary(card, {
      'claim:c1': { chosen: [] },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['continue'] },
    } as Record<string, DecisionAnswer>)

    // c1 ("tests pass") was voted on but with an empty choice -> not in any group
    const lines = s.split('\n')
    const c1Lines = lines.filter(l => l.includes('tests pass'))
    expect(c1Lines).toHaveLength(0)
    assertNoLeaks(s)
  })

  it('all three groups present with notes and attachments: full output has no leaks and correct placeholder behavior', () => {
    const s = buildSummary(resultsCard(defaultClaims), {
      'claim:c1': { chosen: ['reject'], note: 'remove it', attachments: [{ id: 'r1', name: 'r.png', size: 1, path: '/tmp/r.png', uploadedAt: '2026-06-11T00:00:00.000Z' }] },
      'claim:c2': { chosen: ['revise'] }, // no note -> (no note)
      'claim:c3': { chosen: ['approve'], note: 'looks great' },
      results_verdict: { chosen: ['continue'], note: 'overall: tidy the README', attachments: [{ id: 'v1', name: 'v.pdf', size: 2, path: '/tmp/v.pdf', uploadedAt: '2026-06-11T00:00:00.000Z' }] },
    })

    expect(s).toContain('Added instructions: overall: tidy the README')
    expect(s).toContain('/tmp/v.pdf')
    expect(s).toContain('remove it')
    expect(s).toContain('/tmp/r.png')
    expect(s).toContain('(no note)') // c2 revise had no note
    expect(s).toContain('looks great') // c3 approve note surfaced
    assertNoLeaks(s)
  })
})
