#!/bin/bash
# SessionStart hook. When the boardroom daemon is reachable, (re)inject the
# boardroom protocol so it is active every session regardless of CLAUDE.md load
# order. Fail-open: if the daemon is down, emit nothing and never block startup.
# Reach the daemon via BOARDROOM_PORT, as seed.ts/menubar do (default 4040).
port="${BOARDROOM_PORT:-4040}"
input=$(cat)
curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${port}/api/cards" || exit 0

# Register this session so the daemon can `claude --resume` it from the correct
# absolute cwd when a parked card for this project is later decided (Phase 2
# auto-wake). project = basename(cwd), matching the card project the protocol
# below asks agents to use. Fail-open; never block startup.
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
if [ -n "$session_id" ] && [ -n "$cwd" ]; then
  body=$(jq -nc --arg s "$session_id" --arg c "$cwd" --arg p "$(basename "$cwd")" \
    '{sessionId:$s,cwd:$c,project:$p}')
  curl -s -o /dev/null --max-time 2 -X POST "http://127.0.0.1:${port}/api/session" \
    -H 'content-type: application/json' -d "$body" || true
fi

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
- clarify and review_results block while the human decides; if they take longer
  than the block window you get a PARKED result instead of an answer — that means
  STOP: end your turn, do NOT guess, infer, or proceed; the decision is saved and
  re-issuing the identical call later claims it (re-runs nothing). present_plan
  never parks — wait for a real verdict, never infer approval. If a call fails
  because the server is unreachable, fall back to chat; do not retry in a loop.
EOF

jq -nc --arg ctx "$PROTOCOL" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
