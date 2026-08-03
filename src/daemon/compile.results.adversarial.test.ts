import { describe, expect, it } from 'vitest'
import { Card, RESULTS_VERDICT_ID } from '../shared/card.js'
import { ReviewResultsInput } from '../shared/inputs.js'
import { compileResults } from './compile.js'

const md = (id: string, text = 'x') => ({ id, type: 'markdown' as const, text })

// Compile from a raw input through the real boundary parse, mirroring production:
// ReviewResultsInput.parse THEN compileResults. If the parse rejects, that is a
// meaningful assertion target too.
function parseAndCompile(input: unknown) {
  const parsed = ReviewResultsInput.parse(input)
  return compileResults(parsed, { agent: 'claude-code' })
}

describe('compileResults — adversarial', () => {
  it('two claims reusing the SAME inner evidence id produce distinct namespaced blocks with no cross-claim blockRef bleed', () => {
    const card = parseAndCompile({
      project: 'demo', headline: 'h',
      claims: [
        { id: 'c1', claim: 'first', evidence: [md('e1', 'one'), md('e2', 'two')] },
        { id: 'c2', claim: 'second', evidence: [md('e1', 'three')] },
      ],
    })
    // Every block id is globally unique after namespacing.
    const blockIds = card.blocks.map(b => b.id)
    expect(blockIds).toEqual(['c1/e1', 'c1/e2', 'c2/e1'])
    expect(new Set(blockIds).size).toBe(blockIds.length)

    const c1 = card.decisions.find(d => d.id === 'claim:c1')!
    const c2 = card.decisions.find(d => d.id === 'claim:c2')!
    // c1 points ONLY at its own evidence — never at c2/e1.
    expect(c1.blockRefs).toEqual(['c1/e1', 'c1/e2'])
    expect(c2.blockRefs).toEqual(['c2/e1'])
    expect(c1.blockRefs).not.toContain('c2/e1')
    expect(c2.blockRefs).not.toContain('c1/e1')
  })

  it('every claim decision blockRef resolves to a real block on the card (no dangling refs)', () => {
    const card = parseAndCompile({
      project: 'demo', headline: 'h',
      claims: [
        { id: 'alpha', claim: 'a', evidence: [md('x')] },
        { id: 'beta', claim: 'b', evidence: [md('y'), md('z')] },
      ],
    })
    const blockIds = new Set(card.blocks.map(b => b.id))
    for (const d of card.decisions) {
      for (const ref of d.blockRefs ?? []) {
        expect(blockIds.has(ref)).toBe(true)
      }
    }
  })

  it('appends exactly one results_verdict, with options complete/continue, as the LAST decision', () => {
    const card = parseAndCompile({
      project: 'demo', headline: 'h',
      claims: [
        { id: 'c1', claim: 'a', evidence: [md('e1')] },
        { id: 'c2', claim: 'b', evidence: [md('e1')] },
        { id: 'c3', claim: 'c', evidence: [md('e1')] },
      ],
    })
    const verdicts = card.decisions.filter(d => d.id === RESULTS_VERDICT_ID)
    expect(verdicts).toHaveLength(1)
    expect(card.decisions[card.decisions.length - 1].id).toBe(RESULTS_VERDICT_ID)
    expect(verdicts[0].options.map(o => o.id)).toEqual(['complete', 'continue'])
    // total = N claims + 1 verdict
    expect(card.decisions).toHaveLength(4)
  })

  it("a claim literally named 'results_verdict' does NOT collide with the synthetic verdict", () => {
    const card = parseAndCompile({
      project: 'demo', headline: 'h',
      claims: [{ id: 'results_verdict', claim: 'tricky', evidence: [md('e1')] }],
    })
    // The claim decision is namespaced 'claim:results_verdict', distinct from the
    // synthetic 'results_verdict'. Both exist; neither shadows the other.
    const ids = card.decisions.map(d => d.id)
    expect(ids).toContain('claim:results_verdict')
    expect(ids.filter(id => id === RESULTS_VERDICT_ID)).toHaveLength(1)
    expect(ids).toEqual(['claim:results_verdict', RESULTS_VERDICT_ID])
    // The real verdict (last) is the complete/continue one, NOT the claim's a/r/r.
    const last = card.decisions[card.decisions.length - 1]
    expect(last.id).toBe(RESULTS_VERDICT_ID)
    expect(last.options.map(o => o.id)).toEqual(['complete', 'continue'])
  })

  it('the compiled card passes Card.parse (valid zod card) including all Decision refinements', () => {
    const card = parseAndCompile({
      project: 'demo', headline: 'h',
      claims: [
        { id: 'c1', claim: 'a', evidence: [md('e1'), md('e2')] },
        { id: 'c2', claim: 'b', evidence: [{ id: 'ev', type: 'evidence' as const, output: '', command: 'go test', exitCode: 0 }] },
      ],
    })
    expect(() => Card.parse(card)).not.toThrow()
    // And each claim decision's noteRequiredOn is exactly ['revise','reject'] and
    // references real option ids (Decision.superRefine would reject otherwise).
    for (const d of card.decisions.filter(c => c.id.startsWith('claim:'))) {
      expect(d.noteRequiredOn).toEqual(['revise', 'reject'])
      const optIds = d.options.map(o => o.id)
      for (const n of d.noteRequiredOn!) expect(optIds).toContain(n)
    }
  })

  it('duplicate claim ids are rejected at the ReviewResultsInput boundary', () => {
    const dup = {
      project: 'demo', headline: 'h',
      claims: [
        { id: 'c1', claim: 'a', evidence: [md('e1')] },
        { id: 'c1', claim: 'b', evidence: [md('e2')] },
      ],
    }
    expect(() => ReviewResultsInput.parse(dup)).toThrow()
    const res = ReviewResultsInput.safeParse(dup)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i => /duplicate claim ids/.test(i.message))).toBe(true)
    }
  })

  it("a claim id containing '/' or ':' still yields a parseable card with correctly-prefixed block ids", () => {
    const card = parseAndCompile({
      project: 'demo', headline: 'h',
      claims: [
        { id: 'feat/auth:login', claim: 'weird id', evidence: [md('e1'), md('e2')] },
      ],
    })
    expect(() => Card.parse(card)).not.toThrow()
    expect(card.blocks.map(b => b.id)).toEqual(['feat/auth:login/e1', 'feat/auth:login/e2'])
    const d = card.decisions[0]
    expect(d.id).toBe('claim:feat/auth:login')
    expect(d.blockRefs).toEqual(['feat/auth:login/e1', 'feat/auth:login/e2'])
  })

  it('rejects inputs whose namespaced block ids would collide via the "/" delimiter', () => {
    // Hostile aliasing: claim "a" + evidence "b/e" -> "a/b/e", and claim "a/b" +
    // evidence "e" -> "a/b/e". A naive string join collapses these two distinct
    // (claim, evidence) pairs to one block id, so a decision could silently pick
    // up the wrong claim's evidence. The boundary must reject this, mirroring the
    // duplicate-claim-id guard.
    const colliding = {
      project: 'demo', headline: 'h',
      claims: [
        { id: 'a', claim: 'first', evidence: [md('b/e', 'from-a')] },
        { id: 'a/b', claim: 'second', evidence: [md('e', 'from-ab')] },
      ],
    }
    const res = ReviewResultsInput.safeParse(colliding)
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(res.error.issues.some(i => /collide|collision/i.test(i.message))).toBe(true)
    }

    // A near-miss that does NOT actually collide must still be accepted — the
    // guard rejects real collisions, not every "/" in an id.
    expect(ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      claims: [
        { id: 'a', claim: 'first', evidence: [md('x/y', 'ok')] },
        { id: 'a/b', claim: 'second', evidence: [md('e', 'ok')] },
      ],
    }).success).toBe(true)
  })

  it('whitespace-only ids and empty evidence arrays are rejected at the boundary', () => {
    // empty evidence
    expect(ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      claims: [{ id: 'c1', claim: 'a', evidence: [] }],
    }).success).toBe(false)
    // empty claims array
    expect(ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      claims: [],
    }).success).toBe(false)
    // empty-string claim id (min(1))
    expect(ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      claims: [{ id: '', claim: 'a', evidence: [md('e1')] }],
    }).success).toBe(false)
  })

  it('preserves claim order in decisions and does not reorder around the verdict', () => {
    const card = parseAndCompile({
      project: 'demo', headline: 'h',
      claims: [
        { id: 'z', claim: 'last-alpha', evidence: [md('e1')] },
        { id: 'a', claim: 'first-alpha', evidence: [md('e1')] },
        { id: 'm', claim: 'mid', evidence: [md('e1')] },
      ],
    })
    expect(card.decisions.map(d => d.id)).toEqual([
      'claim:z', 'claim:a', 'claim:m', RESULTS_VERDICT_ID,
    ])
  })
})
