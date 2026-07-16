#!/bin/bash
# SessionStart hook. Inject the boardroom protocol on EVERY start so the workflow
# is active regardless of CLAUDE.md load order. The daemon probe is ADVISORY: it
# only (a) selects connected-vs-offline wording and (b) gates session registration.
# It never suppresses the protocol — fail-CLOSED on guidance, fail-open on the
# probe. (Previously a single `curl || exit 0` dropped the whole protocol whenever
# the daemon was slow/cold at session start, e.g. right after a reboot.)
# Reach the daemon via BOARDROOM_PORT, as seed.ts/menubar do (default 4140).
port="${BOARDROOM_PORT:-4140}"
input=$(cat)

# Liveness probe: any HTTP response within 2s → connected. Unreachable or
# slow-past-2s → offline (we still inject, with fallback wording). One 2s shot, no
# retry loop — retrying a daemon we just found down only adds latency, and the
# registry self-heals on the next good start.
connected=1
curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${port}/api/cards" || connected=0

# Extracted unconditionally (not just when connected) so the offline branch can
# also inject the session key below — a daemon that comes up mid-session still
# needs the agent to know its key for later boardroom calls.
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

# Register this session so the daemon can `claude --resume` it from the correct
# absolute cwd when a parked card for this project is later decided (Phase 2
# auto-wake). Gated on the probe result (not on script flow): only attempt it when
# the daemon answered. Fail-open; never block startup. An "offline-start" session
# (daemon unreachable here, so this block is skipped) still gets the session key
# injected into context below and can bind a card to it — but gets no auto-wake
# until a LATER connected start for the same session id registers it.
if [ "$connected" = 1 ]; then
  if [ -n "$session_id" ] && [ -n "$cwd" ]; then
    body=$(jq -nc --arg s "$session_id" --arg c "$cwd" --arg p "$(basename "$cwd")" \
      '{sessionId:$s,cwd:$c,project:$p}')
    # -f so an HTTP-level error (4xx/5xx) counts as failure too, and log to stderr
    # (Claude Code's debug log) — a silently failed registration breaks auto-wake
    # for the whole session with zero diagnostic otherwise. Still never blocks.
    curl -sf -o /dev/null --max-time 2 -X POST "http://127.0.0.1:${port}/api/session" \
      -H 'content-type: application/json' -d "$body" \
      || echo "boardroom session-start: session registration POST failed — auto-wake (claude --resume) may not target this session" >&2
  fi
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
- UI CHANGE REQUESTS: include lightweight wireframes or layout sketches in the
  option context so each option is visually understandable. Let each wireframe
  use its natural dimensions; do not force all options into one fixed card size
  unless readability requires it.
- CONFIRM mid-way: if something comes up that needs a human call, go back to
  boardroom (clarify) — never ask in chat.
- FINISH: when the work is done, call review_results — screenshots or tight
  bullet points as evidence (proof it works, not narration) — so the human can
  decide whether the session is complete. Denied claims come back with notes;
  treat each as your next task.
- CONVEY: to hand the human results, findings, or explanations with nothing to
  decide, call present_report (fire-and-forget — it never blocks and is NOT a
  completion; review_results still closes the session).
- Keep cards glanceable (the human reads like a CEO): tabular/comparative info in
  structured blocks, markdown 1–2 sentences, ≥1 global block + ≥1 question-local
  block per decision (wire blockRefs). Set the card project to your working
  directory's name.
- clarify and review_results block while the human decides; if they take longer
  than the block window you get a PARKED result instead of an answer — that means
  STOP: end your turn, do NOT guess, infer, or proceed; the decision is saved and
  re-issuing the identical call later claims it (re-runs nothing). present_plan
  may also park on a long wait — wait for a real verdict, never infer approval. If
  a call fails because the server is unreachable, fall back to chat; do not retry
  in a loop.
- RESTART / DISCONNECT recovery (the agent twin of PARKED): if a boardroom call
  ERRORS OUT mid-wait with a transport/connection drop or a "re-initialize / mcp
  session not found" error, the daemon was almost certainly restarted (it has no
  hot reload, so every redeploy briefly kills it). That is NOT a verdict. STOP: do
  NOT guess, infer, assume, or proceed on what the human "would have" chosen, and
  do NOT auto-accept. The human's decision is never lost — the card is preserved
  and reattachable. To recover the REAL decision, re-issue the EXACT same call
  (identical sessionKey, project and headline) on your next turn; reattachment is automatic and
  re-runs no work — it either hands you the verdict the human already made or hangs
  again until they decide.
EOF

read -r -d '' FALLBACK <<'EOF'
## Boardroom — the session workflow (daemon offline — best-effort)

The boardroom daemon did not answer at session start, so the mcp__boardroom__*
tools (clarify / present_plan / review_results) may be unavailable this session.
Boardroom is still the DEFAULT workflow when reachable: the human decides
everything as visual cards on a dashboard, and Claude Code runs in auto-permission
mode and handles per-command permissions itself. Never auto-accept anything on the
human's behalf.

- JUDGE FIRST: simple skill calls, automatable/mechanical tasks, factual
  questions and single-obvious fixes — just do them, no boardroom. Genuine
  decisions, ambiguity, new features, structural changes and substantive results
  — route through boardroom.
- DECIDE (form the plan): before acting on an ambiguous task, FIRST call clarify
  with the questions as button decisions; when the plan is formed, call
  present_plan. Once the human finalizes on the dashboard, just start working.
- CONFIRM mid-way: if something needs a human call, go back to boardroom (clarify)
  — never ask in chat.
- FINISH: when the work is done, call review_results with tight evidence so the
  human can decide whether the session is complete.
- CONVEY: to hand the human results, findings, or explanations with nothing to
  decide, call present_report (fire-and-forget — it never blocks and is NOT a
  completion; review_results still closes the session).
- Keep cards glanceable: tabular/comparative info in structured blocks, markdown
  1–2 sentences, ≥1 global block + ≥1 question-local block per decision. Set the
  card project to your working directory's name.
- OFFLINE FALLBACK: if a mcp__boardroom__* call fails because the server is
  unreachable, fall back to asking the same questions natively in chat — do not
  retry in a loop.
- RESTART / DISCONNECT recovery (if the daemon comes up later and a boardroom call
  then drops mid-wait with a transport/connection error): that is NOT a verdict.
  STOP — do NOT guess, infer, or auto-accept. The card is preserved; re-issue the
  EXACT same call (identical sessionKey, project and headline) on your next turn to reattach and
  claim the human's real decision. A PARKED result means the same: stop and
  re-issue later to claim it.
EOF

if [ "$connected" = 1 ]; then ctx="$PROTOCOL"; else ctx="$FALLBACK"; fi

# Append the per-session key OUTSIDE the quoted heredocs (they must not interpolate).
# The agent echoes this as `sessionKey` on every call — the card↔session spine.
if [ -n "$session_id" ]; then
  ctx="${ctx}

Boardroom session key: ${session_id} — pass it as sessionKey on EVERY boardroom call. Recovery/reattach is scoped to this key."
fi

# MUST remain the LAST statement: `read -r -d ''` exits 1 at EOF (no NUL found),
# so the hook's exit status is this jq's (0), not a misleading non-zero.
jq -nc --arg ctx "$ctx" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
