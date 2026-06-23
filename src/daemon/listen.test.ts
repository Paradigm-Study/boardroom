import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { guardListen } from './listen.js'

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

let blocker: ReturnType<typeof createServer> | undefined
let server: ReturnType<typeof createServer> | undefined
afterEach(() => {
  server?.close()
  blocker?.closeAllConnections()
  blocker?.close()
  blocker = server = undefined
})

describe('guardListen', () => {
  it('routes a bind failure (EADDRINUSE) to the fatal handler instead of swallowing it', async () => {
    blocker = createServer()
    await new Promise<void>(r => blocker!.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as AddressInfo).port

    const fatals: string[] = []
    server = createServer()
    guardListen(server, port, msg => { fatals.push(msg) }) // injected non-exiting handler
    server.listen(port, '127.0.0.1') // same port → EADDRINUSE

    await delay(250)
    expect(fatals).toHaveLength(1)
    expect(fatals[0]).toMatch(/EADDRINUSE|bind/i)
    expect(fatals[0]).toContain(String(port))
  })

  it('stays quiet on a clean bind', async () => {
    const fatals: string[] = []
    server = createServer()
    guardListen(server, 0, msg => { fatals.push(msg) })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
    await delay(50)
    expect(fatals).toHaveLength(0)
  })
})
