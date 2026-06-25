import { describe, expect, it } from 'vitest'
import type { Card, Criterion } from '../shared/card.js'
import { SPEC_VERDICT_ID } from '../shared/card.js'
import { buildSummary } from './summary.js'

const claim = (id: string, prompt: string, criterionId?: string): Card['decisions'][number] => ({
  id, prompt,
  options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }],
  noteRequiredOn: ['revise', 'reject'],
  ...(criterionId ? { criterionId } : {}),
})

const crit = (id: string, behavior: string): Criterion =>
  ({ id, behavior, good: `${behavior} holds`, bad: `${behavior} regressed`, tracesTo: 'd1' })

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

describe('buildSummary — results judged against criteria', () => {
  function specResultsCard(): Card {
    return {
      ...resultsCard(),
      criteria: [crit('cr1', 'tokens are secure'), crit('cr2', 'tests pass')],
      decisions: [
        claim('claim:c1', 'tokens in httpOnly cookie', 'cr1'),
        claim('claim:c2', '42 tests pass', 'cr2'),
        { id: 'results_verdict', prompt: 'Is the session complete?', options: [{ id: 'complete', label: 'Mark complete' }, { id: 'continue', label: 'Keep going' }] },
      ],
    }
  }

  it('leads the not-complete body with the unmet criteria, before the rejected group', () => {
    const s = buildSummary(specResultsCard(), {
      'claim:c1': { chosen: ['approve'] },                 // cr1 met
      'claim:c2': { chosen: ['reject'], note: 'still red' }, // cr2 unmet
      results_verdict: { chosen: ['continue'] },
    })
    expect(s).toMatch(/UNMET CRITERIA \(1\)/)
    expect(s).toContain('tests pass')             // the unmet criterion's behavior
    expect(s).toContain('tests pass regressed')   // its bad outcome to avoid
    expect(s).not.toMatch(/UNMET[\s\S]*tokens are secure/) // the met one isn't listed as unmet
    const unmetIdx = s.search(/UNMET CRITERIA/)
    const rejectIdx = s.search(/Reject/)
    expect(unmetIdx).toBeGreaterThanOrEqual(0)
    expect(rejectIdx).toBeGreaterThanOrEqual(0)
    expect(unmetIdx).toBeLessThan(rejectIdx)
  })

  it('a criterion with no claim at all counts as unmet', () => {
    const card = specResultsCard()
    const s = buildSummary(card, {
      'claim:c1': { chosen: ['approve'] },   // cr1 met; cr2 has a claim but unreviewed below
      'claim:c2': { chosen: ['revise'], note: 'almost' }, // revise ≠ met
      results_verdict: { chosen: ['continue'] },
    })
    expect(s).toMatch(/UNMET CRITERIA \(1\)/)
    expect(s).toContain('tests pass')
  })

  it('reports all criteria met when each has an approved claim', () => {
    const s = buildSummary(specResultsCard(), {
      'claim:c1': { chosen: ['approve'] },
      'claim:c2': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })
    expect(s).toMatch(/all .*criteria met/i)
    expect(s).not.toMatch(/UNMET CRITERIA/)
  })

  it('flags marking complete while criteria remain unmet (human is still sovereign)', () => {
    const s = buildSummary(specResultsCard(), {
      'claim:c1': { chosen: ['approve'] },
      'claim:c2': { chosen: ['reject'], note: 'nope' },
      results_verdict: { chosen: ['complete'] },
    })
    expect(s.split('\n')[0]).toMatch(/COMPLETE/)
    expect(s).toMatch(/unmet/i)
  })
})

describe('buildSummary — spec', () => {
  function specCard(): Card {
    return {
      id: 's1', stage: 'spec',
      session: { agent: 'claude-code', project: 'demo' },
      headline: 'definition of done', blocks: [],
      criteria: [crit('cr1', 'tokens are secure'), crit('cr2', 'tests pass')],
      decisions: [
        { id: 'crit:cr1', prompt: 'tokens are secure', criterionId: 'cr1', options: [{ id: 'keep', label: 'Keep' }, { id: 'adjust', label: 'Adjust' }, { id: 'drop', label: 'Drop' }], noteRequiredOn: ['adjust', 'drop'] },
        { id: 'crit:cr2', prompt: 'tests pass', criterionId: 'cr2', options: [{ id: 'keep', label: 'Keep' }, { id: 'adjust', label: 'Adjust' }, { id: 'drop', label: 'Drop' }], noteRequiredOn: ['adjust', 'drop'] },
        { id: SPEC_VERDICT_ID, prompt: 'Lock this acceptance contract?', options: [{ id: 'lock', label: 'Lock spec' }, { id: 'revise', label: 'Revise' }] },
      ],
      specRef: '/tmp/spec.md',
      status: 'pending', createdAt: '2026-06-23T00:00:00.000Z',
    }
  }

  it('locking leads with LOCKED and lists the kept contract (good/bad) plus the write-to-specRef instruction', () => {
    const s = buildSummary(specCard(), {
      'crit:cr1': { chosen: ['keep'] },
      'crit:cr2': { chosen: ['adjust'], note: 'must also cover refresh tokens' },
      spec_verdict: { chosen: ['lock'] },
    })
    expect(s.split('\n')[0]).toMatch(/LOCKED/)
    expect(s).toContain('tokens are secure')
    expect(s).toContain('tokens are secure holds')   // the good outcome
    expect(s).toContain('must also cover refresh tokens')   // adjust note
    expect(s).toContain('/tmp/spec.md')   // write-back instruction
  })

  it('dropping a criterion lists it as out of scope', () => {
    const s = buildSummary(specCard(), {
      'crit:cr1': { chosen: ['keep'] },
      'crit:cr2': { chosen: ['drop'], note: 'not this milestone' },
      spec_verdict: { chosen: ['lock'] },
    })
    expect(s).toMatch(/out of scope/i)
    expect(s).toContain('not this milestone')
  })

  it('revise leads with sent-back and carries the verdict note', () => {
    const s = buildSummary(specCard(), {
      'crit:cr1': { chosen: ['keep'] },
      'crit:cr2': { chosen: ['keep'] },
      spec_verdict: { chosen: ['revise'], note: 'add a performance criterion' },
    })
    expect(s.split('\n')[0]).toMatch(/sent back/i)
    expect(s).toContain('add a performance criterion')
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
