import { describe, expect, it } from 'vitest'
// The menu-bar tray's pure logic lives in a dependency-free CommonJS module so it can
// be unit-tested here (the Electron glue in main.js wires it to the tray). Shipped raw
// by electron-builder alongside main.js — no transpile step.
import { orderedStages, parseFrame, splitFrames, stageSummary, trayView, reconcileNotifications } from '../menubar/trayRender.js'
import type { TrayVM as DaemonTrayVM } from '../src/daemon/trayView.js'

describe('splitFrames', () => {
  it('splits complete SSE frames on a blank line and keeps the incomplete remainder', () => {
    expect(splitFrames('a\n\nb\n\nc')).toEqual({ frames: ['a', 'b'], rest: 'c' })
    expect(splitFrames('a\n\n')).toEqual({ frames: ['a'], rest: '' })
    expect(splitFrames('no terminator yet')).toEqual({ frames: [], rest: 'no terminator yet' })
  })
})

describe('parseFrame', () => {
  it('parses the event name and data, stripping one leading space after the colon', () => {
    expect(parseFrame('event: tray\ndata: {"total":3}')).toEqual({ event: 'tray', data: '{"total":3}' })
  })
  it('defaults the event name to "message" and joins multi-line data', () => {
    expect(parseFrame('data: hello\ndata: world')).toEqual({ event: 'message', data: 'hello\nworld' })
  })
  it('returns null for a comment-only frame (:connected, :hb)', () => {
    expect(parseFrame(':connected')).toBeNull()
    expect(parseFrame(':hb')).toBeNull()
  })
})

describe('trayView', () => {
  it('connecting (never connected) shows a neutral glyph', () => {
    const v = trayView({ connState: 'connecting', vm: null })
    expect(v.title).toBe(' …')
    expect(v.tooltip).toMatch(/connecting/i)
  })
  it('lost (was connected, daemon gone) shows the offline glyph', () => {
    const v = trayView({ connState: 'lost', vm: null })
    expect(v.title).toBe(' •')
    expect(v.tooltip).toMatch(/offline/i)
  })
  it('connected + idle shows a clean title', () => {
    const v = trayView({ connState: 'connected', vm: { total: 0, byStage: { clarify: 0, plan: 0, spec: 0, results: 0 }, items: [] } })
    expect(v.title).toBe('')
    expect(v.tooltip).toMatch(/nothing pending/i)
  })
  it('connected + pending shows the count and a per-stage breakdown', () => {
    // Typed as the DAEMON's TrayVM: this assignment is the compile-time check that
    // what the daemon emits on the wire stays consumable by the tray's renderer.
    const daemonVM: DaemonTrayVM = { total: 3, byStage: { clarify: 2, plan: 0, spec: 0, results: 1 }, items: [] }
    const v = trayView({ connState: 'connected', vm: daemonVM })
    expect(v.title).toBe(' 3')
    expect(v.tooltip).toContain('3')
    expect(v.tooltip).toContain('2 scoping')
    expect(v.tooltip).toContain('1 results')
  })
})

describe('stageSummary', () => {
  it('lists only non-zero stages in canonical order', () => {
    expect(stageSummary({ clarify: 2, plan: 0, spec: 1, results: 1 })).toBe('2 scoping · 1 spec · 1 results')
  })
  it('is forward-compatible with an unknown stage key (falls back to the raw key)', () => {
    expect(stageSummary({ clarify: 1, future: 2 } as Record<string, number>)).toBe('1 scoping · 2 future')
  })
})

describe('orderedStages', () => {
  it('orders known stages canonically and appends unknown keys — the single ordering policy for tooltip and menu', () => {
    expect(orderedStages({ results: 1, clarify: 2, future: 3 } as Record<string, number>)).toEqual(['clarify', 'results', 'future'])
    expect(orderedStages({})).toEqual([])
  })
})

describe('reconcileNotifications', () => {
  it('seeds silently on the first frame (no reconnect notification burst)', () => {
    const r = reconcileNotifications(null, [{ id: 'a' }, { id: 'b' }])
    expect(r.toNotify).toEqual([])
    expect(r.seen.sort()).toEqual(['a', 'b'])
  })
  it('notifies only ids not previously seen', () => {
    const r = reconcileNotifications(['a'], [{ id: 'a' }, { id: 'b' }])
    expect(r.toNotify).toEqual([{ id: 'b' }])
    expect(r.seen.sort()).toEqual(['a', 'b'])
  })
  it('drops ids that left so the seen-set stays bounded', () => {
    const r = reconcileNotifications(['a', 'b'], [{ id: 'a' }])
    expect(r.toNotify).toEqual([])
    expect(r.seen).toEqual(['a'])
  })
})
