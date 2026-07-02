# Boardroom — spec recall panel + widget-enriched spec card

**Date:** 2026-06-26
**Status:** draft pending user review
**Builds on:** `docs/superpowers/specs/2026-06-23-spec-gate-design.md` (the spec gate, shipped in `955f14a`)

## 1. Problem

The spec gate locks a behavior-driven contract, and `review_results` judges it
criterion by criterion — but only **once**, at review time. Mid-thread, there is
no way to pull the locked contract back up and cross-compare it against what the
agent has actually returned. The human asked for two things:

1. A **recallable Spec panel** per session — evoke the contract any time and see,
   per criterion, what the agent claimed and whether it's met.
2. The spec card itself to **read richer** — lean on the widget vocabulary
   (`progress`, `callout`) instead of a bare checklist.

Both decided on clarify card `d059d423`: **per-session panel** (the human noted it
"could be a drawer that opens on the side or simply a popover") and **enrich with
widgets now**.

## 2. Key insight — it's all already persisted

No new storage is needed. Every decided card is in the daemon's `cards` table and
served by `GET /api/cards`:

- the locked **spec card** carries `criteria` + the human's per-criterion
  keep/adjust/drop `answers` → the *locked contract*;
- each **results card** carries the echoed `criteria` and per-claim `answers`,
  with each claim decision tagged `criterionId` → *what the agent claimed, and how
  it was voted*.

The panel is a **pure read-model** over these, keyed by `session.project` (the same
key the inbox/folders group by). Worktree caveat: two checkouts share a project
basename; acceptable for V1 (matches the existing inbox), revisited if it bites.

## 3. The recall panel (read-model)

`buildSpecRecall(cards, project)` → a view model:

```ts
interface SpecRecall {
  goal?: string
  criteria: {
    id, behavior, good, bad, tracesTo,
    status: 'met' | 'unmet' | 'dropped',        // dropped = removed at lock
    adjustedNote?: string,                        // if the human reworded it
    claims: { claim: string; vote: 'approve'|'revise'|'reject'|'pending'; evidenceRef?: string; resultsCardId: string }[],
  }[]
  metCount: number; total: number                 // for the progress widget
  sourceSpecCardId?: string
}
```

- **Locked contract** = the latest decided `spec` card's criteria minus the ones
  the human `drop`ped, carrying any `adjust` notes (reuse the same reduction the
  summary builder already does).
- **Met/unmet** = the §6 rule from the spec gate: a criterion is **met** iff some
  claim mapped to it (across the project's results cards) was approved.
- **Claims** = every results-card claim whose `criterionId` matches, newest card
  first, with its vote and a link to its evidence block.

This logic is shared shared-side (`web/src/specRecall.ts`, unit-tested) so the
panel and any future surface read one definition.

## 4. UI — the panel

A **non-modal surface** opened from a "Spec" affordance on any card belonging to a
session that has a locked spec. Open question for the plan: **side drawer** vs
**popover** (see the wireframes). It renders, top-down:

- a `progress` widget — `metCount / total criteria met`;
- the goal as a `callout`;
- per criterion: the `acceptance` row (good ✓ / bad ✗ / trace) + a met/unmet pill,
  with its agent claims and evidence links nested beneath; a `callout` (danger
  tone) when an UNMET criterion's bad outcome is the live risk.

Strictly a read surface — no decisions, no binding. It never blocks; it just
reflects persisted state and refreshes on the same SSE card stream the inbox uses.

## 5. Spec card enrichment

The `present_spec` card's acceptance rendering gains:

- the goal rendered as a `callout` (info) instead of plain italic text;
- per-criterion `good`/`bad` kept, with the `bad` line styled as the anti-goal.

Note: a `met/total` **progress** bar is *not* meaningful on the spec card at lock
time (nothing is built yet) — it lives in the **recall panel**, where there is
real progress to show. So "progress + callouts" splits cleanly: callouts enrich
the spec card; progress + met/unmet enrich the panel.

## 6. Scope / phasing

| Phase | Ships |
|---|---|
| **1 (this plan)** | `specRecall.ts` read-model + tests; the panel UI (drawer/popover) wired to `/api/cards` + SSE; the "Spec" open affordance on cards with a locked spec; spec-card callout enrichment |
| **later** | richer evidence inline (diff/test snippets in the panel), cross-session spec history, export the cross-compare |

## 7. Testing

- **`specRecall.ts`:** locked-contract reduction (drop/adjust), met/unmet across
  multiple results cards, newest-first claim ordering, a criterion with no claim,
  a project with no spec card (panel hidden).
- **Panel component:** renders progress + per-criterion rows from a fixture view
  model; met vs unmet styling; empty state; no binding controls present.
- **Spec card:** the goal renders as a callout; criteria unchanged.
