import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The SessionStart hook lives in hooks/ (loaded by Claude Code), but it is the
// Claude-Code harness's session protocol, so its behaviour is tested here.
const HOOK = fileURLToPath(new URL('../../../hooks/session-start.sh', import.meta.url))

// Run the hook end-to-end. The daemon-liveness probe is a 2s curl to a loopback
// port; with nothing listening it fails fast and the hook renders its FALLBACK
// branch.
function runHook(port: number, input = '{}'): string {
  const out = execFileSync('bash', [HOOK], {
    input,
    env: { ...process.env, BOARDROOM_PORT: String(port) },
    encoding: 'utf8',
  })
  return contextOf(out)
}

function contextOf(out: string): string {
  const parsed = JSON.parse(out) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } }
  expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart')
  return parsed.hookSpecificOutput?.additionalContext ?? ''
}

// Async runner for the CONNECTED branch: the in-process stub daemon lives on this
// event loop, so the hook must run without blocking it (execFileSync would deadlock
// the probe against the server it is probing).
function runHookAgainst(port: number, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [HOOK], { env: { ...process.env, BOARDROOM_PORT: String(port) } })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { err += String(d) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(out)
      else reject(new Error(`hook exited ${code}: ${err}`))
    })
    child.stdin.end(input)
  })
}

interface SeenRequest { method?: string; url?: string; body: string }

function stubDaemon(): Promise<{ server: Server; port: number; requests: SeenRequest[] }> {
  const requests: SeenRequest[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += String(c) })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body })
      res.setHeader('content-type', 'application/json')
      res.end(req.url === '/api/cards' ? '[]' : '{}')
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, requests })
    })
  })
}

describe('session-start hook (runtime)', () => {
  it('always injects a non-empty SessionStart additionalContext mentioning Boardroom', () => {
    const ctx = runHook(1) // closed port → fast-fail probe → FALLBACK branch
    expect(ctx.length).toBeGreaterThan(0)
    expect(ctx).toMatch(/Boardroom/i)
  })

  it('offline branch (daemon unreachable) injects the best-effort fallback protocol', () => {
    const ctx = runHook(1)
    expect(ctx).toMatch(/offline|best-effort/i)
  })

  it('offline branch still carries the reattach recovery rule (a later-connected session must not re-ask in chat)', () => {
    const ctx = runHook(1)
    expect(ctx).toMatch(/re-?issue/i)
    expect(ctx).toMatch(/PARKED/)
  })

  // The connected branch RUN, not regex-matched: probe answers → the hook must
  // extract session_id/cwd from stdin, register via POST /api/session (this is the
  // waker's resume registry — a broken jq body or route here silently kills
  // auto-wake), and emit the connected protocol.
  it('connected branch: registers the session with the daemon and injects the connected protocol', async () => {
    const { server, port, requests } = await stubDaemon()
    try {
      const out = await runHookAgainst(port, JSON.stringify({ session_id: 'sid-123', cwd: '/tmp/demo-proj' }))
      const ctx = contextOf(out)
      expect(ctx).toMatch(/daemon connected/)
      expect(ctx).not.toMatch(/best-effort/)

      const probe = requests.find(r => r.url === '/api/cards')
      expect(probe?.method).toBe('GET')
      const registration = requests.find(r => r.url === '/api/session')
      expect(registration?.method).toBe('POST')
      expect(JSON.parse(registration!.body)).toEqual({
        sessionId: 'sid-123',
        cwd: '/tmp/demo-proj',
        project: 'demo-proj',
      })
    } finally {
      server.close()
    }
  })

  // The session id is attacker-shaped input (it arrives on stdin and ends up in a
  // shell variable): if the hook ever re-evaluated it — eval, an unquoted heredoc,
  // string-built jq — a $(…)/backtick payload would EXECUTE at every session start.
  // The reviewer probed this manually; codify it: the payload must pass through
  // LITERALLY (context + registration body) and must never run.
  it('a session_id full of shell metacharacters passes through literally and executes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'boardroom-hook-meta-'))
    const markerA = join(dir, 'pwned-subshell')
    const markerB = join(dir, 'pwned-backtick')
    const payload = `sid-$(touch ${markerA})-\`touch ${markerB}\`-"quoted"-'single'-;|&`
    const { server, port, requests } = await stubDaemon()
    try {
      const ctx = contextOf(await runHookAgainst(port, JSON.stringify({ session_id: payload, cwd: '/tmp/demo-proj' })))
      // Literal passthrough: the agent must see the exact key back.
      expect(ctx).toContain(`Boardroom session key: ${payload}`)
      // Literal registration: jq --arg must JSON-encode, never interpolate.
      const registration = requests.find(r => r.url === '/api/session')
      expect(JSON.parse(registration!.body)).toEqual({
        sessionId: payload,
        cwd: '/tmp/demo-proj',
        project: 'demo-proj',
      })
      // And nothing executed: neither the $(…) nor the backtick form ran.
      expect(existsSync(markerA)).toBe(false)
      expect(existsSync(markerB)).toBe(false)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('offline branch also passes a metacharacter session_id through literally without executing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boardroom-hook-meta-off-'))
    const marker = join(dir, 'pwned-offline')
    const payload = `sid-$(touch ${marker})`
    try {
      const ctx = runHook(1, JSON.stringify({ session_id: payload, cwd: '/tmp/demo-proj' }))
      expect(ctx).toContain(`Boardroom session key: ${payload}`)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('connected branch: skips registration (but still injects the protocol) when stdin has no session_id', async () => {
    const { server, port, requests } = await stubDaemon()
    try {
      const ctx = contextOf(await runHookAgainst(port, '{}'))
      expect(ctx).toMatch(/daemon connected/)
      expect(requests.some(r => r.url === '/api/session')).toBe(false)
    } finally {
      server.close()
    }
  })
})

describe('session-start hook (connected protocol content)', () => {
  // The connected-branch PROTOCOL heredoc is injected verbatim, so assert its
  // content from the source. Scope the assertions to that heredoc so a match in
  // the FALLBACK heredoc can't give a false pass.
  const source = readFileSync(HOOK, 'utf8')
  const protocol = source.slice(
    source.indexOf('daemon connected'),
    source.indexOf('read -r -d \'\' FALLBACK'),
  )

  it('isolates a non-empty connected PROTOCOL heredoc', () => {
    expect(protocol.length).toBeGreaterThan(100)
    expect(protocol).toMatch(/daemon connected/)
  })

  it('tells the agent to STOP-and-re-issue when a boardroom call drops on a daemon restart (the agent twin of PARKED)', () => {
    // Names the failure mode (restart / transport / connection drop), the STOP, the
    // deterministic recovery (re-issue the identical call to reattach), and forbids
    // guessing/inferring/assuming a verdict.
    expect(protocol).toMatch(/restart|reconnect|connection|transport|drop/i)
    expect(protocol).toMatch(/re-?issue/i)
    expect(protocol).toMatch(/identical|same/i)
    expect(protocol).toMatch(/STOP/)
    expect(protocol).toMatch(/do NOT (guess|infer|assume)|never (guess|infer|assume)/i)
  })

  it('keeps the existing PARKED rule (the new rule augments, not replaces, it)', () => {
    expect(protocol).toMatch(/PARKED/)
  })
})
