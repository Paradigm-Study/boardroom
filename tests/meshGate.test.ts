import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Exercise the real mesh PreToolUse gate as a process. Contract under test:
// with MESH_URL + MESH_PERSON set, an Edit/Write into a git repo queries the
// relay's /gate; a conflict surfaces an advisory "ask" (never "deny") ONCE per
// (session, repo) via the same sentinel mechanism redirect-ask.sh uses; EVERY
// failure path (no env, relay down, non-git dir, weird stdin, garbage
// response) is a silent allow — empty stdout, exit 0.

const HOOK = fileURLToPath(new URL('../hooks/mesh-gate.sh', import.meta.url))

const CONFLICT_BODY = JSON.stringify({
  conflict: true,
  conflicts: [
    { person: 'bob', kind: 'active_edit', detail: 'refactoring the routes module', ts: '2026-07-12T10:00:00Z' },
    { person: 'carol', kind: 'locked_spec', detail: 'spec card-42 covers this path', ts: '2026-07-11T09:00:00Z' },
  ],
})

// --- git fixture: two temp repos with distinct remotes -----------------------
// realpathSync matters: on macOS os.tmpdir() is /var/... but git resolves the
// toplevel to /private/var/... — the hook strips the toplevel prefix, so the
// paths we feed it must be the resolved ones.
let repoA: string
let repoB: string
function makeRepo(remote: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-gate-repo-')))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'app.ts'), 'export {}\n')
  return dir
}
beforeAll(() => {
  repoA = makeRepo('git@github.com:acme/widgets.git')
  repoB = makeRepo('https://github.com/acme/gadgets.git')
})
afterAll(() => {
  rmSync(repoA, { recursive: true, force: true })
  rmSync(repoB, { recursive: true, force: true })
})

// --- stub relay + per-test sentinel dir --------------------------------------
type Seen = { url: string; auth: string | undefined }
let server: Server | undefined
let seen: Seen[]
let respond: (req: IncomingMessage, res: import('node:http').ServerResponse) => void
let stateDir: string // becomes the hook's TMPDIR → isolates sentinels per test

beforeEach(() => {
  seen = []
  stateDir = mkdtempSync(join(tmpdir(), 'mesh-gate-state-'))
  respond = (_req, res) => { res.statusCode = 200; res.end(JSON.stringify({ conflict: false, conflicts: [] })) }
})
afterEach(async () => {
  rmSync(stateDir, { recursive: true, force: true })
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(r => server!.close(() => r()))
    server = undefined
  }
})
async function startRelay(): Promise<number> {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization })
    respond(req, res)
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

function hookInput(filePath: string, sessionId = 'sess-1', cwd = repoA): string {
  return JSON.stringify({ session_id: sessionId, cwd, tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } })
}

// Async spawn (NOT spawnSync): the stub relay lives in this process, so the
// event loop must stay free to answer the hook's curl.
function runHook(input: string, env: Record<string, string | undefined>): Promise<{ stdout: string; status: number | null; ms: number }> {
  return new Promise(resolve => {
    const start = Date.now()
    const merged: NodeJS.ProcessEnv = { ...process.env, TMPDIR: stateDir, ...env }
    for (const k of ['MESH_URL', 'MESH_PERSON', 'MESH_TOKEN']) if (env[k] === undefined && !(k in env)) delete merged[k]
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k]
    const child = spawn('bash', [HOOK], { env: merged })
    let stdout = ''
    child.stdout.on('data', d => { stdout += d })
    child.on('close', code => resolve({ stdout, status: code, ms: Date.now() - start }))
    child.stdin.end(input)
  })
}
const meshEnv = (port: number) => ({ MESH_URL: `http://127.0.0.1:${port}`, MESH_PERSON: 'alice', MESH_TOKEN: 'sekrit' })

describe('mesh-gate hook', () => {
  it('asks once on conflict with the conflicts summarized, then passes (sentinel)', async () => {
    respond = (_req, res) => { res.statusCode = 200; res.end(CONFLICT_BODY) }
    const port = await startRelay()
    const input = hookInput(join(repoA, 'src', 'app.ts'))

    const first = await runHook(input, meshEnv(port))
    expect(first.status).toBe(0)
    const out = JSON.parse(first.stdout).hookSpecificOutput
    expect(out.hookEventName).toBe('PreToolUse')
    expect(out.permissionDecision).toBe('ask') // advisory: never a hard deny
    expect(out.permissionDecisionReason).toContain('src/app.ts')
    expect(out.permissionDecisionReason).toContain('bob (active_edit): refactoring the routes module')
    expect(out.permissionDecisionReason).toContain('carol (locked_spec)')
    expect(out.permissionDecisionReason).toMatch(/re-run/i) // tells the agent how to proceed

    // sentinel created under TMPDIR/boardroom-hooks, keyed mesh-<sid>-<repo slug>
    const sentinels = readdirSync(join(stateDir, 'boardroom-hooks'))
    expect(sentinels).toHaveLength(1)
    expect(sentinels[0]).toMatch(/^mesh-sess-1-/)

    // second attempt in the same session + repo: silent allow, NO second query
    const second = await runHook(input, meshEnv(port))
    expect(second.status).toBe(0)
    expect(second.stdout).toBe('')
    expect(seen).toHaveLength(1)
  })

  it('sends person, url-encoded raw remote, repo-relative path, and the bearer token', async () => {
    respond = (_req, res) => { res.statusCode = 200; res.end(CONFLICT_BODY) }
    const port = await startRelay()
    await runHook(hookInput(join(repoA, 'src', 'app.ts')), meshEnv(port))
    expect(seen).toHaveLength(1)
    const url = new URL(seen[0].url, 'http://relay')
    expect(url.pathname).toBe('/gate')
    expect(url.searchParams.get('person')).toBe('alice')
    expect(url.searchParams.get('repo')).toBe('git@github.com:acme/widgets.git') // raw remote; relay normalizes
    expect(url.searchParams.get('path')).toBe('src/app.ts')
    expect(seen[0].auth).toBe('Bearer sekrit')
  })

  it('keys the sentinel by (session, repo): a conflict in ANOTHER repo still warns', async () => {
    respond = (_req, res) => { res.statusCode = 200; res.end(CONFLICT_BODY) }
    const port = await startRelay()
    const first = await runHook(hookInput(join(repoA, 'src', 'app.ts')), meshEnv(port))
    expect(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision).toBe('ask')

    // same session, different repo → its own ask
    const other = await runHook(hookInput(join(repoB, 'src', 'app.ts'), 'sess-1', repoB), meshEnv(port))
    expect(other.status).toBe(0)
    expect(JSON.parse(other.stdout).hookSpecificOutput.permissionDecision).toBe('ask')

    // a DIFFERENT session in repoA also gets its own ask
    const otherSession = await runHook(hookInput(join(repoA, 'src', 'app.ts'), 'sess-2'), meshEnv(port))
    expect(JSON.parse(otherSession.stdout).hookSpecificOutput.permissionDecision).toBe('ask')
    expect(readdirSync(join(stateDir, 'boardroom-hooks'))).toHaveLength(3)
  })

  it('allows silently when the relay reports no conflict', async () => {
    const port = await startRelay() // default respond: conflict:false
    const { stdout, status } = await runHook(hookInput(join(repoA, 'src', 'app.ts')), meshEnv(port))
    expect(status).toBe(0)
    expect(stdout).toBe('')
    expect(seen).toHaveLength(1) // it DID consult the relay
    expect(existsSync(join(stateDir, 'boardroom-hooks', 'mesh-sess-1'))).toBe(false)
  })

  describe('fail-open matrix — every degraded mode is a silent allow (exit 0, empty stdout)', () => {
    it('MESH_URL unset → allow without any relay query', async () => {
      const port = await startRelay()
      const { stdout, status } = await runHook(hookInput(join(repoA, 'src', 'app.ts')), { MESH_URL: undefined, MESH_PERSON: 'alice' })
      expect(status).toBe(0)
      expect(stdout).toBe('')
      expect(seen).toHaveLength(0)
      void port
    })

    it('MESH_PERSON unset → allow without any relay query', async () => {
      await startRelay()
      const { stdout, status } = await runHook(hookInput(join(repoA, 'src', 'app.ts')), { MESH_URL: 'http://127.0.0.1:1', MESH_PERSON: undefined })
      expect(status).toBe(0)
      expect(stdout).toBe('')
      expect(seen).toHaveLength(0)
    })

    it('relay down (connection refused) → allow', async () => {
      const { stdout, status } = await runHook(hookInput(join(repoA, 'src', 'app.ts')), { MESH_URL: 'http://127.0.0.1:59999', MESH_PERSON: 'alice' })
      expect(status).toBe(0)
      expect(stdout).toBe('')
    })

    it('relay hangs → allow within the 1s curl budget, not a hook hang', async () => {
      respond = () => { /* never answer */ }
      const port = await startRelay()
      const { stdout, status, ms } = await runHook(hookInput(join(repoA, 'src', 'app.ts')), meshEnv(port))
      expect(status).toBe(0)
      expect(stdout).toBe('')
      expect(ms).toBeLessThan(3_500) // 1s curl + slack; NOT an unbounded wait
    })

    it('relay returns non-JSON garbage → allow', async () => {
      respond = (_req, res) => { res.statusCode = 200; res.end('<html>totally not json</html>') }
      const port = await startRelay()
      const { stdout, status } = await runHook(hookInput(join(repoA, 'src', 'app.ts')), meshEnv(port))
      expect(status).toBe(0)
      expect(stdout).toBe('')
    })

    it('relay 500s → allow', async () => {
      respond = (_req, res) => { res.statusCode = 500; res.end('oops') }
      const port = await startRelay()
      const { stdout, status } = await runHook(hookInput(join(repoA, 'src', 'app.ts')), meshEnv(port))
      expect(status).toBe(0)
      expect(stdout).toBe('')
    })

    it('file outside any git repo → allow without querying the relay', async () => {
      const plain = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-gate-plain-')))
      try {
        await startRelay()
        const { stdout, status } = await runHook(
          hookInput(join(plain, 'notes.md'), 'sess-1', plain),
          { MESH_URL: 'http://127.0.0.1:1', MESH_PERSON: 'alice', GIT_CEILING_DIRECTORIES: plain },
        )
        expect(status).toBe(0)
        expect(stdout).toBe('')
        expect(seen).toHaveLength(0)
      } finally {
        rmSync(plain, { recursive: true, force: true })
      }
    })

    it('git repo without an origin remote → allow', async () => {
      const bare = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-gate-noremote-')))
      try {
        execFileSync('git', ['init', '-q'], { cwd: bare })
        writeFileSync(join(bare, 'a.ts'), '')
        await startRelay()
        const { stdout, status } = await runHook(hookInput(join(bare, 'a.ts'), 'sess-1', bare), { MESH_URL: 'http://127.0.0.1:1', MESH_PERSON: 'alice' })
        expect(status).toBe(0)
        expect(stdout).toBe('')
        expect(seen).toHaveLength(0)
      } finally {
        rmSync(bare, { recursive: true, force: true })
      }
    })

    it.each([
      ['garbage stdin', 'this is not json at all {{{'],
      ['empty stdin', ''],
      ['JSON without tool_input.file_path', JSON.stringify({ session_id: 's', cwd: '/x', tool_name: 'Edit', tool_input: {} })],
    ])('%s → allow', async (_name, input) => {
      await startRelay()
      const { stdout, status } = await runHook(input, { MESH_URL: 'http://127.0.0.1:1', MESH_PERSON: 'alice' })
      expect(status).toBe(0)
      expect(stdout).toBe('')
      expect(seen).toHaveLength(0)
    })
  })
})
