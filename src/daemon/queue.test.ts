import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../shared/card.js'
import { ConflictError, NotFoundError, Queue, ValidationError } from './queue.js'
import { Store } from './store.js'

function card(id: string): Card {
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
  }
}

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
  it('resolves the waiter with answers and summary, persists decided', () => {
    const resolve = vi.fn()
    queue.add(card('c1'), { resolve, reject: vi.fn() })
    const { card: updated, response } = queue.decide('c1', { d1: { chosen: ['a'] } })
    expect(updated.status).toBe('decided')
    expect(updated.answers?.d1.chosen).toEqual(['a'])
    expect(resolve).toHaveBeenCalledWith(response)
    expect(response.summary).toContain('p: A')
    expect(store.get('c1')?.status).toBe('decided')
  })

  it('rejects double-decide with ConflictError', () => {
    queue.add(card('c1'))
    queue.decide('c1', { d1: { chosen: ['a'] } })
    expect(() => queue.decide('c1', { d1: { chosen: ['a'] } })).toThrow(ConflictError)
  })

  it('throws NotFoundError for unknown cards', () => {
    expect(() => queue.decide('nope', {})).toThrow(NotFoundError)
  })

  it('validates: missing answer, unknown option, multi violation, missing required note', () => {
    queue.add(card('c1'))
    expect(() => queue.decide('c1', {})).toThrow(ValidationError)
    expect(() => queue.decide('c1', { d1: { chosen: ['zzz'] } })).toThrow(ValidationError)
    expect(() => queue.decide('c1', { d1: { chosen: ['a', 'b'] } })).toThrow(ValidationError)
    expect(() => queue.decide('c1', { d1: { chosen: ['b'] } })).toThrow(/requires a note/)
  })

  it('accepts the "__other__" choice with custom text, rejects it without', () => {
    queue.add(card('c1'))
    expect(() => queue.decide('c1', { d1: { chosen: ['__other__'] } })).toThrow(/custom text/)
    const { response } = queue.decide('c1', { d1: { chosen: ['__other__'], custom: 'split the difference' } })
    expect(response.summary).toContain('Other: split the difference')
  })
})

describe('Queue.orphan', () => {
  it('rejects the waiter and flips status; decide on orphaned conflicts', () => {
    const reject = vi.fn()
    queue.add(card('c1'), { resolve: vi.fn(), reject })
    queue.orphan('c1')
    expect(reject).toHaveBeenCalled()
    expect(store.get('c1')?.status).toBe('orphaned')
    expect(() => queue.decide('c1', { d1: { chosen: ['a'] } })).toThrow(ConflictError)
  })

  it('is a no-op on already-decided cards', () => {
    queue.add(card('c1'))
    queue.decide('c1', { d1: { chosen: ['a'] } })
    queue.orphan('c1')
    expect(store.get('c1')?.status).toBe('decided')
  })
})

describe('Queue.offlineAnswer', () => {
  it('only works on orphaned cards and returns a copyable summary', () => {
    queue.add(card('c1'))
    expect(() => queue.offlineAnswer('c1', { d1: { chosen: ['a'] } })).toThrow(ConflictError)
    queue.orphan('c1')
    const { summary, card: updated } = queue.offlineAnswer('c1', { d1: { chosen: ['a'] } })
    expect(summary).toContain('p: A')
    expect(updated.status).toBe('orphaned')
    expect(updated.answers?.d1.chosen).toEqual(['a'])
  })
})

describe('Queue events', () => {
  it('emits card on add, decide, and orphan', () => {
    const events: string[] = []
    queue.on('card', (c: Card) => events.push(c.status))
    queue.add(card('c1'))
    queue.decide('c1', { d1: { chosen: ['a'] } })
    queue.add(card('c2'))
    queue.orphan('c2')
    expect(events).toEqual(['pending', 'decided', 'pending', 'orphaned'])
  })
})
