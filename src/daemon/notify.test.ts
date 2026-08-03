import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../shared/card.js'
import type { Config } from './config.js'
import { Queue } from './queue.js'
import { Store } from './store.js'
import { isBenignNotifierNoise, notifyWakeFailed, startAutoOpen, startNotifications } from './notify.js'

const notifyMock = vi.fn()
vi.mock('node-notifier', () => ({ default: { notify: (...args: unknown[]) => notifyMock(...args) } }))

const spawnMock = vi.fn((..._args: unknown[]) => ({ on: () => {} }))
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

// node-notifier shells out to terminal-notifier and JSON.parses its stdout
// (node-notifier/lib/utils.js fileCommandJson). On modern macOS the daemon's
// notification is suppressed and terminal-notifier emits output that isn't a
// clean JSON value, so JSON.parse throws a SyntaxError that node-notifier hands
// back as the callback's error. That surface is best-effort — the menu-bar app
// is the dependable notifier — so the parse failure is expected noise.
describe('isBenignNotifierNoise', () => {
  it('treats the terminal-notifier JSON.parse SyntaxError as benign', () => {
    const err = new SyntaxError(
      'Unexpected non-whitespace character after JSON at position 154 (line 6 column 2)',
    )
    expect(isBenignNotifierNoise(err)).toBe(true)
  })

  it('keeps real spawn failures loud (e.g. notifier missing)', () => {
    const err = new Error('Notifier (terminal-notifier) not found on system.')
    expect(isBenignNotifierNoise(err)).toBe(false)
  })

  it('does not swallow stderr strings or empty errors', () => {
    expect(isBenignNotifierNoise('some terminal-notifier stderr warning')).toBe(false)
    expect(isBenignNotifierNoise(null)).toBe(false)
    expect(isBenignNotifierNoise(undefined)).toBe(false)
  })
})

function card(id: string, status: Card['status'] = 'pending'): Card {
  return {
    id, stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status, createdAt: new Date().toISOString(),
  }
}

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    port: 4040,
    remindEveryMinutes: 10,
    notifications: true,
    openOnPending: false,
    reattachWindowMs: 24 * 60 * 60_000,
    dbPath: ':memory:',
    configDir: '/tmp/boardroom-test',
    ...overrides,
  }
}

let dir: string
let store: Store
let queue: Queue

beforeEach(() => {
  notifyMock.mockClear()
  spawnMock.mockClear()
  dir = mkdtempSync(join(tmpdir(), 'boardroom-'))
  store = new Store(join(dir, 'test.sqlite'))
  queue = new Queue(store)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('notifyWakeFailed', () => {
  it('tells the human the decision was NOT delivered and deep-links to the card', () => {
    notifyWakeFailed(card('c9'), 4040)
    expect(notifyMock).toHaveBeenCalledTimes(1)
    const opts = notifyMock.mock.calls[0][0]
    expect(opts.title).toContain('wake failed')
    expect(opts.message).toContain('h') // the card headline
    expect(opts.message.toLowerCase()).toContain('not delivered')
    expect(opts.open).toBe('http://127.0.0.1:4040/#/card/c9')
  })
})

describe('startNotifications', () => {
  it('does not notify at all when config.notifications is false', () => {
    startNotifications(queue, cfg({ notifications: false }))
    queue.emit('card', card('c1', 'pending'))
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it('notifies once for a pending card', () => {
    startNotifications(queue, cfg())
    queue.emit('card', card('c1', 'pending'))
    expect(notifyMock).toHaveBeenCalledTimes(1)
    const opts = notifyMock.mock.calls[0][0]
    expect(opts.message).toBe('h')
    expect(opts.open).toBe('http://127.0.0.1:4040/#/card/c1')
  })

  it('dedupes: exactly one notify per unique card id', () => {
    startNotifications(queue, cfg())
    queue.emit('card', card('c1', 'pending'))
    queue.emit('card', card('c1', 'pending'))
    queue.emit('card', card('c2', 'pending'))
    expect(notifyMock).toHaveBeenCalledTimes(2)
    const ids = notifyMock.mock.calls.map(c => c[0].open)
    expect(ids).toEqual([
      'http://127.0.0.1:4040/#/card/c1',
      'http://127.0.0.1:4040/#/card/c2',
    ])
  })

  it('ignores non-pending statuses', () => {
    startNotifications(queue, cfg())
    queue.emit('card', card('c1', 'decided'))
    queue.emit('card', card('c2', 'orphaned'))
    expect(notifyMock).not.toHaveBeenCalled()
  })
})

describe('startAutoOpen', () => {
  it('does not spawn when config.openOnPending is false (default)', () => {
    startAutoOpen(queue, cfg({ openOnPending: false }))
    queue.emit('card', card('c1', 'pending'))
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('spawns `open` to the card url once per pending card when openOnPending is true', () => {
    startAutoOpen(queue, cfg({ openOnPending: true }))
    queue.emit('card', card('c1', 'pending'))
    queue.emit('card', card('c1', 'pending'))
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      'open',
      ['http://127.0.0.1:4040/#/card/c1'],
      { stdio: 'ignore' },
    )
  })

  it('does not spawn for non-pending statuses', () => {
    startAutoOpen(queue, cfg({ openOnPending: true }))
    queue.emit('card', card('c1', 'decided'))
    queue.emit('card', card('c2', 'orphaned'))
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
