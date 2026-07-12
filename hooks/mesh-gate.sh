#!/bin/bash
# PreToolUse mesh gate on Edit|Write|MultiEdit. When the mesh relay is
# configured (MESH_URL + MESH_PERSON), ask it whether another teammate has an
# active edit or a locked spec on the same file. On a conflict, surface an
# advisory "ask" ONCE per (session, repo) with the conflicts summarized as the
# reason — never "deny" (house rule for the mesh gate: advisory only). The
# sentinel mechanism is copied from redirect-ask.sh, so a session is never
# hard-blocked: the human can approve the ask, and re-running the edit passes.
#
#   stdin:  { "session_id": "...", "cwd": "...", "tool_name": "Edit|Write|...",
#             "tool_input": { "file_path": "<abs path>", ... } }
#   query:  GET ${MESH_URL}/gate?person=<MESH_PERSON>&repo=<url-enc remote>&path=<url-enc repo-rel>
#           (Authorization: Bearer ${MESH_TOKEN}; curl --max-time 1)
#
# Fail-open (non-negotiable): MESH_URL/MESH_PERSON unset, weird stdin, missing
# file_path, non-git dir, git slow (2s watchdog), relay down/slow/non-JSON —
# every failure path exits 0 with empty stdout so agent work is never blocked
# by mesh infrastructure.
input=$(cat)

[ -n "${MESH_URL:-}" ] || exit 0
[ -n "${MESH_PERSON:-}" ] || exit 0

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -n "$file_path" ] || exit 0

dir=$(dirname "$file_path")
# Write may target a not-yet-existing directory; fall back to the session cwd.
if [ ! -d "$dir" ]; then
  dir=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
  [ -d "$dir" ] || exit 0
fi

# 2s watchdog around git (macOS ships no coreutils `timeout`). `remote get-url`
# is a local config read, but a hook must never hang on a pathological repo.
# The watchdog's stdio is detached so it can't hold the $() capture pipe open.
guarded_git() {
  git "$@" &
  local pid=$!
  ( sleep 2; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local wd=$!
  wait "$pid"
  local rc=$?
  kill "$wd" 2>/dev/null
  return "$rc"
}

top=$(guarded_git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
repo=$(guarded_git -C "$dir" remote get-url origin 2>/dev/null) || exit 0
[ -n "$top" ] && [ -n "$repo" ] || exit 0

# Repo-relative path; a target outside the resolved toplevel is not ours to gate.
case "$file_path" in
  "$top"/*) rel="${file_path#"$top"/}" ;;
  *) exit 0 ;;
esac

# Ask once per (session, repo): same sentinel mechanism as redirect-ask.sh,
# keyed by session_id + a slug of the remote URL. Checked BEFORE the network
# call so an already-warned session pays zero latency.
sid=$(printf '%s' "$input" | jq -r '.session_id // "unknown"' 2>/dev/null)
[ -n "$sid" ] || sid="unknown"
state="${TMPDIR:-/tmp}/boardroom-hooks"
mkdir -p "$state"
repo_slug=$(printf '%s' "$repo" | tr -c 'a-zA-Z0-9' '_')
sentinel="$state/mesh-$sid-$repo_slug"
[ -f "$sentinel" ] && exit 0

enc() { printf '%s' "$1" | jq -sRr '@uri' 2>/dev/null; }
resp=$(curl -s --max-time 1 \
  -H "Authorization: Bearer ${MESH_TOKEN:-}" \
  "${MESH_URL%/}/gate?person=$(enc "$MESH_PERSON")&repo=$(enc "$repo")&path=$(enc "$rel")" \
  2>/dev/null) || exit 0
[ -n "$resp" ] || exit 0

conflict=$(printf '%s' "$resp" | jq -r '.conflict // false' 2>/dev/null)
[ "$conflict" = "true" ] || exit 0

summary=$(printf '%s' "$resp" | jq -r \
  '[.conflicts[]? | "\(.person // "a teammate") (\(.kind // "conflict")): \(.detail // "no detail")"] | join("; ")' \
  2>/dev/null)
[ -n "$summary" ] || summary="a teammate is actively working on this file"

touch "$sentinel"
jq -nc --arg reason "Mesh gate: potential collision on $rel — $summary. Coordinate first (check the Team brief section of your context, or raise it via boardroom) before touching this file. If you have already coordinated or the user told you to proceed, re-run the edit — this gate fires only once per session per repo." \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$reason}}'
