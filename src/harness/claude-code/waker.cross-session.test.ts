import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../shared/card.js'
import { Queue } from '../../daemon/queue.js'
import { Store } from '../../daemon/store.js'
import { Waker } from './waker.js'

// FORMERLY characterization tests for the daemon waker's resume-target resolution
// across Claude Code sessions — now asserting the FIXED behavior. Tags:
//   [FIXED]   = previously a [BUG] (wrong-session resume); now resolves exactly
//   [CORRECT] = a guardrail holds (fail-closed / one-shot / plan-exempt) — unchanged
//
// Fix: cards now carry claudeSessionId (the Claude session id that opened the
// gate). The waker resolves resume targets via store.getRegisteredSession(card.
// claudeSessionId) against sessions_v3 — a session-id-keyed table where ON
// CONFLICT(session_id) means one row PER SESSION survives, immune to the same-cwd
// overwrite that sessions_v2 (cwd PK) suffers. Legacy cards without a
// claudeSessionId still fall back to the fail-closed getSessionByProject. See
// memory: reconnect-most-recent-rootcause.

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
  dir = mkdtempSync(join(tmpdir(), 'boardroom-waker-xsession-'))
  store = new Store(join(dir, 'test.sqlite'))
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

describe('waker resume target across sessions', () => {
  it('[FIXED] a decided card resumes ITS OWN session even after another session re-registered the same cwd', () => {
    // Session A runs in `dir`, opens the gate that later gets decided.
    store.recordSession('demo', 'cc-A', dir)
    // Session B is launched in the SAME directory (re-run claude, or a restart). Its
    // SessionStart hook overwrites sessions_v2's cwd row in place, but sessions_v3
    // keeps a separate row per session id — both cc-A and cc-B survive there.
    store.recordSession('demo', 'cc-B', dir)

    // The card carries the exact Claude session id that opened the gate.
    const card = decided({ claudeSessionId: 'cc-A' })
    waker.onCard(card)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('cc-A')                   // [FIXED] resumes the card's own session
    expect(calls[0].args).not.toContain('cc-B')                // ...never the session that merely reused the cwd
    expect(calls[0].cwd).toBe(dir)
  })

  it('[CORRECT] single session in a cwd resumes the right session (legacy card, no claudeSessionId)', () => {
    store.recordSession('demo', 'sid-A', dir)
    waker.onCard(decided())
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('sid-A')
  })

  it('[CORRECT] two DIFFERENT cwds sharing a basename are ambiguous → fail-closed, no resume (legacy card)', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'boardroom-waker-xsession-2-'))
    try {
      store.recordSession('demo', 'sid-A', dir)
      store.recordSession('demo', 'sid-B', dir2)              // distinct cwd → two 'demo' rows
      waker.onCard(decided())
      expect(calls).toHaveLength(0)                            // getSessionByProject returns undefined
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('[CORRECT] a plan gate is never auto-resumed (claimed by re-issuing present_plan)', () => {
    store.recordSession('demo', 'cc-A', dir)
    store.recordSession('demo', 'cc-B', dir)                   // even with the overwrite present
    waker.onCard(decided({ stage: 'plan', claudeSessionId: 'cc-A' }))
    expect(calls).toHaveLength(0)
  })

  it('[BEHAVIOR] a results-stage gate IS auto-resumed — plan is the ONLY exempt stage', () => {
    // waker.onCard exempts only stage 'plan'; clarify/spec/results all auto-resume,
    // and now they all resolve via the card's own claudeSessionId (exact resume).
    store.recordSession('demo', 'cc-A', dir)
    store.recordSession('demo', 'cc-B', dir)                   // overwrite of sessions_v2, sessions_v3 unaffected
    waker.onCard(decided({ id: 'r1', stage: 'results', claudeSessionId: 'cc-A' }))
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('cc-A')                    // resumes the card's own session, not the newer one
  })

  it('[FIXED] end-to-end: A parks a gate, B re-runs in the same cwd, the human decides → A is woken with its own decision', () => {
    // The full path the user hits: queue events drive the waker. Session A opens and
    // parks a gate; session B is launched in the same directory (overwriting the
    // sessions_v2 cwd row); the human then decides A's parked gate on the dashboard.
    const queue = new Queue(store)
    queue.on('card', c => waker.onCard(c))
    store.recordSession('demo', 'cc-A', dir)

    const c: Card = {
      id: 'e1', stage: 'clarify', session: { agent: 'claude-code', project: 'demo' },
      headline: 'A\'s question', blocks: [], claudeSessionId: 'cc-A',
      decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
      status: 'pending', createdAt: new Date().toISOString(),
    }
    const { cardId, gen } = queue.submit(c, { resolve: () => {}, reject: () => {} })
    expect(queue.park(cardId, gen)).toBe(true)                 // A drops; gate orphaned

    store.recordSession('demo', 'cc-B', dir)                   // B re-runs in the same cwd → sessions_v2 overwrite

    queue.decide(cardId, { d1: { chosen: ['a'] } })            // human decides A's gate
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('cc-A')                    // [FIXED] A's own session is resumed
    expect(calls[0].args).not.toContain('cc-B')                 // ...never B, which only shares the cwd
    expect(calls[0].args.join(' ')).toContain('A\'s question')  // ...carrying A's gate content
  })

  it('[CORRECT] legacy card (no claudeSessionId) still fail-closed resolves by project', () => {
    // Pre-spine cards carry no claudeSessionId. They must keep resolving through
    // the old fail-closed project-basename path rather than being silently dropped.
    store.recordSession('demo', 'sid-A', dir)
    store.recordSession('demo', 'sid-B', dir)                  // overwrite in place — the old steal scenario
    waker.onCard(decided())                                    // no claudeSessionId on this card
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('sid-B')                   // legacy fallback: whatever project resolves to now
  })

  it('[CORRECT] a bound-but-unregistered session (offline-start) skips auto-wake and warns, without crashing', () => {
    // The "offline-start" case: a hook injected the claudeSessionId onto the card
    // (binding it), but the daemon never saw a POST /api/session for that id — e.g.
    // the daemon was down/offline at SessionStart and only came up later. No
    // sessions_v3 row exists, so getRegisteredSession returns undefined. This must
    // NOT crash and must NOT auto-wake — the decision stays claimable via reattach.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      waker.onCard(decided({ claudeSessionId: 'cc-never-registered' }))
      expect(calls).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalled()
      const message = warnSpy.mock.calls.map(args => args.join(' ')).join('\n')
      expect(message).toContain('c1')
      expect(message).toContain('cc-never-registered')
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// The disambiguation that fixes the [BUG] above lives at the store layer (sessions_v3,
// keyed by session id) and is now fed by the card's claudeSessionId. These tests prove
// the mechanism directly at the store layer.
describe('store session resolution — the sessions_v3 spine path', () => {
  it('getSessionByCwd distinguishes sessions by absolute cwd (the precise key, unused by the waker)', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'boardroom-waker-xsession-3-'))
    try {
      store.recordSession('demo', 'sid-A', dir)
      store.recordSession('demo', 'sid-B', dir2)
      expect(store.getSessionByCwd(dir)?.sessionId).toBe('sid-A')   // exact, no most-recent collapse
      expect(store.getSessionByCwd(dir2)?.sessionId).toBe('sid-B')
      // ...but the waker's legacy fallback calls getSessionByProject(basename), not
      // getSessionByCwd — cards with a claudeSessionId skip this path entirely.
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('card.claudeSessionId resolves via sessions_v3', () => {
    // recordSession writes sessions_v3 keyed by session_id — ON CONFLICT(session_id)
    // DO UPDATE, so a second recordSession call for a DIFFERENT session id in the
    // SAME cwd adds a new row rather than overwriting the first (unlike sessions_v2).
    store.recordSession('demo', 'cc-A', dir)
    store.recordSession('demo', 'cc-B', dir)
    expect(store.getRegisteredSession('cc-A')).toEqual({ sessionId: 'cc-A', cwd: dir, project: 'demo' })
    expect(store.getRegisteredSession('cc-B')).toEqual({ sessionId: 'cc-B', cwd: dir, project: 'demo' })

    // An id that was never registered resolves to nothing — the waker declines
    // rather than falling through to a guess.
    expect(store.getRegisteredSession('cc-nonexistent')).toBeUndefined()
  })
})
