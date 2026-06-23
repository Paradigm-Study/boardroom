# Session Capture & Safe Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture every Claude Code session running on the machine into a durable, securely-stored, collision-free registry — no processing, no remote access, no control.

**Architecture:** A new `SessionCapturer` polls Claude Code's on-disk session registry (`~/.claude/sessions/*.json`), probes liveness, and upserts one row per session (keyed by `sessionId`) into a **new** `captured_sessions` SQLite table. A new machine-identity module stamps each row with a stable `machineId` and exposes a renamable `deviceLabel`. Storage is hardened (born-locked file perms, plus locking the already-world-readable attachments). The existing hook-fed `sessions` table and the waker are left **entirely unchanged**, so the waker's "only resume sessions boardroom itself registered" trust boundary is preserved structurally (it reads a different table the capturer never writes).

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import specifiers), `better-sqlite3`, `zod` v4, Express 5, `vitest` + `supertest`. Node `fs`/`os`/`crypto`/`child_process` only — no new dependencies.

## Global Constraints

- **No new dependencies** — `package.json` deps are frozen for this patch.
- **ESM import style:** import local modules with explicit `.js` extensions (e.g. `import { Store } from './store.js'`).
- **Validate into SQLite:** every row is `zod`-parsed before insert, like `Card` in `store.ts`; a malformed row is skipped/logged, never fatal.
- **Capture ≠ process:** store registry-level facts + best-effort pointers only. No transcript/tasks parsing, no derived title/branch/plan/tokens, no status beyond `alive`/`ended`.
- **Trust boundary:** the waker, `getSession`, `recordSession`, the `sessions` table, and `POST /api/session` are NOT modified. Captured (registry) rows live in a separate table and never feed execution.
- **Data is local-only** in this patch; **`machineId` immutable, `deviceLabel` editable** (default = hostname), stored once per machine.
- **Test runner:** the project script is `npm test` (= `vitest run`). Per-file runs below use `npx vitest run <file>`; both are valid.
- Spec of record: `docs/superpowers/specs/2026-06-21-session-capture-design.md`.

---

## File Structure

- **Create** `src/shared/session.ts` — `CapturedSession` zod schema + type (mirrors `src/shared/card.ts`).
- **Create** `src/daemon/machine.ts` — machine identity: mint/load `{ machineId, deviceLabel }`, rename `deviceLabel`.
- **Create** `src/daemon/sessionCapturer.ts` — the poller/watcher.
- **Modify** `src/daemon/store.ts` — add the `captured_sessions` table + `upsertCaptured`/`getCaptured`/`listCaptured`; chmod the DB on open. (Leave `sessions`, `recordSession`, `getSession` untouched.)
- **Modify** `src/daemon/config.ts` — chmod the config dir to `0700`.
- **Modify** `src/daemon/index.ts` — `process.umask(0o077)` before anything writes.
- **Modify** `src/daemon/api.ts` — `GET /api/sessions`, `GET /api/device`, `PUT /api/device`; `ApiOptions.configDir`; lock attachment files. (Leave `POST /api/session` untouched.)
- **Modify** `src/daemon/app.ts` — load identity, start the capturer, pass `configDir`, expose `capturer` on `Daemon`.
- **Create** tests: `src/shared/session.test.ts`, `src/daemon/machine.test.ts`, `src/daemon/sessionCapturer.test.ts`; **extend** `src/daemon/store.test.ts`, `src/daemon/config.test.ts`, `src/daemon/api.test.ts`, `tests/integration.test.ts`.

**Design note (refinement from the spec).** The spec proposed a `source` column on `captured_sessions` with `getSession` filtered to `source: 'hook'`. During planning that turned out to clobber (capturer and hook both upsert one `sessionId`, flipping the column). The **two-table** approach here — old `sessions` table unchanged for the waker, new `captured_sessions` for observe-all capture — delivers the identical guarantee (waker only sees hook data) with strictly less change and no clobber. Consequences vs. the spec's §3 interface: `CapturedSession` has **no `source` field**, and **`pid` is required** (not optional) because `captured_sessions` only ever holds registry rows, which always carry `pid`.

---

### Task 1: CapturedSession schema

**Files:**
- Create: `src/shared/session.ts`
- Test: `src/shared/session.test.ts`

**Interfaces:**
- Produces: `CapturedSession` (zod schema) and `type CapturedSession`. Fields:
  `sessionId: string`, `machineId: string`, `pid: number`, `procStart?: string`, `cwd: string`,
  `project: string`, `claudeVersion?: string`, `entrypoint?: string`, `kind?: string`,
  `startedAt?: string`, `status: 'alive'|'ended'`, `capturedAt: string`, `lastSeenAt: string`,
  `transcriptPath?: string`, `tasksDir?: string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/session.test.ts
import { describe, expect, it } from 'vitest'
import { CapturedSession } from './session.js'

describe('CapturedSession', () => {
  const valid = {
    sessionId: 'abc-123', machineId: 'm-1', pid: 4242, cwd: '/Users/x/proj',
    project: 'proj', status: 'alive' as const, capturedAt: '2026-06-21T00:00:00.000Z',
    lastSeenAt: '2026-06-21T00:00:00.000Z',
  }

  it('parses a minimal valid record', () => {
    expect(CapturedSession.parse(valid)).toMatchObject({ sessionId: 'abc-123', status: 'alive' })
  })

  it('rejects a missing sessionId', () => {
    expect(CapturedSession.safeParse({ ...valid, sessionId: '' }).success).toBe(false)
  })

  it('rejects an unknown status', () => {
    expect(CapturedSession.safeParse({ ...valid, status: 'paused' }).success).toBe(false)
  })

  it('keeps optional pointers when present', () => {
    const r = CapturedSession.parse({ ...valid, transcriptPath: '/t.jsonl', tasksDir: '/td' })
    expect(r.transcriptPath).toBe('/t.jsonl')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/session.test.ts`
Expected: FAIL — cannot resolve `./session.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/session.ts
import { z } from 'zod'

// One captured Claude Code session as observed from ~/.claude/sessions/<pid>.json.
// Registry-level facts + best-effort pointers only — NOT processed content.
// pid is REQUIRED: this table only ever holds registry-observed rows (see the
// plan's Design note); the hook/waker path uses a separate table entirely.
export const CapturedSession = z.object({
  sessionId: z.string().min(1),
  machineId: z.string().min(1),
  pid: z.number().int(),
  procStart: z.string().optional(),
  cwd: z.string().min(1),
  project: z.string().min(1),
  claudeVersion: z.string().optional(),
  entrypoint: z.string().optional(),
  kind: z.string().optional(),
  startedAt: z.string().optional(),
  status: z.enum(['alive', 'ended']),
  capturedAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
  transcriptPath: z.string().optional(),
  tasksDir: z.string().optional(),
})

export type CapturedSession = z.infer<typeof CapturedSession>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/session.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/session.ts src/shared/session.test.ts
git commit -m "feat: CapturedSession schema for session capture"
```

---

### Task 2: Store — captured_sessions table

**Files:**
- Modify: `src/daemon/store.ts` (constructor adds a table; add three methods; do NOT touch `sessions`/`recordSession`/`getSession`)
- Test: `src/daemon/store.test.ts` (extend)

**Interfaces:**
- Consumes: `CapturedSession` from Task 1.
- Produces (on `Store`):
  - `upsertCaptured(session: CapturedSession): void` — validate + INSERT…ON CONFLICT(session_id) DO UPDATE; preserves the existing row's `capturedAt`.
  - `getCaptured(sessionId: string): CapturedSession | undefined`
  - `listCaptured(): CapturedSession[]` — most-recently-updated first (stable tiebreak by `session_id`); skips malformed rows.

- [ ] **Step 1: Write the failing test**

Add this import to the **top-of-file imports** of `src/daemon/store.test.ts` (beside the existing `import { Store } from './store.js'`):

```ts
import { CapturedSession } from '../shared/session.js'
```

Then append this block to `src/daemon/store.test.ts`:

```ts
describe('captured_sessions', () => {
  const make = (over: Partial<CapturedSession> = {}): CapturedSession => CapturedSession.parse({
    sessionId: 's1', machineId: 'm1', pid: 100, cwd: '/Users/x/proj', project: 'proj',
    status: 'alive', capturedAt: '2026-06-21T00:00:00.000Z', lastSeenAt: '2026-06-21T00:00:00.000Z',
    ...over,
  })

  it('upserts and reads back a captured session', () => {
    const store = new Store(':memory:')
    store.upsertCaptured(make())
    expect(store.getCaptured('s1')?.cwd).toBe('/Users/x/proj')
  })

  it('does NOT collide on same project basename (the bug being fixed)', () => {
    const store = new Store(':memory:')
    store.upsertCaptured(make({ sessionId: 's1', cwd: '/a/proj' }))
    store.upsertCaptured(make({ sessionId: 's2', cwd: '/b/proj' }))
    expect(store.listCaptured()).toHaveLength(2)
  })

  it('preserves capturedAt across upserts but updates lastSeenAt/status', () => {
    const store = new Store(':memory:')
    store.upsertCaptured(make({ capturedAt: 'T0', lastSeenAt: 'T0' }))
    store.upsertCaptured(make({ capturedAt: 'T9', lastSeenAt: 'T1', status: 'ended' }))
    const row = store.getCaptured('s1')!
    expect(row.capturedAt).toBe('T0')
    expect(row.lastSeenAt).toBe('T1')
    expect(row.status).toBe('ended')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/store.test.ts`
Expected: FAIL — `store.upsertCaptured is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/daemon/store.ts`, add the import directly beneath the existing `import { Card, ... } from '../shared/card.js'` line:

```ts
import { CapturedSession } from '../shared/session.js'
```

In the constructor, immediately after the `sessions`-table `this.db.exec(\`...\`)` (the block that ends around line 29) and before the constructor's closing `}`, add:

```ts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS captured_sessions (
        session_id TEXT PRIMARY KEY,
        json       TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
```

Add these three methods to the class:

```ts
  // Observe-all session capture (separate from the hook-fed `sessions` table the
  // waker reads — registry capture must never influence `claude --resume`).
  upsertCaptured(session: CapturedSession): void {
    const valid = CapturedSession.parse(session)
    const existing = this.getCaptured(valid.sessionId)
    const toStore: CapturedSession = existing
      ? { ...valid, capturedAt: existing.capturedAt } // first-capture time is sticky
      : valid
    this.db.prepare(
      `INSERT INTO captured_sessions (session_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    ).run(toStore.sessionId, JSON.stringify(toStore), new Date().toISOString())
  }

  getCaptured(sessionId: string): CapturedSession | undefined {
    const row = this.db.prepare('SELECT json FROM captured_sessions WHERE session_id = ?').get(sessionId) as
      | { json: string } | undefined
    if (!row) return undefined
    const parsed = CapturedSession.safeParse(JSON.parse(row.json))
    return parsed.success ? parsed.data : undefined
  }

  listCaptured(): CapturedSession[] {
    const rows = this.db.prepare(
      'SELECT json FROM captured_sessions ORDER BY updated_at DESC, session_id ASC',
    ).all() as { json: string }[]
    return rows
      .map(r => CapturedSession.safeParse(JSON.parse(r.json)))
      .filter((p): p is { success: true; data: CapturedSession } => p.success)
      .map(p => p.data)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/daemon/store.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/store.ts src/daemon/store.test.ts
git commit -m "feat: captured_sessions table + upsert/get/list"
```

---

### Task 3: Machine identity (machineId + editable nickname)

**Files:**
- Create: `src/daemon/machine.ts`
- Test: `src/daemon/machine.test.ts`

**Interfaces:**
- Produces:
  - `interface MachineIdentity { machineId: string; deviceLabel: string }`
  - `loadMachineIdentity(configDir: string): MachineIdentity` — mints+persists `machine.json` on first call (immutable `machineId` via `randomUUID()`, `deviceLabel` = hostname); reuses thereafter.
  - `setDeviceLabel(configDir: string, deviceLabel: string): MachineIdentity` — renames the nickname, keeps `machineId`.

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/machine.test.ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadMachineIdentity, setDeviceLabel } from './machine.js'

describe('machine identity', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'br-machine-')) })

  it('mints once and is stable across calls', () => {
    const a = loadMachineIdentity(dir)
    const b = loadMachineIdentity(dir)
    expect(a.machineId).toBe(b.machineId)
    expect(a.machineId.length).toBeGreaterThan(0)
  })

  it('defaults deviceLabel to a non-empty hostname', () => {
    expect(loadMachineIdentity(dir).deviceLabel.length).toBeGreaterThan(0)
  })

  it('renames deviceLabel but keeps machineId', () => {
    const before = loadMachineIdentity(dir)
    const after = setDeviceLabel(dir, 'My Desktop')
    expect(after.deviceLabel).toBe('My Desktop')
    expect(after.machineId).toBe(before.machineId)
    expect(loadMachineIdentity(dir).deviceLabel).toBe('My Desktop')
  })

  it('persists to machine.json', () => {
    const id = loadMachineIdentity(dir)
    expect(JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8')).machineId).toBe(id.machineId)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/machine.test.ts`
Expected: FAIL — cannot resolve `./machine.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/daemon/machine.ts
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

export interface MachineIdentity {
  machineId: string   // immutable
  deviceLabel: string // user-editable nickname; default = hostname
}

function path(configDir: string): string {
  return join(configDir, 'machine.json')
}

export function loadMachineIdentity(configDir: string): MachineIdentity {
  const p = path(configDir)
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<MachineIdentity>
      if (typeof raw.machineId === 'string' && raw.machineId) {
        const deviceLabel = typeof raw.deviceLabel === 'string' && raw.deviceLabel ? raw.deviceLabel : hostname()
        return { machineId: raw.machineId, deviceLabel }
      }
    } catch { /* corrupt file — fall through and re-mint */ }
  }
  const identity: MachineIdentity = { machineId: randomUUID(), deviceLabel: hostname() }
  writeFileSync(p, JSON.stringify(identity, null, 2))
  return identity
}

export function setDeviceLabel(configDir: string, deviceLabel: string): MachineIdentity {
  const current = loadMachineIdentity(configDir)
  const updated: MachineIdentity = { machineId: current.machineId, deviceLabel }
  writeFileSync(path(configDir), JSON.stringify(updated, null, 2))
  return updated
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/daemon/machine.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/machine.ts src/daemon/machine.test.ts
git commit -m "feat: machine identity (machineId + editable deviceLabel)"
```

---

### Task 4: Safe storage — file permissions

**Files:**
- Modify: `src/daemon/store.ts` (chmod the DB on open), `src/daemon/config.ts` (chmod config dir), `src/daemon/index.ts` (umask), `src/daemon/api.ts` (lock attachment dir + files)
- Test: `src/daemon/store.test.ts`, `src/daemon/config.test.ts`, `src/daemon/api.test.ts` (extend)

**Interfaces:**
- No new exports. Behavior change only: config dir `0700`, DB file `0600`, WAL/SHM born `0600` (via umask), attachment dirs `0700`, attachment + meta files `0600`.

- [ ] **Step 1: Write the failing tests**

(a) In `src/daemon/store.test.ts`, change the **line-1** import to add `statSync` (the others are already imported on lines 1–3):

```ts
import { mkdtempSync, rmSync, statSync } from 'node:fs'
```

Then append:

```ts
describe('safe storage perms', () => {
  it('locks the sqlite file to 0600 on open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'br-store-'))
    const dbPath = join(dir, 'boardroom.sqlite')
    new Store(dbPath)
    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
  })

  it('keeps the WAL sibling 0600 under the production umask', () => {
    const prev = process.umask(0o077)
    try {
      const dbPath = join(mkdtempSync(join(tmpdir(), 'br-wal-')), 'db.sqlite')
      const store = new Store(dbPath)
      store.insert(card('w1'))                 // forces -wal creation
      expect(statSync(dbPath + '-wal').mode & 0o777).toBe(0o600)
      store.close()
    } finally {
      process.umask(prev)
    }
  })

  it('boots against a DB that still has the old project-keyed sessions table', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'br-mig-')), 'db.sqlite')
    const old = new Database(dbPath)
    old.exec('CREATE TABLE sessions (project TEXT PRIMARY KEY, session_id TEXT NOT NULL, cwd TEXT NOT NULL, updated_at TEXT NOT NULL)')
    old.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run('proj', 'sid', '/cwd', 'T')
    old.close()
    const store = new Store(dbPath)   // must not throw
    store.upsertCaptured(CapturedSession.parse({
      sessionId: 'm1', machineId: 'x', pid: 1, cwd: '/c', project: 'p',
      status: 'alive', capturedAt: 'T', lastSeenAt: 'T',
    }))
    expect(store.getCaptured('m1')?.cwd).toBe('/c')
    expect(store.getSession('proj')).toEqual({ sessionId: 'sid', cwd: '/cwd' }) // old data untouched
  })
})
```

(`Database` is already imported at `store.test.ts` line 4; `card(...)` is the existing helper; `CapturedSession` was added in Task 2.)

(b) In `src/daemon/config.test.ts`, change the **line-1** import to add `statSync`:

```ts
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
```

Then append inside the `describe('loadConfig', …)` block:

```ts
  it('creates the config dir locked to 0700', () => {
    const cfgDir = join(dir, 'cfgdir')
    loadConfig(cfgDir)
    expect(statSync(cfgDir).mode & 0o777).toBe(0o700)
  })
```

(c) In `src/daemon/api.test.ts`, change the **line-2** import to add `statSync`:

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
```

Then append:

```ts
describe('attachment storage perms', () => {
  it('locks the attachment dir to 0700 and files to 0600', async () => {
    queue.submit(card('att1'), noop)
    const res = await request(app)
      .post('/api/cards/att1/attachments')
      .set('x-answer-id', 'd1')
      .set('content-type', 'application/octet-stream')
      .set('x-file-name', 'note.txt')
      .send(Buffer.from('hello'))
    expect(res.status).toBe(201)
    expect(statSync(join(dir, 'attachments', 'att1')).mode & 0o777).toBe(0o700)
    expect(statSync(res.body.path).mode & 0o777).toBe(0o600)
  })
})
```

(`card`, `noop`, `queue`, `app`, `dir`, `request` are all existing module-scoped helpers/vars in `api.test.ts`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/daemon/store.test.ts src/daemon/config.test.ts src/daemon/api.test.ts`
Expected: FAIL — modes are `0o644`/`0o755` (defaults), and `-wal` is `0o644` without the chmod/umask.

- [ ] **Step 3: Write the implementation**

`src/daemon/store.ts` — add a new import line (store.ts has no `node:fs` import today):

```ts
import { chmodSync, existsSync } from 'node:fs'
```

In the constructor, immediately after `this.db = new Database(path)`:

```ts
    // Lock the DB (and WAL/SHM siblings, if present) so other local users can't
    // read captured paths / card contents. :memory: has no file. Production also
    // sets a 0077 umask (index.ts) so lazily-created WAL/SHM are born locked.
    if (path !== ':memory:') {
      try {
        chmodSync(path, 0o600)
        for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) chmodSync(path + ext, 0o600)
      } catch { /* best-effort */ }
    }
```

`src/daemon/config.ts` — update the line-1 import to include `chmodSync`:

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
```

Immediately after the existing `mkdirSync(dir, { recursive: true })` (line 16):

```ts
  try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
```

`src/daemon/index.ts` — make `process.umask(0o077)` the **first statement after the import block** (before `const config = loadConfig()`), so the config dir and DB are created under the restrictive umask:

```ts
process.umask(0o077)
```

`src/daemon/api.ts` — add `chmodSync` to the existing `node:fs` import. Then, in the attachment POST handler, after the existing `mkdirSync(dir, { recursive: true })` line insert:

```ts
        try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
```

After the existing `writeFileSync(path, req.body)` line insert:

```ts
        try { chmodSync(path, 0o600) } catch { /* best-effort */ }
```

And for the metadata write, replace the existing one-liner
`writeFileSync(attachmentMetaPath(options.attachmentDir, card.id, id), JSON.stringify(ref, null, 2))`
with:

```ts
        const metaPath = attachmentMetaPath(options.attachmentDir, card.id, id)
        writeFileSync(metaPath, JSON.stringify(ref, null, 2))
        try { chmodSync(metaPath, 0o600) } catch { /* best-effort */ }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/daemon/store.test.ts src/daemon/config.test.ts src/daemon/api.test.ts`
Expected: PASS (new perms tests green; existing tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/store.ts src/daemon/config.ts src/daemon/index.ts src/daemon/api.ts \
  src/daemon/store.test.ts src/daemon/config.test.ts src/daemon/api.test.ts
git commit -m "feat: harden storage perms (0600 db+wal, 0700 config, locked attachments, umask)"
```

---

### Task 5: SessionCapturer

**Files:**
- Create: `src/daemon/sessionCapturer.ts`
- Test: `src/daemon/sessionCapturer.test.ts`

**Interfaces:**
- Consumes: `Store.upsertCaptured` / `Store.getCaptured` (Task 2); `CapturedSession` (Task 1).
- Produces:
  - `class SessionCapturer` with `constructor(store: Store, machineId: string, opts?: CapturerOpts)`,
    `start(): void`, `stop(): void`, `reconcile(): void`.
  - `interface CapturerOpts { claudeDir?: string; intervalMs?: number; isAlive?: (pid: number) => boolean; now?: () => string }`
    (`isAlive`/`now` injected in tests; defaults `process.kill(pid,0)` and `Date`).

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/sessionCapturer.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store.js'
import { SessionCapturer } from './sessionCapturer.js'

function fakeClaudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'br-claude-'))
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  mkdirSync(join(dir, 'projects'), { recursive: true })
  mkdirSync(join(dir, 'tasks'), { recursive: true })
  return dir
}

function writeRegistry(claudeDir: string, pid: number, body: Record<string, unknown>): void {
  writeFileSync(join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify(body))
}

describe('SessionCapturer.reconcile', () => {
  let store: Store, claudeDir: string
  beforeEach(() => { store = new Store(':memory:'); claudeDir = fakeClaudeDir() })

  const cap = (over = {}) => new SessionCapturer(store, 'm-1',
    { claudeDir, isAlive: () => true, now: () => '2026-06-21T00:00:00.000Z', ...over })

  it('captures every live session, keyed by sessionId (no project collision)', () => {
    writeRegistry(claudeDir, 100, { pid: 100, sessionId: 'sA', cwd: '/a/proj', version: '2.1.181' })
    writeRegistry(claudeDir, 101, { pid: 101, sessionId: 'sB', cwd: '/b/proj' })
    cap().reconcile()
    expect(store.listCaptured()).toHaveLength(2)
    expect(store.getCaptured('sA')).toMatchObject({ machineId: 'm-1', project: 'proj', status: 'alive', claudeVersion: '2.1.181' })
  })

  it('marks a dead pid as ended', () => {
    writeRegistry(claudeDir, 200, { pid: 200, sessionId: 'sC', cwd: '/c/proj' })
    cap({ isAlive: () => false }).reconcile()
    expect(store.getCaptured('sC')?.status).toBe('ended')
  })

  it('skips malformed/foreign files without throwing', () => {
    writeFileSync(join(claudeDir, 'sessions', '9.json'), 'not json')
    writeRegistry(claudeDir, 201, { pid: 201, sessionId: 'sD', cwd: '/d/proj' })
    expect(() => cap().reconcile()).not.toThrow()
    expect(store.listCaptured().map(s => s.sessionId)).toEqual(['sD'])
  })

  it('sets transcriptPath only when the file exists (found by sessionId glob)', () => {
    // findTranscript matches <sessionId>.jsonl under ANY slug dir, so the slug name is arbitrary.
    mkdirSync(join(claudeDir, 'projects', 'anyslug'), { recursive: true })
    writeFileSync(join(claudeDir, 'projects', 'anyslug', 'sE.jsonl'), '{}')
    writeRegistry(claudeDir, 202, { pid: 202, sessionId: 'sE', cwd: '/Users/paradigm.study/proj' })
    writeRegistry(claudeDir, 203, { pid: 203, sessionId: 'sF', cwd: '/no/transcript' })
    cap().reconcile()
    expect(store.getCaptured('sE')?.transcriptPath).toContain('sE.jsonl')
    expect(store.getCaptured('sF')?.transcriptPath).toBeUndefined()
  })

  it('is idle (no throw) when the sessions dir is absent', () => {
    expect(() => new SessionCapturer(store, 'm-1', { claudeDir: '/does/not/exist' }).reconcile()).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/sessionCapturer.test.ts`
Expected: FAIL — cannot resolve `./sessionCapturer.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/daemon/sessionCapturer.ts
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CapturedSession } from '../shared/session.js'
import type { Store } from './store.js'

export interface CapturerOpts {
  claudeDir?: string
  intervalMs?: number
  isAlive?: (pid: number) => boolean
  now?: () => string
}

// Captures EVERY Claude Code session on the machine from ~/.claude/sessions/*.json.
// The reconcile tick is authoritative; fs.watch is only a latency optimization
// (macOS FSEvents can coalesce/miss events). Liveness is process.kill(pid,0),
// side-effect-free. Writes the separate captured_sessions table only — never the
// hook-fed `sessions` table the waker reads.
export class SessionCapturer {
  private timer?: ReturnType<typeof setInterval>
  private watcher?: FSWatcher
  private readonly sessionsDir: string
  private readonly projectsDir: string
  private readonly tasksDir: string
  private readonly intervalMs: number
  private readonly isAlive: (pid: number) => boolean
  private readonly now: () => string

  constructor(private store: Store, private machineId: string, opts: CapturerOpts = {}) {
    const claudeDir = opts.claudeDir ?? join(homedir(), '.claude')
    this.sessionsDir = join(claudeDir, 'sessions')
    this.projectsDir = join(claudeDir, 'projects')
    this.tasksDir = join(claudeDir, 'tasks')
    this.intervalMs = opts.intervalMs ?? 5000
    this.isAlive = opts.isAlive ?? defaultIsAlive
    this.now = opts.now ?? (() => new Date().toISOString())
  }

  start(): void {
    this.reconcile()
    try {
      this.watcher = watch(this.sessionsDir, () => this.reconcile())
    } catch { /* dir may not exist yet; the interval still reconciles */ }
    this.timer = setInterval(() => this.reconcile(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.watcher?.close()
    this.watcher = undefined
    this.timer = undefined
  }

  reconcile(): void {
    let files: string[]
    try {
      files = readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'))
    } catch {
      return // sessions dir absent → nothing to capture
    }
    for (const file of files) {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(readFileSync(join(this.sessionsDir, file), 'utf8'))
      } catch {
        continue // malformed/foreign file — skip, never fatal
      }
      if (typeof raw.sessionId !== 'string' || typeof raw.cwd !== 'string' || typeof raw.pid !== 'number') continue
      const ts = this.now()
      const session: CapturedSession = {
        sessionId: raw.sessionId,
        machineId: this.machineId,
        pid: raw.pid,
        procStart: typeof raw.procStart === 'string' ? raw.procStart : undefined,
        cwd: raw.cwd,
        project: basename(raw.cwd),
        claudeVersion: typeof raw.version === 'string' ? raw.version : undefined,
        entrypoint: typeof raw.entrypoint === 'string' ? raw.entrypoint : undefined,
        kind: typeof raw.kind === 'string' ? raw.kind : undefined,
        startedAt: toIso(raw.startedAt),
        status: this.isAlive(raw.pid) ? 'alive' : 'ended',
        capturedAt: this.store.getCaptured(raw.sessionId)?.capturedAt ?? ts,
        lastSeenAt: ts,
        transcriptPath: this.findTranscript(raw.sessionId),
        tasksDir: this.findTasksDir(raw.sessionId),
      }
      this.store.upsertCaptured(session)
    }
  }

  // DERIVED pointer: glob ~/.claude/projects/*/<sessionId>.jsonl rather than trust
  // the lossy cwd→slug encoding. Populate only if the file actually exists.
  private findTranscript(sessionId: string): string | undefined {
    try {
      for (const slug of readdirSync(this.projectsDir)) {
        const p = join(this.projectsDir, slug, `${sessionId}.jsonl`)
        if (existsSync(p)) return p
      }
    } catch { /* projects dir absent */ }
    return undefined
  }

  private findTasksDir(sessionId: string): string | undefined {
    const p = join(this.tasksDir, sessionId)
    try { if (statSync(p).isDirectory()) return p } catch { /* none */ }
    return undefined
  }
}

function toIso(value: unknown): string | undefined {
  if (typeof value === 'number') return new Date(value).toISOString()
  if (typeof value === 'string') return value
  return undefined
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = existence/permission check only, delivers nothing
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/daemon/sessionCapturer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/sessionCapturer.ts src/daemon/sessionCapturer.test.ts
git commit -m "feat: SessionCapturer — capture all live sessions from ~/.claude"
```

---

### Task 6: Wire-up — start capturer, expose sessions + device endpoints

**Files:**
- Modify: `src/daemon/api.ts` (`ApiOptions.configDir`; `GET /api/sessions`, `GET /api/device`, `PUT /api/device`)
- Modify: `src/daemon/api.test.ts` (add `configDir` to the existing router mount; new tests)
- Modify: `src/daemon/app.ts` (load identity, start capturer, pass `configDir`, expose `capturer`)
- Modify: `tests/integration.test.ts` (capture probe + stop the daemon's capturer)

**Interfaces:**
- Consumes: `loadMachineIdentity`/`setDeviceLabel` (Task 3), `SessionCapturer` (Task 5), `Store.listCaptured` (Task 2).
- Produces: `Daemon.capturer: SessionCapturer`; routes `GET /api/sessions` → `CapturedSession[]`,
  `GET /api/device` → `MachineIdentity`, `PUT /api/device` (body `{ deviceLabel: string }`) → `MachineIdentity`.
- Note: `GET /api/sessions` returns rows carrying `machineId` (not the nickname). The nickname is fetched separately via `GET /api/device`; joining the two is a future-console concern — deliberately not done here (no processing).

- [ ] **Step 1: Write the failing tests** (`src/daemon/api.test.ts`)

First, two harness edits in `src/daemon/api.test.ts`:

1. Add to the top-of-file imports: `import { CapturedSession } from '../shared/session.js'`.
2. In `beforeEach`, change the router mount (line 35) to pass `configDir` (the per-test temp `dir` is a valid config dir):

```ts
  app.use(buildApiRouter(queue, store, { attachmentDir: join(dir, 'attachments'), configDir: dir }))
```

Then append the new tests:

```ts
describe('GET /api/sessions', () => {
  it('lists captured sessions', async () => {
    store.upsertCaptured(CapturedSession.parse({
      sessionId: 's1', machineId: 'm1', pid: 1, cwd: '/x/p', project: 'p',
      status: 'alive', capturedAt: 'T', lastSeenAt: 'T',
    }))
    const res = await request(app).get('/api/sessions').expect(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].sessionId).toBe('s1')
  })
})

describe('device identity', () => {
  it('renames the nickname and keeps machineId', async () => {
    const before = (await request(app).get('/api/device').expect(200)).body
    const res = await request(app).put('/api/device').send({ deviceLabel: 'Studio Mac' }).expect(200)
    expect(res.body.deviceLabel).toBe('Studio Mac')
    expect(res.body.machineId).toBe(before.machineId)
  })

  it('rejects an empty nickname', async () => {
    await request(app).put('/api/device').send({ deviceLabel: '  ' }).expect(400)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/daemon/api.test.ts -t "sessions"` and `-t "device"`
Expected: FAIL — routes 404 (and `tsc` would flag the missing `configDir` until Step 3).

- [ ] **Step 3: Write the implementation**

`src/daemon/api.ts`:

1. Add to the import that pulls from `./machine.js` (new line):

```ts
import { loadMachineIdentity, setDeviceLabel } from './machine.js'
```

2. Make `configDir` required on `ApiOptions`:

```ts
interface ApiOptions {
  attachmentDir: string
  configDir: string
}
```

3. Inside `buildApiRouter`, add the routes next to `GET /api/cards`:

```ts
  router.get('/api/sessions', (_req, res) => {
    try { res.json(store.listCaptured()) } catch (err) { sendError(res, err) }
  })

  router.get('/api/device', (_req, res) => {
    try { res.json(loadMachineIdentity(options.configDir)) } catch (err) { sendError(res, err) }
  })

  router.put('/api/device', (req, res) => {
    try {
      const { deviceLabel } = (req.body ?? {}) as { deviceLabel?: unknown }
      if (typeof deviceLabel !== 'string' || !deviceLabel.trim()) {
        throw new ValidationError('body must be { deviceLabel: <non-empty string> }')
      }
      res.json(setDeviceLabel(options.configDir, deviceLabel.trim()))
    } catch (err) { sendError(res, err) }
  })
```

(`ValidationError` and `sendError` are already imported/defined in `api.ts`; `express.json` is already mounted in both `app.ts` and the `api.test.ts` harness, so `req.body` is populated.)

`src/daemon/app.ts`:

1. Add imports:

```ts
import { loadMachineIdentity } from './machine.js'
import { SessionCapturer } from './sessionCapturer.js'
```

2. Extend the `Daemon` interface with `capturer: SessionCapturer`.

3. In `createDaemon`, after `const queue = new Queue(store)`:

```ts
  const machine = loadMachineIdentity(config.configDir)
  const capturer = new SessionCapturer(store, machine.machineId)
  capturer.start()
```

4. Change the API router mount to pass `configDir`:

```ts
  app.use(buildApiRouter(queue, store, {
    attachmentDir: join(config.configDir, 'attachments'),
    configDir: config.configDir,
  }))
```

5. Change the return to include `capturer`:

```ts
  return { app, queue, store, capturer, orphanedOnBoot }
```

- [ ] **Step 4: Write the integration test** (`tests/integration.test.ts`)

1. Extend the `node:fs` import to add `mkdirSync, writeFileSync`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
```

2. Add the capturer import:

```ts
import { SessionCapturer } from '../src/daemon/sessionCapturer.js'
```

3. In `afterAll`, stop the daemon's capturer (it owns an interval + fs.watch) — add as the first line of the existing `afterAll`:

```ts
  daemon.capturer.stop()
```

4. Append the test (uses the shared daemon's store + a probe capturer pointed at a temp dir — no second daemon):

```ts
describe('session capture', () => {
  it('captures a session dropped into a watched ~/.claude/sessions dir', () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'br-claude-int-'))
    mkdirSync(join(claudeDir, 'sessions'), { recursive: true })
    writeFileSync(join(claudeDir, 'sessions', '4242.json'),
      JSON.stringify({ pid: 4242, sessionId: 'int-1', cwd: '/tmp/proj', version: '2.1.181' }))
    const probe = new SessionCapturer(daemon.store, 'm-int', { claudeDir, isAlive: () => true })
    probe.reconcile()
    probe.stop()
    expect(daemon.store.listCaptured().map(s => s.sessionId)).toContain('int-1')
  })
})
```

- [ ] **Step 5: Run the full suite + typecheck + lint**

Run: `npm test && npx tsc --noEmit && npx eslint .`
Expected: PASS — all tests (including new capture/device/integration tests), no type errors, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/app.ts src/daemon/api.ts src/daemon/api.test.ts tests/integration.test.ts
git commit -m "feat: start SessionCapturer + GET /api/sessions, GET/PUT /api/device"
```

---

## Notes for the implementer

- **Eyeball it (optional):** `npm run dev`, then `curl -s http://127.0.0.1:4040/api/sessions | jq` lists your real live Claude Code sessions; `curl -s http://127.0.0.1:4040/api/device | jq` shows the machine identity; `curl -X PUT http://127.0.0.1:4040/api/device -H 'content-type: application/json' -d '{"deviceLabel":"My Mac"}'` renames it.
- **Do NOT** modify `waker.ts`, `getSession`, `recordSession`, the `sessions` table, or `POST /api/session` — the waker's hook-only trust boundary depends on them being untouched.
- **No UI** in this patch — `GET /api/sessions` exists for the next (remote console) patch to consume.
- **The default capturer** started by `createDaemon` scans the real `~/.claude` and owns a 5s interval + an `fs.watch`. Any test (or shutdown) that builds a daemon must call `daemon.capturer.stop()` to avoid a leaked handle (the integration `afterAll` does this).
