# P1 Report Entries & Stage Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Non-card stream citizens: a fire-and-forget `present_report` tool posts report entries into session streams, the daemon auto-derives stage tags from gate calls, and the web renders both — closing spec criteria `report-no-pause` and `tray-separation`.

**Architecture:** A new `Entry` shared type (`report` | `tag`) persists in an `entries` table (copying the cards JSON-blob pattern), is emitted as a separate `entry` SSE event alongside `card`, and is interleaved with cards by `createdAt` in the session stream. `present_report` returns immediately — no queue.submit, no waiter, no park. Stage tags are derived daemon-side in `Queue.submit` (gate raised) and `Queue.decide` (gate decided) — zero agent burden. Read-state is dashboard-local (localStorage, mirroring the session-scroll pattern); reports never touch `needsHuman`, the pending queue, or the tray badge.

**Tech Stack:** unchanged from P0 — TS ^6 strict NodeNext (`.js` specifiers), zod ^4, @modelcontextprotocol/server 2.0.0-alpha.2, better-sqlite3 ^12, express ^5, react ^19, vitest ^4 (TZ=UTC), playwright 1.61.1 hermetic.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-02-report-surface-design.md` — P1 section + "P1 design decisions" (typed entries; summary + drawer; auto-derived tags; sidebar FIFO accordions; stream drawer default closed; NO new transport).
- **Criterion `tray-separation` is load-bearing:** entries must NEVER appear in `needsHuman`, the pending list, `TrayVM.total/byStage`, or notification toasts. Any diff touching those paths must leave them byte-identical.
- **Criterion `finish-integrity` must not regress:** `present_report`'s description and return text must state it is not a FINISH; `review_results` remains the only completion path.
- `Entry.claudeSessionId` is OPTIONAL (an unbound legacy agent may post a report; it renders under its project, outside any session stream). `Entry` additions must never break `Card` parsing — separate table, separate schema.
- Verbatim interfaces from the seam read (verified at HEAD 453c8ec): `ToolResult = { content: { type: 'text'; text: string }[] }` (mcp.ts:75-78); `DESCRIPTIONS` is a `const as const` record (mcp.ts:64-73); `queue.submit` inserts + `this.emit('card', card)` at queue.ts:74-76; `queue.decide` updates + emits at queue.ts:168-173; `/events` registers one listener per event name (api.ts:348-352); web `subscribeCards` uses `es.addEventListener('card', …)` (web/src/api.ts:79-103); App merges via `Map` upsert (App.tsx:124-139); sidebar sorts groups' cards newest-first at TaskSidebar.tsx:48; `ProjectSection` fold state via `readFolded`/`foldKey` (TaskSidebar.tsx:125-213); SpecAffordance drawer pattern (SpecAffordance.tsx:12-32).
- Sidebar ordering note: the human's FIFO rule (first-in at top) applies to the per-session stacks inside accordions — do NOT change the group-level recency ordering or the Needs-you bucket ordering.
- Deliberate scope lines: menubar tray gains NO unread-report count in P1 (web-only read state); explicit event tags deferred (auto-derived only); the reply/thread channel is P2, not here.
- Commit directly to `main`, one commit per task. Commands: `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:e2e`, `npm run build:web`; deploy = `npm run build:web && launchctl kickstart -k gui/$(id -u)/com.boardroom.daemon`.

---

### Task 1: `Entry` shared schema

**Files:**
- Create: `src/shared/entry.ts`
- Test: `src/shared/entry.test.ts`

**Interfaces:**
- Produces:

```ts
export const ReportEntry = z.object({
  id: z.string().min(1),
  type: z.literal('report'),
  claudeSessionId: z.string().min(1).optional(),
  session: SessionInfo,                       // same {agent, project, title?} object cards embed
  headline: z.string().min(1),
  blocks: z.array(Block).min(1),
  createdAt: z.string(),
})
export const TagEntry = z.object({
  id: z.string().min(1),
  type: z.literal('tag'),
  claudeSessionId: z.string().min(1).optional(),
  session: SessionInfo,
  tag: z.string().min(1),                     // e.g. 'stage:clarify:raised', 'stage:plan:decided'
  cardId: z.string().min(1),                  // the gate card this tag was derived from
  createdAt: z.string(),
})
export const Entry = z.discriminatedUnion('type', [ReportEntry, TagEntry])
export type Entry = z.infer<typeof Entry>
```

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/entry.test.ts
import { describe, expect, it } from 'vitest'
import { Entry } from './entry.js'

const report = {
  id: 'e1', type: 'report', claudeSessionId: 'cc-1',
  session: { agent: 'claude-code', project: 'demo' },
  headline: 'investigation findings',
  blocks: [{ id: 'b1', type: 'markdown', text: 'summary' }],
  createdAt: '2026-07-07T00:00:00.000Z',
}
const tag = {
  id: 'e2', type: 'tag', claudeSessionId: 'cc-1',
  session: { agent: 'claude-code', project: 'demo' },
  tag: 'stage:clarify:raised', cardId: 'c1',
  createdAt: '2026-07-07T00:00:00.000Z',
}

describe('Entry', () => {
  it('parses a report entry and round-trips JSON', () => {
    const parsed = Entry.parse(report)
    expect(Entry.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })
  it('parses a tag entry', () => {
    expect(Entry.parse(tag).type).toBe('tag')
  })
  it('accepts an UNBOUND report (no claudeSessionId) — legacy agents may post', () => {
    const { claudeSessionId: _drop, ...unbound } = report
    expect(Entry.safeParse(unbound).success).toBe(true)
  })
  it('rejects a report with zero blocks and a tag without cardId', () => {
    expect(Entry.safeParse({ ...report, blocks: [] }).success).toBe(false)
    const { cardId: _c, ...tagless } = tag
    expect(Entry.safeParse(tagless).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/shared/entry.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement `src/shared/entry.ts`** exactly per the Interfaces block (import `Block` from `./blocks.js`, `SessionInfo` from `./card.js` — check `SessionInfo` is exported there; if not, export it in the same commit).
- [ ] **Step 4: Verify** — `npx vitest run src/shared/entry.test.ts && npm run typecheck` — PASS.
- [ ] **Step 5: Commit** — `feat(p1): Entry shared schema — report and tag stream entries`

---

### Task 2: Store — `entries` table

**Files:**
- Modify: `src/daemon/store.ts` (DDL in constructor after `sessions_v3` block; methods after the captured-sessions block)
- Test: `src/daemon/store.entries.test.ts` (temp-dir Store pattern from `store.sessions.test.ts`)

**Interfaces:**
- Consumes: `Entry` (Task 1).
- Produces: `Store.insertEntry(entry: Entry): void` (Entry.parse on write), `Store.listEntries(): Entry[]` (createdAt ASC — FIFO), `Store.listEntriesBySession(claudeSessionId: string): Entry[]` (createdAt ASC). Parse-on-read skips corrupt rows with a `console.warn`, mirroring `parseRow`.

- [ ] **Step 1: Failing tests** — three: insert+get-back round-trip via `listEntries`; per-session filter excludes other sessions and unbound entries; corrupt-JSON row skipped, not thrown (raw `INSERT INTO entries` of garbage json, then `listEntries()` returns the valid ones and warns). Copy the temp-dir beforeEach/afterEach from `src/daemon/store.sessions.test.ts`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — DDL:

```ts
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id         TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL,
        json       TEXT NOT NULL
      )
    `)
```

Methods follow the cards pattern exactly (validate on write, safeParse-skip on read); `listEntries` orders `created_at ASC, id ASC`; `listEntriesBySession` adds `WHERE session_id = ?`.
- [ ] **Step 4: Verify** — focused + `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(p1): entries table — persisted typed stream entries`

---

### Task 3: Queue — entry emission + auto-derived stage tags

**Files:**
- Modify: `src/daemon/queue.ts` (`submit` after line ~76 emit, `decide` after line ~173 emit; constructor takes no new deps — Store is already there)
- Test: `src/daemon/queue.entries.test.ts`

**Interfaces:**
- Consumes: `Store.insertEntry` (Task 2), `Entry` (Task 1).
- Produces: `Queue` emits `'entry'` events (`queue.on('entry', (e: Entry) => …)`); public `postReport(entry: Entry): void` (validates, persists, emits — the seam `present_report` calls so mcp.ts never touches the Store directly); auto-tags: on FRESH submit (not reattach/revive paths) a `stage:<stage>:raised` tag; on decide a `stage:<stage>:decided` tag. Tags inherit the card's `claudeSessionId`/`session` and reference `cardId`.

- [ ] **Step 1: Failing tests** — (a) fresh `submit` inserts + emits exactly one tag entry `stage:clarify:raised` with the card's id and claudeSessionId; (b) REATTACH path (decided-undelivered claim, the `gen: -1` branch) emits NO tag (re-issue is not a new gate); (c) `decide` emits `stage:clarify:decided`; (d) `postReport` persists and emits; (e) **tray-separation guard:** after a report + two tags exist, `buildTrayVM(store.list(), …)` output is identical to before (import and call the real `buildTrayVM` from `./trayView.js` — check its actual signature first and match it), and `store.list()` (cards) is unaffected. Use the `card()` factory conventions from `queue.test.ts`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — in `submit`, ONLY on the fresh-insert branch (after `this.emit('card', card)`):

```ts
    this.recordTag(card, 'raised')
```

in `decide` after `this.emit('card', updated)`: `this.recordTag(updated, 'decided')`. Private helper:

```ts
  private recordTag(card: Card, event: 'raised' | 'decided'): void {
    const tag: Entry = {
      id: randomUUID(),
      type: 'tag',
      ...(card.claudeSessionId ? { claudeSessionId: card.claudeSessionId } : {}),
      session: card.session,
      tag: `stage:${card.stage}:${event}`,
      cardId: card.id,
      createdAt: new Date().toISOString(),
    }
    this.store.insertEntry(tag)
    this.emit('entry', tag)
  }

  postReport(entry: Entry): void {
    const valid = Entry.parse(entry)
    this.store.insertEntry(valid)
    this.emit('entry', valid)
  }
```

- [ ] **Step 4: Verify** — focused + full suite + typecheck.
- [ ] **Step 5: Commit** — `feat(p1): queue emits entry events — auto stage tags on gate raise/decide, postReport seam`

---

### Task 4: `present_report` tool (non-blocking)

**Files:**
- Modify: `src/shared/inputs.ts` (add `PresentReportInput`), `src/daemon/compile.ts` (add `compileReport`), `src/daemon/mcp.ts` (DESCRIPTIONS key + registerTool + non-blocking handler)
- Test: `src/daemon/mcp.report.test.ts` (in-process daemon + StreamableHTTPClientTransport harness from `mcp.spine.test.ts`)

**Interfaces:**
- Consumes: `Queue.postReport` (Task 3), `resolveClaudeSessionId` + `sessionBindings` (P0), `CompileMeta` (P0).
- Produces:

```ts
// inputs.ts — NO decisions, NO sections in P1; summary blocks only (drawer renders the same blocks large)
export const PresentReportInput = z.object({
  ...sessionFields,
  headline: z.string().min(1).describe('One-line summary of what this report conveys'),
  blocks: z.array(Block).min(1).describe('The report content — glanceable summary blocks; the dashboard offers a full-size drawer'),
}).superRefine(checkUniqueIds)   // match how inputs.ts actually exposes the unique-id check; blocks-only variant

// compile.ts
export function compileReport(input: PresentReportInput, meta: CompileMeta): Entry
```

Handler (in `buildServer`, after `review_results`): NOT `makeHangingHandler` — a direct async handler that resolves the session id, compiles, calls `queue.postReport`, and returns immediately:

```ts
  server.registerTool(
    'present_report',
    { description: DESCRIPTIONS.present_report, inputSchema: PresentReportInput },
    async (input, ctx) => {
      const agent = server.server.getClientVersion()?.name ?? 'unknown'
      const claudeSessionId = resolveClaudeSessionId(ctx, input as { sessionKey?: string }, sessionBindings)
      const entry = compileReport(input as never, { agent, claudeSessionId })
      queue.postReport(entry)
      return {
        content: [{
          type: 'text' as const,
          text: `Report posted (entry ${entry.id})${claudeSessionId ? ' to your session stream' : ' (unbound — no sessionKey)'}. ` +
                'This is NOT a completion: review_results remains the only way to close out a session.',
        }],
      }
    },
  )
```

DESCRIPTIONS gains: `present_report: 'Post a report the human can READ — results, findings, explanations — with NO decision attached. Fire-and-forget: returns immediately, never blocks, never parks. Use it to convey information mid-session; do NOT use it to finish — review_results remains the only completion path. Always pass your sessionKey so the report lands in your session stream. Keep the blocks glanceable; the dashboard offers a full-size drawer view.'`

- [ ] **Step 1: Failing tests** — via the real MCP client harness: (a) `present_report` with `sessionKey` returns immediately (assert wall-clock < 2s AND the returned text contains 'NOT a completion'), and `GET /api/entries` (Task 5 — for THIS task poll `store` via a direct Store handle the harness already has, or assert through `queue.on('entry')`) contains the report bound to the key; (b) without `sessionKey` on a fresh transport → entry unbound; (c) input with zero blocks → tool error (schema reject). Also unit-test `compileReport` meta threading (both branches) mirroring `compile.spine.test.ts`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** per Interfaces. `compileReport` mirrors `compileClarify`'s shape: `id: randomUUID(), type: 'report', session: session(input, meta.agent), …(claudeSessionId spread), headline, blocks, createdAt: now()`. NO fingerprint (reports are not reattachable — each post is a new entry; idempotency is not needed for a non-blocking call that cannot lose a human decision).
- [ ] **Step 4: Verify** — focused + full + typecheck + lint.
- [ ] **Step 5: Commit** — `feat(p1): present_report — fire-and-forget report entries via MCP`

---

### Task 5: API — entries endpoints + SSE `entry` frames + fixtures

**Files:**
- Modify: `src/daemon/api.ts` (`GET /api/entries`, `GET /api/sessions/:id/entries`, `/events` entry listener), `tests/e2e/sessionScroll.fixture.ts` (mock `**/api/entries` with `[]` default so hermetic e2e never hits the dead port)
- Test: extend `src/daemon/api.test.ts`

**Interfaces:**
- Consumes: `Store.listEntries`/`listEntriesBySession` (Task 2), `queue.on('entry')` (Task 3).
- Produces: `GET /api/entries` → `Entry[]` FIFO; `GET /api/sessions/:id/entries` → that session's entries FIFO; `/events` emits `event: entry\ndata: <Entry JSON>` frames (separate listener registered next to `onCard`, removed in the same `req.on('close')`); `sendTray()` NOT called from the entry listener (tray never counts entries).

- [ ] **Step 1: Failing tests** — (a) route returns FIFO entries; (b) per-session route filters; (c) SSE: open `/events` in the api test harness (match how existing SSE tests consume the stream — check api.test.ts for an existing /events test to copy; if none exists, use a raw http GET and assert the `event: entry` frame arrives after `queue.postReport`), and assert the tray frame counts are unchanged by entry activity.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — routes copy the sessions-cards route shape; SSE listener:

```ts
  const onEntry = (entry: Entry): void => {
    res.write(`event: entry\ndata: ${JSON.stringify(entry)}\n\n`)
  }
  queue.on('entry', onEntry)
  // in the existing close handler: queue.off('entry', onEntry)
```

Fixture: add `page.route('**/api/entries', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))` and the per-session variant — mirror how `/api/sessions` is mocked; existing specs must stay green.
- [ ] **Step 4: Verify** — focused + full + typecheck; `npm run test:e2e` (fixture must not break the 3 existing specs).
- [ ] **Step 5: Commit** — `feat(p1): entries API + entry SSE frames — tray provably untouched`

---

### Task 6: Hook protocol mentions `present_report`

**Files:**
- Modify: `hooks/session-start.sh` (both heredocs: one sentence in the workflow bullets), `tests/sessionStartHook.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Failing test** — connected context contains `present_report` and the phrase `never blocks`; offline context mentions it too.
- [ ] **Step 2: Implement** — add to BOTH heredocs' bullet lists (keep them quoted): `- CONVEY: to hand the human results, findings, or explanations with nothing to decide, call present_report (fire-and-forget — it never blocks and is NOT a completion; review_results still closes the session).`
- [ ] **Step 3: Verify** — `npx vitest run tests/sessionStartHook.test.ts` + full suite.
- [ ] **Step 4: Commit** — `feat(p1): hook protocol — present_report guidance in connected and offline contexts`

---

### Task 7: Web — stream subscription + entries state + read-state

**Files:**
- Modify: `web/src/api.ts` (unified `subscribeStream`, `fetchEntries`), `web/src/App.tsx` (entries Map state, initial fetch, SSE merge; do NOT touch notification logic — reports must not toast in P1)
- Create: `web/src/readState.ts` (localStorage seen-entry-ids, TTL + cap, mirroring the sessionScroll read/write pattern at App.tsx:37-81)
- Test: `web/src/readState.test.ts`, extend `web/src/App.test.tsx` mocks (`fetchEntries` → `[]` default — same additive-mock pattern Task 12 used)

**Interfaces:**
- Produces: `subscribeStream(onCard, onEntry, onStatus)` — ONE EventSource, two listeners (replaces `subscribeCards` at its single App.tsx call site; keep `subscribeCards` exported as a thin wrapper so nothing else breaks); `fetchEntries(): Promise<Entry[]>`; `markRead(entryId)`, `isRead(entryId)`, `unreadCount(entries)` in readState.ts.

- [ ] **Step 1: Failing tests** — readState: mark/read round-trip through a storage stub, TTL expiry drops old ids, cap enforced; App: SSE entry event lands in entries state (mirror the existing App SSE test's mock EventSource pattern if one exists — check App.test.tsx; if the ES is stubbed per the e2e fixture style, assert via fetchEntries merge instead).
- [ ] **Step 2: Implement** per the seam map's Option 2 (`subscribeStream`), App state `const [entries, setEntries] = useState<Map<string, Entry>>(new Map())`, initial `fetchEntries` merge copying the cards merge (App.tsx:98-113), SSE upsert copying App.tsx:124-127.
- [ ] **Step 3: Verify** — focused + full + typecheck + lint.
- [ ] **Step 4: Commit** — `feat(p1): web stream subscription — entries state + local read tracking`

---

### Task 8: Web — stream interleave, report summary + drawer, tag rows

**Files:**
- Modify: `web/src/SessionStream.tsx` (interleave entries with cards by createdAt ASC), `web/src/App.tsx` (pass entries into SessionStream route)
- Create: `web/src/ReportEntryView.tsx` (summary card: headline + blocks via BlockView + unread dot + "Open report" button), `web/src/ReportDrawer.tsx` (SpecDrawer-pattern full view: same blocks, wide; `onClose`; marks read on open)
- Modify: `web/src/styles.css` (`.entry-report`, `.entry-tag`, `.entry-unread-dot`, `.report-drawer` — follow the `.stream-*` / `.spec-drawer` conventions)
- Test: `web/src/SessionStream.test.tsx` (extend), `web/src/ReportEntryView.test.tsx`

**Interfaces:**
- Consumes: `Entry` (Task 1), `readState` (Task 7), `BlockView` (existing block renderer — find its exact props in `web/src/blocks/` or wherever CardView renders blocks, and reuse it; do NOT fork block rendering).
- Produces: `SessionStream({ session, cards, entries })` renders one merged FIFO list: cards in `.stream-item` (unchanged), reports as `<ReportEntryView>`, tags as a slim `.entry-tag` row (`stage:plan:decided` renders as label "plan · decided" with the stage's existing color var, linking to `#/card/<cardId>`).

- [ ] **Step 1: Failing tests** — merged ordering (a report between two cards sorts by createdAt); tag renders label + link; ReportEntryView shows unread dot when unread, opens drawer on click, drawer close marks read (stub readState).
- [ ] **Step 2: Implement.** The merge:

```tsx
const items = [
  ...cards.map(c => ({ kind: 'card' as const, at: c.createdAt, card: c })),
  ...entries.map(e => ({ kind: e.type, at: e.createdAt, entry: e })),
].sort((a, b) => a.at.localeCompare(b.at))
```

- [ ] **Step 3: Verify** — focused + full web suite + typecheck + lint.
- [ ] **Step 4: Commit** — `feat(p1): report summary entries with full-size drawer, stage tag rows in streams`

---

### Task 9: Web — sidebar FIFO accordions + tag chips + stream drawer + unread badge

**Files:**
- Modify: `web/src/TaskSidebar.tsx` (per-session stacks FIFO ascending — flip the sort at line ~48 ONLY inside session groups; tag chips in `side-session` bodies; per-session "stream" affordance opening a default-closed drawer; unread-report dot on session heads), `web/src/App.tsx` (pass entries to TaskSidebar), `web/src/styles.css`
- Create: `web/src/StreamDrawer.tsx` (SpecDrawer-pattern wrapper rendering `<SessionStream>` for one session; default closed, opened from the sidebar affordance)
- Test: extend `web/src/TaskSidebar.test.tsx` + `web/src/App.cross-session.test.tsx` mocks

**Interfaces:**
- Consumes: everything above.
- Produces: sidebar session stacks ordered first-in-at-top (human's FIFO rule); group-level ordering and Needs-you bucket UNCHANGED (assert this in a test — the existing newest-first group test must still pass); unread dot never affects the `side-count` "N waiting" number (tray-separation, assert it).

- [ ] **Step 1: Failing tests** — within-session FIFO (two cards, older renders first) while group order stays recency; unread dot present when a session has unread reports and `side-count` text unchanged; stream affordance opens StreamDrawer (default closed on mount).
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify** — full web suite + typecheck + lint.
- [ ] **Step 4: Commit** — `feat(p1): sidebar FIFO session stacks, tag chips, unread dots, default-closed stream drawer`

---

### Task 10: E2E — report + tag in the hermetic stream

**Files:**
- Modify: `tests/e2e/sessionScroll.fixture.ts` (entry factories + `/api/entries` + per-session entries mocks derived from passed entries)
- Create: `tests/e2e/reportEntry.spec.ts`

**Interfaces:** consumes Task 5's fixture default and Task 8/9's classes.

- [ ] **Step 1: Spec** — seed one bound card + one report entry + one tag for `cc-A` (ADVERSARIAL order — newest first in the array, per the Task-13 lesson); assert: `#/session/cc-A` renders card→report→tag in createdAt order; report shows unread dot; clicking "Open report" opens `.report-drawer`; the sidebar "N waiting" count ignores the report.
- [ ] **Step 2: Verify** — `npm run test:e2e` full (all specs).
- [ ] **Step 3: Commit** — `test(p1): hermetic e2e — report entries, tags, unread separation`

---

### Task 11: Full verification, deploy, live proof, results gate

- [ ] **Step 1:** `npm test && npm run typecheck && npm run lint && npm run test:e2e` — all green.
- [ ] **Step 2:** Deploy: `npm run build:web && launchctl kickstart -k gui/$(id -u)/com.boardroom.daemon`.
- [ ] **Step 3:** Live proof from the executing session: call `present_report` WITH sessionKey (a real P1-completion report — dogfooding the tool to announce itself); confirm via `curl /api/sessions/<id>/entries` and the dashboard stream that it landed instantly with the agent never blocking; capture the tray/badge counts before/after (must be identical).
- [ ] **Step 4:** `review_results` echoing the spec — criteria `report-no-pause` and `tray-separation` claimed MET with the live evidence; `card-provenance`/`finish-integrity` restated; P2/P3 still unmet, verdict expectation: keep going.
