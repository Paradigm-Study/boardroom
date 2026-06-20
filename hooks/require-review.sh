#!/bin/bash
# Stop hook. Backstop for the boardroom workflow: if this session edited files
# but the work was never reviewed on the dashboard, ask once for review_results.
# Deny-once + fail-open so it can never trap the session.
input=$(cat)

# Never loop: if we are already inside a stop-hook continuation, stand down.
[ "$(echo "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

sid=$(echo "$input" | jq -r '.session_id // "unknown"')
transcript=$(echo "$input" | jq -r '.transcript_path // ""')

state="${TMPDIR:-/tmp}/boardroom-hooks"
mkdir -p "$state"
sentinel="$state/review-$sid"
[ -f "$sentinel" ] && exit 0                       # deny-once per session

# Only gate sessions that actually edited files (agent-judges-triviality rule).
[ -z "$transcript" ] || [ ! -f "$transcript" ] && exit 0
edited=$(grep -cE '"name": ?"(Edit|Write|MultiEdit|NotebookEdit)"' "$transcript" 2>/dev/null)
[ "${edited:-0}" -eq 0 ] && exit 0

# Daemon reachable? If not, fail open — never trap the session while offline.
# Reach the daemon via BOARDROOM_PORT, as seed.ts/menubar do (default 4040);
# hardcoding it would silently fail-open if the daemon was relocated.
port="${BOARDROOM_PORT:-4040}"
cards=$(curl -s --max-time 2 "http://127.0.0.1:${port}/api/cards") || exit 0
[ -z "$cards" ] && exit 0

# Session start = timestamp of the first transcript line (scopes "this session").
sstart=$(head -n 1 "$transcript" | jq -r '.timestamp // empty' 2>/dev/null)

# Has a results card been decided during this session?
reviewed=$(printf '%s' "$cards" | jq --arg s "$sstart" '
  [ .[] | select(.stage=="results") | select(.status=="decided")
        | select(($s=="") or ((.decidedAt // "") >= $s)) ] | length' 2>/dev/null)
[ "${reviewed:-0}" -gt 0 ] && exit 0

touch "$sentinel"
cat <<'EOF'
{"decision":"block","reason":"This session edited files but the work was never reviewed on the boardroom dashboard. Call mcp__boardroom__review_results with claim-by-claim evidence (proof it works — tests, diffs — not narration of how you built it), wait for the human's verdict, then finish. If the user explicitly told you to skip boardroom, just stop again — this will not ask twice."}
EOF
