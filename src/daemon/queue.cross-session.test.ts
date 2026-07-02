import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card, Stage } from '../shared/card.js'
import { fingerprint } from './compile.js'
import { Queue } from './queue.js'
import { Store } from './store.js'

// CHARACTERIZATION TESTS — they document the ACTUAL behavior of cross-session
// gate resolution, including the buggy parts. Each assertion is tagged:
//   [BUG]     = current behavior is wrong (a gate crosses sessions)
//   [CORRECT] = current behavior is the safe/intended one (a guardrail that holds)
// Nothing here is a proposed fix; it pins down "what happens today" so a fix can be
// designed against a known baseline. See memory: reconnect-most-recent-rootcause.
//
// The premise under test: the Queue/Store have NO notion of which Claude Code
// session a call came from. A card's only "session" linkage is its fingerprint
// (project + stage + headline) and its session: { agent, project, title } — none of
// which is a unique session id. So "session A's gate" and "session B's identical
// call" are INDISTINGUISHABLE to the daemon.

// A gate as a specific session would author it. `marker` is unique per session and
// lives in the decision prompt, so after a reattach we can prove WHOSE content the
// surviving card carries. project+stage+headline drive the fingerprint; agent/title
// are deliberately excluded from it (see compile.ts fingerprint()).
function gate(opts: {
  id: string
  project?: string
  stage?: Stage
  headline?: string
  agent?: string
  title?: string
  marker?: string
  createdAt?: string
}): Card {
  const project = opts.project ?? 'demo'
  const stage = opts.stage ?? 'clarify'
  const headline = opts.headline ?? 'How should we do X?'
  return {
    id: opts.id,
    stage,
    session: { agent: opts.agent ?? 'claude-code', project, ...(opts.title ? { title: opts.title } : {}) },
    headline,
    blocks: [],
    decisions: [{
      id: 'd1',
      prompt: opts.marker ?? `${opts.id} question`,
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    }],
    status: 'pending',
    createdAt: opts.createdAt ?? new Date().toISOString(),
    fingerprint: fingerprint(project, stage, headline),
  }
}

const noop = { resolve: () => {}, reject: () => {} }

let dir: string
let store: Store
let queue: Queue

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-xsession-'))
  store = new Store(join(dir, 'test.sqlite'))
  queue = new Queue(store)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('cross-session reattach — two distinct Claude Code sessions, same project+stage+headline', () => {
  it('[BUG] session B steals session A ORPHANED gate and receives A\'s content', () => {
    // Session A opens a gate, then drops (machine slept / daemon restart).
    const a = queue.submit(gate({ id: 'A', marker: 'A-AUTHORED-QUESTION' }), noop)
    queue.disconnect(a.cardId, a.gen)
    expect(store.get('A')?.status).toBe('orphaned')

    // Session B — a DIFFERENT Claude Code session — issues its own call that happens
    // to share project+stage+headline (e.g. the same repo, same clarify headline).
    const bResolve = vi.fn()
    const b = queue.submit(gate({ id: 'B', marker: 'B-AUTHORED-QUESTION' }), { resolve: bResolve, reject: vi.fn() })

    // B does NOT get its own card — it is bound to A's card.
    expect(b.cardId).toBe('A')                                 // [BUG] B reattached to A's gate
    expect(store.get('B')).toBeUndefined()                     // [BUG] B's own gate was never inserted
    // The surviving live card carries A's authored content, not B's.
    expect(store.get('A')?.decisions[0].prompt).toBe('A-AUTHORED-QUESTION') // [BUG] content is A's
    expect(store.get('A')?.status).toBe('pending')             // revived under B's waiter
  })

  it('[BUG] session B claims a decision the human made on session A\'s gate', () => {
    // A opens, drops; the human decides A's gate while A is away (undelivered).
    const a = queue.submit(gate({ id: 'A', marker: 'A-QUESTION' }), noop)
    queue.disconnect(a.cardId, a.gen)
    queue.decide('A', { d1: { chosen: ['a'] } })
    expect(store.get('A')?.deliveredAt).toBeUndefined()

    // B issues the identical-fingerprint call and is handed A's decision immediately.
    const bResolve = vi.fn()
    const b = queue.submit(gate({ id: 'B', marker: 'B-QUESTION' }), { resolve: bResolve, reject: vi.fn() })
    expect(b.gen).toBe(-1)                                      // [BUG] resolved instantly with A's answer
    expect(bResolve).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'A' }))
    expect(store.get('B')).toBeUndefined()
    expect(store.get('A')?.deliveredAt).toBeTruthy()           // delivered to B, marked delivered
  })

  it('[BUG] a daemon-restart (boot) orphan is cross-claimed too — the user\'s actual trigger', () => {
    // The reported scenario: the daemon redeploys, orphanAllPending tags every live
    // gate orphanedReason 'boot'. findReattachable does not filter on reason, so a
    // foreign same-fingerprint call reattaches to a boot-orphaned gate just the same.
    queue.submit(gate({ id: 'A', marker: 'A-CONTENT' }), noop)
    store.orphanAllPending()                                   // simulate the redeploy
    expect(store.get('A')?.orphanedReason).toBe('boot')

    const b = queue.submit(gate({ id: 'B', marker: 'B-CONTENT' }), noop)
    expect(b.cardId).toBe('A')                                 // [BUG] boot-orphan reattached cross-session
    expect(store.get('A')?.decisions[0].prompt).toBe('A-CONTENT')
  })

  it('[BUG] the fingerprint ignores agent, so even a DIFFERENT agent (codex) steals a claude-code gate', () => {
    // compile.ts fingerprint() deliberately excludes session.agent. Consequence: the
    // collision is not even scoped to the same agent/CLI.
    const a = queue.submit(gate({ id: 'A', agent: 'claude-code', marker: 'A' }), noop)
    queue.disconnect(a.cardId, a.gen)
    const b = queue.submit(gate({ id: 'B', agent: 'codex', marker: 'B' }), noop)
    expect(b.cardId).toBe('A')                                 // [BUG] cross-agent reattach
  })

  it('[BUG] the fingerprint also ignores title, so a different session label still collides', () => {
    // compile.ts fingerprint() drops session.title too (only project+stage+headline).
    // So even when the human-visible session labels differ, the gates collide.
    const a = queue.submit(gate({ id: 'A', title: 'Session A', marker: 'A' }), noop)
    queue.disconnect(a.cardId, a.gen)
    const b = queue.submit(gate({ id: 'B', title: 'Session B', marker: 'B' }), noop)
    expect(b.cardId).toBe('A')                                 // [BUG] title difference doesn't prevent the steal
  })

  it('[BUG] a PARK-orphaned gate is cross-claimed identically to a disconnect/boot one', () => {
    // findReattachable ignores orphanedReason, so all three orphan sources (disconnect,
    // park, boot) are equally stealable. Park is the opt-in-timeout path.
    const a = queue.submit(gate({ id: 'A', marker: 'A' }), noop)
    expect(queue.park(a.cardId, a.gen)).toBe(true)
    expect(store.get('A')?.orphanedReason).toBe('park')
    const b = queue.submit(gate({ id: 'B', marker: 'B' }), noop)
    expect(b.cardId).toBe('A')                                 // [BUG] parked gate reattached cross-session
  })

  it('[BUG] results-stage gates collide too — the bug is not specific to clarify', () => {
    const a = queue.submit(gate({ id: 'A', stage: 'results', headline: 'What I delivered', marker: 'A' }), noop)
    queue.disconnect(a.cardId, a.gen)
    const b = queue.submit(gate({ id: 'B', stage: 'results', headline: 'What I delivered', marker: 'B' }), noop)
    expect(b.cardId).toBe('A')                                 // [BUG] same project+results+headline collides
  })

  it('[BEHAVIOR] same-fingerprint submits are STICKY: repeated calls collapse onto ONE card, never duplicate', () => {
    // This corrects a tempting assumption: you can NOT accumulate two orphaned gates
    // with the same fingerprint via submit. The 2nd submit reattaches to the 1st, so
    // there is at most one live gate per fingerprint — and every same-fingerprint
    // caller (re-issue OR a different session) lands on that single card.
    const fp = fingerprint('demo', 'clarify', 'How should we do X?')

    const a1 = queue.submit(gate({ id: 'A1', marker: 'FIRST' }), noop)
    queue.disconnect(a1.cardId, a1.gen)
    const a2 = queue.submit(gate({ id: 'A2', marker: 'SECOND' }), noop)
    expect(a2.cardId).toBe('A1')                               // reattached, not a 2nd card
    expect(store.get('A2')).toBeUndefined()
    queue.disconnect(a2.cardId, a2.gen)

    const b = queue.submit(gate({ id: 'B', marker: 'THIRD' }), noop)
    expect(b.cardId).toBe('A1')                                // session B also lands on the one card
    expect(store.list().filter(c => c.fingerprint === fp)).toHaveLength(1) // exactly one ever exists
    expect(store.get('A1')?.decisions[0].prompt).toBe('FIRST') // and it keeps the FIRST author's content
  })
})

describe('cross-session reattach — the guardrails that DO hold (bounding the bug)', () => {
  it('[CORRECT] B does NOT steal A\'s gate while A is still PENDING (live waiter)', () => {
    queue.submit(gate({ id: 'A', marker: 'A' }), noop)         // still pending, live
    const b = queue.submit(gate({ id: 'B', marker: 'B' }), noop)
    expect(b.cardId).toBe('B')                                 // fresh card — no steal of a live gate
    expect(store.get('A')?.status).toBe('pending')
    expect(store.get('B')?.status).toBe('pending')
  })

  it('[CORRECT] a DIFFERENT headline (different fingerprint) never collides', () => {
    const a = queue.submit(gate({ id: 'A', headline: 'Question one' }), noop)
    queue.disconnect(a.cardId, a.gen)
    const b = queue.submit(gate({ id: 'B', headline: 'Question two' }), noop)
    expect(b.cardId).toBe('B')                                 // distinct fingerprint → its own card
    expect(store.get('A')?.status).toBe('orphaned')
  })

  it('[CORRECT] a DIFFERENT project basename never collides, even with the same headline', () => {
    const a = queue.submit(gate({ id: 'A', project: 'repo-one', headline: 'Same headline' }), noop)
    queue.disconnect(a.cardId, a.gen)
    const b = queue.submit(gate({ id: 'B', project: 'repo-two', headline: 'Same headline' }), noop)
    expect(b.cardId).toBe('B')
  })

  it('[CORRECT] once A\'s decision was DELIVERED to A, B cannot claim it — the bug is bounded', () => {
    // A decided-AND-delivered gate is not eligible (findReattachable requires
    // !deliveredAt). So if A was online to receive its own answer, a later foreign
    // call gets a fresh card instead of A's resolved one.
    const aResolve = vi.fn()
    const a = queue.submit(gate({ id: 'A', marker: 'A' }), { resolve: aResolve, reject: vi.fn() })
    queue.decide(a.cardId, { d1: { chosen: ['a'] } })          // live → delivered
    expect(store.get('A')?.deliveredAt).toBeTruthy()

    const b = queue.submit(gate({ id: 'B', marker: 'B' }), noop)
    expect(b.cardId).toBe('B')                                 // fresh card — A's delivered answer is off-limits
  })

  it('[CORRECT] an orphaned gate older than the reattach window is NOT stolen', () => {
    // Window keys off orphanedAt; an ancient orphan falls out of it.
    const shortWindowQueue = new Queue(store, 60_000) // 1-minute window
    const a = shortWindowQueue.submit(gate({ id: 'A', marker: 'A' }), noop)
    shortWindowQueue.disconnect(a.cardId, a.gen)
    // Back-date the orphan clock to 2 minutes ago.
    store.update({ ...store.get('A')!, orphanedAt: new Date(Date.now() - 120_000).toISOString() })
    const b = shortWindowQueue.submit(gate({ id: 'B', marker: 'B' }), noop)
    expect(b.cardId).toBe('B')                                 // too old → fresh card, no steal
  })
})

describe('store.findReattachable — the raw matcher, isolated', () => {
  // NOTE: two eligible same-fingerprint cards are not reachable through queue.submit
  // (stickiness collapses them — see the [BEHAVIOR] test above); this inserts them
  // directly to pin down the matcher's contract in isolation.
  it('matches purely on fingerprint with a createdAt-desc tiebreak; carries no session identity', () => {
    const fp = fingerprint('demo', 'clarify', 'How should we do X?')
    store.insert({ ...gate({ id: 'old', marker: 'old', createdAt: '2026-06-30T10:00:00.000Z' }), status: 'orphaned', orphanedAt: '2026-06-30T10:00:00.000Z' })
    store.insert({ ...gate({ id: 'new', marker: 'new', createdAt: '2026-06-30T11:00:00.000Z' }), status: 'orphaned', orphanedAt: '2026-06-30T11:00:00.000Z' })
    const hit = store.findReattachable(fp, Date.parse('2026-06-30T11:30:00.000Z'))
    expect(hit?.id).toBe('new')                                // most recent of the fingerprint matches

    // There is no parameter for "which session is asking" — fingerprint is the only key.
    expect(store.findReattachable(undefined, Date.now())).toBeUndefined()
  })
})
