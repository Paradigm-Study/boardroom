// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Entry } from '../../src/shared/entry.js'
import { isRead, markRead, unreadCount } from './readState.js'

const STORAGE_KEY = 'boardroom.readEntries.v1'

function report(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    type: 'report',
    session: { agent: 'codex', project: 'boardroom' },
    headline: 'Headline',
    blocks: [{ type: 'callout', tone: 'info', text: 'hi' } as never],
    createdAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  } as Entry
}

function tag(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    type: 'tag',
    session: { agent: 'codex', project: 'boardroom' },
    tag: 'blocked',
    cardId: 'card-1',
    createdAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  } as Entry
}

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('markRead / isRead round-trip', () => {
  it('is unread before marking, read after', () => {
    expect(isRead('e1')).toBe(false)
    markRead('e1')
    expect(isRead('e1')).toBe(true)
  })

  it('persists across a fresh read (new call reads localStorage again)', () => {
    markRead('e1')
    // isRead re-reads storage each call; no in-memory-only state.
    expect(isRead('e1')).toBe(true)
    expect(isRead('e2')).toBe(false)
  })

  it('a storage stub throwing on getItem/setItem never throws out of markRead/isRead', () => {
    const getSpy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => { throw new Error('quota') })
    const setSpy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => { throw new Error('quota') })

    expect(() => markRead('e1')).not.toThrow()
    expect(() => isRead('e1')).not.toThrow()
    expect(isRead('e1')).toBe(false) // storage unusable → nothing was ever recorded as read

    getSpy.mockRestore()
    setSpy.mockRestore()
  })

  it('malformed JSON in storage is treated as empty, not a throw', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json')
    expect(() => isRead('e1')).not.toThrow()
    expect(isRead('e1')).toBe(false)
    expect(() => markRead('e1')).not.toThrow()
    expect(isRead('e1')).toBe(true)
  })

  it('a non-object JSON payload in storage is treated as empty', () => {
    window.localStorage.setItem(STORAGE_KEY, '[1,2,3]')
    expect(isRead('e1')).toBe(false)
    markRead('e1')
    expect(isRead('e1')).toBe(true)
  })
})

describe('TTL expiry', () => {
  it('drops ids older than the TTL', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'))
    markRead('old')
    expect(isRead('old')).toBe(true)

    // 15 days later — past the 14-day TTL used by the sessionScroll pattern.
    vi.setSystemTime(new Date('2026-07-22T00:00:01.000Z'))
    expect(isRead('old')).toBe(false)
  })

  it('keeps ids marked within the TTL window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'))
    markRead('recent')

    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'))
    expect(isRead('recent')).toBe(true)
  })
})

describe('entry cap', () => {
  it('enforces a cap on stored ids, evicting the oldest first', () => {
    vi.useFakeTimers()
    const base = new Date('2026-07-07T00:00:00.000Z').getTime()
    // Mark more than the cap (200, mirroring SESSION_SCROLL_MAX_ENTRIES) with
    // strictly increasing timestamps so oldest-first eviction is deterministic.
    const total = 205
    for (let i = 0; i < total; i++) {
      vi.setSystemTime(new Date(base + i * 1000))
      markRead(`e${i}`)
    }

    // The oldest ones should have been evicted.
    expect(isRead('e0')).toBe(false)
    expect(isRead('e4')).toBe(false)
    // The most recent ones must still be read.
    expect(isRead(`e${total - 1}`)).toBe(true)
    expect(isRead(`e${total - 2}`)).toBe(true)
  })
})

describe('unreadCount', () => {
  it('counts only unread report entries, never tags', () => {
    const entries: Entry[] = [report('r1'), report('r2'), tag('t1'), tag('t2')]
    expect(unreadCount(entries)).toBe(2)

    markRead('r1')
    expect(unreadCount(entries)).toBe(1)

    markRead('r2')
    expect(unreadCount(entries)).toBe(0)
  })

  it('marking a tag id read has no effect on the count (tags never count)', () => {
    const entries: Entry[] = [report('r1'), tag('t1')]
    markRead('t1')
    expect(unreadCount(entries)).toBe(1)
  })

  it('returns 0 for an empty entries list', () => {
    expect(unreadCount([])).toBe(0)
  })
})
