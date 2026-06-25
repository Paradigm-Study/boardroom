import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../shared/card.js'
import { ConflictError, NotFoundError, Queue, ValidationError } from './queue.js'
import { Store } from './store.js'

function card(id: string, fingerprint = `fp-${id}`): Card {
  return {
    id, stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [{
      id: 'd1', prompt: 'p', multi: false,
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      noteRequiredOn: ['b'],
    }],
    status: 'pending', createdAt: new Date().toISOString(),
    fingerprint,
  }
}

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

function specCard(id: string, fingerprint = `fp-${id}`): Card {
  const crit = (cid: string, prompt: string): Card['decisions'][number] => ({
    id: cid, prompt, criterionId: cid.replace('crit:', ''),
    options: [{ id: 'keep', label: 'Keep' }, { id: 'adjust', label: 'Adjust' }, { id: 'drop', label: 'Drop' }],
    noteRequiredOn: ['adjust', 'drop'],
  })
  return {
    id, stage: 'spec',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    criteria: [
      { id: 'a', behavior: 'A holds', good: 'A passes', bad: 'A breaks', tracesTo: 'd1' },
      { id: 'b', behavior: 'B holds', good: 'B passes', bad: 'B breaks', tracesTo: 'd1' },
    ],
    decisions: [
      crit('crit:a', 'A holds'),
      crit('crit:b', 'B holds'),
      { id: 'spec_verdict', prompt: 'Lock this acceptance contract?', options: [{ id: 'lock', label: 'Lock spec' }, { id: 'revise', label: 'Revise' }], noteRequiredOn: ['revise'] },
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
  dir = mkdtempSync(join(tmpdir(), 'boardroom-'))
  store = new Store(join(dir, 'test.sqlite'))
  queue = new Queue(store)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Queue.decide', () => {
  it('resolves a live waiter, marks delivered, persists decided', () => {
    const resolve = vi.fn()
    queue.submit(card('c1'), { resolve, reject: vi.fn() })
    const { card: updated, summary, delivered } = queue.decide('c1', { d1: { chosen: ['a'] } })
    expect(updated.status).toBe('decided')
    expect(updated.answers?.d1.chosen).toEqual(['a'])
    expect(delivered).toBe(true)
    expect(updated.deliveredAt).toBeTruthy()
    expect(resolve).toHaveBeenCalledWith({ cardId: 'c1', decisions: { d1: { chosen: ['a'] } }, summary })
    expect(summary).toContain('p: A')
  })

  it('rejects double-decide with ConflictError', () => {
    queue.submit(card('c1'), noop)
    queue.decide('c1', { d1: { chosen: ['a'] } })
    expect(() => queue.decide('c1', { d1: { chosen: ['a'] } })).toThrow(ConflictError)
  })

  it('throws NotFoundError for unknown cards', () => {
    expect(() => queue.decide('nope', {})).toThrow(NotFoundError)
  })

  it('validates: missing answer, unknown option, multi violation, missing required note', () => {
    queue.submit(card('c1'), noop)
    expect(() => queue.decide('c1', {})).toThrow(ValidationError)
    expect(() => queue.decide('c1', { d1: { chosen: ['zzz'] } })).toThrow(ValidationError)
    expect(() => queue.decide('c1', { d1: { chosen: ['a', 'b'] } })).toThrow(ValidationError)
    expect(() => queue.decide('c1', { d1: { chosen: ['b'] } })).toThrow(/requires a note/)
  })

  it('accepts the "__other__" choice with custom text, rejects it without', () => {
    queue.submit(card('c1'), noop)
    expect(() => queue.decide('c1', { d1: { chosen: ['__other__'] } })).toThrow(/custom text/)
    const { summary } = queue.decide('c1', { d1: { chosen: ['__other__'], custom: 'split the difference' } })
    expect(summary).toContain('Other: split the difference')
  })

  it('plan send-back (revise) needs only the verdict, not every sub-decision', () => {
    const planCard: Card = {
      ...card('plan1'), stage: 'plan',
      decisions: [
        { id: 'storage', prompt: 'Storage?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
        { id: 'plan_verdict', prompt: 'Verdict', options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }], noteRequiredOn: ['revise', 'reject'] },
      ],
    }
    queue.submit(planCard, noop)
    // approve still requires the sub-decision answered
    expect(() => queue.decide('plan1', { plan_verdict: { chosen: ['approve'] } })).toThrow(ValidationError)
    // revise needs only the verdict + its note
    const { card: updated } = queue.decide('plan1', { plan_verdict: { chosen: ['revise'], note: 'rethink storage' } })
    expect(updated.status).toBe('decided')
  })

  it('results "keep going" needs only the verdict, not every claim reviewed', () => {
    queue.submit(resultsCard('r1'), noop)
    // No claim votes at all — "keep going" is the send-back analog: verdict only.
    const { card: updated } = queue.decide('r1', { results_verdict: { chosen: ['continue'] } })
    expect(updated.status).toBe('decided')
  })

  it('spec send-back (revise) needs only the verdict, not every criterion addressed', () => {
    queue.submit(specCard('s1'), noop)
    // lock still requires each criterion answered
    expect(() => queue.decide('s1', { spec_verdict: { chosen: ['lock'] } })).toThrow(ValidationError)
    // revise is the send-back analog: just the verdict + its note
    const { card: updated } = queue.decide('s1', { spec_verdict: { chosen: ['revise'], note: 'add a perf criterion' } })
    expect(updated.status).toBe('decided')
  })

  it('spec "lock" requires every criterion addressed', () => {
    queue.submit(specCard('s1'), noop)
    // crit:b unaddressed — locking the contract is not allowed.
    expect(() => queue.decide('s1', {
      'crit:a': { chosen: ['keep'] },
      spec_verdict: { chosen: ['lock'] },
    })).toThrow(ValidationError)
  })

  it('results "keep going" still requires a note on any claim voted revise/reject', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['reject'] },
      results_verdict: { chosen: ['continue'] },
    })).toThrow(/requires a note/)
  })

  it('results "mark complete" requires every claim reviewed', () => {
    queue.submit(resultsCard('r1'), noop)
    // claim:b is unreviewed — completing the session is not allowed.
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })).toThrow(ValidationError)

    const { card: updated } = queue.decide('r1', {
      'claim:a': { chosen: ['approve'] },
      'claim:b': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    })
    expect(updated.status).toBe('decided')
  })

  it('results decisions always require the session verdict', () => {
    queue.submit(resultsCard('r1'), noop)
    expect(() => queue.decide('r1', {
      'claim:a': { chosen: ['approve'] },
      'claim:b': { chosen: ['approve'] },
    })).toThrow(/results_verdict/)
  })

  it('decides an orphaned card with no live waiter as undelivered (claimable later)', () => {
    const { cardId, gen } = queue.submit(card('c1'), noop)
    queue.disconnect(cardId, gen)
    expect(store.get('c1')?.status).toBe('orphaned')
    const { delivered, card: updated } = queue.decide('c1', { d1: { chosen: ['a'] } })
    expect(delivered).toBe(false)
    expect(updated.status).toBe('decided')
    expect(updated.deliveredAt).toBeUndefined()
    expect(updated.answers?.d1.chosen).toEqual(['a'])
  })
})

describe('Queue.disconnect', () => {
  it('orphans a pending card and rejects its waiter', () => {
    const reject = vi.fn()
    const { cardId, gen } = queue.submit(card('c1'), { resolve: vi.fn(), reject })
    queue.disconnect(cardId, gen)
    expect(reject).toHaveBeenCalled()
    expect(store.get('c1')?.status).toBe('orphaned')
    expect(store.get('c1')?.orphanedReason).toBe('disconnect')
  })

  it('is a no-op when a newer connection has taken over (stale gen)', () => {
    const { cardId, gen } = queue.submit(card('c1'), noop)
    queue.disconnect(cardId, gen)             // orphan
    const second = queue.submit(card('c1'), noop) // reattach revives to pending, new gen
    queue.disconnect(cardId, gen)             // stale close from the first connection
    expect(store.get('c1')?.status).toBe('pending')
    expect(second.gen).toBeGreaterThan(gen)
  })

  it('stamps a fresh orphan clock so a long-lived card stays reattachable', () => {
    const { cardId, gen } = queue.submit(card('c1', 'shared-fp'), noop)
    // Back-date creation to 48h ago: the reattach window must key off orphan time
    // (now), not this ancient createdAt.
    store.update({ ...store.get(cardId)!, createdAt: new Date(Date.now() - 48 * 60 * 60_000).toISOString() })
    queue.disconnect(cardId, gen)                            // orphan now → stamps orphanedAt = now
    const retry = queue.submit(card('c2', 'shared-fp'), noop) // identical fingerprint
    expect(retry.cardId).toBe('c1')                          // revived in place, not duplicated
    expect(store.list().filter(c => c.fingerprint === 'shared-fp')).toHaveLength(1)
  })

  it('clears orphan metadata when a retry revives an orphaned card to pending', () => {
    const { cardId, gen } = queue.submit(card('c1', 'shared-fp'), noop)
    queue.disconnect(cardId, gen)                            // orphaned + orphanedAt + reason 'disconnect'
    queue.submit(card('c2', 'shared-fp'), noop)              // reattach → revive to pending
    const revived = store.get(cardId)
    expect(revived?.status).toBe('pending')
    expect(revived?.orphanedReason).toBeUndefined()         // no stale reason on a live card
    expect(revived?.orphanedAt).toBeUndefined()
  })
})

describe('Queue.park', () => {
  it('parks a pending card as orphaned WITHOUT rejecting its waiter (graceful, not an error)', () => {
    const resolve = vi.fn()
    const reject = vi.fn()
    const { cardId, gen } = queue.submit(card('c1'), { resolve, reject })
    expect(queue.park(cardId, gen)).toBe(true)
    expect(store.get('c1')?.status).toBe('orphaned')   // reattachable, unlike a stranded 'pending'
    expect(store.get('c1')?.orphanedReason).toBe('park')
    expect(reject).not.toHaveBeenCalled()              // the handler resolves a STOP sentinel itself
    expect(resolve).not.toHaveBeenCalled()
  })

  it('is a no-op on a stale generation (a newer connection already took over)', () => {
    const { cardId, gen } = queue.submit(card('c1'), noop)
    queue.disconnect(cardId, gen)                  // orphan
    const second = queue.submit(card('c1'), noop)  // revive → pending, new gen
    expect(queue.park(cardId, gen)).toBe(false)    // stale gen from the first connection
    expect(store.get('c1')?.status).toBe('pending')
    expect(second.gen).toBeGreaterThan(gen)
  })

  it('is a no-op when the card is not pending (already decided/orphaned)', () => {
    const { cardId, gen } = queue.submit(card('c1'), noop)
    queue.decide('c1', { d1: { chosen: ['a'] } })
    expect(queue.park(cardId, gen)).toBe(false)
    expect(store.get('c1')?.status).toBe('decided')
  })

  it('a parked card is claimable: decide-then-reissue returns the stored answer, no duplicate', () => {
    const first = queue.submit(card('c1', 'shared-fp'), noop)
    expect(queue.park(first.cardId, first.gen)).toBe(true)
    queue.decide('c1', { d1: { chosen: ['a'] } })            // human decides the parked card → undelivered
    expect(store.get('c1')?.deliveredAt).toBeUndefined()

    const resolve = vi.fn()
    const retry = queue.submit(card('c2', 'shared-fp'), { resolve, reject: vi.fn() })
    expect(retry.gen).toBe(-1)                                // claimed immediately
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'c1' }))
    expect(store.get('c1')?.deliveredAt).toBeTruthy()
    expect(store.get('c2')).toBeUndefined()                   // no duplicate
  })

  it('a stale close after park does not double-process (waiter already detached)', () => {
    const { cardId, gen } = queue.submit(card('c1'), noop)
    expect(queue.park(cardId, gen)).toBe(true)
    queue.disconnect(cardId, gen)                  // the later res.on('close') fires this
    expect(store.get('c1')?.status).toBe('orphaned')  // unchanged, no throw
  })
})

describe('Queue.submit — reattach & claim', () => {
  it('reattaches a retry to an orphaned card instead of duplicating', () => {
    const first = queue.submit(card('c1', 'shared-fp'), noop)
    queue.disconnect(first.cardId, first.gen)
    const retry = queue.submit(card('c2', 'shared-fp'), noop)
    expect(retry.cardId).toBe('c1')                 // same card, not c2
    expect(store.get('c2')).toBeUndefined()         // no duplicate inserted
    expect(store.get('c1')?.status).toBe('pending') // revived
  })

  it('claims a decision made while the agent was disconnected', () => {
    const first = queue.submit(card('c1', 'shared-fp'), noop)
    queue.disconnect(first.cardId, first.gen)
    queue.decide('c1', { d1: { chosen: ['a'] } })   // human decides offline → undelivered
    expect(store.get('c1')?.deliveredAt).toBeUndefined()

    const resolve = vi.fn()
    const retry = queue.submit(card('c2', 'shared-fp'), { resolve, reject: vi.fn() })
    expect(retry.gen).toBe(-1)                        // resolved immediately
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'c1' }))
    expect(store.get('c1')?.deliveredAt).toBeTruthy() // now marked delivered
    expect(store.get('c2')).toBeUndefined()
  })

  it('does not reattach to a live pending card (no stealing)', () => {
    queue.submit(card('c1', 'shared-fp'), noop)       // still pending, live waiter
    const second = queue.submit(card('c2', 'shared-fp'), noop)
    expect(second.cardId).toBe('c2')                  // fresh card, did not steal c1
    expect(store.get('c1')?.status).toBe('pending')
  })

  it('reattaches an orphaned spec card with its criteria contract intact, claimable offline', () => {
    const first = queue.submit(specCard('s1', 'spec-fp'), noop)
    queue.disconnect(first.cardId, first.gen)          // agent dropped mid-lock
    // Human locks the contract offline (revive-by-decide is undelivered).
    queue.decide('s1', { 'crit:a': { chosen: ['keep'] }, 'crit:b': { chosen: ['keep'] }, spec_verdict: { chosen: ['lock'] } })
    expect(store.get('s1')?.deliveredAt).toBeUndefined()
    expect(store.get('s1')?.criteria?.length).toBe(2) // contract survived the round-trip

    const resolve = vi.fn()
    const retry = queue.submit(specCard('s2', 'spec-fp'), { resolve, reject: vi.fn() })
    expect(retry.gen).toBe(-1)                          // claimed immediately
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ cardId: 's1' }))
    expect(store.get('s2')).toBeUndefined()             // no duplicate
  })
})

describe('Queue events', () => {
  it('emits card on submit, decide, and disconnect', () => {
    const events: string[] = []
    queue.on('card', (c: Card) => events.push(c.status))
    queue.submit(card('c1'), noop)
    queue.decide('c1', { d1: { chosen: ['a'] } })
    const { cardId, gen } = queue.submit(card('c2'), noop)
    queue.disconnect(cardId, gen)
    expect(events).toEqual(['pending', 'decided', 'pending', 'orphaned'])
  })
})
