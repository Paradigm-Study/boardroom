import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDefaultSpawn } from './waker.js'

// Isolated file: mocking node:child_process at module level would poison the
// real-process makeDefaultSpawn tests in waker.test.ts.
vi.mock('node:child_process', () => ({
  spawn: () => { throw new TypeError('bad option combination') },
}))

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boardroom-waker-throw-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// queue.decide emits 'card' synchronously inside the HTTP handler; a spawn() that
// throws synchronously would otherwise propagate into the decide POST and 500 it
// AFTER the decision was already persisted and resolved.
describe('makeDefaultSpawn under a synchronously-throwing spawn', () => {
  it('settles onFailure instead of letting the throw escape into the caller', () => {
    const failures: string[] = []
    expect(() => {
      makeDefaultSpawn(join(dir, 'wakelogs'))('claude-test', [], dir, {
        label: 'card-boom',
        onSuccess: () => failures.push('unexpected success'),
        onFailure: detail => failures.push(detail),
      })
    }).not.toThrow()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('could not spawn')
    expect(failures[0]).toContain('bad option combination')
  })
})
