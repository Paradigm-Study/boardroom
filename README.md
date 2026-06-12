# boardroom

A visual decision layer between coding agents and you. Agents send questions,
plans, and results to a local daemon over MCP; you decide with buttons on a
dashboard; your decisions return as the tool result. Spec:
`docs/superpowers/specs/2026-06-11-boardroom-design.md`.

## Run

```bash
npm install
npm run build:web
npm run dev          # daemon + dashboard on http://127.0.0.1:4040
```

## Global setup (one-time per machine — no per-project config)

Three pieces make boardroom ambient for every Claude Code session:

```bash
# 1. Register the MCP server at user scope (all projects)
claude mcp add --transport http --scope user boardroom http://127.0.0.1:4040/mcp

# 2. Daemon as a login service (auto-start, auto-restart)
cp docs/com.boardroom.daemon.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.boardroom.daemon.plist
```

3. Paste `docs/agent-snippet.md` into your **global** `~/.claude/CLAUDE.md`
   (read by every session), and add to `~/.claude/settings.json`:

```json
{ "env": { "MCP_TOOL_TIMEOUT": "86400000", "MCP_TIMEOUT": "30000" } }
```

(`MCP_TOOL_TIMEOUT` lets tool calls hang until you decide; the short
`MCP_TIMEOUT` keeps connection attempts failing fast so the crash-only
fallback still works when the daemon is down.)

Uninstall the service: `launchctl bootout gui/$(id -u)/com.boardroom.daemon`.
Daemon log: `~/Library/Logs/boardroom.log`.

**Other clients (Codex, etc.):** the daemon side is identical — any
MCP-capable agent connects to `http://127.0.0.1:4040/mcp`. Each client has
its own global config surface for MCP servers, instructions, and tool
timeouts; wire those three things once per client.

## Try it without an agent

```bash
npm run seed   # three demo cards through the real MCP pipeline
```

Decide them in the dashboard and watch the seed process print each resolved
summary. Ctrl-C the seed mid-hang to see cards flip to orphaned.

## Dev

```bash
npm test           # unit + integration (real MCP client end-to-end)
npm run dev:web    # vite dev server with proxy to the daemon
npm run typecheck
```

Config: `~/.config/boardroom/config.json` — `port` (4040),
`remindEveryMinutes` (10), `notifications` (true). The daemon only ever
binds 127.0.0.1; that is hardwired (it is the security predicate for
running without auth).

## Enforcement hooks (global, optional but recommended)

Instructions alone are advisory — the model can lapse into its built-in
question UI. Two `PreToolUse` hooks in `~/.claude/settings.json` redirect
those lapses to the dashboard (see `hooks/`):

- `redirect-ask.sh` — denies `AskUserQuestion` once per session with a
  pointer to `clarify`, when the daemon is reachable.
- `check-plan.sh` — denies `ExitPlanMode` once per session unless a plan
  card for this project already exists on the dashboard.

Both are deny-once: a second attempt always passes, so sessions are nudged,
never caged, and a downed daemon disables them automatically.
