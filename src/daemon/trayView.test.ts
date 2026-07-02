import { describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { Store } from './store.js'
import { buildTrayVM } from './trayView.js'

const NOW = Date.parse('2026-06-23T12:00:00.000Z')
const WINDOW = 24 * 60 * 60_000
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString()

function card(o: Partial<Card> & { id: string }): Card {
  return {
    stage: 'clarify', session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'pending', createdAt: minutesAgo(5), ...o,
  }
}

describe('buildTrayVM', () => {
  it('an empty store is idle', () => {
    const store = new Store(':memory:')
    expect(buildTrayVM(store, NOW, WINDOW)).toEqual({
      total: 0, byStage: { clarify: 0, plan: 0, spec: 0, results: 0 }, items: [],
    })
    store.close()
  })

  it('counts pending cards by stage and projects items', () => {
    const store = new Store(':memory:')
    store.insert(card({ id: 'c1', stage: 'clarify', headline: 'scope it', session: { agent: 'a', project: 'web' } }))
    store.insert(card({ id: 'c2', stage: 'results' }))
    store.insert(card({ id: 'c3', stage: 'clarify' }))
    const vm = buildTrayVM(store, NOW, WINDOW)
    expect(vm.total).toBe(3)
    expect(vm.byStage).toEqual({ clarify: 2, plan: 0, spec: 0, results: 1 })
    expect(vm.items).toContainEqual({ id: 'c1', stage: 'clarify', headline: 'scope it', project: 'web' })
    expect(vm.items).toHaveLength(3)
    store.close()
  })

  it('counts boot-orphans within the window as reconnecting (the lost-the-daemon case)', () => {
    const store = new Store(':memory:')
    store.insert(card({ id: 'r1', stage: 'plan', status: 'orphaned', orphanedReason: 'boot', orphanedAt: minutesAgo(2) }))
    const vm = buildTrayVM(store, NOW, WINDOW)
    expect(vm.total).toBe(1)
    expect(vm.byStage).toEqual({ clarify: 0, plan: 1, spec: 0, results: 0 })
    store.close()
  })

  it('excludes decided, disconnect/park orphans, and boot-orphans aged out of the window', () => {
    const store = new Store(':memory:')
    store.insert(card({ id: 'd1', status: 'decided', decidedAt: minutesAgo(1) }))
    store.insert(card({ id: 'o1', status: 'orphaned', orphanedReason: 'disconnect', orphanedAt: minutesAgo(2) }))
    store.insert(card({ id: 'o2', status: 'orphaned', orphanedReason: 'park', orphanedAt: minutesAgo(2) }))
    store.insert(card({ id: 'o3', status: 'orphaned', orphanedReason: 'boot', orphanedAt: minutesAgo(25 * 60) }))
    expect(buildTrayVM(store, NOW, WINDOW)).toEqual({
      total: 0, byStage: { clarify: 0, plan: 0, spec: 0, results: 0 }, items: [],
    })
    store.close()
  })

  it('counts against the supplied window, not the 24h default', () => {
    const store = new Store(':memory:')
    store.insert(card({ id: 'r1', status: 'orphaned', orphanedReason: 'boot', orphanedAt: minutesAgo(10) }))
    expect(buildTrayVM(store, NOW, 5 * 60_000).total).toBe(0) // 10m old vs a 5m window → expired
    expect(buildTrayVM(store, NOW, 30 * 60_000).total).toBe(1) // within a 30m window
    store.close()
  })
})
