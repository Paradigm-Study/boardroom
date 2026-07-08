import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Entry } from '../shared/entry.js'
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

describe('entries table', () => {
  it('insert + list round-trip via listEntries in FIFO order', () => {
    const entry1: Entry = {
      id: 'e1',
      type: 'report',
      claudeSessionId: 'cc-A',
      session: { agent: 'claude', project: 'test' },
      headline: 'First report',
      blocks: [{ id: 'b1', type: 'markdown', text: 'content' }],
      createdAt: '2026-07-07T10:00:00Z',
    }
    const entry2: Entry = {
      id: 'e2',
      type: 'tag',
      claudeSessionId: 'cc-A',
      session: { agent: 'claude', project: 'test' },
      tag: 'important',
      cardId: 'card-1',
      createdAt: '2026-07-07T10:01:00Z',
    }

    store.insertEntry(entry1)
    store.insertEntry(entry2)

    const all = store.listEntries()
    expect(all).toHaveLength(2)
    expect(all[0]).toEqual(entry1)
    expect(all[1]).toEqual(entry2)
  })

  it('listEntriesBySession filters by session_id and excludes unbound entries', () => {
    const boundToA: Entry = {
      id: 'e1',
      type: 'report',
      claudeSessionId: 'cc-A',
      session: { agent: 'claude', project: 'test' },
      headline: 'Report A',
      blocks: [{ id: 'b1', type: 'markdown', text: 'content' }],
      createdAt: '2026-07-07T10:00:00Z',
    }
    const boundToB: Entry = {
      id: 'e2',
      type: 'report',
      claudeSessionId: 'cc-B',
      session: { agent: 'claude', project: 'test' },
      headline: 'Report B',
      blocks: [{ id: 'b2', type: 'markdown', text: 'content' }],
      createdAt: '2026-07-07T10:01:00Z',
    }
    const unbound: Entry = {
      id: 'e3',
      type: 'tag',
      session: { agent: 'claude', project: 'test' },
      tag: 'tag-only',
      cardId: 'card-1',
      createdAt: '2026-07-07T10:02:00Z',
    }

    store.insertEntry(boundToA)
    store.insertEntry(boundToB)
    store.insertEntry(unbound)

    const sessionA = store.listEntriesBySession('cc-A')
    expect(sessionA).toHaveLength(1)
    expect(sessionA[0]).toEqual(boundToA)

    const sessionB = store.listEntriesBySession('cc-B')
    expect(sessionB).toHaveLength(1)
    expect(sessionB[0]).toEqual(boundToB)
  })

  it('corrupt JSON row is skipped with console.warn, not thrown', () => {
    // Insert a valid entry
    const valid: Entry = {
      id: 'e1',
      type: 'report',
      claudeSessionId: 'cc-A',
      session: { agent: 'claude', project: 'test' },
      headline: 'Valid',
      blocks: [{ id: 'b1', type: 'markdown', text: 'content' }],
      createdAt: '2026-07-07T10:00:00Z',
    }
    store.insertEntry(valid)

    // Manually insert corrupt JSON
    store['db'].prepare('INSERT INTO entries (id, type, session_id, created_at, json) VALUES (?, ?, ?, ?, ?)')
      .run('e2', 'report', 'cc-A', '2026-07-07T10:01:00Z', 'not valid json {')

    // Mock console.warn to verify it's called
    const warnSpy = vi.spyOn(console, 'warn')

    const result = store.listEntries()
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(valid)
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})
