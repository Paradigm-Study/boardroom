import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { Queue } from './queue.js'
import { Store } from './store.js'
import { Waker } from './waker.js'

function decided(over: Partial<Card> = {}): Card {
  return {
    id: 'c1', stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'pick a thing', blocks: [],
    decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'decided', createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    answers: { d1: { chosen: ['a'] } },
    ...over,
  }
}

let dir: string
let store: Store
let calls: { bin: string; args: string[]; cwd: string }[]
let waker: Waker

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-waker-'))
  store = new Store(join(dir, 'test.sqlite'))
  // The waker refuses to spawn into a cwd that isn't an existing absolute dir, so
  // the registered session points at the real temp dir.
  store.recordSession('demo', 'sid-1', dir)
  calls = []
  waker = new Waker(store, {
    spawn: (bin, args, cwd) => calls.push({ bin, args, cwd }),
    claudeBin: 'claude-test',
    permissionMode: 'acceptEdits',
  })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Waker', () => {
  it('wakes the session: claude --resume <id> from the absolute cwd, with the chosen permission mode and the decision in the message', () => {
    waker.onCard(decided())
    expect(calls).toHaveLength(1)
    expect(calls[0].bin).toBe('claude-test')
    expect(calls[0].args).toEqual(expect.arrayContaining(['-p', '--resume', 'sid-1', '--permission-mode', 'acceptEdits']))
    expect(calls[0].cwd).toBe(dir)
    // The decision summary + the card headline travel in the resume prompt (a
    // bare /A/ would match the one-char option label and prove almost nothing).
    const message = calls[0].args.join(' ')
    expect(message).toContain('p: A')
    expect(message).toContain('pick a thing')
  })

  it('does NOT wake a card that was delivered live (the agent already has it)', () => {
    waker.onCard(decided({ deliveredAt: new Date().toISOString() }))
    expect(calls).toHaveLength(0)
  })

  it('does NOT wake when no session is registered for the project', () => {
    waker.onCard(decided({ session: { agent: 'claude-code', project: 'unregistered' } }))
    expect(calls).toHaveLength(0)
  })

  it('does NOT wake when the registered cwd is not absolute', () => {
    store.recordSession('demo', 'sid-1', 'relative/dir')
    waker.onCard(decided())
    expect(calls).toHaveLength(0)
  })

  it('does NOT wake when the registered cwd does not exist', () => {
    store.recordSession('demo', 'sid-1', join(dir, 'gone'))
    waker.onCard(decided())
    expect(calls).toHaveLength(0)
  })

  it('is one-shot: never wakes the same card twice', () => {
    waker.onCard(decided())
    waker.onCard(decided())
    expect(calls).toHaveLength(1)
  })

  it('ignores non-decided transitions (pending / orphaned)', () => {
    waker.onCard(decided({ status: 'pending', decidedAt: undefined, answers: undefined }))
    waker.onCard(decided({ status: 'orphaned', decidedAt: undefined, answers: undefined }))
    expect(calls).toHaveLength(0)
  })

  it('end-to-end via queue events: park then decide wakes the session exactly once', () => {
    const queue = new Queue(store)
    queue.on('card', c => waker.onCard(c))
    const c: Card = {
      id: 'e1', stage: 'clarify', session: { agent: 'claude-code', project: 'demo' },
      headline: 'h', blocks: [],
      decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
      status: 'pending', createdAt: new Date().toISOString(),
    }
    const { cardId, gen } = queue.submit(c, { resolve: () => {}, reject: () => {} }) // emits pending → ignored
    expect(queue.park(cardId, gen)).toBe(true)                                       // emits orphaned → ignored
    expect(calls).toHaveLength(0)
    queue.decide(cardId, { d1: { chosen: ['a'] } })                                  // emits decided-undelivered → wakes
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('sid-1')
    expect(calls[0].cwd).toBe(dir)
  })
})
