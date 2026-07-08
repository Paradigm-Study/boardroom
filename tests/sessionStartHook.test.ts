import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Exercise the real SessionStart hook as a process. The contract under test:
// the boardroom protocol is injected on EVERY start (fail-closed on guidance),
// while the daemon probe only (a) selects connected-vs-offline wording and
// (b) gates the POST /api/session registration (fail-open on the probe).

const HOOK = fileURLToPath(new URL('../hooks/session-start.sh', import.meta.url))
const INPUT = JSON.stringify({ session_id: 'demo-123', cwd: '/Users/me/work/demo' })

// Async spawn (NOT spawnSync): the test's HTTP server lives in this same process,
// so the event loop must stay free to answer the hook's curl while it runs.
function runHook(port: number): Promise<{ stdout: string; status: number | null; ms: number }> {
  return new Promise(resolve => {
    const start = Date.now()
    const child = spawn('bash', [HOOK], { env: { ...process.env, BOARDROOM_PORT: String(port) } })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d })
    child.on('close', code => resolve({ stdout, status: code, ms: Date.now() - start }))
    child.stdin.end(INPUT)
  })
}

let server: Server | undefined
afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(r => server!.close(() => r()))
    server = undefined
  }
})

describe('SessionStart hook', () => {
  it('injects the boardroom protocol even when the daemon is unreachable (fail-closed on guidance)', async () => {
    const { stdout, status } = await runHook(59_999) // nothing listening → connection refused
    expect(status).toBe(0)
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string
    expect(ctx).toMatch(/Boardroom/)
    expect(ctx).toMatch(/clarify/)
    expect(ctx).toMatch(/review_results/)
    expect(ctx).toMatch(/offline/i) // offline wording, not the connected variant
  })

  it('selects connected wording AND registers the session when the daemon answers', async () => {
    const posts: unknown[] = []
    server = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/api/cards')) { res.statusCode = 200; res.end('[]'); return }
      if (req.method === 'POST' && req.url === '/api/session') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => { posts.push(JSON.parse(body)); res.statusCode = 200; res.end('{}') })
        return
      }
      res.statusCode = 404; res.end()
    })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
    const { stdout, status } = await runHook((server.address() as AddressInfo).port)
    expect(status).toBe(0)
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string
    expect(ctx).toMatch(/daemon connected/)
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ sessionId: 'demo-123', cwd: '/Users/me/work/demo', project: 'demo' })
  })

  it('does NOT register (and stays fast) when the probe fails — no stacked retries', async () => {
    const posts: unknown[] = []
    // Accepts the connection but never answers GET /api/cards, so the 2s curl
    // probe times out. If the hook tried to register anyway, this records it.
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/session') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => { posts.push(JSON.parse(body)); res.statusCode = 200; res.end('{}') })
        return
      }
      // GET /api/cards: hang forever (no res.end)
    })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
    const { stdout, status, ms } = await runHook((server.address() as AddressInfo).port)
    expect(status).toBe(0)
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string
    expect(ctx).toMatch(/offline/i)
    expect(posts).toHaveLength(0)       // registration gated on the probe
    expect(ms).toBeLessThan(4_000)      // one 2s probe, not a retry loop
  })

  it('injects the session key line into additionalContext (connected)', async () => {
    server = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/api/cards')) { res.statusCode = 200; res.end('[]'); return }
      if (req.method === 'POST' && req.url === '/api/session') {
        req.resume()
        req.on('end', () => { res.statusCode = 200; res.end('{}') })
        return
      }
      res.statusCode = 404; res.end()
    })
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
    const { stdout, status } = await runHook((server.address() as AddressInfo).port)
    expect(status).toBe(0)
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string
    expect(ctx).toContain('Boardroom session key: demo-123')
    expect(ctx).toContain('sessionKey')
    expect(ctx).not.toContain('identical project + headline') // stale protocol gone
    expect(ctx).toContain('identical sessionKey, project and headline')
  })

  it('injects the session key line even when the daemon is offline', async () => {
    const { stdout, status } = await runHook(59_999) // nothing listening → connection refused
    expect(status).toBe(0)
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string
    expect(ctx).toContain('Boardroom session key: demo-123')
    expect(ctx).not.toContain('identical project + headline') // stale protocol gone
    expect(ctx).toContain('identical sessionKey, project and headline')
  })

  it('injects present_report guidance in connected context', async () => {
    let localServer: Server | undefined
    try {
      localServer = createServer((req, res) => {
        if (req.method === 'GET' && req.url?.startsWith('/api/cards')) { res.statusCode = 200; res.end('[]'); return }
        if (req.method === 'POST' && req.url === '/api/session') {
          req.resume()
          req.on('end', () => { res.statusCode = 200; res.end('{}') })
          return
        }
        res.statusCode = 404; res.end()
      })
      await new Promise<void>(r => localServer!.listen(0, '127.0.0.1', r))
      const { stdout, status } = await runHook((localServer.address() as AddressInfo).port)
      expect(status).toBe(0)
      const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string
      expect(ctx).toContain('present_report')
      expect(ctx).toContain('never blocks')
    } finally {
      if (localServer) {
        localServer.closeAllConnections()
        await new Promise<void>(r => localServer!.close(() => r()))
      }
    }
  })

  it('injects present_report guidance in offline context', async () => {
    const { stdout, status } = await runHook(59_999) // nothing listening → connection refused
    expect(status).toBe(0)
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext as string
    expect(ctx).toContain('present_report')
    expect(ctx).toContain('never blocks')
  })
})
