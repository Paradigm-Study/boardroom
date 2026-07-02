import { describe, expect, it } from 'vitest'
import type { Card } from './card.js'
import { isReconnecting, needsHuman, REATTACH_WINDOW_MS } from './needsHuman.js'

const NOW = Date.parse('2026-06-23T12:00:00.000Z')
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString()
function card(o: Partial<Card>): Card {
  return {
    id: 'c', stage: 'clarify', session: { agent: 'claude-code', project: 'p' },
    headline: 'h', blocks: [], decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'pending', createdAt: minutesAgo(5), ...o,
  }
}

describe('needsHuman / isReconnecting (shared)', () => {
  it('a pending card needs the human', () => {
    expect(needsHuman(card({ status: 'pending' }), NOW)).toBe(true)
  })

  it('a boot-orphan within the window is reconnecting and still needs the human', () => {
    const c = card({ status: 'orphaned', orphanedReason: 'boot', orphanedAt: minutesAgo(2) })
    expect(isReconnecting(c, NOW)).toBe(true)
    expect(needsHuman(c, NOW)).toBe(true)
  })

  it('disconnect/park orphans are NOT reconnecting (they stay in history)', () => {
    for (const reason of ['disconnect', 'park'] as const) {
      const c = card({ status: 'orphaned', orphanedReason: reason, orphanedAt: minutesAgo(2) })
      expect(isReconnecting(c, NOW)).toBe(false)
      expect(needsHuman(c, NOW)).toBe(false)
    }
  })

  it('a boot-orphan past the default 24h window is no longer reconnecting', () => {
    const c = card({ status: 'orphaned', orphanedReason: 'boot', orphanedAt: minutesAgo(25 * 60) })
    expect(isReconnecting(c, NOW)).toBe(false)
    expect(needsHuman(c, NOW)).toBe(false)
  })

  it('a decided card never needs the human', () => {
    expect(needsHuman(card({ status: 'decided' }), NOW)).toBe(false)
  })

  // NEW capability the daemon depends on: the reattach window is configurable, so the
  // tray view-model counts against the daemon's OWN window, not the web default.
  it('honors an explicit windowMs (the daemon passes config.reattachWindowMs)', () => {
    const c = card({ status: 'orphaned', orphanedReason: 'boot', orphanedAt: minutesAgo(10) })
    expect(isReconnecting(c, NOW, 5 * 60_000)).toBe(false) // 10m old vs a 5m window → expired
    expect(isReconnecting(c, NOW, 30 * 60_000)).toBe(true) // within a 30m window
    expect(needsHuman(c, NOW, 5 * 60_000)).toBe(false)
    expect(needsHuman(c, NOW, 30 * 60_000)).toBe(true)
  })

  it('exports the 24h default window for callers without the configured value', () => {
    expect(REATTACH_WINDOW_MS).toBe(24 * 60 * 60_000)
  })

  // Corrupt timestamps must fail OPEN: a boot-orphaned gate the clock can't place
  // must stay on the needs-you surfaces, never silently vanish from them.
  it('a boot-orphan with an unparseable orphanedAt falls back to createdAt', () => {
    const withinWindow = card({ status: 'orphaned', orphanedReason: 'boot', orphanedAt: 'not-a-timestamp', createdAt: minutesAgo(2) })
    expect(isReconnecting(withinWindow, NOW)).toBe(true)
    const expired = card({ status: 'orphaned', orphanedReason: 'boot', orphanedAt: 'not-a-timestamp', createdAt: minutesAgo(25 * 60) })
    expect(isReconnecting(expired, NOW)).toBe(false)
  })

  it('a boot-orphan with BOTH timestamps corrupt is still reconnecting (fail open)', () => {
    const c = card({ status: 'orphaned', orphanedReason: 'boot', orphanedAt: 'garbage', createdAt: 'garbage' })
    expect(isReconnecting(c, NOW)).toBe(true)
    expect(needsHuman(c, NOW)).toBe(true)
  })
})
