import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store.js'

let dir: string
let store: Store
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-store-'))
  store = new Store(join(dir, 'test.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('sessions_v3 — session-id-keyed registry', () => {
  it('two sessions in the SAME cwd both stay resolvable (the v2 overwrite bug, fixed)', () => {
    store.recordSession('demo', 'cc-A', '/tmp/demo')
    store.recordSession('demo', 'cc-B', '/tmp/demo')  // same cwd — v2 overwrites, v3 must not
    expect(store.getRegisteredSession('cc-A')).toEqual({ sessionId: 'cc-A', cwd: '/tmp/demo', project: 'demo' })
    expect(store.getRegisteredSession('cc-B')).toEqual({ sessionId: 'cc-B', cwd: '/tmp/demo', project: 'demo' })
  })
  it('re-registering the same session updates its row (resume re-fires the hook)', () => {
    store.recordSession('demo', 'cc-A', '/tmp/demo')
    store.recordSession('demo', 'cc-A', '/tmp/demo2')
    expect(store.getRegisteredSession('cc-A')?.cwd).toBe('/tmp/demo2')
  })
  it('unknown id → undefined', () => {
    expect(store.getRegisteredSession('nope')).toBeUndefined()
  })
})
