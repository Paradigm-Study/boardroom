import { describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { buildSummary } from './summary.js'

const claim = (id: string, prompt: string): Card['decisions'][number] => ({
  id, prompt,
  options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }],
  noteRequiredOn: ['revise', 'reject'],
})

function resultsCard(): Card {
  return {
    id: 'c1', stage: 'results',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'done', blocks: [],
    decisions: [
      claim('claim:c1', 'tests pass'),
      claim('claim:c2', 'docs updated'),
      claim('claim:c3', 'lint is clean'),
      { id: 'results_verdict', prompt: 'Is the session complete?', options: [{ id: 'complete', label: 'Mark complete' }, { id: 'continue', label: 'Keep going' }] },
    ],
    status: 'pending', createdAt: '2026-06-11T00:00:00.000Z',
  }
}

describe('buildSummary — results', () => {
  it('"keep going" leads with NOT complete and groups rejected / revise / add-on as next steps', () => {
    const s = buildSummary(resultsCard(), {
      'claim:c1': { chosen: ['reject'], note: 'tests are flaky, pin the seed' },
      'claim:c2': { chosen: ['revise'], note: 'also add a DB index' },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['continue'], note: 'and write a CHANGELOG entry' },
    })

    expect(s.split('\n')[0]).toMatch(/NOT complete/)
    // rejected claims are flagged as drop/redo work, with their notes
    expect(s).toMatch(/Reject/)
    expect(s).toContain('tests pass')
    expect(s).toContain('tests are flaky, pin the seed')
    // revise claims (on the right track) are a separate group
    expect(s).toMatch(/Revise/)
    expect(s).toContain('also add a DB index')
    // the verdict's own note is the card-level add-on
    expect(s).toContain('write a CHANGELOG entry')
    // approved claims listed last, as context
    expect(s).toContain('lint is clean')
    // Reject group precedes the Approved group. Guard both indices are present
    // first — search() returns -1 for a missing section, which is < any real index
    // and would let the ordering assertion false-pass if a group vanished.
    const rejectIdx = s.search(/Reject/)
    const approvedIdx = s.search(/Approved as-is/)
    expect(rejectIdx).toBeGreaterThanOrEqual(0)
    expect(approvedIdx).toBeGreaterThanOrEqual(0)
    expect(rejectIdx).toBeLessThan(approvedIdx)
  })

  it('"mark complete" leads with COMPLETE and omits reject/revise when all approved', () => {
    const s = buildSummary(resultsCard(), {
      'claim:c1': { chosen: ['approve'] },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })

    expect(s.split('\n')[0]).toMatch(/COMPLETE/)
    expect(s).not.toMatch(/NOT complete/)
    expect(s).not.toMatch(/Reject|Revise|Added instructions/)
    expect(s).toContain('tests pass')
  })

  it('completion is independent of the votes: still leads COMPLETE while listing a rejected claim', () => {
    const s = buildSummary(resultsCard(), {
      'claim:c1': { chosen: ['reject'], note: 'this one was wrong but I am done anyway' },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })

    expect(s.split('\n')[0]).toMatch(/COMPLETE/)
    expect(s).not.toMatch(/NOT complete/)
    expect(s).toMatch(/Reject/)
    expect(s).toContain('this one was wrong but I am done anyway')
  })

  it('surfaces add-on attachments on the verdict', () => {
    const s = buildSummary(resultsCard(), {
      'claim:c1': { chosen: ['approve'] },
      'claim:c2': { chosen: ['approve'] },
      'claim:c3': { chosen: ['approve'] },
      results_verdict: {
        chosen: ['continue'],
        note: 'see the mockup',
        attachments: [{ id: 'a1', name: 'mockup.png', size: 10, path: '/tmp/mockup.png', field: 'note', uploadedAt: '2026-06-11T00:00:00.000Z' }],
      },
    })

    expect(s).toContain('Added instructions')
    expect(s).toContain('mockup.png')
    expect(s).toContain('/tmp/mockup.png')
  })
})

describe('buildSummary — plan', () => {
  it('leads with the verdict and lists chosen options with labels', () => {
    const card: Card = {
      ...resultsCard(), stage: 'plan',
      decisions: [
        { id: 'd1', prompt: 'Storage?', options: [{ id: 'a', label: 'Cookie' }, { id: 'b', label: 'Local' }] },
        { id: 'plan_verdict', prompt: 'Verdict on this plan', options: [{ id: 'approve', label: 'Approve plan' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }] },
      ],
    }
    const s = buildSummary(card, {
      d1: { chosen: ['a'], note: 'rotate refresh tokens weekly' },
      plan_verdict: { chosen: ['approve'] },
    })
    const lines = s.split('\n')
    expect(lines[0]).toBe('Plan verdict: approve')
    expect(s).toContain('Storage?: Cookie')
    expect(s).toContain('rotate refresh tokens weekly')
  })

  it('renders a custom "other" answer with its text', () => {
    const card: Card = {
      ...resultsCard(), stage: 'clarify',
      decisions: [
        { id: 'd1', prompt: 'Storage?', options: [{ id: 'a', label: 'Cookie' }, { id: 'b', label: 'Local' }] },
      ],
    }
    const s = buildSummary(card, { d1: { chosen: ['__other__'], custom: 'IndexedDB with a 7-day TTL' } })
    expect(s).toContain('Storage?: Other: IndexedDB with a 7-day TTL')
  })

  it('includes attachment file paths with the relevant answer', () => {
    const card: Card = {
      ...resultsCard(), stage: 'clarify',
      decisions: [
        { id: 'd1', prompt: 'Which layout?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      ],
    }
    const s = buildSummary(card, {
      d1: {
        chosen: ['a'],
        note: 'the screenshot shows the broken input',
        attachments: [{
          id: 'att-1',
          name: 'broken-layout.png',
          mime: 'image/png',
          size: 42,
          path: '/tmp/boardroom/attachments/c1/att-1-broken-layout.png',
          field: 'note',
          uploadedAt: '2026-06-16T12:00:00.000Z',
        }],
      },
    })

    expect(s).toContain('Attachments:')
    expect(s).toContain('broken-layout.png')
    expect(s).toContain('/tmp/boardroom/attachments/c1/att-1-broken-layout.png')
  })
})
