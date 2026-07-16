import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../shared/card.js'
import { Queue } from './queue.js'
import { installSignalHandlers } from './shutdown.js'
import { Store } from './store.js'

// A stand-in for the http.Server: records close() and lets the test resolve it.
class FakeServer extends EventEmitter {
  closed = 0
  closeAllConnectionsCalls = 0
  closeIdleConnectionsCalls = 0
  private cb?: (err?: Error) => void
  close(cb?: (err?: Error) => void): this {
    this.closed++
    this.cb = cb
    return this
  }
  closeIdleConnections(): void {
    this.closeIdleConnectionsCalls++
  }
  closeAllConnections(): void {
    this.closeAllConnectionsCalls++
  }
  finishClose(err?: Error): void {
    this.cb?.(err)
  }
}

// Capture the handlers installed on `proc` without touching the real process —
// installSignalHandlers must never register on the live process in a unit test.
function fakeProcess(): {
  proc: NodeJS.EventEmitter & { exitCode?: number }
  emit: (event: string, ...args: unknown[]) => void
  listeners: (event: string) => unknown[]
} {
  const ee = new EventEmitter() as NodeJS.EventEmitter & { exitCode?: number }
  return {
    proc: ee,
    emit: (event, ...args) => { ee.emit(event, ...args) },
    listeners: event => ee.listeners(event),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('installSignalHandlers', () => {
  it('on SIGTERM: closes the server, then closes the store, then exits 0', async () => {
    const { proc, emit } = fakeProcess()
    const server = new FakeServer()
    const order: string[] = []
    const store = { close: () => order.push('store') }
    const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })

    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store,
      proc,
      exit: exit as unknown as (code?: number) => never,
    })

    emit('SIGTERM')
    // server.close was requested before anything else
    expect(server.closed).toBe(1)
    expect(order).toEqual([]) // nothing else until the server finishes closing
    server.finishClose()
    await Promise.resolve()
    expect(order).toEqual(['store', 'exit:0'])
  })

  it('is idempotent: a second signal during shutdown does not double-close or re-exit', async () => {
    const { proc, emit } = fakeProcess()
    const server = new FakeServer()
    const order: string[] = []
    const store = { close: () => order.push('store') }
    const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })

    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store,
      proc,
      exit: exit as unknown as (code?: number) => never,
    })

    emit('SIGTERM')
    emit('SIGINT') // arrives mid-shutdown
    expect(server.closed).toBe(1) // not 2
    server.finishClose()
    await Promise.resolve()
    expect(order).toEqual(['store', 'exit:0'])
  })

  it('an uncaughtException is logged and triggers a non-zero graceful shutdown (never a silent crash)', async () => {
    const { proc, emit } = fakeProcess()
    const server = new FakeServer()
    const order: string[] = []
    const store = { close: () => order.push('store') }
    const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })
    const log = vi.fn()

    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store,
      proc,
      exit: exit as unknown as (code?: number) => never,
      log,
    })

    emit('uncaughtException', new Error('boom'))
    expect(log).toHaveBeenCalled()
    server.finishClose()
    await Promise.resolve()
    expect(order).toEqual(['store', 'exit:1'])
  })

  it('an unhandledRejection is logged but does NOT exit (a stray rejection must not take down a daemon mid-decision)', () => {
    const { proc, emit } = fakeProcess()
    const server = new FakeServer()
    const store = { close: () => {} }
    const exit = vi.fn()
    const log = vi.fn()

    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store,
      proc,
      exit: exit as unknown as (code?: number) => never,
      log,
    })

    emit('unhandledRejection', new Error('stray'))
    expect(log).toHaveBeenCalled()
    expect(server.closed).toBe(0)
    expect(exit).not.toHaveBeenCalled()
  })

  it('still exits even if the server never finishes closing (watchdog), so KeepAlive can respawn', () => {
    vi.useFakeTimers()
    try {
      const { proc, emit } = fakeProcess()
      const server = new FakeServer()
      const order: string[] = []
      const store = { close: () => order.push('store') }
      const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })

      installSignalHandlers({
        server: server as unknown as import('node:http').Server,
        store,
        proc,
        exit: exit as unknown as (code?: number) => never,
        forceExitMs: 5_000,
      })

      emit('SIGTERM')
      // server.close() is called but its callback never fires (a hung socket)
      expect(order).toEqual([])
      vi.advanceTimersByTime(5_000)
      expect(order).toEqual(['store', 'exit:0'])
      // A late server.close callback after the watchdog already exited must be a
      // no-op (the `exited` guard), never a second store-close / exit.
      server.finishClose()
      expect(order).toEqual(['store', 'exit:0'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the session capturer BEFORE closing the store, and force-ends connections', async () => {
    const { proc, emit } = fakeProcess()
    const server = new FakeServer()
    const order: string[] = []
    const store = { close: () => order.push('store') }
    const capturer = { stop: () => order.push('capturer') }
    const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })

    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store,
      capturer,
      proc,
      exit: exit as unknown as (code?: number) => never,
      drainGraceMs: 0, // no flush window: force-end connections synchronously
    })

    emit('SIGTERM')
    // Capturer is quiesced immediately (so no watcher tick writes to a closing DB),
    // connections are force-ended (so server.close can complete), and the store is
    // NOT closed until the server finishes draining.
    expect(order).toEqual(['capturer'])
    expect(server.closeAllConnectionsCalls).toBe(1)
    server.finishClose()
    await Promise.resolve()
    expect(order).toEqual(['capturer', 'store', 'exit:0'])
  })

  it('runs quiesce after the capturer stops and BEFORE connections are force-ended', async () => {
    const { proc, emit } = fakeProcess()
    const order: string[] = []
    const server = new (class extends FakeServer {
      closeAllConnections(): void {
        order.push('closeAllConnections')
        super.closeAllConnections()
      }
    })()
    const store = { close: () => order.push('store') }
    const capturer = { stop: () => order.push('capturer') }
    const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })

    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store,
      capturer,
      quiesce: () => order.push('quiesce'),
      proc,
      exit: exit as unknown as (code?: number) => never,
      drainGraceMs: 0, // force-end synchronously so the ordering is observable without timers
    })

    emit('SIGTERM')
    // quiesce must beat closeAllConnections: it orphans pending gates as 'boot'
    // while the store is open, so the socket-close handlers find them non-pending.
    expect(order).toEqual(['capturer', 'quiesce', 'closeAllConnections'])
    server.finishClose()
    await Promise.resolve()
    expect(order).toEqual(['capturer', 'quiesce', 'closeAllConnections', 'store', 'exit:0'])
  })

  it('still exits if quiesce throws (logged), so a redeploy is never blocked', async () => {
    const { proc, emit } = fakeProcess()
    const server = new FakeServer()
    const order: string[] = []
    const store = { close: () => order.push('store') }
    const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })
    const log = vi.fn()

    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store,
      quiesce: () => { throw new Error('quiesce wedged') },
      proc,
      exit: exit as unknown as (code?: number) => never,
      log,
    })

    emit('SIGTERM')
    server.finishClose()
    await Promise.resolve()
    expect(order).toEqual(['store', 'exit:0'])
    expect(log).toHaveBeenCalledWith('[shutdown] quiesce failed:', expect.any(Error))
  })

  // The redeploy-during-a-gate outcome, end to end: a hanging gate's card must
  // survive the shutdown as a BOOT orphan ("reconnecting" on every needs-you
  // surface), never as a 'disconnect' orphan — closeAllConnections() fires the
  // transport's close handlers (queue.disconnect) while the process is still
  // alive, and without the quiesce step those would win and bury the gate.
  it('a hanging gate survives shutdown as a boot orphan, not a disconnect orphan', async () => {
    const store = new Store(':memory:')
    const queue = new Queue(store)
    const card: Card = {
      id: 'gate-1',
      stage: 'clarify',
      session: { agent: 'claude-code', project: 'demo' },
      headline: 'Which way?',
      blocks: [],
      decisions: [{ id: 'd', prompt: 'Pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
      status: 'pending',
      createdAt: new Date().toISOString(),
      fingerprint: 'fp-1',
    }
    const { cardId, gen } = queue.submit(card, { resolve: () => {}, reject: () => {} })

    const { proc, emit } = fakeProcess()
    // Destroying the hanging call's socket fires the transport 'close' handler,
    // which is wired to queue.disconnect — exactly what the real MCP handler does.
    const server = new (class extends FakeServer {
      closeAllConnections(): void {
        queue.disconnect(cardId, gen)
        super.closeAllConnections()
      }
    })()
    const exit = vi.fn()

    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store: { close: () => {} }, // leave the real store open for the assertion
      quiesce: () => store.orphanAllPending(),
      proc,
      exit: exit as unknown as (code?: number) => never,
      drainGraceMs: 0, // fire closeAllConnections (→ queue.disconnect) synchronously
    })

    emit('SIGTERM')
    server.finishClose()
    await Promise.resolve()

    const after = store.get(cardId)
    expect(after?.status).toBe('orphaned')
    expect(after?.orphanedReason).toBe('boot') // NOT 'disconnect'
    store.close()
  })

  // Phase 1 clean-sever flush window: quiesce resolves live gates with a PARKED
  // sentinel; that result must FLUSH over the still-open socket before it's
  // destroyed. So closeIdleConnections fires immediately, but closeAllConnections
  // is deferred by a bounded grace — otherwise the socket dies before the MCP
  // tool-result is written and the agent gets a raw drop instead of the STOP.
  it('defers closeAllConnections by the drain grace so the parked result can flush; closes idle connections immediately', () => {
    vi.useFakeTimers()
    try {
      const { proc, emit } = fakeProcess()
      const server = new FakeServer()
      const store = { close: () => {} }
      const exit = vi.fn()

      installSignalHandlers({
        server: server as unknown as import('node:http').Server,
        store,
        proc,
        exit: exit as unknown as (code?: number) => never,
        drainGraceMs: 300,
      })

      emit('SIGTERM')
      // Idle keep-alives can go at once; the active gate sockets get the grace.
      expect(server.closeIdleConnectionsCalls).toBe(1)
      expect(server.closeAllConnectionsCalls).toBe(0)
      vi.advanceTimersByTime(299)
      expect(server.closeAllConnectionsCalls).toBe(0) // still within the flush window
      vi.advanceTimersByTime(1)
      expect(server.closeAllConnectionsCalls).toBe(1) // grace elapsed → hard-close
    } finally {
      vi.useRealTimers()
    }
  })

  it('clamps a misconfigured grace below the watchdog so the clean sever still fires before exit', () => {
    vi.useFakeTimers()
    try {
      const { proc, emit } = fakeProcess()
      const server = new FakeServer()
      const order: string[] = []
      const store = { close: () => order.push('store') }
      const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })

      installSignalHandlers({
        server: server as unknown as import('node:http').Server,
        store,
        proc,
        exit: exit as unknown as (code?: number) => never,
        drainGraceMs: 10_000, // operator sets a grace LONGER than the watchdog
        forceExitMs: 5_000,
      })

      emit('SIGTERM')
      // The grace must be clamped under the watchdog: closeAllConnections fires
      // (clean sever preserved) strictly before the force-exit, not skipped.
      vi.advanceTimersByTime(4_999)
      expect(server.closeAllConnectionsCalls).toBe(1)
      expect(order).toEqual([]) // not yet exited
      vi.advanceTimersByTime(1)
      expect(order).toEqual(['store', 'exit:0'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('the force-exit watchdog still bounds a wedged drain even with a grace window', () => {
    vi.useFakeTimers()
    try {
      const { proc, emit } = fakeProcess()
      const server = new FakeServer()
      const order: string[] = []
      const store = { close: () => order.push('store') }
      const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })

      installSignalHandlers({
        server: server as unknown as import('node:http').Server,
        store,
        proc,
        exit: exit as unknown as (code?: number) => never,
        drainGraceMs: 300,
        forceExitMs: 5_000,
      })

      emit('SIGTERM')
      // server.close callback never fires; grace elapses, closeAllConnections runs,
      // but the socket stays wedged — the watchdog must still force the exit.
      vi.advanceTimersByTime(300)
      expect(server.closeAllConnectionsCalls).toBe(1)
      expect(order).toEqual([])
      vi.advanceTimersByTime(4_700)
      expect(order).toEqual(['store', 'exit:0'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('parks live gates (parkAllLive) on shutdown so the agent gets a STOP sentinel, not a raw drop', async () => {
    const store = new Store(':memory:')
    const queue = new Queue(store)
    const parked: unknown[] = []
    const card: Card = {
      id: 'gate-2', stage: 'clarify',
      session: { agent: 'claude-code', project: 'demo' },
      headline: 'Which way?', blocks: [],
      decisions: [{ id: 'd', prompt: 'Pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
      status: 'pending', createdAt: new Date().toISOString(), fingerprint: 'fp-2',
    }
    queue.submit(card, { resolve: r => parked.push(r), reject: () => {} })

    const { proc, emit } = fakeProcess()
    const server = new FakeServer()
    const exit = vi.fn()
    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store: { close: () => {} },
      // The real wiring app.ts uses: park live waiters, then sweep the rest.
      quiesce: () => { queue.parkAllLive(); store.orphanAllPending() },
      proc,
      exit: exit as unknown as (code?: number) => never,
      drainGraceMs: 0,
    })

    emit('SIGTERM')
    server.finishClose()
    await Promise.resolve()

    expect(parked).toEqual([{ parked: true, cardId: 'gate-2' }])
    expect(store.get('gate-2')?.orphanedReason).toBe('boot')
    store.close()
  })

  it('detaches the mesh forwarder immediately and awaits flush() before closing the store', async () => {
    const { proc, emit } = fakeProcess()
    const server = new FakeServer()
    const order: string[] = []
    const store = { close: () => order.push('store') }
    let releaseFlush!: () => void
    const meshForwarder = {
      stop: () => order.push('mesh-stop'),
      flush: () => {
        order.push('mesh-flush')
        return new Promise<void>(resolve => { releaseFlush = resolve })
      },
    }
    const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })

    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store,
      meshForwarder,
      proc,
      exit: exit as unknown as (code?: number) => never,
    })

    emit('SIGTERM')
    // Detached up front (like the capturer) so no new lifecycle records enqueue
    // mid-drain; flush is NOT requested until the server has finished closing.
    expect(order).toEqual(['mesh-stop'])
    server.finishClose()
    // The close callback kicks off the flush, and the store must stay open (and
    // the process alive) while the in-flight relay POST / spool write settles.
    expect(order).toEqual(['mesh-stop', 'mesh-flush'])
    releaseFlush()
    await Promise.resolve()
    expect(order).toEqual(['mesh-stop', 'mesh-flush', 'store', 'exit:0'])
  })

  it('the watchdog still force-exits when a mesh flush never settles', () => {
    vi.useFakeTimers()
    try {
      const { proc, emit } = fakeProcess()
      const server = new FakeServer()
      const order: string[] = []
      const store = { close: () => order.push('store') }
      const meshForwarder = {
        stop: () => {},
        flush: () => new Promise<void>(() => {}), // wedged: never settles
      }
      const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })

      installSignalHandlers({
        server: server as unknown as import('node:http').Server,
        store,
        meshForwarder,
        proc,
        exit: exit as unknown as (code?: number) => never,
        forceExitMs: 5_000,
      })

      emit('SIGTERM')
      server.finishClose() // the server drains fine, but the flush hangs
      expect(order).toEqual([])
      vi.advanceTimersByTime(5_000)
      expect(order).toEqual(['store', 'exit:0'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('still exits if the mesh forwarder stop() throws (logged), like every other drain step', async () => {
    const { proc, emit } = fakeProcess()
    const server = new FakeServer()
    const order: string[] = []
    const store = { close: () => order.push('store') }
    const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })
    const log = vi.fn()

    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store,
      meshForwarder: { stop: () => { throw new Error('detach wedged') }, flush: () => Promise.resolve() },
      proc,
      exit: exit as unknown as (code?: number) => never,
      log,
    })

    emit('SIGTERM')
    server.finishClose()
    await Promise.resolve()
    expect(order).toEqual(['store', 'exit:0'])
    expect(log).toHaveBeenCalledWith('[shutdown] mesh forwarder stop failed:', expect.any(Error))
  })

  it('exits even if store.close() throws (logs the failure), so a redeploy is never blocked', async () => {
    const { proc, emit } = fakeProcess()
    const server = new FakeServer()
    const order: string[] = []
    const store = { close: () => { order.push('store-throw'); throw new Error('db wedged') } }
    const exit = vi.fn((code?: number) => { order.push(`exit:${code ?? 0}`) })
    const log = vi.fn()

    installSignalHandlers({
      server: server as unknown as import('node:http').Server,
      store,
      proc,
      exit: exit as unknown as (code?: number) => never,
      log,
    })

    emit('SIGTERM')
    server.finishClose()
    await Promise.resolve()
    expect(order).toEqual(['store-throw', 'exit:0'])
    expect(log).toHaveBeenCalled()
  })
})
