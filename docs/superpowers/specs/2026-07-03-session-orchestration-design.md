# Session orchestration — design spec

**Date:** 2026-07-03
**Status:** draft pending user review
**Scope:** the L2–L3 rungs of the portable-session-console ladder (the session-capture
spec built L0; the waker is a narrow L1). After this patch, boardroom can **start,
steer, and answer** agent sessions from its own dashboard — the user stops typing
into Claude Code terminals. This is the foundation the downloadable app ships on.

## 1. Problem and vision

Today boardroom is a decision layer *beside* the agent harness: agents call our MCP
tools, the human decides on the dashboard, but every session still starts and lives
in a terminal the human must tend. The user's directive (2026-07-03): manage sessions
and navigate the agents *inside boardroom*, without building "a Claude Code
duplication out of boardroom," without losing session context, and preferably on the
usage limits of the already-paid Claude Code / Codex subscription rather than metered
API keys.

The resolution is a **thin control seam over the real engine**. The Claude Agent SDK
is not a lesser clone of Claude Code — it spawns the same engine and reads/writes the
same on-disk session store (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`)
that interactive sessions use. Boardroom therefore never runs a model loop, never
stores transcripts of its own, never manages context or worktrees: it **launches and
steers Claude Code**, renders its event stream, and routes its human-judgment moments
into the card pipeline that already exists.

**Honest blast-radius statement.** This patch crosses boardroom's biggest trust
boundary to date: the daemon goes from *observing* sessions (capture) and *nudging*
them (one-shot waker resume) to *launching agent processes that edit files*, on
demand, from a dashboard button. Every prior invariant about the waker's narrow spawn
surface now applies to a much larger surface, which is why the ownership lock (§5.3),
the auth rules (§6), and the API-token gate on the new endpoints (§5.4) are
load-bearing, not hygiene.

### In scope

- Spawn a new Claude Code session from the dashboard and stream its transcript live.
- Steer a running boardroom-owned session: send follow-ups, interrupt, change
  permission mode.
- Route the session's human-judgment moments (tool-permission requests, questions,
  plans, results) into the existing card queue — one inbox for spawned and foreign
  sessions alike.
- Resume-when-idle: pick up a session the user started elsewhere, with full context,
  under an ownership lock.
- A per-provider auth toggle: logged-in subscription (default) vs API key.
- A vendor seam (`AgentDriver`) shaped so a Codex driver slots in without redesign.

### Explicit non-goals (deferred)

- **Codex driver** (`codex app-server`: thread/start, turn/steer, turn/interrupt —
  the interface is shaped for it; the implementation is V2).
- **Live-attach to a session an interactive terminal currently owns.** No supported
  mechanism exists in mid-2026: the CLI/TUI exposes no IPC, the desktop app is
  documented "interactive only," and the ACP adapters SDK-spawn their own engine.
  Co-driving a TUI-owned session is off the table by design, not omission.
- Re-implementing anything the engine owns: agent loop, context management,
  transcript storage, worktree lifecycle (Claude Code creates/locks/sweeps worktrees
  natively), subagents/teams, hooks, skills, plan mode, Routines.
- Remote/mobile access (still gated on the deferred encryption + transport layer).
- Parallel-fleet UX (kanban boards, task queues). One inbox, N sessions, no more.

## 2. Decisions log

Locked with the user in the 2026-07-03 session (clarify answers + follow-ups):

| # | Decision | Choice |
|---|---|---|
| 1 | Control model | **Spawn & Own** via Agent SDK streaming-input `query()` — drives the real engine, shares the real session store. Not PTY-wrapping (cmux), not a re-hosted loop (coder/Mux), not live-attach (unsupported) |
| 2 | No duplication | Delegate everything below the seam to Claude Code; boardroom owns only the decision/control surface (user: "I don't mean to build a claude code duplication out of boardroom") |
| 3 | Auth default | **Reuse the logged-in subscription** (spawned engine reads the stored OAuth login; usage draws on Pro/Max limits). API key is a first-class per-provider toggle, never a requirement. Never `--bare`; never read/copy/re-present OAuth tokens |
| 4 | Context | Full fidelity required: resume replays the shared JSONL; `systemPrompt: {type:'preset', preset:'claude_code'}` + default `settingSources` so CLAUDE.md/settings/MCP/hooks load exactly as in a terminal |
| 5 | Process | Comprehensive spec before code (user: "rather a huge feature or even pivot") |
| 6 | Engine source | The **SDK-bundled engine**, not a user-installed CLI — this machine has no standalone `claude` on PATH (Claude.app-managed), and a downloadable app cannot assume one |
| 7 | Isolation | Delegate to Claude Code's native worktree support; V1 default spawns in the project cwd. No boardroom-owned worktree code |
| 8 | Vendor seam | Internal `AgentDriver` interface modeled loosely on ACP session semantics; adopt real ACP only if a third vendor/editor-embedding shows up (it is pre-1.0 and editor-shaped) |

### 2.1 Adopt-before-build justification (per the OSS-first rule)

The 2026-07-03 audit compared the field before this design: **manaflow cmux** is a
GPL macOS PTY terminal — no structured events, no way to read agent state; a display
surface, not an engine. **coder/Mux** re-hosts its own agent loop against model APIs —
exactly the duplication decision #2 forbids. **vibe-kanban** is sunsetting
(Bloop shut down 4/2026). **happy** is a relay for remote supervision, not a control
seam. **ACP** is the right vocabulary but pre-1.0, editor-shaped, and its Claude
adapter wraps the Agent SDK anyway. The adopted OSS *is* the Agent SDK — first-party,
in-process, and the only option that is the engine rather than a wrapper around it.
Custom code is confined to the seam no OSS provides: cards-as-permission-UI and the
cross-session inbox.

## 3. Architecture

```
                       dashboard (SPA)                menu-bar tray
                     cards ▲ │ decisions  sessions ▲ │ controls
                            │ ▼                     │ ▼
   Claude Code ──┐   ┌──────┴─────────────────────────────────┐
   Codex ────────┼──►│ daemon (127.0.0.1:4040, token-gated)   │
   any MCP agent─┘   │  /mcp (HTTP MCP, foreign sessions)     │
    (foreign)        │  queue + store (SQLite)                │
                     │  SessionSupervisor ◄── NEW             │
                     │    └─ ClaudeDriver (Agent SDK, in-proc)│
                     │         └─ spawns bundled engine ──────┼──► ~/.claude/projects/
                     └────────────────────────────────────────┘    <slug>/<id>.jsonl
                                                                   (shared with any
                                                                    terminal session)
```

### 3.1 The seam: `AgentDriver`

One interface per vendor; everything above it is vendor-neutral daemon/UI code.

```ts
interface AgentDriver {
  vendor: 'claude-code' | 'codex'
  spawn(opts: SpawnOpts): SessionHandle           // new session
  resume(sessionId: string, opts: SpawnOpts): SessionHandle  // idle session, full context
}

interface SpawnOpts {
  cwd: string                 // absolute; the project the session works in
  prompt: string              // the opening task
  permissionMode: PermissionMode
  worktree?: boolean          // pass through to the engine's native worktree support
}

interface SessionHandle {
  sessionId: Promise<string>  // resolved from the init event
  events: AsyncIterable<SessionEvent>  // normalized: turn, text, tool_use, result, ended
  send(text: string): void    // follow-up into the live turn stream
  interrupt(): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  detach(): Promise<void>     // stop the process; session stays resumable on disk
}
```

`ClaudeDriver` implements this on `@anthropic-ai/claude-agent-sdk` (pinned; see §10):
`query()` with an AsyncIterable prompt (streaming-input mode is required — `send`,
`interrupt`, `setPermissionMode` only exist there), `resume`/`forkSession` options
for Model B, and `canUseTool` wired per §4.2. The driver is dependency-injected into
the supervisor exactly as `SpawnFn` is injected into the waker today, so the entire
lifecycle is unit-testable with a `FakeDriver`.

### 3.2 SessionSupervisor

Owns every boardroom-launched `SessionHandle`. Responsibilities:

1. **Registry.** Persist one row per managed session (§4.1) — status transitions
   `running → detached | ended`, `lastEventAt` heartbeat from the event stream.
2. **Event fan-out.** Normalize `SessionEvent`s onto the existing `/events` SSE
   stream (`event: session` frames; the tray ignores them, the dashboard's session
   panel consumes them). Ring-buffer the last N events per session in memory so a
   freshly-opened panel paints without replaying the JSONL.
3. **Ownership lock (§5.3).** The single arbiter of who may resume what.
4. **Crash-only teardown.** Engine subprocesses die with the daemon. On boot, every
   `running` row flips to `detached` (mirroring `orphanAllPending`) — the dashboard
   shows "detached, resumable," and one click resumes with full context via Model B.
   No state beyond the row is recovered; the transcript on disk *is* the state.

### 3.3 What happens to the waker and capturer

- **SessionCapturer** is unchanged — it remains the read-only radar for *foreign*
  sessions, and its `captured_sessions` liveness (pid probe) feeds the ownership lock.
- **The waker is absorbed as Model B's narrowest case.** Its "decided-but-undelivered
  card → resume with the summary" behavior moves onto `driver.resume()` under the
  supervisor's lock, replacing the detached blind spawn (and retiring the dead
  `/opt/homebrew/bin/claude` default — decision #6; the fail-closed project
  resolution and the plan-stage skip carry over verbatim).

## 4. Data model

### 4.1 `managed_sessions` (new table)

```sql
CREATE TABLE IF NOT EXISTS managed_sessions (
  session_id  TEXT PRIMARY KEY,   -- the engine's session UUID (shared identity with capture)
  vendor      TEXT NOT NULL,      -- 'claude-code' | 'codex'
  json        TEXT NOT NULL,      -- Zod-validated ManagedSession
  updated_at  TEXT NOT NULL
);
```

```ts
interface ManagedSession {
  sessionId: string
  vendor: 'claude-code' | 'codex'
  cwd: string; project: string            // basename(cwd), grouping only
  status: 'running' | 'detached' | 'ended'
  authMode: 'subscription' | 'api-key'    // what it was launched under (cost audit trail)
  permissionMode: string
  startedAt: string; lastEventAt: string
  engineVersion?: string                   // from the init event — version-skew forensics
  costUsd?: number                         // from result events when API-billed
}
```

Keyed by the same session UUID as `captured_sessions`, so a boardroom-spawned session
that also appears in the registry capture is one identity, not two.

### 4.2 Permission requests are cards

`canUseTool(toolName, input, {...})` fires when the engine would prompt a human. The
handler compiles a **card** — stage `permission`, decisions =
`[allow / allow (edited input) / deny (note required)]`, blocks rendering the tool
name and input (`table` for arguments, `diff_stat`/`evidence` where the input carries
file edits or commands) — submits it through the **existing queue**, and awaits the
decision exactly like a hanging MCP gate. The resolution maps to
`{behavior:'allow', updatedInput}` / `{behavior:'deny', message}`.

This reuses, unchanged: SSE push, notifications, the tray badge, decide validation,
and the orphan lifecycle (a session detached mid-request orphans its card; re-asking
on resume reattaches by fingerprint). One new invariant: **permission cards are
one-shot and session-bound** — they carry the exact `sessionId`, are never claimable
cross-session, and the waker/Model B never auto-resumes on their decision (the
resolution travels through the live callback or dies with it).

**The auto-approve blind spot (must be documented in UI copy):** `canUseTool` only
fires when the permission flow *would prompt*. Allow-listed tools, `acceptEdits`,
and `bypassPermissions` skip it entirely. The default spawn mode is therefore
`default` (prompting), and the session panel shows the live permission mode so
"why am I not seeing cards?" is always answerable at a glance.

### 4.3 Exact session attribution for the four MCP gates

Spawned sessions get the boardroom tools (`clarify`, `present_plan`, `present_spec`,
`review_results`) injected **in-process** via the SDK's `createSdkMcpServer`, whose
handlers submit into the same queue but stamp the card with the *known* `sessionId`.
This resolves, for managed sessions, the craggy-spec §3.1 Part 2 deferral ("no
reliable server-side source for the agent's session id"): no fingerprint guessing, no
cross-session steal within managed sessions. Foreign sessions keep the HTTP `/mcp`
path and its existing fingerprint semantics unchanged.

## 5. Control models and trust boundary

### 5.1 Model A — Spawn & Own (primary)

The SDK spawns the bundled engine as a subprocess of the daemon; boardroom holds the
streaming-input handle. This **is** the real Claude Code: same engine, same session
files, same CLAUDE.md/settings/hooks (§7). "Navigate the agents inside boardroom" =
render `events`, expose `send`/`interrupt`/`setPermissionMode` as panel controls.

### 5.2 Model B — Resume-when-idle (secondary)

`driver.resume(sessionId)` picks up any session — boardroom-spawned or foreign — with
its full on-disk history, **only** when the lock (§5.3) says nobody owns it, and only
from the session's original cwd (resuming from elsewhere silently forks a blank
session — the engine scopes session lookup to the directory). When ownership is
ambiguous, the escape hatch is `forkSession: true`: branch to a new id, never
co-write. Foreign-session resume keeps the capture spec's trust boundary: eligible
targets come from hook-registered rows (`sessions_v2`), never from
registry-captured rows.

### 5.3 The ownership lock

Two writers on one session id corrupt the JSONL/config — documented engine behavior,
no file locking exists at that layer, so boardroom must not create the situation. A
session id is **resumable** iff:

1. no `managed_sessions` row has it `running` (boardroom's own processes), and
2. no `captured_sessions` row shows it alive (a terminal owns it — pid probe), and
3. its cwd exists and is absolute (waker rule, carried over).

Fail-closed: any doubt → the panel offers "fork" and "copy summary" (the orphan
card's copy path), never a co-write. The lock lives in the supervisor, in one
function, unit-tested against every combination.

### 5.4 New HTTP surface (all behind the loopback token + Host/Origin guards)

```
POST /api/agent-sessions            { cwd, prompt, permissionMode, worktree? } → spawn
GET  /api/agent-sessions            managed rows (+ live status)
POST /api/agent-sessions/:id/send   { text }
POST /api/agent-sessions/:id/interrupt
POST /api/agent-sessions/:id/permission-mode   { mode }
POST /api/agent-sessions/:id/detach
POST /api/agent-sessions/:id/resume
```

`cwd` must be absolute, existing, and — new rule for a *launch* surface — inside the
user's home directory unless explicitly configured otherwise (`allowedRoots` in
config). The 2026-07-03 security patch (token + Host/Origin validation) is a **hard
prerequisite**: these endpoints start processes that edit files; they must never be
reachable by a rebound page or another local user.

## 6. Auth

Two modes per provider, chosen in config/settings UI, default first:

| Mode | Mechanism | Billing | Notes |
|---|---|---|---|
| **Logged-in subscription** (default) | Spawned engine reads the stored OAuth login (Keychain / `~/.claude/.credentials.json`) exactly as a terminal session does; boardroom injects **no** credentials | Pro/Max plan limits | ToS gray zone (below); pricing direction risk (metering announced 6/15/2026, then paused) |
| **API key** | `ANTHROPIC_API_KEY` in the spawned env only | Metered per-token | The path Anthropic explicitly sanctions for programmatic use; surface `costUsd` per session in the panel |

Hard rules, each preventing a specific failure:

1. **Never `--bare` / equivalent SDK stripping.** Bare mode skips OAuth/keychain
   (breaking subscription auth) *and* skips CLAUDE.md/hooks/MCP (breaking context).
   It is slated to become the `-p` default upstream, so the driver pins its
   invocation and a startup probe asserts settings actually loaded (§10).
2. **Never read, copy, or re-present the OAuth token.** Boardroom orchestrates the
   user's engine as a subprocess; it never becomes the credential holder. This is the
   defensible side of the ToS line (the Feb 2026 clarification bars using the tokens
   "in any other product, tool, or service"). The spec records this as an accepted
   legal gray zone for a single-user local app, with the API-key toggle as the
   fully-sanctioned alternative — flip a setting, not the architecture.
3. **Never leak an ambient `ANTHROPIC_API_KEY` into subscription-mode spawns** (it
   would silently override the login and switch billing) — the driver scrubs it from
   the child env unless the API-key toggle is on.

## 7. Context fidelity (the "headless loses context" question, resolved)

Verdict: mostly false, with two real knobs and one genuine loss.

- **Conversation:** resume replays the same JSONL interactive sessions write. Nothing
  is lost by construction; a boardroom session can later be `/resume`d in a terminal
  and vice versa (`-p`-created sessions just don't show in the interactive picker —
  resume-by-id works).
- **Knob 1 — `settingSources`:** current SDK (0.3.x) loads user/project/local
  settings, CLAUDE.md, MCP, hooks, skills *by default* (the v0.1.0 "no filesystem
  settings" change was reverted). The driver still passes it explicitly — pinned
  behavior over remembered behavior.
- **Knob 2 — system prompt:** the SDK default is a *minimal* prompt (NOT reverted).
  The driver must pass `systemPrompt: { type: 'preset', preset: 'claude_code' }` or
  spawned sessions subtly behave unlike terminal sessions.
- **Genuine loss:** the interactive TUI itself — replaced by the session panel, which
  is the product.

## 8. Dashboard UX (direction; details revisitable at implementation)

- **Sessions panel** grows controls: the existing Folders view of captured sessions
  gains a "managed" badge, live status dot, and per-session drawer — transcript
  stream (auto-following, collapsible tool calls), an input box (`send`), interrupt,
  permission-mode selector, detach/resume.
- **New session** = one button on a folder: prompt textarea, permission mode
  (default: `default`), worktree checkbox, auth-mode indicator (read-only; changed in
  settings).
- **Cards stay the spine.** Permission cards and the four gates land in the same
  inbox, badged with the session they belong to; deciding them from the drawer or the
  inbox is the same action. The inbox is a decision queue, not a session list — the
  differentiator over the desktop app's sidebar.

## 9. Failure handling

| Failure | Behavior |
|---|---|
| Daemon dies with sessions running | Engine subprocesses die too (no zombie writers); rows flip `running → detached` on boot; panel offers one-click resume with full context |
| Spawn fails (engine missing, auth expired) | Row `ended` with the error surfaced in the panel + a notification; subscription-mode auth failure shows "log in to Claude Code and retry," never a token prompt |
| Two-writer attempt | Prevented by the lock; ambiguous → fork or copy-path, never co-write |
| Permission card orphaned (session detached mid-request) | Standard orphan lifecycle; re-issue on resume reattaches; never auto-resolved |
| `--bare` becomes upstream default / settings silently not loaded | Startup probe (§10) fails loudly; driver pins non-bare invocation |
| Ambient `ANTHROPIC_API_KEY` present in subscription mode | Scrubbed from child env; warning logged once |
| Engine version skew after SDK/app update | `engineVersion` recorded per session; probe re-runs on boot; mismatch surfaces in the panel, never silently degrades |
| Foreign session vanishes mid-resume-eligibility check | Lock re-evaluates at spawn time (TOCTOU window accepted: worst case the engine refuses/forks — never corrupts, per fail-closed ordering) |

## 10. Testing

- **Unit (FakeDriver):** supervisor lifecycle (spawn → events → detach/ended), boot
  recovery (`running → detached`), the ownership lock truth table, permission-card
  compile/resolve mapping (`allow`/`updatedInput`/`deny`), env scrubbing.
- **Cross-layer:** a permission card decided on the dashboard resolves the pending
  `canUseTool` promise with exactly the decided payload (mirrors
  `resultsGate.crossLayer`).
- **Startup probe as test and runtime guard:** spawn a minimal real session
  (`maxTurns: 1`, trivial prompt) asserting (a) auth works, (b) a CLAUDE.md marker
  file is visible to the session — i.e., settings loaded, not bare. Runs in CI behind
  `BOARDROOM_E2E_CLAUDE=1` (needs a logged-in machine) and on daemon boot as a
  cheap self-check with cached result.
- **Version pinning:** SDK version pinned exact in package.json; the probe records
  the bundled engine version; a CI job fails on SDK minor bumps until the probe passes.

## 11. V1 scope and deferrals

**V1:** `AgentDriver` + `ClaudeDriver` (Model A spawn/steer, Model B resume with
lock), `managed_sessions`, supervisor with crash-only recovery, permission cards via
`canUseTool`, in-process MCP for exact gate attribution, session panel + spawn UI,
auth toggle with env scrubbing, startup probe, waker absorbed into Model B.

**Deferred, door explicitly open:**
- Codex driver on `codex app-server` (the seam is shaped for it; server-initiated
  approvals map onto permission cards).
- Surfacing subagents/agent-teams structure in the panel (engine-owned; render-only).
- Remote/mobile console (needs the deferred encryption + transport layer).
- Parallel-fleet management UX beyond N concurrent sessions in one inbox.
- Adopting ACP as the driver interface if a third vendor materializes.

## 12. Assumptions to confirm at review

1. **Engine = SDK-bundled CLI** (decision #6). This machine has no standalone
   `claude` binary; the waker's `/opt/homebrew/bin/claude` default is dead today and
   auto-wake has been silently degrading. Confirm bundling is acceptable for the
   downloadable app (it also pins engine+SDK versions together). ← confirm
2. **Subscription auth works for SDK-spawned engines on this machine** — the login
   came via Claude.app; verify the spawned engine finds the Keychain credentials.
   This is empirical check #1 before any code. ← validate
3. **Permission cards as a new `permission` stage** (vs folding into `clarify`).
   New stage keeps the inbox filterable and the one-shot/session-bound invariant
   enforceable in the schema. ← confirm
4. **ToS gray zone accepted** as a documented risk with the API-key toggle as the
   sanctioned fallback (§6 rule 2). ← confirm
5. **Default spawn permission mode = `default`** (prompting), so decisions actually
   reach the dashboard; `acceptEdits` is opt-in per session. ← confirm
6. **The waker's replacement** keeps its exact semantics (fail-closed project
   resolution, plan-stage skip, deliver-on-spawn-only) under the supervisor. ← confirm
7. Empirical checks bundled into the first implementation task: pinned SDK's
   `settingSources` default, `canUseTool` `requestId` support in the bundled engine
   (needs ≥ 2.1.199), absence of session file locking (two-writer test in a temp
   config dir), streaming-input method set (`interrupt`, `setPermissionMode`,
   `streamInput`) present. ← validate
