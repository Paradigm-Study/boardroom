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

  // The reserved global add-on rides the answers map as an extra key that is
  // never a decision: decide must tolerate it (verdict-neutral), persist it,
  // deliver it through the waiter, and render it as its own summary section.
  it('accepts, persists, and delivers the card_addon channel', () => {
    const resolve = vi.fn()
    queue.submit(card('c1'), { resolve, reject: vi.fn() })
    const answers = {
      d1: { chosen: ['a'] },
      card_addon: { chosen: [], note: 'also update the changelog' },
    }
    const { card: updated, summary } = queue.decide('c1', answers)
    expect(updated.status).toBe('decided')
    expect(updated.answers?.card_addon.note).toBe('also update the changelog')
    expect(resolve).toHaveBeenCalledWith({ cardId: 'c1', decisions: answers, summary })
    expect(summary).toContain('Added instructions — act on these:')
    expect(summary).toContain('also update the changelog')
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

describe('Queue.parkAllLive', () => {
  it('parks EVERY live gate on shutdown: resolves each waiter with a parked sentinel and orphans it as boot', () => {
    const a = { resolve: vi.fn(), reject: vi.fn() }
    const b = { resolve: vi.fn(), reject: vi.fn() }
    queue.submit(card('c1'), a)
    queue.submit(card('c2'), b)

    expect(queue.parkAllLive()).toBe(2)

    for (const [id, w] of [['c1', a], ['c2', b]] as const) {
      expect(store.get(id)?.status).toBe('orphaned')
      // 'boot' (not 'disconnect') so the tray/dashboard resurface it as reconnecting.
      expect(store.get(id)?.orphanedReason).toBe('boot')
      expect(w.resolve).toHaveBeenCalledWith({ parked: true, cardId: id })
      expect(w.reject).not.toHaveBeenCalled() // graceful: a STOP sentinel, never an error
    }
  })

  it('leaves the card reattachable: a re-issue after a shutdown-park revives it and claims the later decision', () => {
    const first = queue.submit(card('c1', 'shared-fp'), { resolve: vi.fn(), reject: vi.fn() })
    expect(queue.parkAllLive()).toBe(1)
    // Human decides the now-orphaned card after the restart-park.
    queue.decide(first.cardId, { d1: { chosen: ['a'] } })
    const resolve = vi.fn()
    const retry = queue.submit(card('c2', 'shared-fp'), { resolve, reject: vi.fn() })
    expect(retry.gen).toBe(-1)
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'c1' }))
    expect(store.get('c2')).toBeUndefined() // no duplicate
  })

  it('is a no-op when there are no live waiters (returns 0, resolves nothing)', () => {
    expect(queue.parkAllLive()).toBe(0)
  })

  it('does not re-park a card whose waiter is live but already decided (no double-resolve)', () => {
    const w = { resolve: vi.fn(), reject: vi.fn() }
    queue.submit(card('c1'), w)
    queue.decide('c1', { d1: { chosen: ['a'] } }) // resolves + detaches the waiter
    w.resolve.mockClear()
    expect(queue.parkAllLive()).toBe(0)
    expect(w.resolve).not.toHaveBeenCalled()
    expect(store.get('c1')?.status).toBe('decided')
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

// A session-bound gate: fingerprint + claudeSessionId set — the real-world case,
// since every hooked session passes its sessionKey. stage/headline/createdAt are
// overridable so a coalesce can be exercised across an adjusted headline, a
// different stage, or a specific age.
function boundCard(
  id: string,
  opts: { session: string; stage?: Card['stage']; headline?: string; fingerprint?: string; createdAt?: string },
): Card {
  return {
    ...card(id, opts.fingerprint ?? `fp-${id}`),
    claudeSessionId: opts.session,
    ...(opts.stage ? { stage: opts.stage } : {}),
    headline: opts.headline ?? 'h',
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  }
}

describe('Queue.submit — same-session reconnect coalescing', () => {
  it('coalesces a reconnect onto the session\'s still-PENDING gate instead of duplicating (the pending-race bug)', () => {
    const firstReject = vi.fn()
    queue.submit(boundCard('a', { session: 'S', fingerprint: 'fp' }), { resolve: vi.fn(), reject: firstReject })
    // The client re-issues before the daemon has orphaned A (A is still pending) —
    // the proven race that used to insert a duplicate.
    const retry = queue.submit(boundCard('b', { session: 'S', fingerprint: 'fp' }), noop)
    expect(retry.cardId).toBe('a')                                       // reused A's card
    expect(store.get('b')).toBeUndefined()                              // no duplicate inserted
    expect(store.list().filter(c => c.claudeSessionId === 'S')).toHaveLength(1)
    expect(firstReject).toHaveBeenCalled()                             // stale connection superseded
  })

  it('an ADJUSTED re-issue (same session+stage, reworded headline) refreshes the same card in place', () => {
    queue.submit(boundCard('a', { session: 'S', headline: 'first wording', fingerprint: 'fp-1' }), noop)
    const retry = queue.submit(boundCard('b', { session: 'S', headline: 'adjusted wording', fingerprint: 'fp-2' }), noop)
    expect(retry.cardId).toBe('a')                                     // same row reused, no twin
    expect(store.get('a')?.headline).toBe('adjusted wording')          // content refreshed to the latest call
    expect(store.get('a')?.fingerprint).toBe('fp-2')
    expect(store.get('b')).toBeUndefined()
  })

  it('preserves the reconnect target\'s ORIGINAL createdAt even when the re-issue is newer (identity, not a new gate)', () => {
    // A reconnect keeps the gate's identity: its id AND createdAt. createdAt is the
    // recency sort key (findReattachable/findSessionGate) and the activity-clock
    // fallback, so re-aging it on every retry would reshuffle the board.
    const OLD = new Date(Date.now() - 60 * 60_000).toISOString()      // gate first raised 1h ago
    store.insert({ ...boundCard('a', { session: 'S', fingerprint: 'fp', createdAt: OLD }), status: 'orphaned', orphanedAt: new Date(Date.now() - 60_000).toISOString(), orphanedReason: 'disconnect' })
    queue.submit(boundCard('b', { session: 'S', headline: 'reworded', fingerprint: 'fp-2', createdAt: new Date().toISOString() }), noop)
    expect(store.get('a')?.createdAt).toBe(OLD)                       // NOT re-aged to the re-issue's clock
    expect(store.get('a')?.headline).toBe('reworded')                // content still refreshed
  })

  it('revives an ORPHANED same-session gate on reconnect, refreshing to the latest content', () => {
    const first = queue.submit(boundCard('a', { session: 'S', fingerprint: 'fp' }), noop)
    queue.disconnect(first.cardId, first.gen)
    const retry = queue.submit(boundCard('b', { session: 'S', headline: 'reworded', fingerprint: 'fp-2' }), noop)
    expect(retry.cardId).toBe('a')
    expect(store.get('a')?.status).toBe('pending')
    expect(store.get('a')?.headline).toBe('reworded')
    expect(store.get('b')).toBeUndefined()
  })

  it('does NOT coalesce across DIFFERENT sessions, even while one is live (no cross-session steal)', () => {
    queue.submit(boundCard('a', { session: 'S1', fingerprint: 'fp' }), noop)       // live pending
    const other = queue.submit(boundCard('b', { session: 'S2', fingerprint: 'fp' }), noop)
    expect(other.cardId).toBe('b')                                     // its own card
    expect(store.get('a')?.status).toBe('pending')
    expect(store.list()).toHaveLength(2)
  })

  it('does NOT coalesce a DIFFERENT stage for the same session (a plan gate is not a clarify gate)', () => {
    queue.submit(boundCard('a', { session: 'S', stage: 'clarify', fingerprint: 'fp-c' }), noop)
    const retry = queue.submit(boundCard('b', { session: 'S', stage: 'plan', fingerprint: 'fp-p' }), noop)
    expect(retry.cardId).toBe('b')                                     // distinct gate → its own card
    expect(store.list().filter(c => c.claudeSessionId === 'S')).toHaveLength(2)
  })

  it('preserves the legacy no-session guarantee: a live no-session pending card is not coalesced onto', () => {
    queue.submit(card('c1', 'shared-fp'), noop)                        // no claudeSessionId, still pending
    const second = queue.submit(card('c2', 'shared-fp'), noop)
    expect(second.cardId).toBe('c2')                                   // fresh card — no steal, exactly as before
    expect(store.get('c1')?.status).toBe('pending')
  })

  it('auto-retires an already-stranded orphaned twin of the same session+stage on reconnect', () => {
    // Two pre-existing orphaned twins for one session+stage — the residue the
    // pre-fix pending-race left behind. Recent orphan clocks so both are in-window.
    const older = new Date(Date.now() - 120_000).toISOString()
    const newer = new Date(Date.now() - 60_000).toISOString()
    store.insert({ ...boundCard('old', { session: 'S', fingerprint: 'fp', createdAt: older }), status: 'orphaned', orphanedAt: older, orphanedReason: 'disconnect' })
    store.insert({ ...boundCard('new', { session: 'S', fingerprint: 'fp', createdAt: newer }), status: 'orphaned', orphanedAt: newer, orphanedReason: 'disconnect' })
    const retry = queue.submit(boundCard('retry', { session: 'S', fingerprint: 'fp' }), noop)
    expect(retry.cardId).toBe('new')                                   // reused the most-recent twin
    expect(store.get('new')?.status).toBe('pending')
    expect(store.get('old')?.status).toBe('dismissed')                 // the stranded twin retired
    expect(store.list().filter(c => c.claudeSessionId === 'S' && c.status !== 'dismissed')).toHaveLength(1)
  })

  it('emits a card event for the retired twin so the dashboard drops it live (not just on reload)', () => {
    const older = new Date(Date.now() - 120_000).toISOString()
    const newer = new Date(Date.now() - 60_000).toISOString()
    store.insert({ ...boundCard('old', { session: 'S', fingerprint: 'fp', createdAt: older }), status: 'orphaned', orphanedAt: older, orphanedReason: 'disconnect' })
    store.insert({ ...boundCard('new', { session: 'S', fingerprint: 'fp', createdAt: newer }), status: 'orphaned', orphanedAt: newer, orphanedReason: 'disconnect' })
    const events: Card[] = []
    queue.on('card', (c: Card) => events.push(c))
    queue.submit(boundCard('retry', { session: 'S', fingerprint: 'fp' }), noop)
    // The superseded twin must broadcast its terminal 'dismissed' status over SSE,
    // mirroring Queue.dismiss — otherwise the stale duplicate lingers until reload.
    expect(events.some(e => e.id === 'old' && e.status === 'dismissed')).toBe(true)
  })

  it('does NOT retire a genuinely DIFFERENT (different-fingerprint) orphaned gate of the same session+stage', () => {
    // A true-duplicate pair (fp-DUP) plus a DISTINCT still-actionable gate (fp-OTHER),
    // all orphaned in the same session+stage. Inserted directly so the reconnect below
    // resolves via findReattachable's EXACT-fingerprint match (not findSessionGate's
    // by-stage coalesce), isolating retireSupersededTwins' scope.
    const ts = new Date(Date.now() - 30_000).toISOString()
    store.insert({ ...boundCard('dup', { session: 'S', fingerprint: 'fp-DUP', createdAt: ts }), status: 'orphaned', orphanedAt: ts, orphanedReason: 'disconnect' })
    store.insert({ ...boundCard('distinct', { session: 'S', fingerprint: 'fp-OTHER', createdAt: ts }), status: 'orphaned', orphanedAt: ts, orphanedReason: 'disconnect' })
    const retry = queue.submit(boundCard('retry', { session: 'S', fingerprint: 'fp-DUP' }), noop)
    expect(retry.cardId).toBe('dup')                                 // reconnected the true duplicate (exact fp)
    expect(store.get('distinct')?.status).toBe('orphaned')          // the DIFFERENT gate is untouched, not retired
  })

  it('retires a stranded same-ORIGINAL-fingerprint twin even when the reconnect ADJUSTED the headline', () => {
    // Two pre-existing race twins carrying the ORIGINAL fingerprint, both in-window.
    const older = new Date(Date.now() - 120_000).toISOString()
    const newer = new Date(Date.now() - 60_000).toISOString()
    store.insert({ ...boundCard('old', { session: 'S', fingerprint: 'fp-orig', createdAt: older }), status: 'orphaned', orphanedAt: older, orphanedReason: 'boot' })
    store.insert({ ...boundCard('new', { session: 'S', fingerprint: 'fp-orig', createdAt: newer }), status: 'orphaned', orphanedAt: newer, orphanedReason: 'boot' })
    // Re-issue the SAME logical gate with a reworded headline → a NEW fingerprint.
    const retry = queue.submit(boundCard('retry', { session: 'S', fingerprint: 'fp-new', headline: 'reworded' }), noop)
    expect(retry.cardId).toBe('new')                                  // coalesced onto the most-recent twin (session+stage)
    expect(store.get('new')?.status).toBe('pending')
    expect(store.get('new')?.fingerprint).toBe('fp-new')             // refreshed to the adjusted content
    expect(store.get('old')?.status).toBe('dismissed')               // the same-ORIGINAL-gate twin is still retired
  })

  it('does NOT retire a same-fingerprint twin that has aged out of the reattach window', () => {
    const ancient = new Date(Date.now() - 48 * 60 * 60_000).toISOString()   // 48h ago, beyond the 24h window
    store.insert({ ...boundCard('ancient', { session: 'S', fingerprint: 'fp', createdAt: ancient }), status: 'orphaned', orphanedAt: ancient, orphanedReason: 'disconnect' })
    const first = queue.submit(boundCard('a', { session: 'S', fingerprint: 'fp' }), noop)
    queue.disconnect(first.cardId, first.gen)
    queue.submit(boundCard('b', { session: 'S', fingerprint: 'fp' }), noop)       // reconnect onto 'a'
    expect(store.get('ancient')?.status).toBe('orphaned')            // out of window → left alone (symmetric with findSessionGate)
  })
})

describe('Queue.dismiss', () => {
  it('marks an orphaned card dismissed and drops it from every actionable surface', () => {
    const { cardId, gen } = queue.submit(card('c1'), noop)
    queue.disconnect(cardId, gen)                                      // orphaned
    queue.dismiss('c1')
    expect(store.get('c1')?.status).toBe('dismissed')
    expect(store.get('c1')?.dismissedAt).toBeTruthy()
    expect(store.list('pending')).toHaveLength(0)
    expect(store.list('orphaned')).toHaveLength(0)
  })

  it('rejects the live waiter when dismissing a pending card (boardroom-scoped, graceful)', () => {
    const reject = vi.fn()
    queue.submit(card('c1'), { resolve: vi.fn(), reject })
    queue.dismiss('c1')
    expect(store.get('c1')?.status).toBe('dismissed')
    expect(reject).toHaveBeenCalled()
  })

  it('refuses to dismiss a decided card (its decision is history, not clutter)', () => {
    queue.submit(card('c1'), noop)
    queue.decide('c1', { d1: { chosen: ['a'] } })
    expect(() => queue.dismiss('c1')).toThrow(ConflictError)
    expect(store.get('c1')?.status).toBe('decided')
  })

  it('refuses to DECIDE a dismissed card — a retired card is never resurrected or pushed to the agent', () => {
    const { cardId, gen } = queue.submit(card('c1'), noop)
    queue.disconnect(cardId, gen)                                   // orphaned
    queue.dismiss('c1')                                             // retired
    expect(() => queue.decide('c1', { d1: { chosen: ['a'] } })).toThrow(ConflictError)
    expect(store.get('c1')?.status).toBe('dismissed')              // stayed dismissed, not flipped to decided
  })

  it('throws NotFoundError for an unknown card', () => {
    expect(() => queue.dismiss('nope')).toThrow(NotFoundError)
  })

  it('emits a card event so the dashboard removes it live', () => {
    const events: Card[] = []
    const { cardId, gen } = queue.submit(card('c1'), noop)
    queue.disconnect(cardId, gen)
    queue.on('card', (c: Card) => events.push(c))
    queue.dismiss('c1')
    expect(events.at(-1)?.status).toBe('dismissed')
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
