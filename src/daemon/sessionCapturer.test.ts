// src/daemon/sessionCapturer.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store.js'
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
})
