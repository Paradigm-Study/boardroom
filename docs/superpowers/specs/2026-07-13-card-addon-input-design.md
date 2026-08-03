# Card add-on input — global "add to session" channel on every gate

**Status:** approved (plan card 4de08afc, 2026-07-14) — keep the results
derivation; migrate the results box onto the global channel with a legacy read.
**Date:** 2026-07-13

## Problem

Every boardroom gate blocks the session until the human decides — but only the
*results* gate lets the human append free-form instructions to the session
alongside the decision ("Add anything for the agent", `results_verdict.note` +
attachments). Plan/spec only carry a note when *sending back*; clarify has no
card-level channel at all. The human wants to always be able to add commands,
context, and explanations to the current session's work, on any gate.

## Direction (decided on the clarify card e34f2e63)

- **Global, not per-gate**: this is a card-level layout + data-structure
  concept. Any card stage — current or future — ends with an add-on section.
  No per-stage wiring.
- **Always visible**: compact textarea + attachment input docked above the
  submit bar (the shipped results pattern).
- **Verdict-neutral**: the add-on never alters the decisions above it. It is
  its own section in the summary that instructs the agent. No binary flag.

## Design

### Data model (src/shared/card.ts)

Reserve a stage-agnostic answer id:

```ts
export const CARD_ADDON_ID = 'card_addon'
```

The add-on rides the existing open `DecisionAnswers` record as
`answers[CARD_ADDON_ID] = { chosen: [], note, attachments? }`. No schema
change: `DecisionAnswer` already allows empty `chosen` and carries
`note`/`attachments` (text + multimedia); `Queue.validateAnswers` iterates
`card.decisions` only, so the extra key passes validation untouched and lands
in `card.answers` and `CardResponse.decisions`.

`src/shared/inputs.ts` gains a refinement: agent-authored decision ids,
claim ids, and criterion ids must not collide with the reserved id.

### Summary (src/shared/summary.ts)

A single stage-agnostic renderer: when `answers[CARD_ADDON_ID]` has a
non-blank note or attachments, every stage's summary appends its own section:

```
Added instructions — act on these:
<note>
[attachments list]
```

Results keeps a legacy read: old decided cards that stored the add-on on
`results_verdict.note` still render. Existing property-test invariants hold
(no dangling labels, no `Added instructions:` with blank content,
deterministic output).

### Web UI

- One `CardAddon` component (textarea + `AttachmentInput`, always visible)
  rendered by `CardView` above the submit bar for **every** stage; the
  results-specific add-on box in `ResultsFinish` is replaced by it.
- State lives in the `useCardAnswers` map under `CARD_ADDON_ID`, so it rides
  the existing localStorage draft persistence (survives reload).
- Attachment uploads reuse `POST /api/cards/:id/attachments` with
  `answerId=card_addon, field='note'`.
- Submit drops the add-on entry entirely when note and attachments are both
  empty (no empty `card_addon` key on the wire).
- Golden flat-card snapshots are deliberately rebaselined.

### Results-gate session state (pending decision)

Decided: keep the one derived behavior — when the add-on is non-empty the
finish button reads "Keep going" (verdict `continue`), because a session with
standing instructions is by definition not complete. Claim approvals ride
through unchanged; nothing above the add-on is altered.
`deriveResultsVerdict` reads the global add-on instead of the verdict note.

Human rationale (plan card): any prompt given to an agent causes it to act, so
instructions inherently mean "keep going" — no explicit flag is needed. The
add-on may be side notes alongside approval or fresh ideas for the session;
either way the session stays alive until a review round arrives with an empty
add-on and all claims approved.

Alternative (rejected unless chosen on the card): fully neutral — all claims
approved derives "Mark complete" even with add-on text; the summary would say
"COMPLETE — after handling the added instructions". Risk: the agent ends the
session and the instructions become unread parting notes.

### Agent-facing contract (src/daemon/mcp.ts)

Gate tool descriptions gain one line: the human may append added
instructions on any gate — treat them as tasks in the current session.
`formatGateResult` is unchanged (the summary carries the section).

## Out of scope

- Reply threads on report entries (P2 of the report surface).
- Post-decide follow-up messages to a card that already resolved (the add-on
  rides the decide payload only).
