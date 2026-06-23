import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { ConflictError, Queue, ValidationError } from './queue.js'
import { Store } from './store.js'

// A results card mirroring the real shape: two 3-way claims (approve/revise/reject,
// note required on revise/reject) plus the synthetic results_verdict (complete|continue).
function resultsCard(id: string, fingerprint = `fp-${id}`): Card {
  const claim = (cid: string, prompt: string): Card['decisions'][number] => ({
    id: cid, prompt,
    options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }],
    noteRequiredOn: ['revise', 'reject'],
  })
  return {
    id, stage: 'results',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [
      claim('claim:a', 'A'),
      claim('claim:b', 'B'),
      { id: 'results_verdict', prompt: 'Is the session complete?', options: [{ id: 'complete', label: 'Mark complete' }, { id: 'continue', label: 'Keep going' }] },
    ],
    status: 'pending', createdAt: new Date().toISOString(),
    fingerprint,
  }
}

const noop = { resolve: () => {}, reject: () => {} }

let dir: string
let store: Store
let queue: Queue

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-adv-'))
  store = new Store(join(dir, 'test.sqlite'))
  queue = new Queue(store)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('results gate — adversarial note enforcement', () => {
  it('complete + a reject claim with EMPTY-STRING note must throw (note required)', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['reject'], note: '' },
      'claim:b': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })).toThrow(ValidationError)
  })

  it('complete + a reject claim with WHITESPACE-ONLY note ("   ") must throw (non-empty after trim)', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['reject'], note: '   ' },
      'claim:b': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })).toThrow(/requires a note/)
  })

  it('continue + a VOTED revise claim with no note must throw, but the SAME claim left unanswered must NOT throw', () => {
    queue.submit(resultsCard('r1'), noop)
    // voted revise, no note → must throw
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['revise'] },
      results_verdict: { chosen: ['continue'] },
    })).toThrow(/requires a note/)

    // fresh card: claim:a simply unanswered → continue must NOT throw
    queue.submit(resultsCard('r2'), noop)
    const { card: updated } = queue.decide('r2', {
      results_verdict: { chosen: ['continue'] },
    })
    expect(updated.status).toBe('decided')
  })

  it('continue + a whitespace-only note on a voted revise claim must throw (trim, not presence)', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['revise'], note: '\t\n  ' },
      results_verdict: { chosen: ['continue'] },
    })).toThrow(/requires a note/)
  })
})

describe('results gate — completeness boundary', () => {
  it('complete with exactly ONE claim left unanswered must throw (all claims required)', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['approve'] },
      // claim:b omitted entirely
      results_verdict: { chosen: ['complete'] },
    })).toThrow(ValidationError)
  })

  it('complete with a claim present but chosen=[] (empty array) must throw (missing answer)', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['approve'] },
      'claim:b': { chosen: [] },
      results_verdict: { chosen: ['complete'] },
    })).toThrow(ValidationError)
  })
})

describe('results gate — hostile / legacy option ids', () => {
  it('a claim voted with the LEGACY id "deny" (not in this card\'s options) must throw unknown option', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['deny'], note: 'x' },
      'claim:b': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })).toThrow(/unknown option/)
  })

  it('a claim voted with the LEGACY id "changes" must throw unknown option', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['changes'], note: 'x' },
      'claim:b': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })).toThrow(/unknown option/)
  })

  it('a single-choice claim voted with two options ["approve","reject"] must throw single-choice', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['approve', 'reject'], note: 'x' },
      'claim:b': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })).toThrow(/single-choice/)
  })
})

describe('results gate — verdict integrity', () => {
  it('results_verdict answered with chosen=[] must throw (missing answer)', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['approve'] },
      'claim:b': { chosen: ['approve'] },
      results_verdict: { chosen: [] },
    })).toThrow(/results_verdict/)
  })

  it('results_verdict answered with garbage ["garbage"] (not complete/continue) must throw unknown option', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['approve'] },
      'claim:b': { chosen: ['approve'] },
      results_verdict: { chosen: ['garbage'] },
    })).toThrow(/unknown option/)
  })

  it('results_verdict missing entirely must throw', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['approve'] },
      'claim:b': { chosen: ['approve'] },
    })).toThrow(/results_verdict/)
  })

  it('a garbage verdict does NOT silently relax scope to "continue": unanswered claims are still enforced', () => {
    // With chosen=['garbage'], validationScope finds no matching RESULTS_VERDICT,
    // so the strict (all-claims) scope must apply. The first error surfaced should
    // be about the unknown verdict option, NOT a silent accept.
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      // both claims unanswered, garbage verdict
      results_verdict: { chosen: ['garbage'] },
    })).toThrow(ValidationError)
  })
})

describe('results gate — double-decide conflict', () => {
  it('deciding an already-decided results card throws ConflictError', () => {
    queue.submit(resultsCard('r1'), noop)
    queue.decide('r1', { results_verdict: { chosen: ['continue'] } })
    expect(() => queue.decide('r1', { results_verdict: { chosen: ['continue'] } })).toThrow(ConflictError)
  })
})
