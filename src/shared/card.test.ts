import { describe, expect, it } from 'vitest'
import { Block } from './blocks.js'
import { Card, Decision, DecisionAnswer } from './card.js'

const markdown = { id: 'b1', type: 'markdown', text: 'hello' }

const decision = {
  id: 'd1',
  prompt: 'Token storage?',
  options: [
    { id: 'cookie', label: 'Cookie + refresh', recommended: true },
    { id: 'local', label: 'LocalStorage' },
  ],
}

const card = {
  id: 'c1',
  stage: 'clarify',
  session: { agent: 'claude-code', project: 'demo' },
  headline: 'Need a call on token storage',
  blocks: [markdown],
  decisions: [decision],
  status: 'pending',
  createdAt: '2026-06-11T00:00:00.000Z',
}

describe('Block', () => {
  it('accepts every block type', () => {
    const blocks = [
      markdown,
      { id: 'g', type: 'graph', nodes: [{ id: 'n1', label: 'web' }], edges: [{ from: 'n1', to: 'n1' }] },
      { id: 'p', type: 'phases', phases: [{ title: 'Phase 1' }] },
      { id: 'o', type: 'options_compare', options: [
        { label: 'A', pros: ['fast'], cons: [] },
        { label: 'B', pros: [], cons: ['slow'] },
      ] },
      { id: 't', type: 'table', columns: ['k'], rows: [['v']] },
      { id: 'df', type: 'diff_stat', files: [{ path: 'a.ts', additions: 1, deletions: 2 }] },
      { id: 'e', type: 'evidence', output: 'all tests pass', command: 'npm test', exitCode: 0 },
      { id: 'm', type: 'mermaid', source: 'graph TD; a-->b' },
    ]
    for (const b of blocks) expect(Block.parse(b).id).toBe(b.id)
  })

  it('rejects an unknown type with the field path', () => {
    const r = Block.safeParse({ id: 'x', type: 'gif', url: 'nope' })
    expect(r.success).toBe(false)
  })
})

describe('Decision', () => {
  it('rejects duplicate option ids', () => {
    const r = Decision.safeParse({ ...decision, options: [decision.options[0], decision.options[0]] })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].path).toEqual(['options'])
  })

  it('rejects noteRequiredOn pointing at unknown options', () => {
    const r = Decision.safeParse({ ...decision, noteRequiredOn: ['missing'] })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].path).toEqual(['noteRequiredOn'])
  })

  it('requires at least two options', () => {
    expect(Decision.safeParse({ ...decision, options: [decision.options[0]] }).success).toBe(false)
  })
})

describe('Card', () => {
  it('parses a full card and defaults nothing silently', () => {
    const parsed = Card.parse(card)
    expect(parsed.status).toBe('pending')
    expect(parsed.session.agent).toBe('claude-code')
  })

  it('rejects a card with zero decisions', () => {
    expect(Card.safeParse({ ...card, decisions: [] }).success).toBe(false)
  })
})

describe('DecisionAnswer', () => {
  it('accepts uploaded attachment references', () => {
    const parsed = DecisionAnswer.parse({
      chosen: ['cookie'],
      note: 'see screenshot',
      attachments: [{
        id: 'att-1',
        name: 'layout.png',
        mime: 'image/png',
        size: 12_345,
        path: '/Users/me/.config/boardroom/attachments/c1/att-1-layout.png',
        url: '/api/cards/c1/attachments/att-1',
        field: 'note',
        uploadedAt: '2026-06-16T12:00:00.000Z',
      }],
    })

    expect(parsed.attachments?.[0].name).toBe('layout.png')
  })
})
