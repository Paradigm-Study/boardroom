# Fix boardroom craggy / flaky behavior — design spec

**Date:** 2026-06-22
**Status:** draft pending user review (debate-driven root-cause analysis; fixes adversarially reviewed)
**Scope:** correctness/robustness of the boardroom session workflow (hook → daemon → MCP → orphan/reattach → waker). No new product surface.

## 0. How this spec was produced

The original report was: *after a reboot, new sessions are less likely to push decision gates to
the boardroom.* That single symptom was used as the entry point for a wider sweep of "craggy"
behavior. Two multi-agent workflows drove the analysis:

1. A **verification workflow** (Q1 "do we need to reconnect to the MCP?", Q2 "do we need to set an
   orphan inactive time?") — grounded readers + adversarial verifiers.
2. A **debate workflow**: 4-lens discovery → triage → proponent / skeptic / judge debate per
   candidate cause → adversarially-reviewed fix designs → spec synthesis (38 agents).

Every load-bearing claim was checked against the source (file:line), and several were re-checked by
live probing this host. Where a conclusion rests on **Claude Code client internals** that are not
in this repo, it is flagged as such.

## 1. Problem statement

The boardroom feels unreliable in two distinct ways that are easy to conflate:

- **The headline complaint (post-reboot routing):** after a reboot or a deploy, a session sometimes
  starts with little/no boardroom reinforcement — decisions get asked in chat instead of opening
  cards.
- **A cluster of adjacent rough edges:** decided cards that don't auto-resume the agent; a parked
  plan that "does nothing" when approved late; the occasional duplicate card; and — most dangerous —
  under multiple git worktrees of the same repo, a decided card can resume work in the **wrong
  worktree**.

**Important correction from the investigation.** The post-reboot "empty workflow" feeling is
**largely self-correcting** and is **not** caused by the things it looks like (daemon crashing, MCP
transport, per-boot orphaning). The one genuinely high-severity defect is **silent** and was *not*
the original complaint: **wrong-worktree resume under a shared basename.** This spec fixes that
first, hardens the boot-window fail-open behavior that *contributes* to the post-reboot feeling, and
explicitly declines to "fix" four red herrings.

## 2. Root causes (ranked)

> Read the §2a / §2b split literally. Only the boot-window fail-open hook bears on the *post-reboot
> routing* symptom, and only weakly. The wrong-worktree bug is the only high-severity item and is a
> *different* failure mode.

### 2a. Genuine defects to fix

| # | Cause | Class | Severity | Conf. | Evidence | Fix direction |
|---|---|---|---|---|---|---|
| A | **Basename-keyed session registry misroutes a decided card's resume to the wrong worktree.** Two checkouts of one repo share `basename(cwd)`; the 2nd SessionStart's POST clobbers the 1st's row; the waker then `claude --resume`s from the surviving (wrong) cwd under `acceptEdits`. | root-cause | **HIGH** | high | `store.ts:34-39,50-55` (`project TEXT PRIMARY KEY`, `ON CONFLICT(project)`); `session-start.sh:17` (`project=basename(cwd)`); `waker.ts:41,46,51-52`; `compile.ts:21-22` (identical fingerprints) | Re-key registry on absolute `cwd`; correlate resume on the Claude `session_id`; fail-closed basename fallback. |
| B | **SessionStart probe gates BOTH protocol injection and session registration (boot-window fail-open).** One `curl --max-time 2 \|\| exit 0` sits in front of the only `additionalContext` site *and* `POST /api/session`. Slow/cold daemon within 2s → no protocol, no registration; the row's absence then blocks auto-wake for cards decided in that window. | contributing | low | `session-start.sh:8,16-21,23-65`; `com.boardroom.daemon.plist:10-16` | Demote the probe to a wording-selector; **always** inject protocol; gate only registration on probe success. |
| C | **`present_plan` long tail: alive-but-slow has no graceful STOP.** `present_plan` is `bounded=false`, so on the alive-but-slow tail it clings to a connection Claude Code drops (~22% orphan tail) and only raw-rejects when the socket dies — no instructional exit, unlike `clarify`/`review_results`. | contributing | low | `mcp.ts:201-202,206`; `mcp.ts:155-168` | Park `present_plan` too **and** suppress plan-stage auto-wake in the waker (so it degrades gracefully without ever auto-approving the gate). |
| D | **`createdAt`-anchored reattach window can miss a recently-orphaned-but-old card → duplicate insert.** `orphanAllPending()` re-orphans pending cards on each boot but stamps no fresh clock; a card older than 24h-by-`createdAt` is "stale" the instant it becomes reattachable, so a re-issued identical call inserts a duplicate. | contributing | low | `store.ts:120-127` (window on `createdAt`); `store.ts:108-111` (re-orphan, no stamp); `queue.ts:70` (fresh insert) | Add `orphanedAt`, stamp at every orphan transition, window on it with `createdAt` fallback; make the window config-tunable. |

### 2b. Adjacent red herrings — investigated, **NOT** fixed

| Cause | Class | Why it is NOT the fix |
|---|---|---|
| `POST /mcp` mints a fresh transport on unknown session-id instead of 404/410 (`mcp.ts:242-254`). | red-herring | The installed client SDK treats 400 and 404 **identically** (no `_sessionId` reset, no retry); the fabricated transport is never inserted/heartbeated (GC-eligible, not a leak). Cosmetic hygiene only. |
| `orphanAllPending()` on boot "loses decisions" (`app.ts:24`). | red-herring | On respawn the OS already tore down all sockets/waiters; line 24 reconciles a stranded `pending` row into the *designed*, fully decidable `orphaned` state. It manufactures honest state, not loss. |
| Missing `server.on('error')` on `app.listen` → EADDRINUSE crash-loop (`index.ts:9`). | red-herring (but hardened anyway) | **Reproduced live on this host:** on Express 5 the bind error reaches the `listen()` callback rather than throwing, so there was no crash-loop — but that is version/runtime-dependent (Express 4 / raw `net` would throw uncaught). Not the cause of the observed behavior; nonetheless hardened via `guardListen` (`src/daemon/listen.ts`) so a bind failure is logged and exits cleanly everywhere. |
| Deploy model (tsx no-watch + KeepAlive) → stale daemon. | red-herring | **Live probes** show the running daemon is current-branch code (`/api/sessions`=200). The "lagging daemon" forensics were misread append-mode log history from *dead* daemons. Log hygiene only. |

**On the original two questions:** Q1 *reconnect to MCP* — **not needed** (boardroom is only the MCP
server; card survival across restart is already handled by `orphanAllPending` + fingerprint-keyed,
PID-free `findReattachable`; reconnection is the client's job and wouldn't fix the routing symptom).
Q2 *orphan inactive time* — **not needed** for the regression; reboot-reconnect is already covered by
the 24h reattach window. (Item D re-anchors *which clock* that window uses; it does not add an
inactivity timeout.)

## 3. Proposed changes

### 3.1 Re-key the session registry — fixes the wrong-worktree resume (the only HIGH-severity bug)

**What changes.** De-collapse the registry so two worktrees never clobber one row, and resolve resume
by a stable id rather than a reconstructed basename.

- `store.ts`: add `sessions_v2(cwd TEXT PRIMARY KEY, session_id, project, claude_session_id, updated_at)`
  **alongside** the legacy `sessions` table (do not rename/ALTER — keep legacy `getSession(project)`
  green for `store.test.ts`). `recordSession(project, sessionId, cwd, claudeSessionId?)` →
  `ON CONFLICT(cwd) DO UPDATE` (trailing optional arg, so `api.ts` is unchanged). Add
  `getSessionByCwd(cwd)`, `getSessionById(claudeSessionId)`, and a **fail-closed**
  `getSessionByProject(project)` (returns a row only when exactly one matches; zero or >1 → `undefined`).
- `card.ts` (`SessionInfo`): add `claudeSessionId: z.string().optional()` (existing stored cards still parse).
- `mcp.ts`: capture the live Claude `session_id` server-side (request header / `initialize` `clientInfo`)
  and thread it into `compile` → `card.session.claudeSessionId`. Keep it off the keepalive/park hot path.
- `compile.ts`: thread `claudeSessionId` onto `Card['session']` when present.
- `waker.ts` (`onCard`): resolve `getSessionById(...)` first, else fail-closed `getSessionByProject(...)`;
  no-op if neither yields a unique row. Keep the `isAbsolute`/`isExistingDir` guard as defense in depth.

**Why minimal.** Part (1) (cwd key + fail-closed fallback) alone ends the data-loss clobber and is
independently shippable. Part (2) (session-id correlation) makes resume robust **without trusting a
model-echoed string** — a rejected alternative keyed on `card.session.cwd`, which does not exist in
the MCP path and would *never* wake the exact multi-worktree case it targets. No change to fingerprint,
queue, env knobs, or keepalive.

**Status (as merged) — Part (2) is DEFERRED.** Part (1) is implemented and shipped: `sessions_v2`
(cwd-keyed), fail-closed `getSessionByProject` **and** `getSessionById` (both `undefined` on >1 match),
the legacy→v2 backfill, and the waker resolving by project. Part (2) (session-id correlation) is
intentionally **unwired**: the plumbing exists (`claude_session_id` column, the
`recordSession(..., claudeSessionId?)` arg, `getSessionById`, and the `COALESCE` preserve-on-re-register
guard) but **no producer populates it**, so it is always `NULL` and the waker resolves by project today.
The assumed producer — capturing the agent's Claude `session_id` server-side from the MCP `initialize`
`clientInfo` or a header (bullet above) — is **unverified and likely unavailable**: MCP `clientInfo`
carries only `{name, version}`, and Claude Code does not send its session id to the boardroom server.
Wiring it against that assumption would be speculative and probably non-functional, so it is deferred
until a reliable server-side source for the agent's session id exists. `card.ts`/`mcp.ts`/`compile.ts`
were therefore **not** changed for Part (2).

**TDD (red first).** `store.test.ts`: two same-basename worktrees both survive distinctly; ambiguous
basename → `undefined`; resolves by claude session id. `waker.test.ts`: resumes the correct worktree by
claude session id; fail-closed (ambiguous + no id → no spawn). `tests/integration.test.ts`: two
same-basename sessions, two cards, each resumes its own cwd (exercise the orphaned→decided path too).

### 3.2 SessionStart hook: fail-open on the probe, fail-**closed** on guidance

**What changes (one file: `hooks/session-start.sh`).**
1. Replace the `curl ... || exit 0` with `connected=1; curl ... || connected=0` — never exit before injection.
2. Gate the `POST /api/session` registration block on `[ "$connected" = 1 ]` (still `|| true`). **No retry loop, no new env knobs** (retrying a daemon the probe just found unreachable is pure latency; the row self-heals on the next good start).
3. Keep the connected `PROTOCOL` heredoc; add a near-identical `FALLBACK` heredoc (same routing rules; header notes the daemon may be offline; closing bullet: fall back to chat if `mcp__boardroom__*` is unreachable).
4. `ctx = connected ? PROTOCOL : FALLBACK`, then **always** run the final `jq` emitting `additionalContext`. Comment that the final `jq` **must remain the last statement** (so `read -r -d ''`'s EOF exit-1 can't flip the hook non-zero).

**Why minimal.** Shell-only; no daemon/TS changes (`api.ts` + `store.ts` already upsert idempotently).
The static protocol becomes a guaranteed floor; the probe only chooses wording. This rejects the
heavier "retry-with-three-env-knobs" design, which measured ~9.7s per SessionStart against a hanging
cold daemon vs ~2s here.

**TDD (red first, process-spawn style).** (a) injects protocol even when the daemon is unreachable
(today: empty stdout → JSON.parse throws); (b) connected probe → connected wording **and** exactly one
registration POST; (c) unreachable → fallback wording, **no** POST; (d) latency bound: a server that
accepts but never responds → hook completes < ~3s (pins the retry regression closed); (e) exits 0 in
all branches.

### 3.3 Give `present_plan` a graceful long tail — *without* auto-approving the gate

**Two edits that MUST ship together (safety pair).**
1. `mcp.ts:206`: flip `present_plan` to `bounded=true` so it parks on `BLOCK_MS` and returns the
   `PARKED_TEXT` hard-STOP sentinel instead of clinging to the connection.
2. `waker.ts` `onCard`: after the existing guards, `if (card.stage === 'plan') return` — a plan card is
   an approval gate; its verdict must be claimed by the agent **re-issuing `present_plan`** (which
   re-surfaces the app-native gate), never pushed via an unsolicited `claude --resume`.
3. Doc/description cleanup: `mcp.ts` comments + `DESCRIPTIONS.present_plan`, `docs/agent-snippet.md`,
   `docs/superpowers/specs/2026-06-11-boardroom-design.md` — drop "present_plan never parks", note
   plan-stage auto-wake suppression.

**Why both.** Flipping the flag alone is unsafe: the waker fires for **all** stages with a
verdict-agnostic "continue the work you paused" resume — so a slow human's eventual "approve" would
**auto-resume the agent into building**, the exact auto-green-light the exemption exists to prevent.

**TDD (red first).** (A) **mandatory** waker guard: a decided `stage:'plan'` card does **not** spawn
(`deliveredAt` stays undefined → claimable on re-issue); a `stage:'clarify'` card **does** spawn. (B)
MCP park: with `BLOCK_MS` short, `present_plan` returns parked/STOP text, one orphaned/zero pending,
**no** verdict text. (C) keep the clarify park + `decide-then-reissue` tests as regression anchors.

### 3.4 Re-anchor the reattach window to orphan time

**What changes.**
1. `card.ts`: add `orphanedAt: z.string().optional()` (no migration; existing rows parse).
2. `queue.ts`: stamp `orphanedAt = now` at both inline orphan transitions — `disconnect()` and `park()`.
3. `store.ts` `orphanAllPending()`: stamp `orphanedAt` (the site that produces the bug).
4. `store.ts` `findReattachable()`: window on `Date.parse(c.orphanedAt ?? c.createdAt)`.
5. `config.ts`: add `reattachWindowMs` (default `24*60*60_000`), thread `createDaemon → Queue →
   findReattachable` (keep `windowMs` a defaulted param so existing call sites still override). **Do
   not** make `Store` read `process.env`; `config.ts` is the established seam (parity with `BLOCK_MS`).

**Why minimal.** `orphanedAt` optional → no migration; the `?? c.createdAt` fallback makes legacy rows
behave exactly as today.

**TDD (red first, drive the real path).** `store.test.ts`: a **pending** card with `createdAt` 48h ago,
`orphanAllPending()`, then `findReattachable` still returns it (RED today). Regressions: a 1-min-old
legacy no-`orphanedAt` card still reattaches; a genuinely-stale orphan still returns `undefined`;
`reattachWindowMs=1` excludes after 1ms. `queue.test.ts`: back-date `createdAt` 48h, `disconnect()`
stamps `orphanedAt`, re-submit identical fingerprint → **same** cardId, exactly one card (no fresh
insert). *(A higher-value sibling fix — dedup-on-insert at `queue.ts:70` so a stale duplicate can't be
decided in place of the original — is noted as an option, not in scope here.)*

## 4. Sequencing & scope (commits grouped by scope)

1. **Commit A — wrong-worktree resume (3.1).** Highest severity, only silent-data-harm bug. Ship part
   (1) (cwd key + fail-closed fallback) even if part (2) (session-id correlation) is deferred — part (1)
   alone converts a wrong-tree edit into a safe *missed* wake.
2. **Commit B — SessionStart hook (3.2).** Shell-only, isolated; directly addresses the post-reboot feel.
3. **Commit C — present_plan park + waker plan-stage guard (3.3).** One commit (safety pair) + doc updates.
4. **Commit D — reattach window orphan-time anchor (3.4).** Independent, smallest blast radius.

**Defer:** session-id correlation (3.1 part 2) may be a follow-up; clean-404 transport hygiene and
`server.on('error')` are optional hardening (see §6). **Do nothing** on the four §2b red herrings —
except optional plist log rotation so dead-daemon stacks can't be misread again. Explicitly **do not**
add a version-skew guard and **do not** change `app.ts:24`.

## 5. Risks & non-goals

**Risks (all Low after the tightened designs).** 3.1: new table abandons already-unreliable legacy rows
(self-heals next SessionStart); if correlation is deferred, multi-worktree auto-wake degrades to
dashboard copy-paste — strictly *safer* (missed wake, never wrong-tree edit). 3.2: a daemon-absent
session now always gets guidance whose tools may not resolve — mitigated by distinct fallback wording;
it only makes the already-loaded `CLAUDE.md` stance reliable. 3.3: plan continuation is slightly delayed
(agent re-issues rather than being pushed) — that delay *is* the gate. 3.4: confirm a card legitimately
orphaned beyond the window is still excluded.

**Non-goals.** Eliminating the ~22% connection-drop orphan tail (external client behavior; keepalive/park
already absorbs it); changing the orphaned-card lifecycle, the `captured_sessions`↔`sessions` separation,
`app.ts:24`, the MCP heartbeat, the deploy model, or fingerprint equality; "fixing" the MCP 404,
`index.ts:9`, or the deploy model as behavior root causes — they are not.

## 6. Open decisions (each with a recommendation)

1. **Scope this round.** *Recommend:* A + B + C + D now (each small, independently testable). — *vs.* A-only (just the dangerous bug) — *vs.* A + B (bug + the post-reboot symptom).
2. **Hook posture.** *Recommend:* fail-closed-on-protocol only (always inject; probe selects wording; gate registration on probe). — *vs.* wait-for-ready retry (adds ~9.7s cold) — *vs.* both.
3. **Session-id correlation timing.** *Recommend:* ship 3.1 part (1) now, correlation as the immediate follow-up. — *vs.* both now — *vs.* part (1) only, no follow-up.
4. **Make the reattach window config-tunable?** *Recommend:* yes, via `config.ts` only (`reattachWindowMs`). — *vs.* leave hardcoded at 24h.
5. **Clean 404/410 for unknown session-ids on `/mcp`?** *Recommend:* defer (no client-visible change). — *vs.* do it as standalone hygiene now.
6. **`server.on('error')` on `index.ts:9`?** *Recommend:* optional 3-line hardening, deferred (defends Linux/raw-net; no macOS symptom). — *vs.* include now.
7. **Menubar-vs-LaunchAgent double-start.** *Recommend:* out of scope; flag for a separate decision (second bind fails silently here). — *vs.* address now (menubar adopts the LaunchAgent daemon).
