# Report Surface & Gate Loosening — Design

**Date:** 2026-07-02
**Status:** Spec LOCKED on boardroom (2026-07-02); sequencing resolved same day — **session-stream spine pivot committed** (clarify card `9a064f50`).
**P0 (session spine): IMPLEMENTED 2026-07-02** — commits `ad710db..6f07381` (12 tasks + final-review fixes; plan: `docs/superpowers/plans/2026-07-02-p0-session-spine.md`; per-task ledger: `.superpowers/sdd/progress.md`). Criterion 3 delivered: cards bind to their owning CC session via hook-injected `sessionKey`; reattach and waker route by binding (both cross-session steal bugs fixed, characterization suites flipped); web groups by real session id with `#/session/<id>` streams and inbox status tags. Criterion 6 preserved. Criteria 1, 2, 4, 5 remain for P1–P3.

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

## Architecture (amended 2026-07-02 — session-stream spine)

### P0 · Session spine

- Sessions become first-class: **one Claude Code session = one boardroom session** (a scrollable stream), created at MCP handshake; every card, report, and tag is an entry in exactly one stream.
- Real-time sync rides the existing SSE plumbing and session capture (PR #1); only human-relevant entries stream (curated v1 below).
- Provenance is structural — reattach, waker, and dashboard route by stream membership; fingerprint/most-recent/cwd/`pending[0]` resolution is **deleted**, not patched.
- Each session carries a **status tag** (running / needs-decision / awaiting-review / idle) surfaced in the inbox — "flag its role," per the human's note.

### P1 · Report entries (`present_report`)

- New MCP tool `present_report`: **strictly non-blocking** — posts a report entry into the session stream and returns immediately (entry id + dashboard URL). The agent never pauses.
- Report card = glanceable executive summary (full palette + report sections); the full document opens in a drawer (SpecDrawer pattern — the "future report page" the `report` section kind reserved).
- Per-entry unread state; the inbox aggregates unread-report counts **separately from blockers** — reports never inflate the decision badge.
- Guardrail: a report is not a FINISH — `review_results` remains the only way to close a session.

### P2 · Elaboration channel (two-way)

- A human reply on a report routes to the **owning session** via its stream (structural binding from P0).
- Agent-side protocol: a follow-up is handled by a **subagent** with session context; the answer posts as a child report (`parent_report_id`). The main thread continues unharmed.
- The stream renders report + follow-ups as a thread.

### P3 · Loosen the gates

- Mixable decide/explain/report sections on **all four** existing gates (today: clarify/plan only).
- Full block palette everywhere; `report` sections on any decision card also surface as report entries in the stream (one reading surface, two feeders).
- Tool descriptions rewritten from prescriptive shape rules to intent guidance ("give the reader what they need"), while keeping role isolation per gate.

### Stream v1 contents (curated — decided 2026-07-02)

Decision cards (all four gates, blocking entries) + report cards (non-blocking entries) + stage/event tags (the old P4 sketch, promoted). Full history and secondary information live behind an **explicitly-opened drawer**, never pushed. Live command/tool mirroring is **out of v1** — the filtering problem must prove out first.

### Inbox → cross-session attention filter

The inbox stops being the primary container: it shows pending blockers across all sessions, unread-report counts, and each session's status tag. Streams are depth; the inbox is attention.

## Locked acceptance contract (2026-07-02, spec gate)

Locked via `present_spec`; human adjustments folded in. Criteria 1–3 carry a **pending sequencing amendment** (session-stream pivot — see open question below).

1. **Report delivery is non-blocking, and cards are the media — not the gate.** *(adjusted at lock)* The CC session feeds real-time data from which report cards render; only human-needed information surfaces — mid-progress noise is discarded; decisions may be integrated into reports. The agent never freezes on a card that has nothing to decide.
2. **Human-relevant reports only, never inflating the decision badge.** *(adjusted at lock)* Only information useful for the human to read is ported to the report surface; agent-only or result-irrelevant information stays hidden. Unread reports leave the pending-decision queue and badge untouched.
3. **Provenance is structural.** *(human queried wording at lock — clarified)* Original intent: every card carries a pointer to the CC session that created it (NOT one-card-one-session), so with 2+ concurrent sessions in one cwd, decisions and replies route to the correct session. Under the session-stream pivot this becomes structural: a card lives inside its session's stream and cannot be mis-attributed.
4. **A human reply on a report produces a threaded answer.** Reply reaches the owning session; a subagent with session context answers as a child report (`parent_report_id`); the main task continues undisturbed.
5. **All four existing gates accept the full block palette and mixable sections.** spec/results cards can carry sections and any block; validation still enforces each gate's verdict semantics — no role drift.
6. **`review_results` remains the only way to close a session.** Reports carry no verdict and cannot complete anything.

## Sequencing verdict (resolved 2026-07-02, clarify card `9a064f50`)

The human proposed at lock: **one Claude Code session = one boardroom session**, human-relevant events synced in real time, gates as continuous cards in one scrollable stream — because bouncing between boardroom and Claude Code is inconvenient. Verdict: **pivot the spine now** (not report-gate-first, not full event mirror); stream v1 is curated (gates + reports + stage tags); the inbox survives as a cross-session attention filter with per-session status tags. The Architecture section above reflects the amended shape.

## Non-goals

Windows/cross-platform support (macOS-only by design), cloud transport (halted), live command/tool event mirroring (deferred until stream filtering proves out), renaming existing gates.
