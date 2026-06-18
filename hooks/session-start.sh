#!/bin/bash
# SessionStart hook. When the boardroom daemon is reachable, (re)inject the
# boardroom protocol so it is active every session regardless of CLAUDE.md load
# order. Fail-open: if the daemon is down, emit nothing and never block startup.
curl -s -o /dev/null --max-time 2 http://127.0.0.1:4040/api/cards || exit 0

read -r -d '' PROTOCOL <<'EOF'
## Boardroom — the session workflow (daemon connected)

The boardroom MCP server is connected (mcp__boardroom__clarify / present_plan /
review_results). It is the DEFAULT workflow: the human decides everything as
visual cards on a dashboard, and Claude Code runs in auto-permission mode and
handles per-command permissions itself. Never auto-accept anything on the human's
behalf — their approval lives in the cards.

- JUDGE FIRST: simple skill calls, automatable/mechanical tasks, factual
  questions and single-obvious fixes — just do them, no boardroom. Genuine
  decisions, ambiguity, new features, structural changes and substantive results
  — route through boardroom.
- DECIDE (form the plan): before acting on an ambiguous task, FIRST call clarify
  with the questions as button decisions (one recommended; attach
  graph/table/options_compare/phases blocks where a visual helps). When the plan
  is formed, call present_plan (structural blocks + decisions, exactly one
  recommended each). Once the human finalizes the decisions on the dashboard,
  just start working — do not re-ask in chat.
- CONFIRM mid-way: if something comes up that needs a human call, go back to
  boardroom (clarify) — never ask in chat.
- FINISH: when the work is done, call review_results — screenshots or tight
  bullet points as evidence (proof it works, not narration) — so the human can
  decide whether the session is complete. Denied claims come back with notes;
  treat each as your next task.
- Keep cards glanceable (the human reads like a CEO): tabular/comparative info in
  structured blocks, markdown 1–2 sentences, ≥1 global block + ≥1 question-local
  block per decision (wire blockRefs). Set the card project to your working
  directory's name.
- These calls block until the human decides, possibly for hours — never time them
  out. If a call fails because the server is unreachable, fall back to chat; do
  not retry in a loop.
EOF

jq -nc --arg ctx "$PROTOCOL" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
