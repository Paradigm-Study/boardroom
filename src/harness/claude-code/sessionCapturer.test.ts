// src/harness/claude-code/sessionCapturer.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../../daemon/store.js'
import { SessionCapturer } from './sessionCapturer.js'

function fakeClaudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'br-claude-'))
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  mkdirSync(join(dir, 'projects'), { recursive: true })
  mkdirSync(join(dir, 'tasks'), { recursive: true })
  return dir
}

function writeRegistry(claudeDir: string, pid: number, body: Record<string, unknown>): void {
  writeFileSync(join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify(body))
}

describe('SessionCapturer.reconcile', () => {
  let store: Store, claudeDir: string
  beforeEach(() => { store = new Store(':memory:'); claudeDir = fakeClaudeDir() })

  const cap = (over = {}) => new SessionCapturer(store, 'm-1',
    { claudeDir, isAlive: () => true, now: () => '2026-06-21T00:00:00.000Z', ...over })

  it('captures every live session, keyed by sessionId (no project collision)', () => {
    writeRegistry(claudeDir, 100, { pid: 100, sessionId: 'sA', cwd: '/a/proj', version: '2.1.181' })
    writeRegistry(claudeDir, 101, { pid: 101, sessionId: 'sB', cwd: '/b/proj' })
    cap().reconcile()
    expect(store.listCaptured()).toHaveLength(2)
    expect(store.getCaptured('sA')).toMatchObject({ machineId: 'm-1', project: 'proj', status: 'alive', claudeVersion: '2.1.181' })
  })

  it('marks a dead pid as ended', () => {
    writeRegistry(claudeDir, 200, { pid: 200, sessionId: 'sC', cwd: '/c/proj' })
    cap({ isAlive: () => false }).reconcile()
    expect(store.getCaptured('sC')?.status).toBe('ended')
  })

  it('skips malformed/foreign files without throwing', () => {
    writeFileSync(join(claudeDir, 'sessions', '9.json'), 'not json')
    writeRegistry(claudeDir, 201, { pid: 201, sessionId: 'sD', cwd: '/d/proj' })
    expect(() => cap().reconcile()).not.toThrow()
    expect(store.listCaptured().map(s => s.sessionId)).toEqual(['sD'])
  })

  it('sets transcriptPath only when the file exists (found by sessionId glob)', () => {
    // findTranscript matches <sessionId>.jsonl under ANY slug dir, so the slug name is arbitrary.
    mkdirSync(join(claudeDir, 'projects', 'anyslug'), { recursive: true })
    writeFileSync(join(claudeDir, 'projects', 'anyslug', 'sE.jsonl'), '{}')
    writeRegistry(claudeDir, 202, { pid: 202, sessionId: 'sE', cwd: '/Users/paradigm.study/proj' })
    writeRegistry(claudeDir, 203, { pid: 203, sessionId: 'sF', cwd: '/no/transcript' })
    cap().reconcile()
    expect(store.getCaptured('sE')?.transcriptPath).toContain('sE.jsonl')
    expect(store.getCaptured('sF')?.transcriptPath).toBeUndefined()
  })

  it('is idle (no throw) when the sessions dir is absent', () => {
    expect(() => new SessionCapturer(store, 'm-1', { claudeDir: '/does/not/exist' }).reconcile()).not.toThrow()
  })

  it('skips a session whose cwd has no basename (cwd "/") instead of crashing the tick', () => {
    // basename('/') === '' fails CapturedSession.parse (project.min(1)); a session
    // launched from the filesystem root must be skipped, never throw out of reconcile.
    writeRegistry(claudeDir, 300, { pid: 300, sessionId: 'sRoot', cwd: '/' })
    writeRegistry(claudeDir, 301, { pid: 301, sessionId: 'sOk', cwd: '/x/proj' })
    expect(() => cap().reconcile()).not.toThrow()
    expect(store.listCaptured().map(s => s.sessionId)).toEqual(['sOk'])
  })

  it('skips rows with a non-positive pid or empty sessionId/cwd, without throwing', () => {
    writeRegistry(claudeDir, 1, { pid: 0, sessionId: 'sZeroPid', cwd: '/x/proj' })
    writeRegistry(claudeDir, 2, { pid: -5, sessionId: 'sNegPid', cwd: '/x/proj' })
    writeRegistry(claudeDir, 3, { pid: 400, sessionId: '', cwd: '/x/proj' })
    writeRegistry(claudeDir, 4, { pid: 401, sessionId: 'sEmptyCwd', cwd: '' })
    writeRegistry(claudeDir, 5, { pid: 402, sessionId: 'sGood', cwd: '/x/proj' })
    expect(() => cap().reconcile()).not.toThrow()
    expect(store.listCaptured().map(s => s.sessionId)).toEqual(['sGood'])
  })

  it('advances status alive->ended->alive across ticks while keeping capturedAt sticky', () => {
    const times = ['2026-06-21T00:00:00.000Z', '2026-06-21T00:01:00.000Z', '2026-06-21T00:02:00.000Z']
    let i = 0
    let alive = true
    writeRegistry(claudeDir, 500, { pid: 500, sessionId: 'sLive', cwd: '/x/proj' })
    const c = new SessionCapturer(store, 'm-1', { claudeDir, isAlive: () => alive, now: () => times[i] })
    c.reconcile()                                       // tick 0: alive
    expect(store.getCaptured('sLive')?.status).toBe('alive')
    i = 1; alive = false; c.reconcile()                 // tick 1: process gone
    expect(store.getCaptured('sLive')?.status).toBe('ended')
    i = 2; alive = true; c.reconcile()                  // tick 2: alive again
    const row = store.getCaptured('sLive')!
    expect(row.status).toBe('alive')
    expect(row.capturedAt).toBe(times[0])               // first-capture time is sticky
    expect(row.lastSeenAt).toBe(times[2])               // advances every tick
  })

  it('does not crash on an out-of-range numeric startedAt (toIso must be total)', () => {
    // raw.startedAt comes from the untrusted registry; a number outside Date range
    // would make new Date(n).toISOString() throw RangeError out of the tick.
    writeRegistry(claudeDir, 700, { pid: 700, sessionId: 'sBadTs', cwd: '/x/proj', startedAt: 1e21 })
    expect(() => cap().reconcile()).not.toThrow()
    expect(store.getCaptured('sBadTs')).toBeDefined()
    expect(store.getCaptured('sBadTs')?.startedAt).toBeUndefined() // dropped, session still captured
  })

  it('contains a per-session upsert error and still captures later sessions in the same tick', () => {
    // Exercises the try/catch around upsertCaptured: one throwing session must not
    // abort the loop (fails both ways without the catch — throws out, or drops sAfter).
    const captured: string[] = []
    const stub = {
      getCaptured: () => undefined,
      upsertCaptured: (s: { sessionId: string }) => {
        if (s.sessionId === 'sBoom') throw new Error('SQLITE_FULL')
        captured.push(s.sessionId)
      },
    } as unknown as Store
    writeRegistry(claudeDir, 600, { pid: 600, sessionId: 'sBoom', cwd: '/x/proj' })
    writeRegistry(claudeDir, 601, { pid: 601, sessionId: 'sAfter', cwd: '/y/proj' })
    const c = new SessionCapturer(stub, 'm-1', { claudeDir, isAlive: () => true, now: () => 'T' })
    expect(() => c.reconcile()).not.toThrow()
    expect(captured).toContain('sAfter')
  })

  it('never feeds a non-positive pid to the liveness probe (guard runs before process.kill)', () => {
    const seen: number[] = []
    writeRegistry(claudeDir, 1, { pid: 0, sessionId: 'sZero', cwd: '/x/proj' })
    writeRegistry(claudeDir, 2, { pid: -3, sessionId: 'sNeg', cwd: '/x/proj' })
    writeRegistry(claudeDir, 3, { pid: 700, sessionId: 'sOk', cwd: '/x/proj' })
    cap({ isAlive: (p: number) => { seen.push(p); return true } }).reconcile()
    expect(seen.every(p => p > 0)).toBe(true)
    expect(seen).toContain(700)
  })
})
