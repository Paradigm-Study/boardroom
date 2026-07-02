import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../../shared/card.js'
import { Queue } from '../../daemon/queue.js'
import { Store } from '../../daemon/store.js'
import { Waker } from './waker.js'

// CHARACTERIZATION TESTS for the daemon waker's resume-target resolution across
// Claude Code sessions. Tags as in queue.cross-session.test.ts:
//   [BUG]     = the waker resumes the WRONG session
//   [CORRECT] = a guardrail holds (fail-closed / one-shot / plan-exempt)
//
// Premise: the waker resolves a decided gate -> a session to `claude --resume` via
// store.getSessionByProject(card.session.project) — keyed on the project BASENAME.
// A card carries no Claude session id, and recordSession's ON CONFLICT(cwd) DO
// UPDATE overwrites session_id IN PLACE. So re-launching Claude Code in the same
// directory silently rebinds the project's resume target. See memory:
// reconnect-most-recent-rootcause.

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
  it('[BUG] same cwd, new session id: a later Claude Code run silently rebinds the resume target', () => {
    // Session A runs in `dir`, opens the gate that later gets decided.
    store.recordSession('demo', 'sid-A', dir)
    // Session B is launched in the SAME directory (re-run claude, or a restart). Its
    // SessionStart hook overwrites the cwd row in place: session_id A -> B.
    store.recordSession('demo', 'sid-B', dir)

    // The gate that session A opened is now decided (offline). The waker resolves the
    // resume target by project basename and finds only the overwritten row.
    waker.onCard(decided())
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('sid-B')                  // [BUG] resumes the newer session
    expect(calls[0].args).not.toContain('sid-A')             // ...not the session that opened the gate
    expect(calls[0].cwd).toBe(dir)
  })

  it('[CORRECT] single session in a cwd resumes the right session', () => {
    store.recordSession('demo', 'sid-A', dir)
    waker.onCard(decided())
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('sid-A')
  })

  it('[CORRECT] two DIFFERENT cwds sharing a basename are ambiguous → fail-closed, no resume', () => {
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
    store.recordSession('demo', 'sid-A', dir)
    store.recordSession('demo', 'sid-B', dir)                  // even with the overwrite present
    waker.onCard(decided({ stage: 'plan' }))
    expect(calls).toHaveLength(0)
  })

  it('[BEHAVIOR] a results-stage gate IS auto-resumed — plan is the ONLY exempt stage', () => {
    // waker.onCard exempts only stage 'plan'; clarify/spec/results all auto-resume, so
    // they all inherit the wrong-session resume when the cwd row was overwritten.
    store.recordSession('demo', 'sid-A', dir)
    store.recordSession('demo', 'sid-B', dir)                  // overwrite in place
    waker.onCard(decided({ id: 'r1', stage: 'results' }))
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('sid-B')                  // resumed (the wrong session), unlike plan
  })

  it('[BUG] end-to-end: A parks a gate, B re-runs in the same cwd, the human decides → B is woken with A\'s decision', () => {
    // The full path the user hits: queue events drive the waker. Session A opens and
    // parks a gate; session B is launched in the same directory (overwriting the cwd
    // row); the human then decides A's parked gate on the dashboard.
    const queue = new Queue(store)
    queue.on('card', c => waker.onCard(c))
    store.recordSession('demo', 'sid-A', dir)

    const c: Card = {
      id: 'e1', stage: 'clarify', session: { agent: 'claude-code', project: 'demo' },
      headline: 'A\'s question', blocks: [],
      decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
      status: 'pending', createdAt: new Date().toISOString(),
    }
    const { cardId, gen } = queue.submit(c, { resolve: () => {}, reject: () => {} })
    expect(queue.park(cardId, gen)).toBe(true)                 // A drops; gate orphaned

    store.recordSession('demo', 'sid-B', dir)                  // B re-runs in the same cwd → overwrite

    queue.decide(cardId, { d1: { chosen: ['a'] } })           // human decides A's gate
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('sid-B')                  // [BUG] A's decision is injected into B
    expect(calls[0].args).not.toContain('sid-A')
    expect(calls[0].args.join(' ')).toContain('A\'s question') // ...carrying A's gate content
  })
})

// The disambiguation that WOULD fix the [BUG] above exists at the store layer but is
// never fed by the waker or any producer. These tests prove the mechanism works in
// isolation — and that nothing wires it in — so a fix knows exactly what is missing.
describe('store session resolution — the dead claude_session_id path', () => {
  it('getSessionByCwd distinguishes sessions by absolute cwd (the precise key, unused by the waker)', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'boardroom-waker-xsession-3-'))
    try {
      store.recordSession('demo', 'sid-A', dir)
      store.recordSession('demo', 'sid-B', dir2)
      expect(store.getSessionByCwd(dir)?.sessionId).toBe('sid-A')   // exact, no most-recent collapse
      expect(store.getSessionByCwd(dir2)?.sessionId).toBe('sid-B')
      // ...but the waker calls getSessionByProject(basename), not getSessionByCwd —
      // and the card carries no cwd to pass here anyway.
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('getSessionById resolves an exact Claude session id WHEN populated — but no producer ever populates it', () => {
    // recordSession accepts a 4th claudeSessionId arg; the /api/session route and the
    // SessionStart hook never pass it, so in production it is always NULL.
    store.recordSession('demo', 'sid-A', dir, 'claude-uuid-A')
    expect(store.getSessionById('claude-uuid-A')?.sessionId).toBe('sid-A') // works in isolation

    // Reproduce production: register WITHOUT a claude id (as /api/session does).
    const dir2 = mkdtempSync(join(tmpdir(), 'boardroom-waker-xsession-4-'))
    try {
      store.recordSession('other', 'sid-X', dir2)             // no claudeSessionId
      expect(store.getSessionById('anything')).toBeUndefined() // nothing to match → dead path
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })
})
