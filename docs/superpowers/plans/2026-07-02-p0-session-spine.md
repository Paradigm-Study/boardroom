# P0 Session Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sessions first-class: one Claude Code session = one boardroom session; every card is bound to its owning CC session; reattach/waker/dashboard route by that binding instead of fingerprint/cwd/pending[0].

**Architecture:** A durable `claudeSessionId` (the CC session id, already delivered to the daemon by the SessionStart hook) becomes the spine key. It reaches tool calls through a new optional `sessionKey` input field the agent echoes (injected into its context by the hook), cached per MCP connection (`ctx.sessionId` is the per-connection correlation handle only — it churns on daemon restarts and waker respawns). Cards gain an optional `claudeSessionId`; reattach becomes session-scoped; the waker resumes the exact session via a new session-id-keyed registry table; the web groups by real session id.

**Tech Stack:** TypeScript ^6 strict NodeNext (`.js` import specifiers), zod ^4, @modelcontextprotocol/{server,node,client} 2.0.0-alpha.2, better-sqlite3 ^12, express ^5, react ^19, vitest ^4 (TZ=UTC), playwright 1.61.1 (hermetic, `BOARDROOM_PROXY_TARGET` dead port).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-02-report-surface-design.md` — this plan implements **P0 only** (criterion 3: "with 2+ concurrent sessions in one cwd, each card displays its true origin and decisions/replies route to the correct session").
- **Vocabulary (fixed, use everywhere):** `claudeSessionId` = the durable Claude Code session id (spine key). `mcpSessionId` = daemon-minted per-connection transport id (`ctx.sessionId`) — correlation handle ONLY, never persisted as identity. `sessionKey` = the agent-facing tool-input field whose value is the claudeSessionId. Note the existing minefield: `sessions_v2.session_id` and `captured_sessions.session_id` already hold claudeSessionIds; `sessions_v2.claude_session_id` is a reserved, never-populated duplicate — do not confuse them.
- `Card.claudeSessionId` MUST be optional in the Zod schema: `Store.parseRow` silently drops rows failing `Card.safeParse` (src/daemon/store.ts:149-162), so a required field vanishes every pre-migration card.
- The waker must NEVER read `captured_sessions` (observe-only trust boundary, comment at src/daemon/store.ts:210-211); resume targets come from hook-registered tables only.
- Characterization suites pin today's BUGGY behavior with `[BUG]` tags and MUST be flipped, not appended to: `src/daemon/queue.cross-session.test.ts`, `src/harness/claude-code/waker.cross-session.test.ts`, `web/src/App.cross-session.test.tsx`.
- Agent-facing recovery texts hardcode the fingerprint protocol ("re-issue … identical project + headline") in `PARKED_TEXT`, the tool `DESCRIPTIONS` (src/daemon/mcp.ts), and both hook heredocs — they must be rewritten in the same tasks that change the mechanics, or agents will follow a dead protocol.
- Commit directly to `main` (repo convention), one commit per task, message prefix per task.
- **Deliberate deferrals (not gaps):** stage/event tags and report entries are BOTH non-card stream entries — they share an entry abstraction and ship together in the P1 plan, not here. Root auto-open of the newest blocker (`pending[0]` at App.tsx:208-213) is KEPT: it is inbox-as-filter attention routing, not session resolution — what the spec deletes is `pending[0]`-style *session* mis-resolution, which dies with Tasks 6/8/12.
- Commands: `npm test` (vitest), `npm run typecheck` (tsc --noEmit), `npm run lint` (eslint .), `npm run test:e2e` (playwright), `npm run build:web` (vite build web). Deploy: `npm run build:web && launchctl kickstart -k gui/$(id -u)/com.boardroom.daemon` (daemon is tsx LaunchAgent, no hot reload; every restart orphans in-flight gates as `boot` — that is expected, not a bug).

---

### Task 1: Header spike — does Claude Code identify its session on MCP HTTP calls?

Evidence-only, timeboxed to 15 minutes. The design below assumes NO such header exists (hook-echo channel). If this spike finds one, do NOT redesign — finish the plan as written and note the header in `resolveClaudeSessionId`'s doc comment as a future simplification. This task produces no committed code.

**Files:**
- Modify (temporarily, then revert): `src/daemon/mcp.ts:117-124`

**Interfaces:** none (throwaway diagnostic).

- [ ] **Step 1: Add a temporary header log inside makeHangingHandler**

In `src/daemon/mcp.ts`, directly after `const agent = server.server.getClientVersion()?.name ?? 'unknown'` (line ~123), insert:

```ts
    console.warn('[spike] mcp headers:', JSON.stringify([...(ctx.http?.req?.headers ?? [])]))
    console.warn('[spike] mcpSessionId:', ctx.sessionId)
```

- [ ] **Step 2: Redeploy the daemon and trigger one live call**

Run: `launchctl kickstart -k gui/$(id -u)/com.boardroom.daemon`
Then, from any live Claude Code session with boardroom connected, make any boardroom call (or ask the human operator to). Find the daemon log path via: `plutil -p ~/Library/LaunchAgents/com.boardroom.daemon.plist | grep -i path`
Then: `grep '\[spike\]' <StandardOutPath/StandardErrorPath from plist>`

- [ ] **Step 3: Record the outcome and revert**

Record the full header list in the execution notes (PR/commit description of Task 2). Revert the edit:

```bash
git checkout -- src/daemon/mcp.ts
```

Expected: headers include standard fetch/MCP headers (`mcp-session-id`, `content-type`, …). Decision rule: only a header whose VALUE equals the live CC session id (verify against `~/.claude/sessions/*.json`) counts as positive.

---

### Task 2: `Card.claudeSessionId` (shared schema)

**Files:**
- Modify: `src/shared/card.ts:124-164`
- Test: `src/shared/card.test.ts` (create if absent; vitest picks up `src/**/*.test.ts`)

**Interfaces:**
- Produces: `Card.claudeSessionId?: string` — optional field on the `Card` zod object, available to every consumer of `Card`.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/card.test.ts
import { describe, expect, it } from 'vitest'
import { Card } from './card.js'

const base = {
  id: 'c1',
  stage: 'clarify',
  session: { agent: 'claude-code', project: 'demo' },
  headline: 'h',
  blocks: [],
  decisions: [
    { id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  ],
  status: 'pending',
  createdAt: '2026-07-02T00:00:00.000Z',
}

describe('Card.claudeSessionId', () => {
  it('parses a legacy card WITHOUT claudeSessionId (pre-migration rows must not vanish)', () => {
    const parsed = Card.safeParse(base)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.claudeSessionId).toBeUndefined()
  })

  it('round-trips a card WITH claudeSessionId', () => {
    const parsed = Card.parse({ ...base, claudeSessionId: 'cc-session-1' })
    expect(parsed.claudeSessionId).toBe('cc-session-1')
    expect(Card.parse(JSON.parse(JSON.stringify(parsed))).claudeSessionId).toBe('cc-session-1')
  })

  it('rejects an empty-string claudeSessionId', () => {
    expect(Card.safeParse({ ...base, claudeSessionId: '' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/card.test.ts`
Expected: FAIL — "rejects an empty-string claudeSessionId" fails (unknown key is stripped today, so empty string passes silently).

- [ ] **Step 3: Add the field**

In `src/shared/card.ts`, inside the `Card` z.object (after `session: SessionInfo,`):

```ts
  // Durable Claude Code session id that owns this card (the session spine key).
  // OPTIONAL: pre-spine rows lack it, and Store.parseRow drops schema failures.
  claudeSessionId: z.string().min(1).optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/card.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Full suite + commit**

```bash
npm test && npm run typecheck
git add src/shared/card.ts src/shared/card.test.ts
git commit -m "feat(spine): Card.claudeSessionId — optional durable session binding on cards"
```

---

### Task 3: `sessionKey` tool input (shared inputs)

**Files:**
- Modify: `src/shared/inputs.ts:7-10`
- Test: `src/shared/inputs.sessionKey.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: every tool input schema (`ClarifyInput`, `PresentPlanInput`, `SpecInput`, `ReviewResultsInput` — all spread `sessionFields`) accepts `sessionKey?: string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/inputs.sessionKey.test.ts
import { describe, expect, it } from 'vitest'
import { ClarifyInput } from './inputs.js'
import { z } from 'zod'

const minimal = {
  project: 'demo',
  headline: 'h',
  blocks: [
    { id: 'g', type: 'markdown', text: 'global' },
    { id: 'l', type: 'markdown', text: 'local' },
  ],
  decisions: [
    { id: 'd1', prompt: 'p', blockRefs: ['l'], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  ],
}

describe('sessionKey input field', () => {
  it('accepts a clarify input WITHOUT sessionKey (backwards compatible)', () => {
    expect(z.object(ClarifyInput).safeParse(minimal).success).toBe(true)
  })
  it('accepts and preserves sessionKey', () => {
    const parsed = z.object(ClarifyInput).parse({ ...minimal, sessionKey: 'cc-session-1' })
    expect(parsed.sessionKey).toBe('cc-session-1')
  })
  it('rejects an empty sessionKey', () => {
    expect(z.object(ClarifyInput).safeParse({ ...minimal, sessionKey: '' }).success).toBe(false)
  })
})
```

Note: if `ClarifyInput` is exported as a ZodObject already (not a raw shape), replace `z.object(ClarifyInput)` with `ClarifyInput` directly — check the export at the top of `src/shared/inputs.ts` and match the existing test convention in `src/shared/inputs.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/inputs.sessionKey.test.ts`
Expected: FAIL — sessionKey stripped/unknown (second and third tests fail).

- [ ] **Step 3: Add the field to sessionFields**

In `src/shared/inputs.ts:7-10`:

```ts
const sessionFields = {
  project: z.string().min(1).describe('Project name or working directory — shown in the inbox'),
  title: z.string().optional().describe('Short human-readable session title'),
  sessionKey: z.string().min(1).optional().describe(
    'Your boardroom session key, injected into your context at session start ("Boardroom session key: …"). ' +
    'Pass it on EVERY boardroom call — it binds this card to your session so decisions route back to you and ' +
    'reattach/recovery works across daemon restarts. Omit only if no key was injected.',
  ),
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/inputs.sessionKey.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Full suite + commit**

```bash
npm test && npm run typecheck
git add src/shared/inputs.ts src/shared/inputs.sessionKey.test.ts
git commit -m "feat(spine): optional sessionKey field on all gate tool inputs"
```

---

### Task 4: Thread the binding through compile

**Files:**
- Modify: `src/daemon/compile.ts:12-14, 26-39, 52, 88, 147` (the four `compileX` signatures + the `session()` helper call sites)
- Test: `src/daemon/compile.spine.test.ts` (create)

**Interfaces:**
- Consumes: `Card.claudeSessionId` (Task 2), `input.sessionKey` (Task 3).
- Produces: `type CompileMeta = { agent: string; claudeSessionId?: string }` (exported from `src/daemon/compile.ts`); all four compile signatures become `compileClarify(input: ClarifyInput, meta: CompileMeta): Card` (same for Plan/Spec/Results). Cards carry `claudeSessionId: meta.claudeSessionId`.

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/compile.spine.test.ts
import { describe, expect, it } from 'vitest'
import { compileClarify, compilePlan, compileSpec, compileResults } from './compile.js'

const clarifyInput = {
  project: 'demo',
  headline: 'h',
  blocks: [
    { id: 'g', type: 'markdown' as const, text: 'global' },
    { id: 'l', type: 'markdown' as const, text: 'local' },
  ],
  decisions: [
    { id: 'd1', prompt: 'p', blockRefs: ['l'], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  ],
}

describe('compile threads claudeSessionId onto cards', () => {
  it('clarify card carries meta.claudeSessionId', () => {
    const card = compileClarify(clarifyInput as never, { agent: 'claude-code', claudeSessionId: 'cc-1' })
    expect(card.claudeSessionId).toBe('cc-1')
    expect(card.session.agent).toBe('claude-code')
  })
  it('card omits claudeSessionId when meta has none (legacy caller)', () => {
    const card = compileClarify(clarifyInput as never, { agent: 'claude-code' })
    expect(card.claudeSessionId).toBeUndefined()
  })
})
```

(Use the existing input fixtures from `src/daemon/compile.test.ts` for plan/spec/results if that file has them — mirror one assertion per stage; the two clarify assertions above are the required minimum.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/compile.spine.test.ts`
Expected: FAIL — compile signature is `(input, agent: string)`; TypeScript error TS2345 at test compile time.

- [ ] **Step 3: Widen the signatures**

In `src/daemon/compile.ts`:

```ts
export interface CompileMeta {
  agent: string
  claudeSessionId?: string
}
```

Change each of the four functions from `(input: XInput, agent: string): Card` to `(input: XInput, meta: CompileMeta): Card`, replace internal uses of `agent` with `meta.agent`, and add to each returned card object literal (after `session: session(input, meta.agent),`):

```ts
    ...(meta.claudeSessionId ? { claudeSessionId: meta.claudeSessionId } : {}),
```

Example for `compileClarify` (pattern identical in the other three):

```ts
export function compileClarify(input: ClarifyInput, meta: CompileMeta): Card {
  return {
    id: randomUUID(),
    stage: 'clarify',
    session: session(input, meta.agent),
    ...(meta.claudeSessionId ? { claudeSessionId: meta.claudeSessionId } : {}),
    headline: input.headline,
    blocks: input.blocks,
    decisions: input.decisions,
    status: 'pending',
    createdAt: now(),
    fingerprint: fingerprint(input.project, 'clarify', input.headline),
  }
}
```

Fix every compile call site the typecheck now flags — `src/daemon/mcp.ts` (`makeHangingHandler`'s `compile(input, agent)` becomes `compile(input, { agent })` for now; Task 5 supplies the real claudeSessionId) and any test callers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/daemon/compile.spine.test.ts && npm run typecheck`
Expected: PASS; zero type errors.

- [ ] **Step 5: Full suite + commit**

```bash
npm test
git add src/daemon/compile.ts src/daemon/compile.spine.test.ts src/daemon/mcp.ts
git commit -m "feat(spine): CompileMeta threads claudeSessionId into every compiled card"
```

---

### Task 5: MCP resolution chain + per-connection binding cache + agent-facing text updates

**Files:**
- Modify: `src/daemon/mcp.ts` (`makeHangingHandler` ~117-206, `PARKED_TEXT` 32-33, `DESCRIPTIONS` — the tool description constants in the same file, transport wiring ~302-342)
- Test: `src/daemon/mcp.spine.test.ts` (create; follow the in-process daemon + `StreamableHTTPClientTransport` pattern of `src/daemon/mcp.test.ts:14-111`)

**Interfaces:**
- Consumes: `CompileMeta` (Task 4), `ctx.sessionId` (v2-alpha SDK `ServerContext`, verified present).
- Produces: `resolveClaudeSessionId(ctx: ServerContext, input: { sessionKey?: string }, bindings: Map<string, string>): string | undefined` — exported for tests. Resolution order: (1) `input.sessionKey`; (2) `bindings.get(ctx.sessionId)` (set whenever (1) is present). No cwd/header fallback (header seam documented from Task 1's evidence).

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/mcp.spine.test.ts — same harness as mcp.test.ts: createDaemon({..., port: 0}),
// Client + StreamableHTTPClientTransport, pollPendingCard via GET /api/cards?status=pending.
// Three tests:
import { describe, expect, it } from 'vitest'
import { resolveClaudeSessionId } from './mcp.js'

describe('resolveClaudeSessionId', () => {
  it('prefers explicit input.sessionKey and records the binding', () => {
    const bindings = new Map<string, string>()
    const got = resolveClaudeSessionId({ sessionId: 'mcp-1' } as never, { sessionKey: 'cc-1' }, bindings)
    expect(got).toBe('cc-1')
    expect(bindings.get('mcp-1')).toBe('cc-1')
  })
  it('falls back to the connection binding when sessionKey omitted', () => {
    const bindings = new Map([['mcp-1', 'cc-1']])
    expect(resolveClaudeSessionId({ sessionId: 'mcp-1' } as never, {}, bindings)).toBe('cc-1')
  })
  it('returns undefined with no key and no binding (legacy caller)', () => {
    expect(resolveClaudeSessionId({ sessionId: 'mcp-2' } as never, {}, new Map())).toBeUndefined()
  })
})
```

Plus one end-to-end test in the same file using the `mcp.test.ts` harness: call `clarify` with `sessionKey: 'cc-e2e'` → poll the pending card via `/api/cards?status=pending` → `expect(card.claudeSessionId).toBe('cc-e2e')`; then (same MCP client/transport) call `clarify` again WITHOUT `sessionKey` and a different headline → second pending card also has `claudeSessionId === 'cc-e2e'` (binding inheritance). Decide the first card via POST `/api/cards/:id/decide` before issuing the second call so the first tool call returns (copy the exact decide-body shape from `mcp.test.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/mcp.spine.test.ts`
Expected: FAIL — `resolveClaudeSessionId` is not exported.

- [ ] **Step 3: Implement resolution + binding**

In `src/daemon/mcp.ts`:

```ts
// Durable-identity resolution for a tool call. The mcpSessionId (ctx.sessionId)
// is daemon-minted and per-connection — it churns on daemon restart and on every
// waker respawn — so it is ONLY the cache key, never the identity itself.
// Task-1 spike evidence (2026-07-02): Claude Code sends no session-identifying
// header on MCP HTTP calls, so the agent-echoed sessionKey is the sole channel.
// If a future CC version adds one, check it here between (1) and (2).
export function resolveClaudeSessionId(
  ctx: { sessionId?: string },
  input: { sessionKey?: string },
  bindings: Map<string, string>,
): string | undefined {
  if (input.sessionKey) {
    if (ctx.sessionId) bindings.set(ctx.sessionId, input.sessionKey)
    return input.sessionKey
  }
  return ctx.sessionId ? bindings.get(ctx.sessionId) : undefined
}
```

Module-level in the router setup (next to `const transports = new Map(...)`): `const sessionBindings = new Map<string, string>()`. In the transport `onclose` handler (which already deletes from `transports`), also `sessionBindings.delete(fresh.sessionId)`. In `makeHangingHandler`, replace the Task-4 stopgap:

```ts
    const agent = server.server.getClientVersion()?.name ?? 'unknown'
    const claudeSessionId = resolveClaudeSessionId(ctx, input as { sessionKey?: string }, sessionBindings)
    const card = compile(input, { agent, claudeSessionId })
```

(`makeHangingHandler` needs access to `sessionBindings` — pass it as a parameter from `buildServer`, which receives it from the router scope; widen `buildServer(queue: Queue)` to `buildServer(queue: Queue, sessionBindings: Map<string, string>)`.)

- [ ] **Step 4: Update PARKED_TEXT and DESCRIPTIONS in the same file**

Replace in `PARKED_TEXT`: `re-issue this EXACT same call (identical project + headline)` → `re-issue this EXACT same call (identical sessionKey, project and headline)`. In each of the four `DESCRIPTIONS` entries, update every occurrence of the reattach instruction (`identical project + headline` or equivalent wording) the same way, and append one sentence to each description: `Always pass your sessionKey (injected at session start) — it binds the card to your session.`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/daemon/mcp.spine.test.ts && npm test && npm run typecheck`
Expected: PASS. (Existing `mcp.test.ts` tests still pass — no-sessionKey calls behave exactly as before.)

- [ ] **Step 6: Commit**

```bash
git add src/daemon/mcp.ts src/daemon/mcp.spine.test.ts
git commit -m "feat(spine): resolve claudeSessionId per call — sessionKey echo + per-connection binding cache"
```

---

### Task 6: Session-scoped reattach

**Files:**
- Modify: `src/daemon/store.ts:200-208` (`findReattachable`), `src/daemon/queue.ts:48-78` (`submit` call site)
- Test: REWRITE `src/daemon/queue.cross-session.test.ts` (flip `[BUG]` assertions), extend `src/daemon/queue.test.ts` only if its factories need the new field

**Interfaces:**
- Consumes: `Card.claudeSessionId` (Task 2).
- Produces: `Store.findReattachable(card: Pick<Card, 'fingerprint' | 'claudeSessionId'>, nowMs: number, windowMs?: number): Card | undefined` — matching rules below. `Queue.submit` unchanged in signature.

**Matching rules (the heart of criterion 3):**
1. Caller card HAS `claudeSessionId` S → candidates are cards with `claudeSessionId === S` AND same `fingerprint`. Legacy cards (no `claudeSessionId`) are NOT candidates — a bound caller never claims an unbound card.
2. Caller card has NO `claudeSessionId` → candidates are cards with NO `claudeSessionId` AND same `fingerprint` (exact legacy behavior, preserved for un-hooked agents).
3. Same eligibility window logic as today (decided-undelivered from decidedAt / orphaned from orphanedAt; most recent wins).

- [ ] **Step 1: Rewrite the failing characterization tests**

In `src/daemon/queue.cross-session.test.ts`: every test tagged `[BUG]` asserts a cross-session steal succeeds; flip each to assert the steal now FAILS (fresh card inserted instead of reattach). Rename tags `[BUG]` → `[FIXED]`. Keep `[CORRECT]` tests as-is but update the `card()` factory to accept `claudeSessionId`:

```ts
// factory change (top of file): give cards distinct session bindings
const card = (id: string, claudeSessionId?: string, fingerprint = 'fp-shared'): Card => ({
  /* existing stub fields exactly as the current factory builds them */
  ...(claudeSessionId ? { claudeSessionId } : {}),
  fingerprint,
} as Card)
```

Core new assertions (adapt each existing steal scenario to this shape):

```ts
it('[FIXED] session B re-issuing the same headline does NOT claim session A\'s decided card', () => {
  const a = card('a1', 'cc-A')
  queue.submit(a, waiterA)
  queue.decide('a1', answers)          // A's human decision, undelivered (waiterA already resolved — use the orphan path: park a1 first, then decide, exactly as the current [BUG] test stages it)
  const b = card('b1', 'cc-B')          // same fingerprint, different session
  const res = queue.submit(b, waiterB)
  expect(res.cardId).toBe('b1')         // fresh card — no steal
})

it('[FIXED] the SAME session reattaches across a reconnect', () => {
  const a = card('a1', 'cc-A')
  queue.submit(a, waiterA)
  queue.park('a1', gen)                // simulate PARKED
  queue.decide('a1', answers)
  const retry = card('a2', 'cc-A')     // same session + fingerprint, new call
  const res = queue.submit(retry, waiterRetry)
  expect(res.cardId).toBe('a1')        // reattached, answers delivered
})

it('legacy: unbound caller still reattaches to unbound card (pre-spine agents)', () => { /* today's [CORRECT] path, unchanged */ })

it('[FIXED] unbound caller does NOT claim a bound card, and vice versa', () => { /* both directions return fresh cardId */ })
```

Copy the exact staging (park→decide sequencing, waiter fixtures, gen handling) from the current test file — only the expectations flip.

- [ ] **Step 2: Run to verify the flipped tests fail**

Run: `npx vitest run src/daemon/queue.cross-session.test.ts`
Expected: FAIL — steals still succeed under fingerprint-only matching.

- [ ] **Step 3: Implement the scoped lookup**

Replace `Store.findReattachable` (src/daemon/store.ts:200-208):

```ts
  findReattachable(
    caller: Pick<Card, 'fingerprint' | 'claudeSessionId'>,
    nowMs: number,
    windowMs = REATTACH_WINDOW_MS,
  ): Card | undefined {
    if (!caller.fingerprint) return undefined
    // Session-scoped: a bound caller only ever reclaims its own session's cards;
    // an unbound (legacy) caller only ever reclaims unbound cards. Cross-scope
    // claims are the fingerprint-collision steal this replaces.
    const matches = this.list().filter(c =>
      c.fingerprint === caller.fingerprint &&
      (caller.claudeSessionId ? c.claudeSessionId === caller.claudeSessionId : c.claudeSessionId === undefined),
    )
    const eligible = matches.filter(c =>
      (c.status === 'decided' && !c.deliveredAt && nowMs - Date.parse(c.decidedAt ?? c.createdAt) < windowMs) ||
      (c.status === 'orphaned' && nowMs - Date.parse(c.orphanedAt ?? c.createdAt) < windowMs),
    )
    return eligible.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  }
```

In `Queue.submit` (src/daemon/queue.ts:48), change the call:

```ts
    const existing = this.store.findReattachable(card, this.now(), this.reattachWindowMs)
```

Fix any other `findReattachable` callers the typecheck flags (tests pass a card object now, not a string).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/daemon/queue.cross-session.test.ts src/daemon/queue.test.ts && npm run typecheck`
Expected: PASS — steals blocked, same-session reattach works, legacy path intact.

- [ ] **Step 5: Full suite + commit**

```bash
npm test
git add src/daemon/store.ts src/daemon/queue.ts src/daemon/queue.cross-session.test.ts
git commit -m "fix(spine): session-scoped reattach — fingerprint collisions can no longer steal cross-session decisions"
```

---

### Task 7: Session-id-keyed registry (`sessions_v3`)

**Files:**
- Modify: `src/daemon/store.ts:34-130` (DDL + `recordSession` + new getter)
- Test: `src/daemon/store.sessions.test.ts` (create; temp-dir + Store pattern from `src/daemon/queue.test.ts:1-83`)

**Interfaces:**
- Consumes: nothing new (hook already POSTs `{sessionId, cwd, project}` = the claudeSessionId).
- Produces: `Store.getRegisteredSession(claudeSessionId: string): { sessionId: string; cwd: string; project: string } | undefined` reading a new `sessions_v3` table keyed by `session_id` (so concurrent sessions in ONE cwd each keep a row — the `ON CONFLICT(cwd)` overwrite in `sessions_v2` is exactly the steal bug). `recordSession` gains a third write (v3), same transaction.

- [ ] **Step 1: Write the failing test**

```ts
// src/daemon/store.sessions.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store.js'

let dir: string
let store: Store
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-store-'))
  store = new Store(join(dir, 'test.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('sessions_v3 — session-id-keyed registry', () => {
  it('two sessions in the SAME cwd both stay resolvable (the v2 overwrite bug, fixed)', () => {
    store.recordSession('demo', 'cc-A', '/tmp/demo')
    store.recordSession('demo', 'cc-B', '/tmp/demo')  // same cwd — v2 overwrites, v3 must not
    expect(store.getRegisteredSession('cc-A')).toEqual({ sessionId: 'cc-A', cwd: '/tmp/demo', project: 'demo' })
    expect(store.getRegisteredSession('cc-B')).toEqual({ sessionId: 'cc-B', cwd: '/tmp/demo', project: 'demo' })
  })
  it('re-registering the same session updates its row (resume re-fires the hook)', () => {
    store.recordSession('demo', 'cc-A', '/tmp/demo')
    store.recordSession('demo', 'cc-A', '/tmp/demo2')
    expect(store.getRegisteredSession('cc-A')?.cwd).toBe('/tmp/demo2')
  })
  it('unknown id → undefined', () => {
    expect(store.getRegisteredSession('nope')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/store.sessions.test.ts`
Expected: FAIL — `getRegisteredSession` does not exist.

- [ ] **Step 3: Implement DDL + writes + getter**

In the Store constructor, after the `sessions_v2` backfill block (src/daemon/store.ts:68):

```ts
    // Session-id-keyed registry (the session spine). Unlike sessions_v2 (cwd PK,
    // where a re-launch in the same cwd overwrites the previous session's row —
    // the cross-session steal), one row PER SESSION survives concurrent and
    // sequential sessions sharing a cwd. The waker resolves resume targets here
    // by the card's claudeSessionId.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_v3 (
        session_id TEXT PRIMARY KEY,
        cwd        TEXT NOT NULL,
        project    TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    this.db.exec(`
      INSERT INTO sessions_v3 (session_id, cwd, project, updated_at)
      SELECT session_id, cwd, project, updated_at FROM sessions_v2 WHERE true
      ON CONFLICT(session_id) DO NOTHING
    `)
```

In `recordSession`, inside the existing transaction (after the v2 write):

```ts
      this.db.prepare(
        `INSERT INTO sessions_v3 (session_id, cwd, project, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET cwd = excluded.cwd, project = excluded.project, updated_at = excluded.updated_at`,
      ).run(sessionId, cwd, project, ts)
```

New method next to `getSessionById` (src/daemon/store.ts:118):

```ts
  // Exact spine lookup: the card carries claudeSessionId, this returns where to
  // `claude --resume` it. No ambiguity possible — session_id is the PK.
  getRegisteredSession(claudeSessionId: string): { sessionId: string; cwd: string; project: string } | undefined {
    const row = this.db
      .prepare('SELECT session_id, cwd, project FROM sessions_v3 WHERE session_id = ?')
      .get(claudeSessionId) as { session_id: string; cwd: string; project: string } | undefined
    return row ? { sessionId: row.session_id, cwd: row.cwd, project: row.project } : undefined
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/daemon/store.sessions.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/store.ts src/daemon/store.sessions.test.ts
git commit -m "feat(spine): sessions_v3 — session-id-keyed registry immune to same-cwd overwrite"
```

---

### Task 8: Waker resumes the exact session

**Files:**
- Modify: `src/harness/claude-code/waker.ts:50-72`
- Test: REWRITE `src/harness/claude-code/waker.cross-session.test.ts` (flip the steal scenario), keep its `[CORRECT]` tests

**Interfaces:**
- Consumes: `Card.claudeSessionId` (Task 2), `Store.getRegisteredSession` (Task 7).
- Produces: waker resolution order: (1) `card.claudeSessionId` → `getRegisteredSession` (exact); (2) legacy fallback `getSessionByProject` ONLY for cards without `claudeSessionId`. cwd safety checks unchanged; plan-stage skip unchanged; deliveredAt semantics unchanged.

- [ ] **Step 1: Flip the characterization tests**

In `waker.cross-session.test.ts`, the end-to-end `[BUG]` scenario (session B re-registers same cwd → A's card resumes B) must now assert: `claude --resume` is spawned with **`cc-A`** (the card's own session id), from A's registered cwd. The test `'getSessionById resolves exact Claude session id WHEN populated — but no producer ever populates it'` becomes `'card.claudeSessionId resolves via sessions_v3'`. Keep the injected-`spawn` capture pattern the file already uses; assertions change from `args` containing `'sid-B'` to `'cc-A'`:

```ts
it('[FIXED] a decided card resumes ITS OWN session even after another session re-registered the same cwd', () => {
  store.recordSession('demo', 'cc-A', dir)      // dir = real temp dir (cwd existence check)
  store.recordSession('demo', 'cc-B', dir)      // B overwrites v2's row; v3 keeps both
  const card = decidedCard({ claudeSessionId: 'cc-A' })  // adapt the file's card factory
  waker.onCard(card)
  expect(spawned[0].args).toContain('cc-A')
  expect(spawned[0].args).not.toContain('cc-B')
})

it('legacy card (no claudeSessionId) still fail-closed resolves by project', () => { /* existing [CORRECT] test unchanged */ })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/harness/claude-code/waker.cross-session.test.ts`
Expected: FAIL — waker still resolves by project and resumes `cc-B`.

- [ ] **Step 3: Implement exact resolution**

In `waker.ts`, replace the resolution block (lines 50-56):

```ts
    // Exact spine resolution first: the card knows its owning session. Only
    // legacy cards (pre-spine, no claudeSessionId) fall back to the fail-closed
    // project-basename guess.
    const session = card.claudeSessionId
      ? this.store.getRegisteredSession(card.claudeSessionId)
      : this.store.getSessionByProject(card.session.project)
    if (!session) return
```

(`getRegisteredSession` returns `{sessionId, cwd, project}`; the spawn line already uses `session.sessionId` and `session.cwd` — no other change.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/harness/claude-code/waker.cross-session.test.ts && npm test && npm run typecheck`
Expected: PASS — exact resume; legacy fallback intact.

- [ ] **Step 5: Commit**

```bash
git add src/harness/claude-code/waker.ts src/harness/claude-code/waker.cross-session.test.ts
git commit -m "fix(spine): waker resumes the card's own session via sessions_v3 — same-cwd steal eliminated"
```

---

### Task 9: Hook injects the session key + protocol text updates

**Files:**
- Modify: `hooks/session-start.sh`
- Test: extend `tests/sessionStartHook.test.ts` (spawned-process pattern already there)

**Interfaces:**
- Consumes: hook stdin `{session_id, cwd}` (already parsed at lines 24-25).
- Produces: `additionalContext` now ENDS with an interpolated line `Boardroom session key: <session_id> — pass it as sessionKey on EVERY boardroom call.` (connected AND offline variants — offline included so a daemon that comes up mid-session still gets bound calls). Recovery wording updated: `identical project + headline` → `identical sessionKey, project and headline` in BOTH heredocs.

- [ ] **Step 1: Write the failing test**

Add to `tests/sessionStartHook.test.ts` (reuse its existing spawn helper that pipes stdin JSON and parses the jq output):

```ts
it('injects the session key line into additionalContext (connected)', async () => {
  const out = await runHook({ session_id: 'cc-hook-1', cwd: dir })   // file's existing helper + mock server
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext
  expect(ctx).toContain('Boardroom session key: cc-hook-1')
  expect(ctx).toContain('sessionKey')
  expect(ctx).not.toContain('identical project + headline')          // stale protocol gone
})

it('injects the session key line even when the daemon is offline', async () => {
  const out = await runHookOffline({ session_id: 'cc-hook-2', cwd: dir })
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext
  expect(ctx).toContain('Boardroom session key: cc-hook-2')
})
```

(Match the file's actual helper names — it spawns the script with a `createServer` on an ephemeral port for the connected case; mirror the existing two tests' setup verbatim.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/sessionStartHook.test.ts`
Expected: FAIL — no session key line in context.

- [ ] **Step 3: Implement in the hook**

In `hooks/session-start.sh`: the heredocs stay quoted (no interpolation risk); append the key AFTER selecting the protocol. `session_id` is currently only extracted inside the `connected=1` branch — hoist the two `jq -r` extractions (lines 24-25) ABOVE the `if [ "$connected" = 1 ]` block so both branches have `$session_id`. Then replace line 125:

```bash
if [ "$connected" = 1 ]; then ctx="$PROTOCOL"; else ctx="$FALLBACK"; fi

# Append the per-session key OUTSIDE the quoted heredocs (they must not interpolate).
# The agent echoes this as `sessionKey` on every call — the card↔session spine.
if [ -n "$session_id" ]; then
  ctx="${ctx}

Boardroom session key: ${session_id} — pass it as sessionKey on EVERY boardroom call. Recovery/reattach is scoped to this key."
fi
```

And in BOTH heredocs, change every `identical project + headline` to `identical sessionKey, project and headline` (two occurrences in PROTOCOL, one in FALLBACK).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sessionStartHook.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add hooks/session-start.sh tests/sessionStartHook.test.ts
git commit -m "feat(spine): hook injects the boardroom session key; recovery protocol is session-scoped"
```

---

### Task 10: Per-session status derivation (shared)

**Files:**
- Create: `src/shared/sessionStatus.ts`
- Test: `src/shared/sessionStatus.test.ts`

**Interfaces:**
- Consumes: `CapturedSession` (src/shared/session.ts:7-25), `Card` (Task 2), `needsHuman(card)` (src/shared/needsHuman.ts:16-40 — signature `needsHuman(card: Card, nowMs?: number, windowMs?: number): boolean`; verify the exact parameter list in the file and match it).
- Produces:

```ts
export type SessionStatus = 'needs-decision' | 'awaiting-review' | 'running' | 'idle' | 'ended'
export function deriveSessionStatus(session: Pick<CapturedSession, 'status'>, cards: Card[], nowMs: number): SessionStatus
```

Rules (first match wins): (1) any card needing the human with `stage === 'results'` → `awaiting-review`; (2) any card needing the human → `needs-decision`; (3) `session.status === 'ended'` → `ended`; (4) newest card activity (`decidedAt ?? createdAt`, max over cards) within 30 minutes of `nowMs` → `running`; (5) otherwise → `idle` (alive, quiet — includes zero cards).

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/sessionStatus.test.ts
import { describe, expect, it } from 'vitest'
import { deriveSessionStatus } from './sessionStatus.js'
import type { Card } from './card.js'

const NOW = Date.parse('2026-07-02T12:00:00.000Z')
const mk = (over: Partial<Card>): Card => ({
  id: 'c', stage: 'clarify', session: { agent: 'a', project: 'p' }, headline: 'h',
  blocks: [], decisions: [{ id: 'd', prompt: 'q', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] }],
  status: 'pending', createdAt: '2026-07-02T11:59:00.000Z', ...over,
} as Card)

describe('deriveSessionStatus', () => {
  it('pending results card → awaiting-review (outranks needs-decision)', () => {
    const cards = [mk({ stage: 'results' }), mk({ id: 'c2' })]
    expect(deriveSessionStatus({ status: 'alive' }, cards, NOW)).toBe('awaiting-review')
  })
  it('pending non-results card → needs-decision', () => {
    expect(deriveSessionStatus({ status: 'alive' }, [mk({})], NOW)).toBe('needs-decision')
  })
  it('ended session with nothing pending → ended', () => {
    expect(deriveSessionStatus({ status: 'ended' }, [mk({ status: 'decided', decidedAt: '2026-07-02T11:00:00.000Z' })], NOW)).toBe('ended')
  })
  it('alive + recent decided activity → running', () => {
    expect(deriveSessionStatus({ status: 'alive' }, [mk({ status: 'decided', decidedAt: '2026-07-02T11:45:00.000Z' })], NOW)).toBe('running')
  })
  it('alive + stale activity → idle; alive + no cards → idle', () => {
    expect(deriveSessionStatus({ status: 'alive' }, [mk({ status: 'decided', decidedAt: '2026-07-02T09:00:00.000Z' })], NOW)).toBe('idle')
    expect(deriveSessionStatus({ status: 'alive' }, [], NOW)).toBe('idle')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/shared/sessionStatus.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// src/shared/sessionStatus.ts
import type { Card } from './card.js'
import type { CapturedSession } from './session.js'
import { needsHuman } from './needsHuman.js'

export type SessionStatus = 'needs-decision' | 'awaiting-review' | 'running' | 'idle' | 'ended'

const RUNNING_WINDOW_MS = 30 * 60 * 1000

// Inbox status tag for one session — a pure aggregate over its cards + liveness.
// Ranked: the human's obligations outrank liveness (a dead session with an
// undecided card still needs the human).
export function deriveSessionStatus(
  session: Pick<CapturedSession, 'status'>,
  cards: Card[],
  nowMs: number,
): SessionStatus {
  const pendingOnHuman = cards.filter(c => needsHuman(c, nowMs))
  if (pendingOnHuman.some(c => c.stage === 'results')) return 'awaiting-review'
  if (pendingOnHuman.length > 0) return 'needs-decision'
  if (session.status === 'ended') return 'ended'
  const lastActivity = Math.max(0, ...cards.map(c => Date.parse(c.decidedAt ?? c.createdAt)))
  return nowMs - lastActivity < RUNNING_WINDOW_MS ? 'running' : 'idle'
}
```

(If `needsHuman`'s real signature differs — check src/shared/needsHuman.ts:16 — adapt the call and keep the test's semantics: pending or reconnecting-orphan counts as "on the human".)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/sessionStatus.test.ts && npm run typecheck`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/sessionStatus.ts src/shared/sessionStatus.test.ts
git commit -m "feat(spine): deriveSessionStatus — per-session inbox status tag"
```

---

### Task 11: API — session view-model + per-session cards + tray session binding

**Files:**
- Modify: `src/daemon/api.ts:123-125` (GET /api/sessions), `src/daemon/trayView.ts:5-37` (TrayItem), `menubar/trayRender.d.ts:6-21` (loose mirror type)
- Test: extend the api tests (colocated `src/daemon/api.test.ts` — follow its existing supertest-or-fetch pattern; if endpoints are tested via `tests/integration.test.ts`, add there instead)

**Interfaces:**
- Consumes: `deriveSessionStatus` (Task 10), `Store.listCaptured()` (src/daemon/store.ts:249-256), `Store.list()` (cards), `Card.claudeSessionId`.
- Produces:
  - `GET /api/sessions` now returns `SessionVM[]`: `CapturedSession & { sessionStatus: SessionStatus; pendingCount: number; cardCount: number }` (existing consumers read CapturedSession fields — additive, non-breaking).
  - `GET /api/sessions/:id/cards` → `Card[]` (cards with `claudeSessionId === :id`, `createdAt` ascending — stream order).
  - `TrayItem` gains `claudeSessionId?: string`.

- [ ] **Step 1: Write the failing tests**

In the api test file (match its existing daemon-boot + fetch pattern):

```ts
it('GET /api/sessions decorates captured sessions with status + counts', async () => {
  // seed: one captured session + one pending card bound to it
  store.upsertCaptured(capturedFixture({ sessionId: 'cc-1', status: 'alive' }))
  store.insert(cardFixture({ id: 'k1', claudeSessionId: 'cc-1' }))              // status 'pending'
  const res = await fetch(`${base}/api/sessions`).then(r => r.json())
  const s = res.find((x: { sessionId: string }) => x.sessionId === 'cc-1')
  expect(s.sessionStatus).toBe('needs-decision')
  expect(s.pendingCount).toBe(1)
  expect(s.cardCount).toBe(1)
})

it('GET /api/sessions/:id/cards returns only that session\'s cards in stream order', async () => {
  store.insert(cardFixture({ id: 'k1', claudeSessionId: 'cc-1', createdAt: '2026-07-02T10:00:00.000Z' }))
  store.insert(cardFixture({ id: 'k2', claudeSessionId: 'cc-1', createdAt: '2026-07-02T11:00:00.000Z' }))
  store.insert(cardFixture({ id: 'other', claudeSessionId: 'cc-2' }))
  const cards = await fetch(`${base}/api/sessions/cc-1/cards`).then(r => r.json())
  expect(cards.map((c: { id: string }) => c.id)).toEqual(['k1', 'k2'])
})
```

(`capturedFixture`/`cardFixture`: small local factories in the test file supplying the required CapturedSession fields — sessionId, machineId 'm', pid 1, cwd '/tmp/x', project 'x', status, capturedAt/lastSeenAt ISO strings — and the queue.test.ts-style card stub plus overrides.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/daemon/api.test.ts` (or the integration file)
Expected: FAIL — no sessionStatus field; 404 on /api/sessions/:id/cards.

- [ ] **Step 3: Implement**

In `src/daemon/api.ts`, replace the GET /api/sessions body (lines 123-125):

```ts
router.get('/api/sessions', (_req, res) => {
  const cards = store.list()
  const nowMs = Date.now()
  const vms = store.listCaptured().map(s => {
    const own = cards.filter(c => c.claudeSessionId === s.sessionId)
    return {
      ...s,
      sessionStatus: deriveSessionStatus(s, own, nowMs),
      pendingCount: own.filter(c => c.status === 'pending').length,
      cardCount: own.length,
    }
  })
  res.json(vms)
})

router.get('/api/sessions/:id/cards', (req, res) => {
  const own = store.list()
    .filter(c => c.claudeSessionId === req.params.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  res.json(own)
})
```

(Import `deriveSessionStatus` from `../shared/sessionStatus.js`.) In `src/daemon/trayView.ts`, add `claudeSessionId: card.claudeSessionId` into the TrayItem mapping and `claudeSessionId?: string` to the TrayItem type; mirror the optional field in `menubar/trayRender.d.ts` (it is deliberately loose — `stage: string` — keep the same looseness: `claudeSessionId?: string`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api.ts src/daemon/trayView.ts menubar/trayRender.d.ts <api test file>
git commit -m "feat(spine): session view-model API — status tags, per-session card streams, tray binding"
```

---

### Task 12: Web — group by real session id, stream view, inbox as filter

**Files:**
- Modify: `web/src/api.ts:23-31`, `web/src/fileView.ts:76-112` (Route + parseHash), `web/src/App.tsx` (sessionScrollKey :24-26, sessions polling :200-206, route render :234-252), `web/src/TaskSidebar.tsx:11-59` (grouping), `web/src/styles.css` (append)
- Create: `web/src/SessionStream.tsx`
- Test: REWRITE `web/src/App.cross-session.test.tsx` (flip), extend `web/src/TaskSidebar.test.tsx` (grouping tests live with `groupCardsByProjectAndSession`), create `web/src/SessionStream.test.tsx`

**Interfaces:**
- Consumes: `GET /api/sessions` → `SessionVM[]` (Task 11), `Card.claudeSessionId` (Task 2), existing `CardView({ card, cards })`, `needsHuman(card)`, `parseHash`.
- Produces:
  - `web/src/api.ts`: `export type SessionVM = CapturedSession & { sessionStatus: 'needs-decision' | 'awaiting-review' | 'running' | 'idle' | 'ended'; pendingCount: number; cardCount: number }`; `fetchSessions(): Promise<SessionVM[]>`.
  - Route kind `{ kind: 'session'; id: string }` for `#/session/<claudeSessionId>`.
  - `SessionStream({ session, cards })` — one session's cards, `createdAt` ascending, each rendered with the existing `CardView`.
  - `groupCardsByProjectAndSession` groups by `card.claudeSessionId` when present (legacy pseudo-key `${project}\0${title}\0${agent}` only for unbound cards).

- [ ] **Step 1: Flip / write the failing tests**

`web/src/App.cross-session.test.tsx`: the suite pins the pseudo-key collision (two sessions, same project+title+agent → ONE sidebar group). Flip: give the two card sets distinct `claudeSessionId`s → assert TWO groups. Keep one legacy test: two unbound card sets with identical pseudo-keys still merge (pre-spine behavior preserved).

`web/src/TaskSidebar.test.tsx` — add:

```tsx
it('groups by claudeSessionId when present, pseudo-key only for unbound cards', () => {
  const a = card({ id: 'a', claudeSessionId: 'cc-A', session: { agent: 'x', project: 'p', title: 't' } })
  const b = card({ id: 'b', claudeSessionId: 'cc-B', session: { agent: 'x', project: 'p', title: 't' } })
  const legacy = card({ id: 'l', session: { agent: 'x', project: 'p', title: 't' } })
  const groups = groupCardsByProjectAndSession([a, b, legacy])
  // identical project/title/agent, but three distinct groups: cc-A, cc-B, pseudo
  expect(groups.flatMap(p => p.sessions).length).toBe(3)
})
```

(Adapt `card()` and the group-shape assertions to the factory and return type already in that test file — only the expectations above are new.)

`web/src/SessionStream.test.tsx` (React Testing Library, mirror the render setup used by `App.cross-session.test.tsx`):

```tsx
import { render, screen } from '@testing-library/react'
import { SessionStream } from './SessionStream.js'

const vm = {
  sessionId: 'cc-A', machineId: 'm', pid: 1, cwd: '/tmp/p', project: 'p',
  status: 'alive', capturedAt: '2026-07-02T10:00:00.000Z', lastSeenAt: '2026-07-02T12:00:00.000Z',
  sessionStatus: 'needs-decision', pendingCount: 1, cardCount: 2,
} as const

it('renders the session header with status tag and cards oldest-first', () => {
  const older = card({ id: 'old', claudeSessionId: 'cc-A', createdAt: '2026-07-02T10:00:00.000Z', headline: 'first gate' })
  const newer = card({ id: 'new', claudeSessionId: 'cc-A', createdAt: '2026-07-02T11:00:00.000Z', headline: 'second gate' })
  render(<SessionStream session={vm} cards={[newer, older]} />)
  expect(screen.getByText('needs-decision')).toBeInTheDocument()
  const headlines = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)
  expect(headlines.indexOf('first gate')).toBeLessThan(headlines.indexOf('second gate'))
})
```

(If CardView renders headlines at a different heading level, target them via the `.stream-item` wrapper order instead — assert DOM order of the two headline texts.)

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run web/src/App.cross-session.test.tsx web/src/TaskSidebar.test.tsx web/src/SessionStream.test.tsx`
Expected: FAIL — no claudeSessionId grouping, no SessionStream module.

- [ ] **Step 3: Implement**

`web/src/api.ts` — replace `fetchSessions` (lines 29-31):

```ts
export type SessionVM = CapturedSession & {
  sessionStatus: 'needs-decision' | 'awaiting-review' | 'running' | 'idle' | 'ended'
  pendingCount: number
  cardCount: number
}

export async function fetchSessions(): Promise<SessionVM[]> {
  return check(await fetch('/api/sessions'))
}
```

`web/src/fileView.ts` — extend the Route union with `| { kind: 'session'; id: string }` and add to `parseHash` (before the card regex):

```ts
  const session = /^\/session\/(.+)$/.exec(raw)
  if (session) return { kind: 'session', id: decodeURIComponent(session[1]) }
```

`web/src/TaskSidebar.tsx` — in `groupCardsByProjectAndSession` (lines 11-59), change the session key derivation to:

```ts
const sessionKey = (card: Card): string =>
  card.claudeSessionId ?? `${card.session.project} ${card.session.title?.trim() || 'Untitled session'} ${card.session.agent}`
```

and make each session group header render as `<a href={`#/session/${encodeURIComponent(key)}`}>` ONLY when the key is a claudeSessionId (group carries a `bound: boolean` — derive from whether any card in the group has `claudeSessionId`).

`TaskSidebar` also gains the inbox status tags (the human's decision note: "each session should have some status tag that can help me flag its role in the inbox section"): widen the props to `{ cards, selectedId, sessions }: { cards: Card[]; selectedId: string | null; sessions?: SessionVM[] }` and, on each BOUND session group header, render `<span className={`stream-status stream-status-${vm.sessionStatus}`}>{vm.sessionStatus}</span>` where `vm = sessions?.find(s => s.sessionId === key)` (omit the chip when the VM is absent — sessions data is eventually consistent). `App.tsx` passes its `sessions` state down at both `<TaskSidebar …/>` call sites, and its sessions polling effect drops the route guard entirely (poll every 15s on ALL routes — the sidebar now always needs it; keep 4s only while `route.kind === 'folders' || route.kind === 'session'`).

`CardView` gains the provenance line (criterion 3: "each card displays its true origin"): in the sheet-head, where `card.session.title` renders as `.sheet-source` (CardView.tsx:~350), wrap it in a link when the card is bound:

```tsx
<p className="sheet-source">
  {card.claudeSessionId
    ? <a href={`#/session/${encodeURIComponent(card.claudeSessionId)}`}>{card.session.title?.trim() || 'Untitled session'}</a>
    : (card.session.title?.trim() || 'Untitled session')}
</p>
```

Add a TaskSidebar tag test alongside the grouping test: bound group with a `sessions` VM shows its `sessionStatus` chip; unbound group never shows a chip.

`web/src/App.tsx`:
- `sessionScrollKey` (lines 24-26) becomes: `return card.claudeSessionId ?? <existing pseudo-key expression>`.
- Sessions polling (lines 200-206): change the guard from `route.kind !== 'folders'` to `route.kind !== 'folders' && route.kind !== 'session'` and widen the poll interval condition accordingly (same 4s cadence is fine on the stream view).
- Route render (after the `folders` branch, lines 244-252):

```tsx
if (route.kind === 'session') {
  const vm = sessions?.find(s => s.sessionId === route.id) ?? null
  const own = all
    .filter(c => c.claudeSessionId === route.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return (
    <div className="frame">
      <TaskSidebar cards={all} selectedId={null} />
      <main className="content"><div className="content-inner">
        <SessionStream session={vm} cards={own} />
      </div></main>
    </div>
  )
}
```

`web/src/SessionStream.tsx` (new):

```tsx
import type { Card } from '../../src/shared/card.js'
import type { SessionVM } from './api.js'
import { CardView } from './CardView.js'

// One session's scrollable stream: gates in chronological order. The spine view —
// cards are entries in the session, not free-floating inbox items.
export function SessionStream({ session, cards }: { session: SessionVM | null; cards: Card[] }) {
  return (
    <section className="session-stream" aria-label="Session stream">
      <header className="stream-head">
        <div>
          <span className="canvas-label">Session</span>
          <h2>{session?.project ?? cards[0]?.session.project ?? 'Unknown session'}</h2>
          <p className="stream-sub">{cards[0]?.session.title?.trim() || session?.cwd || ''}</p>
        </div>
        {session && <span className={`stream-status stream-status-${session.sessionStatus}`}>{session.sessionStatus}</span>}
      </header>
      {cards.length === 0 && <p className="side-empty">No cards from this session yet.</p>}
      {cards.map(c => (
        <div className="stream-item" key={c.id}>
          <CardView card={c} cards={cards} />
        </div>
      ))}
    </section>
  )
}
```

(Match the Card import specifier style used by existing web files — check how `App.tsx` imports `Card` and copy it exactly.)

`web/src/styles.css` — append:

```css
/* Session stream (spine view) */
.session-stream { display: flex; flex-direction: column; gap: 18px; }
.stream-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
.stream-sub { font-size: 12.5px; color: var(--ink-3); margin: 2px 0 0; }
.stream-status { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line-2); color: var(--ink-2); white-space: nowrap; }
.stream-status-needs-decision, .stream-status-awaiting-review { color: var(--pending); background: var(--pending-soft); border-color: transparent; }
.stream-status-running { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
.stream-item { border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px 16px; background: var(--bg-2); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src && npm run typecheck`
Expected: PASS — flipped grouping, stream view renders, legacy pseudo-key preserved for unbound cards.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(spine): web session streams — group by claudeSessionId, #/session/<id> stream view, status tags"
```

---

### Task 13: E2E fixtures + stream-view spec

**Files:**
- Modify: `tests/e2e/sessionScroll.fixture.ts:59-111` (`browserCard` factory + `mockBoardroomApi`)
- Create: `tests/e2e/sessionStream.spec.ts`

**Interfaces:**
- Consumes: the fixture's existing `mockBoardroomApi(page, cards)` (routes `**/api/cards`, `**/api/sessions`, `**/api/device`, stubs `window.EventSource`), Task 12's `#/session/<id>` route and `.stream-item` / `.stream-status` classes.
- Produces: `browserCard` accepts `claudeSessionId`; `mockBoardroomApi` serves `SessionVM[]` (with `sessionStatus`/`pendingCount`/`cardCount`) on `**/api/sessions`.

- [ ] **Step 1: Extend the fixture**

In `tests/e2e/sessionScroll.fixture.ts`: add `claudeSessionId?: string` to the `browserCard` factory's overrides (spread into the returned card object). In `mockBoardroomApi`, replace the `/api/sessions` fulfill body (currently `[]` or CapturedSession stubs — check lines 80-111) with a `SessionVM[]` derived from the cards passed in:

```ts
const sessionVMs = [...new Set(cards.map(c => c.claudeSessionId).filter(Boolean))].map(id => ({
  sessionId: id, machineId: 'm', pid: 1, cwd: `/tmp/${id}`, project: cards.find(c => c.claudeSessionId === id)!.session.project,
  status: 'alive', capturedAt: '2026-07-02T10:00:00.000Z', lastSeenAt: '2026-07-02T12:00:00.000Z',
  sessionStatus: 'needs-decision', pendingCount: 1, cardCount: cards.filter(c => c.claudeSessionId === id).length,
}))
await page.route('**/api/sessions', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sessionVMs) }))
```

- [ ] **Step 2: Write the spec**

```ts
// tests/e2e/sessionStream.spec.ts
import { expect, test } from '@playwright/test'
import { browserCard, mockBoardroomApi } from './sessionScroll.fixture.js'

test('session stream shows one session\'s cards oldest-first with its status tag', async ({ page }) => {
  const cards = [
    browserCard('s1-old', 'Session One', 'first gate', '2026-07-02T10:00:00.000Z'),
    browserCard('s1-new', 'Session One', 'second gate', '2026-07-02T11:00:00.000Z'),
    browserCard('s2', 'Session Two', 'other session gate', '2026-07-02T10:30:00.000Z'),
  ]
  ;(cards[0] as { claudeSessionId?: string }).claudeSessionId = 'cc-A'
  ;(cards[1] as { claudeSessionId?: string }).claudeSessionId = 'cc-A'
  ;(cards[2] as { claudeSessionId?: string }).claudeSessionId = 'cc-B'
  await mockBoardroomApi(page, cards)
  await page.goto('/#/session/cc-A')

  await expect(page.locator('.stream-item')).toHaveCount(2)
  await expect(page.locator('.stream-status')).toHaveText('needs-decision')
  const first = page.locator('.stream-item').first()
  await expect(first).toContainText('first gate')
  await expect(page.locator('.stream-item')).not.toContainText(['other session gate'])
})
```

(If `browserCard`'s parameter order differs — check its signature at fixture lines 59-78 — pass overrides the way the factory expects; the assertions are the contract.)

- [ ] **Step 3: Run to verify**

Run: `npm run test:e2e -- sessionStream.spec.ts`
Expected: PASS. Also run the full e2e suite: `npm run test:e2e` — the fixture change must not break `sessionScroll.spec.ts` (it ignores `/api/sessions` content).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/sessionScroll.fixture.ts tests/e2e/sessionStream.spec.ts
git commit -m "test(spine): hermetic e2e for the session stream view"
```

---

### Task 14: Full verification + deploy

**Files:** none (verification only).

- [ ] **Step 1: Full local gate**

Run: `npm test && npm run typecheck && npm run lint && npm run test:e2e`
Expected: all PASS.

- [ ] **Step 2: Deploy**

```bash
npm run build:web && launchctl kickstart -k gui/$(id -u)/com.boardroom.daemon
```

Expected: daemon restarts; any in-flight gates orphan as `boot` (expected, reattachable).

- [ ] **Step 3: Live two-session proof (criterion 3 evidence)**

With the human: open TWO Claude Code sessions in the SAME cwd; from each, issue a boardroom `clarify` with the SAME headline but its own injected `sessionKey`. Verify on the dashboard: two distinct cards, each showing its own session; decide each — each decision reaches its own caller (no steal). Capture screenshots for `review_results`.

- [ ] **Step 4: Commit any doc updates and record evidence paths in the execution notes.**
