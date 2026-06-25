# boardroom

A visual decision layer between coding agents and you. Agents send questions,
plans, acceptance specs, and results to a local daemon over MCP; you decide with
buttons on a dashboard; your decisions return as the tool result. Spec:
`docs/superpowers/specs/2026-06-11-boardroom-design.md`; the spec gate (an
acceptance contract between plan and results):
`docs/superpowers/specs/2026-06-23-spec-gate-design.md`.

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

## Standalone app direction

Boardroom can become a downloaded local app without adding hosted
infrastructure: the app would bundle the daemon, built dashboard, and menu-bar
shell, start the local `127.0.0.1` MCP/API endpoint itself, and store data in
the user's local config directory. First-run setup can detect supported agent
harnesses and offer to wire them to `http://127.0.0.1:4040/mcp` with explicit
user consent; clients that do not expose a writable setup surface can fall back
to copyable commands and config snippets.

## Try it without an agent

```bash
npm run seed   # three demo cards through the real MCP pipeline
```

Decide them in the dashboard and watch the seed process print each resolved
summary. Ctrl-C the seed mid-hang to see cards flip to orphaned.

## Author good cards

Boardroom is fastest when agents send visual structure, not prose:

- Put the decision in buttons; keep prompts to one sentence.
- Put comparisons in `options_compare`, sequences in `phases`, dependencies in
  `graph`, facts in `table`, file changes in `diff_stat`, test output in
  `evidence`, and acceptance criteria in `acceptance`.
- For UI change requests, include lightweight wireframes or layout sketches in
  the option context. Let each wireframe use its natural dimensions; do not force
  all options into one fixed card size unless readability requires it.
- Use markdown only for 1-2 sentence context that changes the decision.
- Every clarify/plan card must include at least one global context block and at
  least one question-local block for each decision. Wire `blockRefs` so local
  blocks render inside the exact question they inform; leave whole-card context
  unreferenced so it renders separately as global context.
- For result reviews, claim text should be short; long commands and output live
  inside expandable evidence.

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

## Menu-bar app (macOS)

A thin Electron tray shell around the dashboard the daemon already serves —
so boardroom lives in your menu bar instead of a browser tab. It shows the
pending count next to the tray icon and drops down the full dashboard on
click; right-click for "Open in browser" / "Quit". All state stays in the
daemon — this is pure presentation.

```bash
cd menubar
npm install      # also generates the tray icons (postinstall)
npm start        # dev run: tray icon appears (runs as "Electron")
npm run pack     # package boardroom.app → release/mac-arm64/boardroom.app
```

`npm run pack` builds a real, icon'd `boardroom.app` (a menu-bar-only app via
`LSUIElement`; unsigned, so the first launch is right-click → Open). Drag it to
`/Applications`, and add it to System Settings → General → Login Items to have
it always there. Packaged, its tray icon **and its macOS notifications carry
the boardroom icon** — that's the fix for the generic cog you saw from the
daemon's notifier.

Electron (not Tauri) so there's no extra toolchain to install — it's isolated
in `menubar/` and never touches the daemon package. Set `BOARDROOM_PORT` if
your daemon isn't on 4040.

## Notifications

Three surfaces, in order of reliability:

- **Menu-bar app** (packaged) — fires native macOS notifications with the
  boardroom icon; click → opens the card. The dependable path.
- **Browser dashboard** — click "Enable desktop alerts" once; new cards pop a
  Web Notification (boardroom icon, click → opens the card).
- **Daemon** (`terminal-notifier`) — best-effort fallback; macOS often
  suppresses it and its icon is a fixed generic cog. Set `notifications: false`
  in config once you use the app/browser to silence it.

Optional: set `openOnPending: true` in `~/.config/boardroom/config.json` to have
the daemon auto-open the dashboard (default browser) straight to each new card —
the decision comes to you, no hunting. (Off by default; auto-opening tabs is
intrusive unless asked for.)

Note: a live decision *inside the Claude Code preview pane* isn't supported —
that pane launches and owns its own dev server and won't attach to the shared
always-on daemon. Use the menu-bar app, the browser, or `openOnPending`.
