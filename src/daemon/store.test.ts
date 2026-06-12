import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { loadConfig } from './config.js'
import { Store } from './store.js'

function card(id: string): Card {
  return {
    id, stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'pending', createdAt: new Date().toISOString(),
  }
}

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-'))
  store = new Store(join(dir, 'test.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Store', () => {
  it('round-trips a card', () => {
    store.insert(card('c1'))
    expect(store.get('c1')?.headline).toBe('h')
    expect(store.get('missing')).toBeUndefined()
  })

  it('lists by status, newest first', () => {
    const a = { ...card('c1'), createdAt: '2026-06-11T00:00:00.000Z' }
    const b = { ...card('c2'), createdAt: '2026-06-11T01:00:00.000Z' }
    store.insert(a)
    store.insert(b)
    store.update({ ...a, status: 'decided' })
    expect(store.list('pending').map(c => c.id)).toEqual(['c2'])
    expect(store.list().map(c => c.id)).toEqual(['c2', 'c1'])
  })

  it('orphans all pending cards on demand (boot recovery)', () => {
    store.insert(card('c1'))
    store.insert({ ...card('c2'), status: 'decided' })
    expect(store.orphanAllPending()).toBe(1)
    expect(store.get('c1')?.status).toBe('orphaned')
    expect(store.get('c2')?.status).toBe('decided')
  })
})

describe('loadConfig', () => {
  it('uses defaults when no config file exists', () => {
    const cfg = loadConfig(join(dir, 'cfgdir'))
    expect(cfg.port).toBe(4040)
    expect(cfg.remindEveryMinutes).toBe(10)
    expect(cfg.notifications).toBe(true)
    expect(cfg.dbPath).toBe(join(dir, 'cfgdir', 'boardroom.sqlite'))
  })
})
