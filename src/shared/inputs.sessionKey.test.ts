import { describe, expect, it } from 'vitest'
import { ClarifyInput } from './inputs.js'

const minimal = {
  project: 'demo',
  headline: 'h',
  blocks: [
    { id: 'g', type: 'markdown', text: 'global' },
    { id: 'l', type: 'markdown', text: 'local' },
  ],
  decisions: [
    { id: 'd1', prompt: 'p', blockRefs: ['l'], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  ],
}

describe('sessionKey input field', () => {
  it('accepts a clarify input WITHOUT sessionKey (backwards compatible)', () => {
    expect(ClarifyInput.safeParse(minimal).success).toBe(true)
  })
  it('accepts and preserves sessionKey', () => {
    const parsed = ClarifyInput.parse({ ...minimal, sessionKey: 'cc-session-1' })
    expect(parsed.sessionKey).toBe('cc-session-1')
  })
  it('rejects an empty sessionKey', () => {
    expect(ClarifyInput.safeParse({ ...minimal, sessionKey: '' }).success).toBe(false)
  })
})
