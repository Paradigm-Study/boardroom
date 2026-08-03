#!/bin/bash
# Claude Code PreToolUse advisory for Edit|Write|MultiEdit. This hook talks only
# to the local Praxis Studio proxy. Studio owns active-team consent resolution,
# canonical project/path derivation, and hosted credentials; none of those
# credentials are ever serialized into Claude settings or this process.
#
# Every infrastructure or parsing failure is fail-open. A real conflict emits a
# one-time "ask" per session/workspace, so the user can coordinate or proceed.
input=$(head -c 1048577)
[ "${#input}" -gt 1048576 ] && exit 0

base="${PRAXIS_STUDIO_URL:-http://127.0.0.1:4319}"
if [[ ! "$base" =~ ^http://(127\.0\.0\.1|\[::1\]):([0-9]{1,5})/?$ ]]; then exit 0; fi
port="${BASH_REMATCH[2]}"
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then exit 0; fi

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$cwd" ] && [ -n "$file_path" ] || exit 0

local_token="${PRAXIS_LOCAL_TOKEN:-}"
if [ -z "$local_token" ] && [ -n "${PRAXIS_LOCAL_TOKEN_FILE:-}" ] \
  && [ -f "$PRAXIS_LOCAL_TOKEN_FILE" ] && [ ! -L "$PRAXIS_LOCAL_TOKEN_FILE" ]; then
  local_token=$(head -c 4097 -- "$PRAXIS_LOCAL_TOKEN_FILE" 2>/dev/null | tr -d '\r\n')
fi
if [ "${#local_token}" -lt 32 ] || [ "${#local_token}" -gt 4096 ]; then
  local_token=""
else
  case "$local_token" in *[!A-Za-z0-9._~-]*) local_token="" ;; esac
fi
[ -n "$local_token" ] || exit 0

# Already-warned sessions pay no network latency. The proxy still performs the
# authoritative consent/path check on the first attempt.
sid=$(printf '%s' "$input" | jq -r '.session_id // "unknown"' 2>/dev/null)
[ -n "$sid" ] || sid="unknown"
state="${TMPDIR:-/tmp}/paradigm-mesh-hooks"
mkdir -p "$state" 2>/dev/null || exit 0
workspace_slug=$(printf '%s' "$cwd" | shasum -a 256 2>/dev/null | cut -c1-24)
[ -n "$workspace_slug" ] || workspace_slug=$(printf '%s' "$cwd" | tr -c 'a-zA-Z0-9' '_' | cut -c1-80)
session_slug=$(printf '%s' "$sid" | tr -c 'a-zA-Z0-9._-' '_' | cut -c1-100)
sentinel="$state/gate-$session_slug-$workspace_slug"
[ -f "$sentinel" ] && exit 0

enc() { printf '%s' "$1" | jq -sRr '@uri' 2>/dev/null; }
resp=$(curl -s --noproxy '*' --max-filesize 1048576 --max-time 2 \
  -H "Authorization: Bearer $local_token" \
  "${base%/}/api/mesh/gate?cwd=$(enc "$cwd")&path=$(enc "$file_path")" \
  2>/dev/null) || exit 0
[ "${#resp}" -gt 1048576 ] && exit 0
[ -n "$resp" ] || exit 0

conflict=$(printf '%s' "$resp" | jq -r '.conflict // false' 2>/dev/null)
[ "$conflict" = "true" ] || exit 0

summary=$(printf '%s' "$resp" | jq -r '
  [.conflicts[:8][]?
    | ((.person // "Team member") | tostring | gsub("[[:cntrl:]]"; " ") | .[0:100]) as $person
    | ((.kind // "conflict") | tostring | gsub("[[:cntrl:]]"; " ") | .[0:80]) as $kind
    | ((.detail // "coordinate before editing") | tostring | gsub("[[:cntrl:]]"; " ") | .[0:300]) as $detail
    | "\($person) (\($kind)): \($detail)"] | join("; ")' 2>/dev/null)
[ -n "$summary" ] || summary="a team member may be working on this file"

touch "$sentinel" 2>/dev/null || true
relative=$(printf '%s' "$resp" | jq -r '(.path // "this file") | tostring | gsub("[[:cntrl:]]"; " ") | .[0:240]' 2>/dev/null)
[ -n "$relative" ] || relative="this file"
jq -nc --arg reason "Team sync found a potential collision on $relative — $summary. Coordinate first, or re-run the edit if you already coordinated or the user told you to proceed. This advisory fires only once per session and workspace." \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}'
