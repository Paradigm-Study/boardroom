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
npm run dev          # isolated dev daemon + dashboard on http://127.0.0.1:4041
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

Optional mesh relay (mesh-v0, default-off): add `"mesh": { "url", "token",
"person", "teamId"? }` to `config.json` (or set `BOARDROOM_MESH_URL` /
`BOARDROOM_MESH_TOKEN` / `BOARDROOM_MESH_PERSON` / optional
`BOARDROOM_MESH_TEAM_ID` — env overrides the file field-by-field). When the
required first three resolve, the daemon forwards privacy-safe card lifecycle
records (`raised`/`decided`, no card bodies) to `/outbox/<person>`; a partial
config is treated as "not configured" and nothing leaves the machine.

Publishes are committed to a durable Mesh outbox before network I/O. Legacy
local mode reconciles card transitions; hosted mode re-authorizes only records
already in its team-scoped outbox and never backfills pre-consent history.
Retries retain a stable `Idempotency-Key`, and a terminal 401/403 is surfaced
rather than retried forever. Local diagnostics are available at
`/api/mesh/status` and `/api/mesh/publishes`; receipt changes also appear as
`event: mesh` on the existing `/events` stream.

For a hosted rotating credential, the mesh block additionally carries
`"deviceId"` and `"expiresAt"` (env: `BOARDROOM_MESH_DEVICE_ID` and
`BOARDROOM_MESH_EXPIRES_AT`). Desktop remains the only credential owner and
restarts Boardroom with a replacement before expiry; Boardroom never persists
the bearer. Expired credentials remain queued for a Desktop-led re-enrollment.

Hosted forwarding also requires `BOARDROOM_MESH_PROJECTS_JSON`, a Desktop-
projected array of exact `{ "workspaceRoot", "project" }` mappings for the
active team. `project` is the canonical lowercase GitHub `owner/repository`.
Each card must carry a registered session id whose exact cwd matches one of
those roots; otherwise it is not enqueued. Absolute workspace paths stay local
and the canonical project replaces all producer-supplied repository labels at
the wire boundary. Missing or empty consent keeps Boardroom useful locally but
sends nothing to Mesh. Hosted outboxes are team-scoped so delayed records cannot
cross a later team switch.

### Packaged local API authentication

A packaged supervisor must set a random install-scoped bearer in
`BOARDROOM_LOCAL_TOKEN`, or write it to a 0600 file and set
`BOARDROOM_LOCAL_TOKEN_FILE` (the default discovered file is
`<configDir>/local-token`). When configured, the bearer protects every daemon
surface: MCP, cards/admin writes, mesh status/publishes, attachments, static
content, and `/events` SSE. Clients send `Authorization: Bearer <token>`; the
daemon compares it in constant time and never logs or reflects it. Leaving the
token unset preserves legacy loopback-only development behavior, but is not a
valid packaged-supervisor configuration.

### Operations and recovery

```bash
npm run doctor -- --config-dir ~/.config/boardroom
npm run doctor -- --config-dir ~/.config/boardroom --repair
npm run backup -- --config-dir ~/.config/boardroom --output /secure/backup-dir
npm run restore -- --config-dir ~/.config/boardroom --input /secure/backup-dir
```

`doctor` emits a machine-readable report covering SQLite integrity and
migration journals, configuration/credential shape, and owner-only file modes.
`--repair` is intentionally limited to safe permission and retention repairs.
Database startup runs `quick_check` and can recover a corrupt or partial file
from a verified `.last-good` image while preserving the corrupt copy.

Migrations take a consistent pre-migration snapshot and run in a transaction.
Failure rolls back both schema and data changes and leaves a retryable failed
journal entry; snapshots remain available for operator-led recovery. Backups
carry SHA-256 manifests, are verified before any restore mutation, and restore
first creates a pre-restore backup. A failed multi-file swap restores every
original file.

Portable backups contain only `boardroom.sqlite`, legacy or team-scoped
`mesh-outbox*.sqlite` databases, and non-secret `machine.json`. They never
contain `config.json`, `local-token`, or `mesh-credential.json`; restore
preserves those machine-local secrets. Database,
WAL/SHM, snapshots, backups, manifests, configuration, and credential files are
kept owner-only. Delivered Mesh outbox rows age out after 30 days, while queued
and terminal records remain available for recovery and diagnosis.

## Enforcement hooks (global, optional but recommended)

Instructions alone are advisory — the model can lapse into its built-in
question UI. `PreToolUse` hooks in `~/.claude/settings.json` redirect
those lapses to the dashboard (see `hooks/`):

- `redirect-ask.sh` — denies `AskUserQuestion` once per session with a
  pointer to `clarify`, when the daemon is reachable. Matcher:
  `AskUserQuestion`.
- `check-plan.sh` — denies `ExitPlanMode` once per session unless a plan
  card for this project already exists on the dashboard. Matcher:
  `ExitPlanMode`.
- `mesh-gate.sh` (mesh-v0, default-off) — on `Edit|Write|MultiEdit` (register
  with that matcher), asks the mesh relay whether a teammate has an active
  edit or a locked spec on the same file, and surfaces an advisory `ask` once
  per (session, repo) on a conflict — never `deny`. Armed only when
  `MESH_URL` + `MESH_PERSON` (and usually `MESH_TOKEN`) are present in the
  hook's environment; fails open on every relay/git/parse failure.

All are fire-once per session: a second attempt always passes, so sessions
are nudged, never caged, and a downed daemon (or relay) disables them
automatically.

`session-start.sh` additionally appends a `## Team brief (mesh)` digest of
teammates' active intents and locked specs to the injected context when
`MESH_URL` + `MESH_PERSON` are set; without them (or with the relay down) its
output is byte-identical to the pre-mesh hook.

Note the deliberate env split: the **daemon** reads `BOARDROOM_MESH_*` (or
`config.json` `"mesh"`), while the **hooks** read `MESH_URL` / `MESH_PERSON` /
`MESH_TOKEN` from the environment Claude Code gives them — hooks never read
the daemon's config file. Set both if you want forwarding and the gate/brief.

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
