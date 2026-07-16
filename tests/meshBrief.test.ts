import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Exercise the mesh team-brief block of the real SessionStart hook as a
// process. Contract under test: with MESH_URL + MESH_PERSON set and the relay
// answering /brief with content, a '## Team brief (mesh)' section is APPENDED
// to the additionalContext the hook already emits; on ANY failure (no env,
// relay down/slow, non-JSON, empty brief) the output is byte-identical to the
// pre-mesh hook. The boardroom daemon probe is pointed at a dead port
// throughout so the baseline (offline wording) is deterministic.

const HOOK = fileURLToPath(new URL('../hooks/session-start.sh', import.meta.url))
const DEAD_DAEMON_PORT = 59_999
const INPUT = JSON.stringify({ session_id: 'demo-123', cwd: '/Users/me/work/demo' })

const BRIEF_BODY = JSON.stringify({
  teammates: [
    { person: 'bob', intent: 'refactor relay auth middleware', artifacts: [{ repo: 'https://github.com/acme/widgets', path: 'src/api/routes.ts' }], ts: '2026-07-12T10:00:00Z' },
    { person: 'carol', intent: 'tighten sqlite retention', artifacts: [], ts: '2026-07-12T09:30:00Z' },
  ],
  lockedSpecs: [
    { person: 'dana', cardId: 'card-42', specCriteria: [{ id: 'c1', behavior: 'gate denies once per session' }], artifacts: [{ repo: 'https://github.com/acme/widgets', path: 'hooks/mesh-gate.sh' }], ts: '2026-07-11T08:00:00Z' },
  ],
  recentDecisions: [],
})

type Seen = { url: string; auth: string | undefined }
let server: Server | undefined
let seen: Seen[] = []
afterEach(async () => {
  seen = []
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(r => server!.close(() => r()))
    server = undefined
  }
})
async function startRelay(respond: (req: IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<number> {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization })
    respond(req, res)
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

// Async spawn (NOT spawnSync): the stub relay lives in this process, so the
// event loop must stay free to answer the hook's curl while it runs.
function runHook(env: Record<string, string | undefined>): Promise<{ stdout: string; status: number | null; ms: number }> {
  return new Promise(resolve => {
    const start = Date.now()
    const merged: NodeJS.ProcessEnv = { ...process.env, BOARDROOM_PORT: String(DEAD_DAEMON_PORT), ...env }
    // Never inherit mesh config from the outer environment; tests opt in explicitly.
    for (const k of ['MESH_URL', 'MESH_PERSON', 'MESH_TOKEN']) if (env[k] === undefined) delete merged[k]
    const child = spawn('bash', [HOOK], { env: merged })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d })
    child.on('close', code => resolve({ stdout, status: code, ms: Date.now() - start }))
    child.stdin.end(INPUT)
  })
}
const ctxOf = (stdout: string) => JSON.parse(stdout).hookSpecificOutput.additionalContext as string

describe('SessionStart mesh team brief', () => {
  it('appends a Team brief section (teammates + locked specs) when the relay answers', async () => {
    const port = await startRelay((_req, res) => { res.statusCode = 200; res.end(BRIEF_BODY) })
    const baseline = await runHook({})
    const withMesh = await runHook({ MESH_URL: `http://127.0.0.1:${port}`, MESH_PERSON: 'alice', MESH_TOKEN: 'sekrit' })
    expect(withMesh.status).toBe(0)

    const ctx = ctxOf(withMesh.stdout)
    // strictly additive: everything the hook emitted before, then the brief
    expect(ctx.startsWith(ctxOf(baseline.stdout))).toBe(true)
    expect(ctx).toContain('## Team brief (mesh)')
    expect(ctx).toContain('- bob: refactor relay auth middleware — src/api/routes.ts')
    expect(ctx).toContain('- carol: tighten sqlite retention')
    expect(ctx).toContain('Locked specs')
    expect(ctx).toContain('- dana locked spec card-42 — hooks/mesh-gate.sh — criteria: gate denies once per session')
  })

  it('queries /brief with person, project=basename(cwd), cwd, and the bearer token', async () => {
    const port = await startRelay((_req, res) => { res.statusCode = 200; res.end(BRIEF_BODY) })
    await runHook({ MESH_URL: `http://127.0.0.1:${port}`, MESH_PERSON: 'alice', MESH_TOKEN: 'sekrit' })
    expect(seen).toHaveLength(1)
    const url = new URL(seen[0].url, 'http://relay')
    expect(url.pathname).toBe('/brief')
    expect(url.searchParams.get('person')).toBe('alice')
    expect(url.searchParams.get('project')).toBe('demo')
    expect(url.searchParams.get('cwd')).toBe('/Users/me/work/demo')
    expect(seen[0].auth).toBe('Bearer sekrit')
  })

  describe('fail-open matrix — output stays byte-identical to the mesh-less hook', () => {
    it('MESH_URL unset', async () => {
      const baseline = await runHook({})
      const again = await runHook({})
      expect(again.stdout).toBe(baseline.stdout) // baseline itself is deterministic
      expect(again.status).toBe(0)
    })

    it('MESH_URL set but MESH_PERSON unset → no query, untouched output', async () => {
      const port = await startRelay((_req, res) => { res.statusCode = 200; res.end(BRIEF_BODY) })
      const baseline = await runHook({})
      const { stdout, status } = await runHook({ MESH_URL: `http://127.0.0.1:${port}` })
      expect(status).toBe(0)
      expect(stdout).toBe(baseline.stdout)
      expect(seen).toHaveLength(0)
    })

    it('relay down (connection refused)', async () => {
      const baseline = await runHook({})
      const { stdout, status } = await runHook({ MESH_URL: 'http://127.0.0.1:59998', MESH_PERSON: 'alice' })
      expect(status).toBe(0)
      expect(stdout).toBe(baseline.stdout)
    })

    it('relay hangs → untouched output within the 2s curl budget', async () => {
      const port = await startRelay(() => { /* never answer */ })
      const baseline = await runHook({})
      const { stdout, status, ms } = await runHook({ MESH_URL: `http://127.0.0.1:${port}`, MESH_PERSON: 'alice' })
      expect(status).toBe(0)
      expect(stdout).toBe(baseline.stdout)
      expect(ms).toBeLessThan(5_000) // 2s brief curl + 2s dead daemon slack, not a hang
    })

    it('relay returns non-JSON garbage', async () => {
      const port = await startRelay((_req, res) => { res.statusCode = 200; res.end('<html>nope</html>') })
      const baseline = await runHook({})
      const { stdout, status } = await runHook({ MESH_URL: `http://127.0.0.1:${port}`, MESH_PERSON: 'alice' })
      expect(status).toBe(0)
      expect(stdout).toBe(baseline.stdout)
    })

    it('relay 500s', async () => {
      const port = await startRelay((_req, res) => { res.statusCode = 500; res.end('boom') })
      const baseline = await runHook({})
      const { stdout, status } = await runHook({ MESH_URL: `http://127.0.0.1:${port}`, MESH_PERSON: 'alice' })
      expect(status).toBe(0)
      expect(stdout).toBe(baseline.stdout)
    })

    it('empty brief (no teammates, no locked specs) → no empty section appended', async () => {
      const port = await startRelay((_req, res) => {
        res.statusCode = 200
        res.end(JSON.stringify({ teammates: [], lockedSpecs: [], recentDecisions: [] }))
      })
      const baseline = await runHook({})
      const { stdout, status } = await runHook({ MESH_URL: `http://127.0.0.1:${port}`, MESH_PERSON: 'alice' })
      expect(status).toBe(0)
      expect(stdout).toBe(baseline.stdout)
      expect(seen).toHaveLength(1) // it DID ask; the brief just had nothing to say
    })
  })
})
