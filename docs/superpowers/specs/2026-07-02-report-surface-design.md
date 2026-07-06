# Report Surface & Gate Loosening — Design

**Date:** 2026-07-02
**Status:** Plan approved on boardroom (card `cf7ea64f`). Spec lock pending (`present_spec`).

## Vision

Boardroom becomes the primary surface for supervising agent sessions (Claude Code, Codex, any MCP client): the human sees **blockers** (decisions) and **results** (reports). Mid-stream execution noise — command runs, tool chatter — is not part of the human contract.

## Problems today

1. **All four gates are decision-shaped.** There is no way to deliver a result presentation or issue explanation without freezing the agent on a card that has nothing to decide. `clarify` requires ≥1 decision; plan/spec/results auto-append verdicts; there is no acknowledge-only or read-only path anywhere.
2. **Card context arrives missing, limited, or confusing.** Agents have too few presentation options (sections only on clarify/plan; spec/results have fixed shapes) and the gate rules are too prescriptive about what each gate may present.
3. **Cards carry no provenance.** No card↔session binding exists: reattach resolves by fingerprint + most-recent, the waker overwrites by cwd, the dashboard picks `pending[0]`. The human cannot tell which session or topic a card belongs to — observed live on 2026-07-02 ("I don't know which session you are referring to").

## Approved decisions

| Decision | Choice | Note |
|---|---|---|
| Elaboration model | **Two-way replies** | Follow-up threads answer confusion; a **subagent living in the owning session** (has context, can't corrupt the main thread) produces the answer. Starting point for boardroom-only session management. |
| Gate loosening | **All gates: full palette + sections** | Any gate can use any block/widget to present information — but each gate keeps its **dedicated, isolated role** in the development lifecycle. |
| Session-progress view | **Deferred (P4)** | Seed sketch: stage/event **tags** denote progress inline; full history / secondary info offloads to an **explicitly-opened drawer**. For session progress management only. Design later, after P1–P3. |

Gate roles after this work: `clarify` = scoping, `present_plan` = plan approval, `present_spec` = scope lock, `review_results` = completion verdict, `present_report` = convey information (never a completion path).

## Architecture

### P0 · Card provenance & session binding

- Bind every card to its owning agent-session id at creation (revive the dead `claude_session_id` plumbing from Part 2).
- Card header shows: origin session title, project, and a one-line trigger context ("what conversation produced this card").
- Reattach, waker, and dashboard resolve cards **by binding** — never by fingerprint/most-recent, cwd, or `pending[0]`.

### P1 · `present_report` + report tray

- New MCP tool `present_report`: **strictly non-blocking** — posts and returns immediately (card id + dashboard URL). The agent never pauses.
- Content: full block palette + report sections. The card is a glanceable executive summary; the full document opens in a drawer (SpecDrawer pattern — this is the "future report page" the `report` section kind reserved).
- Tray: read/unread state, **separate from the pending-decision queue**. Reports never inflate the "needs you" badge.
- Guardrail: tool description states a report is not a FINISH — `review_results` remains the only way to close a session.

### P2 · Elaboration channel (two-way)

- A human reply on a report routes back to the **owning session** (P0 binding) via the existing decision-injection/waker path.
- Agent-side protocol: on receiving a report follow-up, dispatch a **subagent** with session context to answer; the answer posts as a new report threaded to the parent (`parent_report_id`). The main thread continues unharmed.
- The tray renders report + follow-ups as a thread.

### P3 · Loosen the gates

- Mixable decide/explain/report sections on **all four** existing gates (today: clarify/plan only).
- Full block palette everywhere; `report` sections on any decision card are **also collected into the report tray** (one tray, two feeders).
- Tool descriptions rewritten from prescriptive shape rules to intent guidance ("give the reader what they need"), while keeping role isolation per gate.

### P4 · Session progress view (deferred)

Direction locked, not designed. Seed sketch above (stage tags + history drawer). Prerequisite: P1–P3 have moved everything meaningful onto cards.

## Acceptance criteria (candidates for spec lock)

1. A pure report reaches the human with **zero agent pause** — `present_report` returns immediately, never blocks, never parks.
2. Reports never appear in the pending-decision queue or badge; they land in a distinct tray with unread state.
3. Every card displays its origin session and trigger context; with multiple concurrent sessions in the same cwd, decisions and replies route to the **correct** session.
4. A reply on a report arrives in the owning session and yields a threaded answer report without derailing the main task (subagent answers).
5. All four gates accept the full block palette and sections; validation still enforces each gate's verdict semantics (no role drift).
6. `review_results` remains the only completion path — a session cannot be closed via `present_report`.

## Non-goals

Windows/cross-platform support (macOS-only by design), cloud transport (halted), the full session timeline (P4, deferred), renaming existing gates.
