# Plan: boardroom as the enforced session workflow (2026-06-17)

Make every Claude Code session route its decisions, plans, and result approvals
through boardroom. Locked scope (via clarify card 24953bbe):

- **Enforcement = gated**: deny-once PreToolUse hooks on the three surfaces + a
  deny-once Stop hook requiring `review_results` before finishing substantive work.
- **Triviality = agent's judgment**: simple skill calls / automatable / trivial
  tasks proceed; genuine decisions, plans, substantive results route to boardroom.
- **Boardroom = sole gate**: once a plan is approved on the dashboard, the native
  ExitPlanMode gate is auto-passed (PreToolUse `allow`). Reverses the prior
  "native approval stays final" invariant.
- **Session start = protocol reload** via a SessionStart hook (daemon-gated). No
  new dashboard/session-entity feature.

## Build phases

1. **SessionStart hook** (`hooks/session-start.sh`): if the daemon is reachable,
   emit the boardroom protocol as `additionalContext` so it's active every session.
2. **Rewrite the CLAUDE.md boardroom protocol**: encode the agent-judges-triviality
   rule, sole-gate semantics, and the review-before-finish requirement.
3. **Sole-gate plan hook** (`hooks/check-plan.sh`): when an *approved* plan card
   exists for the project, return `allow` (auto-pass the native gate); otherwise
   deny-once redirect (today it only checks a plan card *exists*, not its verdict).
4. **Stop gate** (`hooks/require-review.sh`): deny-once; on Stop, if the session
   shows edit/write/commit activity and has no approved `review_results` card for
   the project, instruct the model to call `review_results`. Deny-once so it never
   hard-locks.
5. **Wire `~/.claude/settings.json`** (register SessionStart + Stop hooks; keep the
   two PreToolUse hooks) and test each gate end-to-end against the live daemon.

## Open decisions (on the card)

- Stop-gate trigger: real-work-only (edits/commits) vs every session end.
- Sole-gate scope: native plan gate only vs also auto-allow command permissions.

## Notes / risks

- Hooks are daemon-health-gated and deny-once, so a determined session is never
  hard-blocked and an offline daemon never breaks the session.
- The Stop hook reads the transcript (`transcript_path`) to detect Edit/Write/Bash
  commit activity; if detection is unreliable it falls back to not nagging.
