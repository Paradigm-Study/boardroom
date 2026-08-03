import { describe, expect, it } from 'vitest'
import { Entry } from './entry.js'

const report = {
  id: 'e1', type: 'report', claudeSessionId: 'cc-1',
  session: { agent: 'claude-code', project: 'demo' },
  headline: 'investigation findings',
  blocks: [{ id: 'b1', type: 'markdown', text: 'summary' }],
  createdAt: '2026-07-07T00:00:00.000Z',
}
const tag = {
  id: 'e2', type: 'tag', claudeSessionId: 'cc-1',
  session: { agent: 'claude-code', project: 'demo' },
  tag: 'stage:clarify:raised', cardId: 'c1',
  createdAt: '2026-07-07T00:00:00.000Z',
}

describe('Entry', () => {
  it('parses a report entry and round-trips JSON', () => {
    const parsed = Entry.parse(report)
    expect(Entry.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })
  it('parses a tag entry', () => {
    expect(Entry.parse(tag).type).toBe('tag')
  })
  it('accepts an UNBOUND report (no claudeSessionId) — legacy agents may post', () => {
    const { claudeSessionId: _drop, ...unbound } = report
    expect(Entry.safeParse(unbound).success).toBe(true)
  })
  it('rejects a report with zero blocks and a tag without cardId', () => {
    expect(Entry.safeParse({ ...report, blocks: [] }).success).toBe(false)
    const { cardId: _c, ...tagless } = tag
    expect(Entry.safeParse(tagless).success).toBe(false)
  })
})
