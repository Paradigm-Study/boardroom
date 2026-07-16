import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Exercise the real Claude PreToolUse hook as a process. The hook may talk only
// to the authenticated loopback Praxis proxy. Praxis owns consent resolution,
// canonical project/path derivation, and hosted Mesh credentials. A collision
// is a one-time advisory per (session, workspace); every degraded path fails
// open so a local editor is never made unavailable by coordination services.
const HOOK = fileURLToPath(new URL('../hooks/mesh-gate.sh', import.meta.url))
const LOCAL_TOKEN = 'L'.repeat(43)
const CONFLICT_BODY = JSON.stringify({
  conflict: true,
  path: 'src/app.ts',
  conflicts: [
    { person: 'Bob', kind: 'active_edit', detail: 'refactoring the routes module', ts: '2026-07-12T10:00:00Z' },
    { person: 'Carol', kind: 'locked_spec', detail: 'spec card-42 covers this path', ts: '2026-07-11T09:00:00Z' },
  ],
})

type Seen = { url: string; auth: string | undefined }
let server: Server | undefined
let seen: Seen[]
let respond: (req: IncomingMessage, res: import('node:http').ServerResponse) => void
let stateDir: string
let workspaceA: string
let workspaceB: string
let tokenFile: string

beforeEach(() => {
  seen = []
  stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-gate-state-')))
  workspaceA = join(stateDir, 'workspace-a')
  workspaceB = join(stateDir, 'workspace-b')
  tokenFile = join(stateDir, 'local-token')
  writeFileSync(tokenFile, LOCAL_TOKEN, { mode: 0o600 })
  respond = (_req, res) => {
    res.statusCode = 200
    res.end(JSON.stringify({ conflict: false, conflicts: [] }))
  }
})

afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }
  rmSync(stateDir, { recursive: true, force: true })
})

async function startProxy(): Promise<number> {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization })
    respond(req, res)
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function hookInput(filePath: string, sessionId = 'sess-1', cwd = workspaceA): string {
  return JSON.stringify({ session_id: sessionId, cwd, tool_name: 'Edit', tool_input: { file_path: filePath } })
}

function runHook(input: string, env: Record<string, string | undefined>): Promise<{ stdout: string; status: number | null; ms: number }> {
  return new Promise(resolve => {
    const start = Date.now()
    const merged: NodeJS.ProcessEnv = { ...process.env, TMPDIR: stateDir, ...env }
    for (const key of ['PRAXIS_STUDIO_URL', 'PRAXIS_LOCAL_TOKEN', 'PRAXIS_LOCAL_TOKEN_FILE']) {
      if (env[key] === undefined && !(key in env)) delete merged[key]
    }
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete merged[key]
    const child = spawn('bash', [HOOK], { env: merged })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.on('close', code => resolve({ stdout, status: code, ms: Date.now() - start }))
    child.stdin.end(input)
  })
}

const proxyEnv = (port: number) => ({
  PRAXIS_STUDIO_URL: `http://127.0.0.1:${port}`,
  PRAXIS_LOCAL_TOKEN_FILE: tokenFile,
  // Host-provided Mesh values are hostile legacy input and must be ignored.
  MESH_URL: 'https://attacker.invalid',
  MESH_TOKEN: 'hosted-secret-must-not-leave',
  MESH_PERSON: 'hosted-person',
})

describe('mesh-gate hook', () => {
  it('asks once on conflict with a bounded summary, then silently allows the retry', async () => {
    respond = (_req, res) => { res.statusCode = 200; res.end(CONFLICT_BODY) }
    const port = await startProxy()
    const input = hookInput(join(workspaceA, 'src', 'app.ts'))

    const first = await runHook(input, proxyEnv(port))
    expect(first.status).toBe(0)
    const output = JSON.parse(first.stdout).hookSpecificOutput
    expect(output.hookEventName).toBe('PreToolUse')
    expect(output.permissionDecision).toBe('ask')
    expect(output.permissionDecisionReason).toContain('src/app.ts')
    expect(output.permissionDecisionReason).toContain('Bob (active_edit): refactoring the routes module')
    expect(output.permissionDecisionReason).toContain('Carol (locked_spec)')
    expect(output.permissionDecisionReason).toMatch(/re-run/i)
    expect(output.permissionDecisionReason.length).toBeLessThan(4_000)

    const sentinels = readdirSync(join(stateDir, 'paradigm-mesh-hooks'))
    expect(sentinels).toHaveLength(1)
    expect(sentinels[0]).toMatch(/^gate-sess-1-/)

    const second = await runHook(input, proxyEnv(port))
    expect(second.status).toBe(0)
    expect(second.stdout).toBe('')
    expect(seen).toHaveLength(1)
  })

  it('sends only cwd, target path, and the local bearer token to the Praxis proxy', async () => {
    respond = (_req, res) => { res.statusCode = 200; res.end(CONFLICT_BODY) }
    const port = await startProxy()
    await runHook(hookInput(join(workspaceA, 'src', 'app.ts')), proxyEnv(port))

    expect(seen).toHaveLength(1)
    const url = new URL(seen[0].url, 'http://praxis')
    expect(url.pathname).toBe('/api/mesh/gate')
    expect(url.searchParams.get('cwd')).toBe(workspaceA)
    expect(url.searchParams.get('path')).toBe(join(workspaceA, 'src', 'app.ts'))
    expect(seen[0].auth).toBe(`Bearer ${LOCAL_TOKEN}`)
    expect(seen[0].url).not.toContain('hosted-secret')
    expect(seen[0].url).not.toContain('hosted-person')
  })

  it('keys its advisory sentinel by session and workspace', async () => {
    respond = (_req, res) => { res.statusCode = 200; res.end(CONFLICT_BODY) }
    const port = await startProxy()
    const first = await runHook(hookInput(join(workspaceA, 'a.ts')), proxyEnv(port))
    expect(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision).toBe('ask')

    const otherWorkspace = await runHook(hookInput(join(workspaceB, 'a.ts'), 'sess-1', workspaceB), proxyEnv(port))
    expect(JSON.parse(otherWorkspace.stdout).hookSpecificOutput.permissionDecision).toBe('ask')

    const otherSession = await runHook(hookInput(join(workspaceA, 'a.ts'), 'sess-2'), proxyEnv(port))
    expect(JSON.parse(otherSession.stdout).hookSpecificOutput.permissionDecision).toBe('ask')
    expect(readdirSync(join(stateDir, 'paradigm-mesh-hooks'))).toHaveLength(3)
  })

  it('allows silently after the proxy authoritatively reports no conflict', async () => {
    const port = await startProxy()
    const result = await runHook(hookInput(join(workspaceA, 'src', 'app.ts')), proxyEnv(port))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(seen).toHaveLength(1)
    expect(existsSync(join(stateDir, 'paradigm-mesh-hooks'))).toBe(true)
    expect(readdirSync(join(stateDir, 'paradigm-mesh-hooks'))).toHaveLength(0)
  })

  describe('fail-open matrix', () => {
    it('missing local token allows without a proxy query', async () => {
      const port = await startProxy()
      const result = await runHook(hookInput(join(workspaceA, 'a.ts')), {
        PRAXIS_STUDIO_URL: `http://127.0.0.1:${port}`,
        PRAXIS_LOCAL_TOKEN: undefined,
        PRAXIS_LOCAL_TOKEN_FILE: undefined,
      })
      expect(result).toMatchObject({ stdout: '', status: 0 })
      expect(seen).toHaveLength(0)
    })

    it('a short token allows without a proxy query', async () => {
      const port = await startProxy()
      const result = await runHook(hookInput(join(workspaceA, 'a.ts')), {
        PRAXIS_STUDIO_URL: `http://127.0.0.1:${port}`,
        PRAXIS_LOCAL_TOKEN: 'short',
      })
      expect(result).toMatchObject({ stdout: '', status: 0 })
      expect(seen).toHaveLength(0)
    })

    it('a symlinked token file is refused', async () => {
      const port = await startProxy()
      const link = join(stateDir, 'token-link')
      symlinkSync(tokenFile, link)
      const result = await runHook(hookInput(join(workspaceA, 'a.ts')), {
        PRAXIS_STUDIO_URL: `http://127.0.0.1:${port}`,
        PRAXIS_LOCAL_TOKEN_FILE: link,
      })
      expect(result).toMatchObject({ stdout: '', status: 0 })
      expect(seen).toHaveLength(0)
    })

    it.each(['https://praxis.example', 'http://localhost:4319', 'http://127.0.0.1:99999'])('rejects a non-literal or invalid loopback base: %s', async base => {
      const port = await startProxy()
      const result = await runHook(hookInput(join(workspaceA, 'a.ts')), {
        PRAXIS_STUDIO_URL: base,
        PRAXIS_LOCAL_TOKEN_FILE: tokenFile,
      })
      expect(result).toMatchObject({ stdout: '', status: 0 })
      expect(seen).toHaveLength(0)
      void port
    })

    it('connection refusal allows', async () => {
      const result = await runHook(hookInput(join(workspaceA, 'a.ts')), {
        PRAXIS_STUDIO_URL: 'http://127.0.0.1:59999',
        PRAXIS_LOCAL_TOKEN_FILE: tokenFile,
      })
      expect(result).toMatchObject({ stdout: '', status: 0 })
    })

    it('a hanging proxy respects the two-second request budget', async () => {
      respond = () => { /* intentionally never answer */ }
      const port = await startProxy()
      const result = await runHook(hookInput(join(workspaceA, 'a.ts')), proxyEnv(port))
      expect(result).toMatchObject({ stdout: '', status: 0 })
      expect(result.ms).toBeLessThan(4_500)
    })

    it.each([
      ['non-JSON', 200, '<html>not json</html>'],
      ['server failure', 500, 'oops'],
    ])('%s response allows', async (_name, statusCode, body) => {
      respond = (_req, res) => { res.statusCode = statusCode; res.end(body) }
      const port = await startProxy()
      const result = await runHook(hookInput(join(workspaceA, 'a.ts')), proxyEnv(port))
      expect(result).toMatchObject({ stdout: '', status: 0 })
    })

    it.each([
      ['garbage stdin', 'this is not json {{{'],
      ['empty stdin', ''],
      ['missing file path', JSON.stringify({ session_id: 's', cwd: workspaceA, tool_input: {} })],
      ['missing cwd', JSON.stringify({ session_id: 's', tool_input: { file_path: '/a.ts' } })],
    ])('%s allows without a proxy query', async (_name, input) => {
      const port = await startProxy()
      const result = await runHook(input, proxyEnv(port))
      expect(result).toMatchObject({ stdout: '', status: 0 })
      expect(seen).toHaveLength(0)
    })
  })
})
