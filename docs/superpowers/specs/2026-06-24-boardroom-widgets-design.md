# Boardroom widgets + mixable sections — design

- **Date:** 2026-06-24
- **Status:** Approved at the `present_plan` gate (card `f276ba6e`) + widget build-list and skip decisions (cards `52bf90d5`). Awaiting spec review before implementation planning.
- **Scope:** Foundation only — a richer widget vocabulary and an optional mixable-sections card model. Session widget library and per-question clarification subagents are **deferred to their own gates** (captured in §8).

## 1. Motivation

Boardroom already has a widget vocabulary — 8 `block` types — but they only render as a flat list split into "global" vs per-decision "question-local" context, and each gate has a single fixed shape. The human asked for widgets to become a **richer, hand-crafted toolkit** that composes into **navigable, mixed-purpose** cards: a single gate is rarely "just decide" — it mixes report, explanation, and decisions, and sometimes the reader wants more context on demand.

This design delivers two things and explicitly defers two:

1. **Richer widgets** — 7 new presentational block types + 2 already locked, plus a markdown-renderer upgrade.
2. **Mixable sections** — an optional ordered `sections[]` layer so one card freely interleaves decide / explain / report regions, fully back-compatible with today's flat cards.
3. *(Deferred)* Session widget library — reuse a widget/report across gates.
4. *(Deferred)* Per-question clarification subagents — live "ask a follow-up" while a gate is open.

## 2. Approved decisions

| Decision | Choice |
|---|---|
| Scope sequencing | **Foundation only** — ship widgets + sections; library & clarification become their own `present_plan` gates. |
| v1 widget set | `callout`, `key_facts` (locked) **+** `status_list`, `bar_list`, `image`, `progress`, `file_tree`, `tabs`, `comparison_matrix`. **Skip** `html` and action `buttons`. |
| Markdown renderer | Treat as a first-class booster (typography + code-fence highlighting). Raw HTML stays disabled — that *is* the XSS safety that justified skipping the `html` widget. |
| Section kinds | **Three:** `decide` / `explain` / `report` (report renders like explain for now; carried separately for a future report page). |
| Coverage strictness | **Strict on decisions, lenient on blocks** — every non-verdict decision must sit in exactly one `decide` section; stray blocks may go unplaced (just don't render). |

## 3. Goals / non-goals

**Goals**
- Add the 9-widget v1 set as additive members of the `Block` discriminated union.
- Add an optional `sections[]` model to `clarify` and `plan` cards (never `results`).
- Keep every existing flat clarify/plan/results card **byte-identical** in render output.
- Preserve `fingerprint(project, stage, headline)` exactly — it drives retry-reattach idempotency.
- Keep `compile.ts` pure (input → Card, no I/O).

**Non-goals (this pass)**
- No session-scoped widget store, no `register_widget` tool, no cross-gate references.
- No clarification back-channel, no new agent collaborator.
- No in-card actions, no raw-HTML rendering, no live/streaming data in widgets (all static snapshots).
- No table-of-contents component (a TOC fights the glanceable-CEO principle until multi-section cards actually exist; revisit when there's a card long enough to need it).

## 4. Architecture overview

Three layers change, in dependency order:

```
Phase 0  Guardrails ........ tsconfig + evidenceChip exhaustiveness + golden/fingerprint tests
Phase 1  Widgets ........... src/shared/blocks.ts (union) + web/src/blocks/BlockView.tsx + evidenceChip + markdown boost
Phase 2  Sections schema ... src/shared/section.ts + card.ts + inputs.ts (gated) + compile.ts (thread-through)
Phase 3  Section renderer .. web/src/cardWorkspace.ts (default synthesis) + CardView.tsx (one section loop)
```

The single registration point for widgets is the `Block` `z.discriminatedUnion('type', [...])` in [blocks.ts](../../../src/shared/blocks.ts) — adding a member there makes the type valid in `Card.blocks` and every `*Input.blocks` automatically. The renderer keys off `block.type` in [BlockView.tsx](../../../web/src/blocks/BlockView.tsx).

## 5. Phase 0 — Guardrails (must land first)

A claimed safety net is false today: adding a block type is **not** a compile error everywhere. `web/src/blocks/BlockView.tsx`'s `KIND` is `Record<Block['type'], …>` (truly compiler-forced), **but** `web/src/evidenceChip.ts` `label()` is a no-default `switch` returning `string`, and `tsconfig.json` has `strict: true` *without* `noImplicitReturns`. So a missing case silently returns `undefined` at runtime.

- Enable `"noImplicitReturns": true` in `tsconfig.json` (codebase-wide correctness win).
- Add an explicit exhaustiveness guard to `evidenceChip.label()`: `default: { const _x: never = block; return _x }`.
- Add a **golden-render snapshot test** for a flat clarify / plan / results card (the precondition for the Phase 3 `CardView` rewrite — proves "byte-identical for legacy cards").
- Add a **fingerprint-invariant test**: `fingerprint` ignores `sections` and any new optional field.

After Phase 0, adding a widget type is a genuine compile error in *both* switches.

## 6. Phase 1 — Widgets

Each widget costs ~3 touch points: a zod member in `blocks.ts`, a `KIND` entry (`{ label, Icon }`) + a `case` in `BlockView.tsx`, and a `label()` case in `evidenceChip.ts`. All are **static** (CSS/SVG, no server round-trips, no live data). Proposed zod shapes (refined during planning):

### 6a. Narrative + scoreboard + verification (cheap, ship first)
- **`callout`** — `{ ...base, type:'callout', tone: enum(info|success|warn|danger).default('info'), summary: string.min(1), detail?: string }`. `detail` is markdown rendered behind an "Explain more" disclosure. This block is the per-question "why this matters / why this option" affordance and the home for progressive disclosure (scoped to prose — the existing Markdown clamp at `BlockView.tsx:39-59` only works on prose; lift it into a small reusable wrapper applied to `callout.detail`, **not** whole sections).
- **`key_facts`** — `{ ...base, type:'key_facts', facts: array({ label, value, delta?, tone?: enum(neutral|good|bad) }).min(1) }`. `value`/`delta` are pre-formatted strings (daemon does no math). Keep to ~3–6 cells.
- **`status_list`** — `{ ...base, type:'status_list', items: array({ label, status: enum(done|pending|fail|skip|warn), detail? }).min(1) }`. The results-gate verifier: acceptance criteria with state pills.

### 6b. Ranking / progress / structure (cheap)
- **`bar_list`** — `{ ...base, type:'bar_list', items: array({ label, value: number.nonnegative(), display? }).min(1), max?: number }`. Horizontal bars scaled to `max` (default = max value). Pure CSS, no chart dependency.
- **`progress`** — `{ ...base, type:'progress', value: number.nonnegative(), total: number.positive(), label?, tone? }`. One bar toward a target; static snapshot only.
- **`file_tree`** — `{ ...base, type:'file_tree', entries: array({ path: string.min(1), status?: enum(add|mod|del) }).min(1) }`. Client builds the indented tree from paths; clearer than a `graph` for pure hierarchy.
- **`comparison_matrix`** — `{ ...base, type:'comparison_matrix', criteria: string[].min(1), rows: array({ label, cells: array(enum(yes|no|partial)), recommended?: boolean }).min(2) }`. Options × criteria grid with ✓/✗/~ icons; `cells.length` must equal `criteria.length` (zod refine).

### 6c. Media + panels + markdown boost (carry specific risk; ship after 6a/6b)
- **`image`** — `{ ...base, type:'image', src: string, alt: string.min(1), caption? }`. **Source is sandboxed by a zod refine:** allow only `data:` URIs or attachment URLs / whitelisted in-app paths (reuse `fileView.ts` viewable-href logic). No arbitrary remote `<img src>` (avoids request-leak / pixel-tracking). Highest-leverage gap-closer: visual proof at the results gate, which is text-only today.
- **`tabs`** — `{ ...base, type:'tabs', tabs: array({ label: string.min(1), blockRefs: string[].min(1) }).min(2) }`. Switch panels within one card; each tab references **existing block ids** (reusing the established `blockRefs` indirection), so a tab can hold an `evidence`, `table`, or `diff_stat` block (e.g. Diff / Tests / Logs). Introduces local UI state and a `cardWorkspace` rule: a block referenced **only** by a tab renders inside the tab and is **not** also emitted as a standalone/global block (no double-render). This is the most complex widget; if its entanglement with sections proves heavy during planning, it may be split into its own follow-up.
- **Markdown booster** — upgrade the `Markdown` component in `BlockView.tsx`:
  - Add code-fence syntax highlighting (lightweight `rehype-highlight`-class plugin; avoid heavy bundles).
  - Keep **raw HTML disabled** (do *not* add `rehype-raw`) — this is the XSS safety that justified skipping the `html` widget; document it as a deliberate invariant.
  - Style the full remark-gfm surface (tables, task-lists, strikethrough, autolinks) and tighten `.prose` typography.

## 7. Phase 2 + 3 — Mixable sections

### 7.1 Schema (Phase 2)
New `src/shared/section.ts`:
```
Section = z.object({
  id, title?,
  kind: z.enum(['decide','explain','report']),
  blockRefs: z.array(z.string()).default([]),
  decisionRefs: z.array(z.string()).default([]),   // only meaningful on 'decide'
  collapsible?: boolean,
})
```
Sections reference **existing** block ids and decision ids — one id space, embeds nothing, mints no new ids. Add **one optional field** `sections?: Section[]` to:
- `Card` in [card.ts](../../../src/shared/card.ts) (alongside `orphanedAt`/`fingerprint`/`answers` — the established back-compat-safe precedent).
- `ClarifyInput` and `PresentPlanInput` in [inputs.ts](../../../src/shared/inputs.ts).
- **Not** `ReviewResultsInput` — results owns the `${claimId}/${blockId}` evidence id-namespace and is **hard-excluded** from sections (any ref there would silently route to the wrong claim).

### 7.2 Validation gating (the riskiest change — stated per gate)
- `checkBlockRefs` — runs **always**, both modes.
- `checkQuestionAndGlobalContext` (the "each decision ≥1 blockRef" + "≥1 unreferenced global block" rules) — wrap its body to run **only when `input.sections === undefined`**.
- New `checkSections(input, ctx)` — runs **only when sections present**: unique section ids; every `blockRef`/`decisionRef` resolves to a real block/decision; **every non-verdict decision is referenced by exactly one `decide` section** (strict on decisions — no decision silently vanishes); blocks may be referenced by zero sections (lenient); `decisionRefs` only on `decide` sections. Skips verdict ids (`PLAN_VERDICT_ID`) exactly as the existing helper does.
- `PresentPlanInput`'s STRUCTURAL-block check and exactly-one-recommended check are **separate `ctx.addIssue` blocks** (inputs.ts:77-93), not inside the gated helper — they run **unconditionally in both modes**. A test pins this.

### 7.3 Compile (Phase 2)
`compile.ts` threads the optional field through `compileClarify`/`compilePlan` as `...(input.sections ? { sections: input.sections } : {})`. `compileResults` is **unchanged**. `fingerprint()` is **unchanged** — sections never enter it. `compile.ts` stays **pure** (no `store`, no I/O).

### 7.4 Rendering (Phase 3)
- `cardWorkspace.ts` — when `card.sections` is absent, **synthesize** the identical decisions-then-global layout as a default section list, so `CardView` always renders via `sections.map(renderSection)` and produces byte-identical output for legacy cards.
- **`linkedBlocks` resolution (locked):** keep `visualSummary.totalBlocks = card.blocks.length`; define `linkedBlocks` as "blocks referenced by any visible (non-verdict) decision's `blockRefs`" in **both** modes (the existing semantic at `cardWorkspace.ts:29-31`). Blocks placed only in a `context`/`explain` section are **not** counted as linked — preserves CardHeader's cockpit-stat meaning. Pinned by a `cardWorkspace` test.
- `CardView.tsx` — replace the hardcoded `choiceDecisions.map(...)` + single global-context block (lines ~249-277) with `workspace.sections.map(renderSection)`: a `decide` section renders `DecisionSection` + `QuestionContext` rows; an `explain`/`report` section renders its blocks via `BlockView` (prose `Disclosure` only when `collapsible` and content is prose). The `resultsMode` branch (~204-237) and the submit bars (~279-319) are **untouched**.

## 8. Deferred (own go/no-go gates — captured, not built)

### 8.1 Session widget library
~13 files, de-purifies `compile.ts`, zero current cross-gate consumer. **Park entirely.** If a per-session report is ever wanted, the simpler path is a read-only route grouping **existing stored cards** by `session.project` — no widgets table, no `widget_ref` block, no `register_widget` tool, no `compile.ts` change.

### 8.2 Per-question clarification subagents — recommended architecture (for its future gate)
The literal "pre-spawn one subagent per question" is unsafe/unfit: the main session is provably frozen mid-gate (`makeHangingHandler` awaits one Promise; MCP notifications are one-way), `--resume` races a live turn, and pre-spawned pollers leak. **Recommended = Option B′ — a daemon-spawned *stateless* answerer:**
1. **Storage** — new `clarifications` sqlite table (parse-on-write/skip-on-read, mirroring `captured_sessions`), keyed by per-question `randomUUID`: `{ id, card_id, decision_id, question, answer?, status, error?, created_at, answered_at? }`. New `src/shared/clarification.ts`. **Card schema untouched.**
2. **Events** — `Queue.askClarification` / `recordAnswer` emit on a sibling channel; existing `decide`/`disconnect`/`park` also `closeClarificationsForCard`; `orphanAllPending` closes stale rows on boot (no zombie "thinking…" threads). The gen-guarded waiter machinery is never touched.
3. **Answerer** — new `src/harness/claude-code/answerer.ts` (modeled on `waker.ts`), wired in `app.ts`. Resolves the session fail-closed; spawns a **fresh stateless** `claude -p --permission-mode plan` (read-only at the tool level — cannot edit files or fork the transcript), captures stdout, POSTs the answer.
4. **Routes/UI** — `POST/GET /api/cards/:id/clarifications` + internal answer route; SSE `clarification` frames (old tabs ignore unknown event types). A read-only per-decision thread, **never** through the `DraftAnswer` map.
- **Honest caveat (product expectation before any code):** a stateless answerer answers from the card JSON + disk, not the paused agent's in-memory reasoning — grounded, not authoritative. This is exactly why Phase 1 ships `callout.detail` first: the agent authoring "why this option" up front covers ~80% of the need with zero new infra.

## 9. Testing strategy

- **Phase 0:** golden-render snapshot (flat clarify/plan/results); fingerprint-invariant test; `noImplicitReturns` makes omissions compile errors.
- **Phase 1:** per-widget render tests + zod parse/reject tests (esp. `image` src sandboxing, `comparison_matrix` cell/criteria length, `tabs` blockRef resolution).
- **Phase 2:** input-validation tests for both modes — sectioned and flat — proving the gated helper + the always-on STRUCTURAL/recommended checks; results-excluded-from-sections test.
- **Phase 3:** the golden snapshot must stay green; `cardWorkspace` test pinning `linkedBlocks`/`totalBlocks`; a sectioned-card render test.

## 10. Risks

- `CardView` is the load-bearing 328-line component; the Phase 3 section-loop rewrite guts the clarify/plan branch. The golden snapshot is a **gating precondition**, not a nicety.
- `tabs` is the most entangled widget (local state + block-ref dedup in `cardWorkspace`); may be split out if planning shows it fighting the sections model.
- `image` source sandboxing must be airtight (refine + reuse `fileView` allow-list) or it reintroduces the request-leak surface the `html` skip avoided.
- The widget set is broader than the lean recommendation; mitigated by sub-phasing 6a/6b before 6c and shipping each phase independently.

## 11. File-by-file impact (foundation)

| File | Change |
|---|---|
| `tsconfig.json` | enable `noImplicitReturns` |
| `web/src/evidenceChip.ts` | exhaustiveness `never` guard + one `case` per new widget |
| `src/shared/blocks.ts` | 7 new zod members added to the `Block` union |
| `web/src/blocks/BlockView.tsx` | 7 new `KIND` entries + `case`s; markdown booster; reusable prose `Disclosure` |
| `src/shared/section.ts` | **new** — `Section` schema |
| `src/shared/card.ts` | optional `sections?: Section[]` on `Card` |
| `src/shared/inputs.ts` | optional `sections` on Clarify/Plan inputs; gated `checkQuestionAndGlobalContext`; new `checkSections` |
| `src/daemon/compile.ts` | thread `sections` through clarify/plan; results + fingerprint untouched |
| `web/src/cardWorkspace.ts` | synthesize default sections; pin `linkedBlocks` semantics; tab-ref dedup |
| `web/src/CardView.tsx` | render via `sections.map(renderSection)`; results branch + submit bars untouched |
| `package.json` | add a lightweight syntax-highlight rehype plugin |
