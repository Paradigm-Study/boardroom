#!/bin/bash
# PreToolUse hook on AskUserQuestion. When the boardroom daemon is reachable,
# redirect decision questions to the boardroom dashboard (deny once per session,
# then stay out of the way so a determined session is never hard-blocked).
input=$(cat)
sid=$(echo "$input" | jq -r '.session_id // "unknown"')
state="${TMPDIR:-/tmp}/boardroom-hooks"
mkdir -p "$state"
sentinel="$state/ask-$sid"
[ -f "$sentinel" ] && exit 0
# Reach the daemon via BOARDROOM_PORT, as seed.ts/menubar do (default 4140);
# hardcoding it would silently fail-open if the daemon was relocated.
port="${BOARDROOM_PORT:-4140}"
curl -s -o /dev/null --max-time 0.4 "http://127.0.0.1:${port}/api/cards" || exit 0
touch "$sentinel"
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Boardroom is connected: present these decision questions on the dashboard instead of in chat. Call mcp__boardroom__clarify with the same questions as decisions (button options, one recommended; attach visual blocks where they help). Only fall back to AskUserQuestion if the user explicitly told you to skip boardroom."}}
EOF
