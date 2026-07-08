import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../shared/card.js'
import type { Entry } from '../shared/entry.js'
import { Queue } from './queue.js'
import { Store } from './store.js'
import { buildTrayVM } from './trayView.js'

function card(id: string, fingerprint = `fp-${id}`, o: Partial<Card> = {}): Card {
  return {
    id, stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [{
      id: 'd1', prompt: 'p', multi: false,
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      noteRequiredOn: ['b'],
    }],
    status: 'pending', createdAt: new Date().toISOString(),
    fingerprint,
    ...o,
  }
}

const noop = { resolve: () => {}, reject: () => {} }

let dir: string
let store: Store
let queue: Queue

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-'))
  store = new Store(join(dir, 'test.sqlite'))
  queue = new Queue(store)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Queue — entry emission on fresh submit', () => {
  it('inserts + emits exactly one "stage:clarify:raised" tag carrying the card id and claudeSessionId', () => {
    const entries: Entry[] = []
    queue.on('entry', (e: Entry) => entries.push(e))

    queue.submit(card('c1', 'fp-c1', { claudeSessionId: 'cc-123' }), noop)

    expect(entries).toHaveLength(1)
    const [tag] = entries
    expect(tag.type).toBe('tag')
    if (tag.type !== 'tag') throw new Error('expected tag entry')
    expect(tag.tag).toBe('stage:clarify:raised')
    expect(tag.cardId).toBe('c1')
    expect(tag.claudeSessionId).toBe('cc-123')
    expect(tag.session).toEqual({ agent: 'claude-code', project: 'demo' })

    const persisted = store.listEntries()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toEqual(tag)
  })

  it('omits claudeSessionId on the tag when the card has none', () => {
    const entries: Entry[] = []
    queue.on('entry', (e: Entry) => entries.push(e))

    queue.submit(card('c1'), noop)

    expect(entries).toHaveLength(1)
    expect(entries[0]).not.toHaveProperty('claudeSessionId')
  })
})

describe('Queue — entry emission on reattach/claim (must NOT tag)', () => {
  it('the decided-undelivered claim (gen: -1) branch emits no tag — a re-issue is not a new gate', () => {
    const first = queue.submit(card('c1', 'shared-fp'), noop)
    queue.disconnect(first.cardId, first.gen)
    queue.decide('c1', { d1: { chosen: ['a'] } }) // human decides offline → undelivered

    const entries: Entry[] = []
    queue.on('entry', (e: Entry) => entries.push(e))

    const retry = queue.submit(card('c2', 'shared-fp'), { resolve: vi.fn(), reject: vi.fn() })
    expect(retry.gen).toBe(-1) // claimed immediately, no new insert

    expect(entries).toHaveLength(0)
  })

  it('the orphan-revive branch emits no tag — reattaching a live retry is not a new gate', () => {
    const first = queue.submit(card('c1', 'shared-fp'), noop)
    queue.disconnect(first.cardId, first.gen)

    const entries: Entry[] = []
    queue.on('entry', (e: Entry) => entries.push(e))

    const retry = queue.submit(card('c2', 'shared-fp'), noop)
    expect(retry.cardId).toBe('c1') // revived, not a fresh insert

    expect(entries).toHaveLength(0)
  })
})

describe('Queue.decide — entry emission', () => {
  it('emits "stage:clarify:decided" with the card id and claudeSessionId', () => {
    queue.submit(card('c1', 'fp-c1', { claudeSessionId: 'cc-999' }), noop)

    const entries: Entry[] = []
    queue.on('entry', (e: Entry) => entries.push(e))

    queue.decide('c1', { d1: { chosen: ['a'] } })

    expect(entries).toHaveLength(1)
    const [tag] = entries
    expect(tag.type).toBe('tag')
    if (tag.type !== 'tag') throw new Error('expected tag entry')
    expect(tag.tag).toBe('stage:clarify:decided')
    expect(tag.cardId).toBe('c1')
    expect(tag.claudeSessionId).toBe('cc-999')

    const persisted = store.listEntries()
    expect(persisted).toHaveLength(2) // raised (from submit) + decided
    expect(persisted).toContainEqual(tag)
  })
})

describe('Queue.postReport', () => {
  it('validates, persists, and emits the report entry', () => {
    const entries: Entry[] = []
    queue.on('entry', (e: Entry) => entries.push(e))

    const report: Entry = {
      id: 'r1',
      type: 'report',
      claudeSessionId: 'cc-1',
      session: { agent: 'claude-code', project: 'demo' },
      headline: 'Shipped the thing',
      blocks: [{ id: 'b1', type: 'markdown', text: 'done' }],
      createdAt: new Date().toISOString(),
    }

    queue.postReport(report)

    expect(entries).toEqual([report])
    expect(store.listEntries()).toEqual([report])
  })

  it('throws on an invalid entry and does not persist or emit', () => {
    const entries: Entry[] = []
    queue.on('entry', (e: Entry) => entries.push(e))

    const invalid = {
      id: 'bad',
      type: 'report',
      session: { agent: 'claude-code', project: 'demo' },
      headline: '',
      blocks: [],
      createdAt: new Date().toISOString(),
    } as unknown as Entry

    expect(() => queue.postReport(invalid)).toThrow()
    expect(entries).toHaveLength(0)
    expect(store.listEntries()).toHaveLength(0)
  })
})

describe('Queue entries — tray/cards isolation guard (spec criterion tray-separation)', () => {
  it('buildTrayVM output and store.list() (cards) are unaffected by entries', () => {
    queue.submit(card('c1'), noop) // also emits a 'raised' tag entry
    queue.submit(card('c2'), noop) // also emits a 'raised' tag entry

    const now = Date.now()
    const window = 24 * 60 * 60_000
    const trayBefore = buildTrayVM(store, now, window)
    const cardsBefore = store.list()

    expect(store.listEntries()).toHaveLength(2) // the two 'raised' tags from submit above

    // Post a report — a pure entry write with no card side effects at all — and
    // confirm tray/cards are byte-identical to before, despite entries now
    // existing in the same store.
    queue.postReport({
      id: 'r1',
      type: 'report',
      session: { agent: 'claude-code', project: 'demo' },
      headline: 'Interim update',
      blocks: [{ id: 'b1', type: 'markdown', text: 'progress' }],
      createdAt: new Date().toISOString(),
    })

    expect(store.listEntries()).toHaveLength(3) // 2 raised + 1 report

    const trayAfter = buildTrayVM(store, now, window)
    const cardsAfter = store.list()

    expect(trayAfter).toEqual(trayBefore)
    expect(cardsAfter).toEqual(cardsBefore)
  })
})
