# Boardroom — spec gate calibration

**Date:** 2026-06-26
**Status:** draft pending user review
**Builds on:** the spec gate (`955f14a`) and recall drawer.

## 1. Problem

The spec gate is sound but mis-calibrated in practice:

1. **It rarely fires.** The guidance every session reads — the SessionStart hook
   (`hooks/session-start.sh`) and the user's global `~/.claude/CLAUDE.md` — never
   mentions `present_spec` (0 references). Agents don't know the gate exists.
2. **When it fires, the spec can drift from the decisions** the human just made,
   or arrive as a wall of jargon — hard to trust at a glance.
3. **Locking is all-or-nothing per entry.** Strict validation forces a keep/adjust/
   drop on *every* criterion before "Lock spec" enables. Safest, but slow — the
   human wants to skim and flick gates/nays, like marking up a plan.

Decided on clarify card (this session): trigger on **substantive tasks (the plan
bar), skip trivial**; locking is **one-click "Keep all & lock", edit exceptions**.

## 2. Three changes

### 2.1 Make it fire — wire the gate into the guidance (root cause)

- **`hooks/session-start.sh`**: add the spec step to the injected workflow, between
  DECIDE and FINISH, with the trigger policy: *after plan approval (or any
  substantive task), call `present_spec` with criteria distilled from the LOCKED
  decisions — each criterion traces to a specific decision; keep them terse and
  jargon-free; trivial/mechanical tasks skip it.*
- **Global `~/.claude/CLAUDE.md`**: the same paragraph (offered to the user — it's
  their personal config). Without this, no session fires the gate.
- **`present_spec` tool description**: demand short, plain-language criteria that
  each cite the decision they enforce (anti-drift + anti-jargon at the source).

### 2.2 Decision-anchored presentation (anti-drift, scannable)

Render the spec card so each criterion sits **under the decision it traces from**,
so the human reads it as "my decision → the outcome it implies," and any criterion
that doesn't map to a decision is obvious. Group by `tracesTo`. Each row stays
terse: behavior + good ✓ / bad ✗, the trace shown as the group header (not repeated
as jargon in every line).

### 2.3 Plan-style markup locking (fast, still safe)

- Every criterion **defaults to keep**. The human skims and only acts on exceptions:
  a one-tap **veto (drop)** or **adjust** per row.
- **"Lock spec"** is always enabled; on submit, any untouched criterion is recorded
  as **keep**. (Drop `validationScope`'s strict-all requirement for spec lock; the
  one-click lock fills unaddressed → keep.)
- A small **"Keep all"** affordance resets vetoes, mirroring the results card's
  "Approve all." So: skim → flick a couple of nays → one click to lock.

Net: the safety of per-criterion control (every item visible and overridable) with
the speed of marking up a plan.

## 3. Scope / phasing

| Phase | Ships |
|---|---|
| **1 (this plan)** | guidance wiring (hook + offer global CLAUDE.md + tool description); plan-style lock (default-keep, one-click lock, per-row veto/adjust, Keep-all); decision-anchored grouping on the spec card |
| **later** | richer "why this criterion" linkage (click a criterion → the source decision card), spec diff across revise rounds |

## 4. Testing

- **Guidance:** the hook output contains the spec step + trigger policy (snapshot).
- **Lock:** `validationScope` allows spec lock with untouched criteria; the submit
  fills them as keep; a vetoed criterion records "drop"; "Keep all" clears vetoes.
- **Grouping:** criteria render grouped by `tracesTo`; an untraced criterion falls
  into an "ungrouped" bucket (visible, not hidden).
- Backward compatible: existing spec/clarify/plan/results behavior unchanged.
