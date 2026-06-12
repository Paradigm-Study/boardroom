#!/bin/bash
# PreToolUse hook on ExitPlanMode. When the boardroom daemon is reachable and no
# plan card was presented for this project recently, ask the model to present the
# plan on the dashboard first (deny once per session — second attempt passes, so
# the native gate is never hard-blocked).
input=$(cat)
sid=$(echo "$input" | jq -r '.session_id // "unknown"')
cwd=$(echo "$input" | jq -r '.cwd // ""')
proj=$(basename "$cwd")
state="${TMPDIR:-/tmp}/boardroom-hooks"
mkdir -p "$state"
sentinel="$state/plan-$sid"
[ -f "$sentinel" ] && exit 0
cards=$(curl -s --max-time 0.4 http://127.0.0.1:4040/api/cards) || exit 0
[ -z "$cards" ] && exit 0
match=$(echo "$cards" | jq --arg p "$proj" '
  [.[] | select(.stage == "plan")
       | select((.session.project | contains($p)) or ($p | contains(.session.project)))
  ] | length' 2>/dev/null)
[ "${match:-0}" -gt 0 ] && exit 0
touch "$sentinel"
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Boardroom is connected but this plan was never presented there. Call mcp__boardroom__present_plan first (structural blocks like graph/phases plus your plan decisions, exactly one recommended option each), wait for the human's verdict on the dashboard, then call ExitPlanMode again — it will pass. If the user explicitly said to skip boardroom, just call ExitPlanMode again."}}
EOF
