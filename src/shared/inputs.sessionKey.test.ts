import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { ClarifyInput, PresentPlanInput, PresentReportInput, ReviewResultsInput, SpecInput } from './inputs.js'

// One minimal-valid fixture per gate schema. sessionKey comes from the shared
// sessionFields spread, but each schema re-declares its object shape — a schema
// that drops the spread (or clones it with a typo) would silently lose the
// card↔session spine for that gate only. Assert the invariant on every gate.
const GATES: [string, z.ZodType<{ sessionKey?: string }>, Record<string, unknown>][] = [
  ['ClarifyInput', ClarifyInput, {
    project: 'demo',
    headline: 'h',
    blocks: [
      { id: 'g', type: 'markdown', text: 'global' },
      { id: 'l', type: 'markdown', text: 'local' },
    ],
    decisions: [
      { id: 'd1', prompt: 'p', blockRefs: ['l'], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ],
  }],
  ['PresentPlanInput', PresentPlanInput, {
    project: 'demo',
    headline: 'h',
    blocks: [{ id: 'ph', type: 'phases', phases: [{ title: 'Phase 1' }] }],
  }],
  ['SpecInput', SpecInput, {
    project: 'demo',
    headline: 'h',
    goal: 'the outcome',
    criteria: [{ id: 'c1', behavior: 'b', good: 'g', bad: 'anti', tracesTo: 't' }],
  }],
  ['ReviewResultsInput', ReviewResultsInput, {
    project: 'demo',
    headline: 'h',
    claims: [{ id: 'c1', claim: 'done', evidence: [{ id: 'e1', type: 'markdown', text: 'proof' }] }],
  }],
  ['PresentReportInput', PresentReportInput, {
    project: 'demo',
    headline: 'h',
    blocks: [{ id: 'b1', type: 'markdown', text: 'report' }],
  }],
]

describe.each(GATES)('sessionKey on %s', (_name, schema, minimal) => {
  it('accepts the input WITHOUT sessionKey (backwards compatible)', () => {
    expect(schema.safeParse(minimal).success).toBe(true)
  })
  it('accepts and preserves sessionKey', () => {
    const parsed = schema.parse({ ...minimal, sessionKey: 'cc-session-1' })
    expect(parsed.sessionKey).toBe('cc-session-1')
  })
  it('rejects an empty sessionKey', () => {
    expect(schema.safeParse({ ...minimal, sessionKey: '' }).success).toBe(false)
  })
})
