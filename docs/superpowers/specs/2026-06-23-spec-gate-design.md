# Boardroom — spec gate design

**Date:** 2026-06-23
**Status:** draft pending user review
**Builds on:** `docs/superpowers/specs/2026-06-11-boardroom-design.md`

## 1. Problem and vision

Boardroom today runs a three-stage loop — **clarify → plan → results**. The
human approves *how* the work will be done (the plan) and later judges *what
came back* (the result claims). But nothing in between pins down **what a good
outcome actually is**. Two gaps follow:

- **The human has no shared mental model of "done."** They steer the plan, then
  wait, then react to whatever claims the agent chooses to surface. Expectations
  are never written down, so "good" is decided ad hoc at review time.
- **"Keep going" has no fixed target.** When the human sends a results card back
  with `continue`, the agent loops against the human's notes and its own sense of
  the goal — not against an agreed contract. Convergence is by vibes.

The **spec gate** closes both. After the plan is approved, the agent distills the
locked decisions into a short, behavior-driven **acceptance contract**: a list of
criteria, each stating the *good* outcome we want, the *bad* outcome/anti-goal we
must avoid, and the decision it traces back to. The human locks or steers that
contract on the dashboard. From then on it is the definition of done: the agent
builds to satisfy every criterion, and `review_results` is judged criterion by
criterion, so the loop converges when all criteria are **met** and the human
accepts.

The core boardroom abstraction is unchanged: **decisions are buttons; everything
else is informational visuals.** A spec card is just a card whose decisions are
"keep / adjust / drop" per criterion plus a "lock / revise" verdict.

## 2. Decisions log

Settled with the human on the dashboard (clarify card `6c94461a`):

| # | Decision | Choice |
|---|---|---|
| C1 | Placement | New `spec` stage — a 4th gate between plan approval and work |
| C2 | Criterion shape | Good/bad behavior pair + a trace to the decision it enforces |
| C3 | Loop binding | Criterion-driven results — claims map to criteria; the summary leads with the **unmet** ones |

Open for the `present_plan` gate (recommendations in §7):

| # | Decision | Recommendation |
|---|---|---|
| P1 | How the human locks & steers criteria | Per-criterion keep / adjust / drop + a card-level lock / revise verdict |
| P2 | Where the locked contract lives in V1 | Stateless — the agent carries the locked criteria forward into `review_results` |
| P3 | Scope / phasing | Ship Phase 1 (gate + criterion-driven results) now; defer daemon-persisted, tamper-evident spec to Phase 2 |

Approved on plan card `2f7e619d` with all three recommendations, plus two
refinements that shape the build:

- **Boardroom owns the gate, not the authoring (P1).** *How* criteria are
  generated is not boardroom's job — there are already good skills for
  initializing a spec per task. Boardroom provides the gate (present → lock/steer
  → return the contract) and ships only a **light fallback** prompt for when no
  spec-authoring skill is driving. `present_spec` stays a thin facade; we do not
  engineer a criteria-generation methodology into it. (Consistent with base
  design decision #3: the agent distills its own content.)
- **Stateless, but session-resident (P2).** The contract does **not** live in the
  daemon/backend. It lives in the agent's session as an on-disk file — a
  `specRef`, mirroring `planRef` — that the agent writes when the spec locks and
  reads back whenever it needs to verify or review. This survives context
  compaction and keeps the daemon a pure queue. See §6.1.

## 3. The workflow, after the gate

```
clarify ──► plan ──► spec ──► (agent works) ──► results ──┐
                      ▲  the contract                     │
                      │                                    │
                      └──────── continue: unmet criteria ◄─┘
                                                  │
                                          all met + accepted ──► complete
```

1. **plan approved** — decisions are locked (`present_plan` verdict = approve).
2. **`present_spec`** — the agent distills those decisions into criteria and
   sends a spec card. The human reviews each criterion (keep / adjust / drop),
   may add criteria via notes, and locks the contract (or revises, sending it
   back). No second LLM: the agent authors the criteria, exactly as it already
   authors plans (design decision #3 of the base spec).
3. **work** — the agent builds against the locked contract.
4. **`review_results`** — each claim is tagged with the criterion it satisfies.
   The results card groups claims under their criteria; the response summary
   leads with **unmet** criteria (no claim, or all claims rejected).
5. **loop** — `continue` ⇒ the unmet criteria are the agent's marching orders.
   `complete` (human-set, as today) ends the session.

The spec, like the plan, is **advisory-before-the-gate**: it never replaces the
human's final `review_results` verdict, and the agent must still surface its
app's native approvals. It is a contract for *alignment and convergence*, not a
new auto-accept path.

## 4. Data model

### 4.1 Criterion (new shared type)

```ts
interface Criterion {
  id: string;          // stable; reused verbatim at results time
  behavior: string;    // the observable behavior under test ("auth tokens are stored")
  good: string;        // what a GOOD result looks like — the pass condition
  bad: string;         // the anti-goal — the failure we must avoid
  tracesTo: string;    // the decision/goal this enforces (free text, or a plan decision id)
  check?: string;      // optional: how it will be verified (e.g. "inspect localStorage")
  status?: 'unknown' | 'met' | 'unmet';  // unset at spec time; computed at results time
}
```

Worked example (traces to a plan decision "token storage = httpOnly cookie"):

> **behavior:** auth tokens are persisted client-side
> **good:** tokens live only in httpOnly cookies, unreadable from JS
> **bad:** any auth token written to `localStorage`/`sessionStorage` or other
> JS-readable storage
> **tracesTo:** decision `token_storage`

### 4.2 Stage and Card

- `Stage` enum gains `'spec'`: `"clarify" | "plan" | "spec" | "results"`.
- `Card` gains an optional `criteria?: Criterion[]`. It is set on spec cards (the
  proposed contract) and on results cards (the contract being judged), and is the
  single source the summary builder and dashboard read. Optional ⇒ clarify/plan
  cards and legacy rows are unaffected.

### 4.3 New block type: `acceptance`

A first-class, boardroom-rendered block so criteria render consistently (good ✓ /
bad ✗ / trace chip, plus a met/unmet state at results time) instead of as a raw
table. Added to the block discriminated union:

```ts
acceptance: {
  goal?: string;            // the overarching outcome the criteria serve
  criteria: Criterion[];    // rendered as a compact checklist
}
```

Rendering: each criterion is one row — behavior as the line, a green "good" and a
red "bad" sub-line, a small trace chip, and (results time only) a met/unmet
status pill. The block stays strictly informational; all binding happens through
the card's decisions (invariant from the base spec preserved).

## 5. Tool facade: `present_spec`

A fourth MCP tool, same hanging/parking engine as the other three.

### Input (`SpecInput`)

```ts
{
  project, title?,                 // session attribution, shared with the others
  headline,                        // one-line "what done & good means here"
  goal: string,                    // 1–2 sentences: the outcome the criteria serve
  criteria: [{ id, behavior, good, bad, tracesTo, check? }],   // >= 1
  specRef?: string,                // absolute path to the on-disk spec file (see §6.1)
  blocks?: Block[],                // optional extra context
}
```

Validation (Zod `superRefine`, mirroring the existing facades):

- `criteria` non-empty; `behavior`, `good`, `bad`, `tracesTo` each non-empty.
- Criterion ids unique — they become decision ids (`crit:<id>`) and results keys,
  exactly like claim ids in `review_results`, so duplicates are rejected at the
  boundary.
- No `/` collision rule needed (criterion ids are not namespaced), but ids are
  rejected if they would collide with the reserved verdict id.

### Compile (`compileSpec`)

Recommended (per P1, per-criterion control):

- For each criterion `c`: an `acceptance` block `crit/<c.id>` carrying just that
  criterion, plus a decision `crit:<c.id>` — prompt = `c.behavior`, options
  **keep** (recommended) / **adjust** (note required) / **drop** (note required),
  `blockRefs: [crit/<c.id>]`.
- A global `acceptance` block holding the `goal` (+ all criteria as an at-a-glance
  list), left unreferenced ⇒ global card context.
- A synthetic `SPEC_VERDICT` decision appended: **lock spec** (recommended) /
  **revise** (note required). The verdict note is the always-on card-level add-on
  — this is where the human types "add a criterion: …" or broad steering.
- `card.criteria` = the proposed criteria.

### Response summary (the agent's marching orders)

The `CardResponse.summary` leads with the **locked contract** — the final
criteria after keep/adjust/drop plus any added via notes — each rendered as
`GOOD … / BAD … / traces-to …`, followed by the dropped criteria as
"explicitly out of scope." It ends with a one-line instruction to persist the
contract to `specRef` (when given) so it survives into later turns.

### 5.1 Session-resident contract (`specRef`)

The locked contract must outlive the agent's context window, because `continue`
loops can span many turns and a compaction could drop it. Mechanism (stateless —
the daemon never touches project files):

1. The agent passes `specRef` (an absolute path, e.g.
   `docs/.../<task>-acceptance.md`) on `present_spec`, the same way `present_plan`
   takes `planRef`.
2. When the card resolves, the response summary tells the agent to **write the
   locked contract to `specRef`** — the criteria as finally kept/adjusted/added.
3. Whenever the agent needs to verify progress or assemble `review_results`, it
   **reads `specRef`** rather than relying on conversation memory, and echoes it
   into `review_results` (§6).

The daemon's only role is returning the locked text and surfacing `specRef` as a
header link for the human to drill into — exactly the `planRef` pattern. No
backend persistence (that is Phase 2).

## 6. Criterion-driven results (the loop binding)

`review_results` becomes spec-aware while staying fully backward compatible.

- **Input additions:** each claim gains an optional `criterionId`. A new optional
  top-level `spec: { goal?, criteria: [{ id, behavior, good, bad, tracesTo }] }`
  echoes the locked contract (stateless V1 — see P2; Phase 2 removes the echo by
  persisting the spec daemon-side). The echo is held to the **same id invariants**
  as `present_spec` (no duplicate / reserved-id criteria).
- **Boundary validation (fail-fast):** when a `spec` is echoed, every tagged
  claim's `criterionId` must name a criterion in that spec — an unmatched id is
  rejected with a structured Zod issue so the agent self-corrects, exactly like
  `ClarifyInput`'s `blockRefs` check. (This supersedes the earlier "surface an
  unknown id as unscoped" idea: a typo'd id would silently leave its criterion
  UNMET forever, so it is a boundary error, not a tolerated state.) A claim with
  **no** `criterionId` is allowed — a claim need not bind to the contract.
- **Compile:** when `spec` is present, `compileResults` stores `card.criteria` and
  tags each claim's decision with its `criterionId`.
- **Unmet computation:** a criterion is **met** iff some claim mapped to it was
  approved; otherwise **unmet** (no claim, or all of its claims revised/rejected).
- **Summary:** for results cards carrying criteria, `buildSummary` adds an
  **UNMET CRITERIA (n)** section (each unmet criterion's behavior + the bad outcome
  to avoid) right after the complete/continue line — *before* the rejected /
  revised / approved groupings. This is what makes `continue` concrete. Any claim
  not tied to a criterion is flagged with a one-line "not tied to any criterion"
  note (defense in depth if a stray id ever bypasses validation).
- **Backward compatible:** `review_results` with no `spec` behaves exactly as
  today (the whole criteria path is skipped).

The `RESULTS_VERDICT` (`complete` / `continue`) is unchanged and still
human-set — completion is never inferred from criteria status. But the summary
now warns when `complete` is set while criteria remain unmet, so the human
chooses with eyes open.

## 7. Open plan-level decisions (P1–P3)

**P1 — How the human locks & steers criteria.**
*Recommended: per-criterion keep / adjust / drop + a card-level lock / revise
verdict.* Gives the human fine control to reshape the contract (the whole point
of "steer with the proper mental model"), and reuses the existing claim-by-claim
card machinery. Alternative: one coarse approve/revise verdict over the whole set
plus a free-text note — cheaper, but the human can only accept or bounce the
entire spec, not surgically edit it.

**P2 — Where the locked contract lives in V1.**
*Recommended: stateless — the agent echoes the locked criteria into
`review_results`.* Keeps the daemon a pure queue (consistent with base design
decision #3: the agent carries its own content; no server-side plan memory).
Alternative (Phase 2): the daemon persists the locked spec keyed by the session
fingerprint lineage, so `review_results` auto-loads it and can flag tampering
(claims citing unknown criteria, or criteria silently dropped between lock and
review). Stronger guarantee, more build — deferred, door open.

**P3 — Scope / phasing.**
*Recommended: ship Phase 1 now, defer Phase 2.*

| Phase | Ships | Why this split |
|---|---|---|
| **1 (now)** | `present_spec` + `spec` stage, `Criterion` type, `acceptance` block, per-criterion lock card, criterion-driven `review_results` (stateless echo), unmet-first summary, agent-snippet paragraph, full test suite | The end-to-end behavior change the human asked for, shippable as one reviewable slice |
| **2 (later)** | Daemon-persisted authoritative spec, tamper-evidence, spec in the decision-log history, reminders threaded to the contract | Hardening + provenance; valuable but independent, and not needed to prove the loop |

## 8. Dashboard UX

- **`acceptance` block renderer** (the one genuinely new component): criteria as a
  checklist — behavior line, good ✓ / bad ✗ sub-lines, trace chip, and a met/unmet
  status pill *when a criterion carries `status`* (met/unmet/unknown each styled).
- **Spec card** reuses the generic card renderer: N per-criterion decisions in
  the rail + the lock/revise submit bar, exactly like a results card's claims +
  verdict. The only new surface is the acceptance block.
- **Results card / met-unmet signal (Phase 1):** met/unmet is computed at decide
  time and surfaced through the **response summary text** (the UNMET CRITERIA
  section) — the agent's loop target. The criteria render on the card, but live
  visual met/unmet pills (which depend on the human's in-progress votes) are a
  Phase 2 polish; in Phase 1 nothing sets `status` on a pending results card.
- **Stage badge** gains a `spec` variant in the inbox and history.

## 9. Failure handling

| Failure | Behavior |
|---|---|
| Invalid `SpecInput` / echoed spec | MCP error with structured Zod issues (duplicate / reserved criterion ids on either `present_spec` or the `review_results` echo); agent retries |
| Claim cites an unknown `criterionId` | Rejected at the `review_results` boundary with a structured issue (a typo would otherwise leave its criterion UNMET forever); agent self-corrects |
| Human takes too long | `present_spec` parks like the others — returns the `PARKED_TEXT` hard-STOP sentinel, orphans the card; reattach by fingerprint `(project, 'spec', headline)`; never auto-locks |
| Spec sent back (`revise`) | Validates only the verdict (sub-criteria need not be answered); agent adjusts and re-presents. The delivered card is not reattachable, so a re-issue with new criteria is a fresh card |
| Every criterion dropped at lock | Summary leads with "no contract to build against" (not "build to this contract") and skips the write-to-`specRef` instruction |
| `review_results` without a spec | Identical to today; criteria path skipped |
| `complete` set with criteria still unmet | Allowed (human is sovereign) but the summary flags it |
| Agent alters the contract between lock and review (stateless V1) | Visible in the grouped results; not yet machine-detected — Phase 2 adds tamper-evidence |

## 10. Testing

- **Schema fixtures:** valid/invalid `SpecInput` — empty criteria, missing
  good/bad/behavior/tracesTo, duplicate criterion ids, reserved-id collision.
- **`compileSpec`:** per-criterion decisions + blockRefs, global goal block,
  appended `SPEC_VERDICT`, `card.criteria` populated.
- **`compileResults` with spec:** `criterionId` tagged onto each claim decision,
  `card.criteria` populated; backward-compatible with no spec.
- **Unmet computation + `buildSummary`:** criterion with no claim ⇒ unmet;
  all-rejected ⇒ unmet; one approved (even alongside another rejected) ⇒ met;
  unmet-first ordering; `complete`-while-unmet warning; unscoped-claim note.
- **Echo validation:** `SpecEcho` rejects duplicate / reserved-id criteria;
  `review_results` rejects a claim citing an unknown `criterionId`; an untagged
  claim is accepted.
- **Spec adversarial (`spec-gate.adversarial.test.ts`):** lock with every criterion
  dropped (no-contract message, no `specRef` write); a criterion met by one of two
  claims (any-approved ⇒ met); a criterion with no claim ⇒ unmet; a stray
  `criterionId` doesn't crash compile/summary (stays unscoped).
- **Integration (real MCP client + fake browser):** `present_spec` → lock with one
  adjust + one drop → assert locked-contract summary; then `review_results` echoing
  the spec → reject a criterion's only claim → assert unmet-first summary and
  `continue`.
- **Adversarial:** drop every criterion; criterion with zero claims; claim citing
  an unknown criterion id (stateless V1: surfaces as unscoped, no crash).
- **Dashboard:** `acceptance` block renderer (spec-time vs results-time states);
  stage badge; spec-card lock submit gating.

## 11. Agent protocol (CLAUDE.md / `agent-snippet.md`)

Boardroom is the **gate**, not the spec author. Authoring criteria is left to
whatever spec/brainstorming/plan skill the agent already uses; the snippet is a
**light fallback** for when none is driving — it tells the agent *to run the gate*
and the *format* to send, not a methodology for inventing criteria. One paragraph,
after the plan step:

> **Spec the outcome (gate):** once the plan is approved, call `present_spec` with
> acceptance criteria — each a *good* outcome, a *bad* anti-goal, and the decision
> it traces to. If you have a spec/acceptance skill, use it to derive the criteria;
> otherwise distill them straight from the locked decisions. The locked contract is
> your definition of done: write it to `specRef` so it survives later turns. When
> you finish, call `review_results` echoing that spec (read back from `specRef`) and
> tag each claim with its `criterionId`; if the summary lists unmet criteria, those
> are your next tasks — re-submit until every criterion is met and the human marks
> the session complete.

## 12. V1 scope and deferrals

**V1 (Phase 1):** `present_spec` tool + `spec` stage, `Criterion` type,
`acceptance` block + renderer, per-criterion lock card, criterion-driven
`review_results` (stateless echo), unmet-first summary, stage badge, agent-snippet
paragraph, full unit + integration + adversarial tests.

**Deferred (Phase 2), door open:** daemon-persisted authoritative spec keyed by
session lineage; tamper-evidence between lock and review; spec entries in the
decision-log history; contract-threaded reminders.
