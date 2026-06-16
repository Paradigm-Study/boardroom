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
  })

  it('is a no-op when a newer connection has taken over (stale gen)', () => {
    const { cardId, gen } = queue.submit(card('c1'), noop)
    queue.disconnect(cardId, gen)             // orphan
    const second = queue.submit(card('c1'), noop) // reattach revives to pending, new gen
    queue.disconnect(cardId, gen)             // stale close from the first connection
    expect(store.get('c1')?.status).toBe('pending')
    expect(second.gen).toBeGreaterThan(gen)
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
