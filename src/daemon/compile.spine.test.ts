import { describe, expect, it } from 'vitest'
import { compileClarify, compilePlan, compileSpec, compileResults } from './compile.js'

const clarifyInput = {
  project: 'demo',
  headline: 'h',
  blocks: [
    { id: 'g', type: 'markdown' as const, text: 'global' },
    { id: 'l', type: 'markdown' as const, text: 'local' },
  ],
  decisions: [
    { id: 'd1', prompt: 'p', blockRefs: ['l'], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  ],
}

const planInput = {
  project: 'demo',
  headline: 'the plan',
  blocks: [{ id: 'ph', type: 'phases' as const, phases: [{ title: 'Phase 1' }] }],
  decisions: [
    { id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  ],
}

const specInput = {
  project: 'demo',
  headline: 'definition of done',
  goal: 'ship securely',
  criteria: [{ id: 'cr1', behavior: 'tokens secure', good: 'tokens secure holds', bad: 'tokens secure fails', tracesTo: 'd1' }],
  blocks: [],
}

const resultsInput = {
  project: 'demo',
  headline: 'done',
  claims: [{ id: 'c1', claim: 'tests pass', evidence: [{ id: 'e1', type: 'markdown' as const, text: 'x' }] }],
}

describe('compile threads claudeSessionId onto cards', () => {
  it('clarify card carries meta.claudeSessionId', () => {
    const card = compileClarify(clarifyInput as never, { agent: 'claude-code', claudeSessionId: 'cc-1' })
    expect(card.claudeSessionId).toBe('cc-1')
    expect(card.session.agent).toBe('claude-code')
  })
  it('card omits claudeSessionId when meta has none (legacy caller)', () => {
    const card = compileClarify(clarifyInput as never, { agent: 'claude-code' })
    expect(card.claudeSessionId).toBeUndefined()
  })

  it('plan card carries meta.claudeSessionId', () => {
    const card = compilePlan(planInput as never, { agent: 'claude-code', claudeSessionId: 'cc-2' })
    expect(card.claudeSessionId).toBe('cc-2')
  })
  it('plan card omits claudeSessionId when meta has none', () => {
    const card = compilePlan(planInput as never, { agent: 'claude-code' })
    expect(card.claudeSessionId).toBeUndefined()
  })

  it('spec card carries meta.claudeSessionId', () => {
    const card = compileSpec(specInput as never, { agent: 'claude-code', claudeSessionId: 'cc-3' })
    expect(card.claudeSessionId).toBe('cc-3')
  })
  it('spec card omits claudeSessionId when meta has none', () => {
    const card = compileSpec(specInput as never, { agent: 'claude-code' })
    expect(card.claudeSessionId).toBeUndefined()
  })

  it('results card carries meta.claudeSessionId', () => {
    const card = compileResults(resultsInput as never, { agent: 'claude-code', claudeSessionId: 'cc-4' })
    expect(card.claudeSessionId).toBe('cc-4')
  })
  it('results card omits claudeSessionId when meta has none', () => {
    const card = compileResults(resultsInput as never, { agent: 'claude-code' })
    expect(card.claudeSessionId).toBeUndefined()
  })
})
