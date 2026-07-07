import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card, Stage } from '../shared/card.js'
import { fingerprint } from './compile.js'
import { Queue } from './queue.js'
import { Store } from './store.js'

// CHARACTERIZATION TESTS — they document the behavior of cross-session gate
// resolution now that reattach is SESSION-SCOPED. Each assertion is tagged:
//   [FIXED]   = this used to be a cross-session steal ([BUG]); it is now blocked
//   [CORRECT] = the guardrail was already safe/intended and still holds
// Session B — a DIFFERENT Claude Code session — can share project+stage+headline
// with session A (e.g. the same repo, same clarify headline) and previously that
// fingerprint collision let B claim A's card. Store.findReattachable now also
// scopes on Card.claudeSessionId: a bound caller only reclaims its OWN session's
// cards, and an unbound (legacy) caller only reclaims unbound cards. See memory:
// reconnect-most-recent-rootcause.

// A gate as a specific session would author it. `marker` is unique per session and
// lives in the decision prompt, so after a reattach we can prove WHOSE content the
// surviving card carries. project+stage+headline drive the fingerprint; agent/title
// are deliberately excluded from it (see compile.ts fingerprint()). `claudeSessionId`
// is the new session-binding field (Task 2/6): omit it to simulate a legacy,
// un-hooked agent.
function gate(opts: {
  id: string
  project?: string
  stage?: Stage
  headline?: string
  agent?: string
  title?: string
  marker?: string
  createdAt?: string
  claudeSessionId?: string
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
    ...(opts.claudeSessionId ? { claudeSessionId: opts.claudeSessionId } : {}),
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
  it('[FIXED] session B does NOT steal session A\'s ORPHANED gate or receive A\'s content', () => {
    // Session A opens a gate, then drops (machine slept / daemon restart).
    const a = queue.submit(gate({ id: 'A', marker: 'A-AUTHORED-QUESTION', claudeSessionId: 'cc-A' }), noop)
    queue.disconnect(a.cardId, a.gen)
    expect(store.get('A')?.status).toBe('orphaned')

    // Session B — a DIFFERENT Claude Code session — issues its own call that happens
    // to share project+stage+headline (e.g. the same repo, same clarify headline).
    const bResolve = vi.fn()
    const b = queue.submit(gate({ id: 'B', marker: 'B-AUTHORED-QUESTION', claudeSessionId: 'cc-B' }), { resolve: bResolve, reject: vi.fn() })

    // B gets its own fresh card — it is NOT bound to A's card.
    expect(b.cardId).toBe('B')                                 // [FIXED] no steal — fresh card
    expect(store.get('B')?.decisions[0].prompt).toBe('B-AUTHORED-QUESTION') // B's own content
    expect(store.get('B')?.status).toBe('pending')
    // A's card is untouched — still orphaned, still carries A's content.
    expect(store.get('A')?.status).toBe('orphaned')
    expect(store.get('A')?.decisions[0].prompt).toBe('A-AUTHORED-QUESTION')
  })

  it('[FIXED] session B does NOT claim a decision the human made on session A\'s gate', () => {
    // A opens, drops; the human decides A's gate while A is away (undelivered).
    const a = queue.submit(gate({ id: 'A', marker: 'A-QUESTION', claudeSessionId: 'cc-A' }), noop)
    queue.disconnect(a.cardId, a.gen)
    queue.decide('A', { d1: { chosen: ['a'] } })
    expect(store.get('A')?.deliveredAt).toBeUndefined()

    // B issues the identical-fingerprint call but is a different session — it gets
    // its own fresh card instead of A's undelivered decision.
    const bResolve = vi.fn()
    const b = queue.submit(gate({ id: 'B', marker: 'B-QUESTION', claudeSessionId: 'cc-B' }), { resolve: bResolve, reject: vi.fn() })
    expect(b.gen).not.toBe(-1)                                  // [FIXED] not resolved instantly with A's answer
    expect(bResolve).not.toHaveBeenCalled()
    expect(b.cardId).toBe('B')
    expect(store.get('B')?.status).toBe('pending')
    expect(store.get('A')?.deliveredAt).toBeUndefined()        // A's decision remains undelivered, untouched
  })

  it('[FIXED] a daemon-restart (boot) orphan is NOT cross-claimed — the user\'s original trigger, now fixed', () => {
    // The reported scenario: the daemon redeploys, orphanAllPending tags every live
    // gate orphanedReason 'boot'. findReattachable is now session-scoped, so a
    // foreign same-fingerprint call from a different session does not reattach.
    queue.submit(gate({ id: 'A', marker: 'A-CONTENT', claudeSessionId: 'cc-A' }), noop)
    store.orphanAllPending()                                   // simulate the redeploy
    expect(store.get('A')?.orphanedReason).toBe('boot')

    const b = queue.submit(gate({ id: 'B', marker: 'B-CONTENT', claudeSessionId: 'cc-B' }), noop)
    expect(b.cardId).toBe('B')                                 // [FIXED] no cross-session reattach
    expect(store.get('A')?.decisions[0].prompt).toBe('A-CONTENT')
    expect(store.get('B')?.decisions[0].prompt).toBe('B-CONTENT')
  })

  it('[FIXED] a different agent (codex) does not steal a claude-code gate when sessions are bound', () => {
    // compile.ts fingerprint() deliberately excludes session.agent, so the old
    // collision was not even scoped to the same agent/CLI. Session binding closes
    // that gap as long as both callers are bound to distinct sessions.
    const a = queue.submit(gate({ id: 'A', agent: 'claude-code', marker: 'A', claudeSessionId: 'cc-A' }), noop)
    queue.disconnect(a.cardId, a.gen)
    const b = queue.submit(gate({ id: 'B', agent: 'codex', marker: 'B', claudeSessionId: 'cc-B' }), noop)
    expect(b.cardId).toBe('B')                                 // [FIXED] no cross-agent reattach
  })

  it('[FIXED] a different session title does not collide when sessions are bound', () => {
    // compile.ts fingerprint() drops session.title too (only project+stage+headline).
    // Session binding (not title) is what now prevents the collision.
    const a = queue.submit(gate({ id: 'A', title: 'Session A', marker: 'A', claudeSessionId: 'cc-A' }), noop)
    queue.disconnect(a.cardId, a.gen)
    const b = queue.submit(gate({ id: 'B', title: 'Session B', marker: 'B', claudeSessionId: 'cc-B' }), noop)
    expect(b.cardId).toBe('B')                                 // [FIXED] no steal
  })

  it('[FIXED] a PARK-orphaned gate is not cross-claimed either — same fix covers all orphan sources', () => {
    // findReattachable ignores orphanedReason but now enforces session scope, so
    // all three orphan sources (disconnect, park, boot) are equally protected.
    const a = queue.submit(gate({ id: 'A', marker: 'A', claudeSessionId: 'cc-A' }), noop)
    expect(queue.park(a.cardId, a.gen)).toBe(true)
    expect(store.get('A')?.orphanedReason).toBe('park')
    const b = queue.submit(gate({ id: 'B', marker: 'B', claudeSessionId: 'cc-B' }), noop)
    expect(b.cardId).toBe('B')                                 // [FIXED] no cross-session reattach
  })

  it('[FIXED] results-stage gates do not collide across sessions either — the fix is not stage-specific', () => {
    const a = queue.submit(gate({ id: 'A', stage: 'results', headline: 'What I delivered', marker: 'A', claudeSessionId: 'cc-A' }), noop)
    queue.disconnect(a.cardId, a.gen)
    const b = queue.submit(gate({ id: 'B', stage: 'results', headline: 'What I delivered', marker: 'B', claudeSessionId: 'cc-B' }), noop)
    expect(b.cardId).toBe('B')                                 // [FIXED] same project+results+headline, different session
  })

  it('[FIXED] the SAME session reattaches across a reconnect (park then decide)', () => {
    const a = queue.submit(gate({ id: 'A', marker: 'A-CONTENT', claudeSessionId: 'cc-A' }), noop)
    expect(queue.park(a.cardId, a.gen)).toBe(true)
    queue.decide('A', { d1: { chosen: ['a'] } })
    expect(store.get('A')?.deliveredAt).toBeUndefined()

    // Same session (cc-A) retries the identical call — it IS the rightful owner.
    const retryResolve = vi.fn()
    const retry = queue.submit(gate({ id: 'A2', marker: 'A-RETRY', claudeSessionId: 'cc-A' }), { resolve: retryResolve, reject: vi.fn() })
    expect(retry.gen).toBe(-1)                                  // resolved instantly — legitimate reattach
    expect(retryResolve).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'A' }))
    expect(store.get('A2')).toBeUndefined()
    expect(store.get('A')?.deliveredAt).toBeTruthy()
  })

  it('[BEHAVIOR] same-fingerprint, same-session submits are STICKY: repeated calls collapse onto ONE card', () => {
    // This corrects a tempting assumption: you can NOT accumulate two orphaned gates
    // with the same fingerprint+session via submit. The 2nd submit reattaches to the
    // 1st, so there is at most one live gate per (fingerprint, session) pair.
    const fp = fingerprint('demo', 'clarify', 'How should we do X?')

    const a1 = queue.submit(gate({ id: 'A1', marker: 'FIRST', claudeSessionId: 'cc-A' }), noop)
    queue.disconnect(a1.cardId, a1.gen)
    const a2 = queue.submit(gate({ id: 'A2', marker: 'SECOND', claudeSessionId: 'cc-A' }), noop)
    expect(a2.cardId).toBe('A1')                               // reattached, not a 2nd card
    expect(store.get('A2')).toBeUndefined()
    queue.disconnect(a2.cardId, a2.gen)

    // A DIFFERENT session (B) issuing the identical fingerprint now gets its own card.
    const b = queue.submit(gate({ id: 'B', marker: 'THIRD', claudeSessionId: 'cc-B' }), noop)
    expect(b.cardId).toBe('B')                                 // [FIXED] session B does not land on A's card
    expect(store.list().filter(c => c.fingerprint === fp)).toHaveLength(2) // A's card + B's card
    expect(store.get('A1')?.decisions[0].prompt).toBe('FIRST') // A's card still carries A's authored content
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

  it('legacy: unbound caller still reattaches to unbound card (pre-spine agents)', () => {
    // Neither session ever populated claudeSessionId (an un-hooked agent). This is
    // exact legacy fingerprint-only behavior, preserved on purpose: with no session
    // signal at all, the daemon still lets a re-issued call reclaim its own card.
    const a = queue.submit(gate({ id: 'A', marker: 'A' }), noop)
    queue.disconnect(a.cardId, a.gen)
    const retry = queue.submit(gate({ id: 'A2', marker: 'A-RETRY' }), noop)
    expect(retry.cardId).toBe('A')                             // reattached — legacy path intact
    expect(store.get('A2')).toBeUndefined()
  })

  it('[FIXED] unbound caller does NOT claim a bound card, and vice versa', () => {
    // Direction 1: A is bound (cc-A), B is unbound (legacy) — B must not claim A's card.
    const a = queue.submit(gate({ id: 'A', marker: 'A', claudeSessionId: 'cc-A' }), noop)
    queue.disconnect(a.cardId, a.gen)
    const bUnbound = queue.submit(gate({ id: 'B', marker: 'B' }), noop)
    expect(bUnbound.cardId).toBe('B')                          // fresh card — unbound caller can't claim a bound card
    expect(store.get('A')?.status).toBe('orphaned')

    // Direction 2: C is unbound, D is bound — D must not claim C's card either.
    const c = queue.submit(gate({ id: 'C', marker: 'C' }), noop)
    queue.disconnect(c.cardId, c.gen)
    const dBound = queue.submit(gate({ id: 'D', marker: 'D', claudeSessionId: 'cc-D' }), noop)
    expect(dBound.cardId).toBe('D')                            // fresh card — bound caller can't claim an unbound card
    expect(store.get('C')?.status).toBe('orphaned')
  })
})

describe('store.findReattachable — the raw matcher, isolated', () => {
  // NOTE: two eligible same-fingerprint-and-session cards are not reachable through
  // queue.submit (stickiness collapses them — see the [BEHAVIOR] test above); this
  // inserts them directly to pin down the matcher's contract in isolation.
  it('matches on fingerprint scoped to the caller\'s session, with a createdAt-desc tiebreak', () => {
    const fp = fingerprint('demo', 'clarify', 'How should we do X?')
    store.insert({ ...gate({ id: 'old', marker: 'old', createdAt: '2026-06-30T10:00:00.000Z', claudeSessionId: 'cc-A' }), status: 'orphaned', orphanedAt: '2026-06-30T10:00:00.000Z' })
    store.insert({ ...gate({ id: 'new', marker: 'new', createdAt: '2026-06-30T11:00:00.000Z', claudeSessionId: 'cc-A' }), status: 'orphaned', orphanedAt: '2026-06-30T11:00:00.000Z' })
    const caller = { fingerprint: fp, claudeSessionId: 'cc-A' }
    const hit = store.findReattachable(caller, Date.parse('2026-06-30T11:30:00.000Z'))
    expect(hit?.id).toBe('new')                                // most recent of the same-session fingerprint matches

    // A caller from a DIFFERENT session with the identical fingerprint gets nothing.
    expect(store.findReattachable({ fingerprint: fp, claudeSessionId: 'cc-B' }, Date.now())).toBeUndefined()

    // No fingerprint at all → no candidates regardless of session.
    expect(store.findReattachable({ fingerprint: undefined, claudeSessionId: 'cc-A' }, Date.now())).toBeUndefined()
  })
})
