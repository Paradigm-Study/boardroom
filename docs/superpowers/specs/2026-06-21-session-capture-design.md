# Session capture & safe storage — design spec

**Date:** 2026-06-21
**Status:** draft pending user review (adversarially reviewed; fixes applied)
**Scope:** the foundation slice ("this patch") of the larger portable-session-console direction.

## 1. Problem and scope

Boardroom is heading toward a **portable session console**: log in on any device and see the
context/scope of your agent sessions across your machines, decide remotely, and eventually
control a running session (captured as a capability ladder L0–L9 in the brainstorming artifacts).
This spec is **only the bottom of that ladder.**

**This patch does exactly one thing: reliably capture every agent session on the machine and
store the capture safely.** We do not start, resume, redirect, or stop sessions; we do not expose
anything remotely; we do not derive status/titles/progress; we do not build any new UI. We
observe what is already happening and persist a durable, securely-stored record that later
patches read from.

**Honest blast-radius statement.** This patch is *not* purely passive. It makes the daemon ingest
files written by *other* processes (`~/.claude/sessions/*.json`) into its store. The only place
that store touches execution today is the **waker** (`claude --resume`), so the security design
below deliberately keeps the waker on its existing trust boundary: it resumes **only sessions
boardroom itself registered via the loopback hook**, never arbitrary registry-captured rows
(§5.2). With that boundary held, the patch adds no new execution-reachable surface; without it,
it would (§5.2 explains the attack it closes).

### In scope

- Capture **all** live agent sessions on the machine (not only hook-reported ones).
- Give every session a **stable identity** that does not collide.
- **Safely store** the captured records (and fix the adjacent world-readable storage already present).
- Keep the existing SessionStart-hook → waker path working, on its current trust boundary.

### Explicit non-goals (deferred to later patches)

- Remote access of any kind (tunnel, hub, account login, cross-device sync/aggregation).
- Any console/inbox UI for sessions.
- **Processing** the capture: no derived status beyond alive/ended, no title, no plan/progress,
  no token accounting, no transcript parsing.
- Starting / resuming / redirecting / stopping sessions on demand ("initiate" / control).
- Ingesting transcript **bodies** into our storage (we store best-effort pointers, not content).
- At-rest **encryption** beyond OS full-disk encryption + locked file permissions.
- **Retention / GC** of records for ended sessions — they are retained indefinitely (§5.3).
- **The captured records must not leave the machine** until the deferred encryption + transport
  layer exists — the path index this builds is sensitive (§3) and is local-only by design here.

## 2. Decisions log

| # | Decision | Choice |
|---|---|---|
| 1 | End-state structure | Zero-knowledge "dumb courier" hub — **end-state only, not built here.** |
| 2 | This patch's job | **Capture all sessions on the machine and store them safely. Do not process or act on them.** |
| 3 | Identity | Key on **`sessionId`** (fixes today's `project`-keyed collision). |
| 4 | Waker trust boundary | Waker resumes **only hook-sourced rows**; registry-captured rows are observe-only. |
| 5 | `machineId` + nickname | **Kept.** Each machine has an immutable `machineId` plus a **user-editable `deviceLabel` nickname** (default = hostname), stored once per machine (not per session) so a rename propagates without rewriting rows. |
| 6 | Safe storage | Born-locked files (`umask 0077`) + lock the existing world-readable attachments; **app-level encryption deferred.** |

## 3. What we capture (data model)

One record per real session, keyed by the Claude Code **session UUID**. We capture facts read
directly from the live-session registry file plus **best-effort pointers** to where richer context
lives, so a later processing patch can act without re-capturing.

```ts
interface CapturedSession {
  sessionId: string;        // Claude Code session UUID — the stable identity (PRIMARY KEY)
  source: 'registry' | 'hook'; // how this row was captured — gates waker eligibility (§5.2)
  machineId: string;        // stable, IMMUTABLE per-machine id. The editable nickname (deviceLabel) is
                            //   resolved from machineId via the machine-identity record (§4 step 4), NOT
                            //   stored per row — so renaming a device never rewrites session rows.
  pid?: number;             // OS pid (registry rows only; NOT identity — pids recycle). Optional: hook rows lack it.
  procStart?: string;       // process start time from the registry file — for future recycled-pid disambiguation
  cwd: string;              // absolute working directory
  project: string;          // basename(cwd) — grouping only, NO LONGER an identity key
  claudeVersion?: string;   // carried verbatim from the registry file; not consumed in this patch
  entrypoint?: string;      // 'claude-desktop' | 'claude-vscode' | … ; carried verbatim, not consumed
  kind?: string;            // e.g. 'interactive'; carried verbatim, not consumed
  startedAt?: string;       // session start (from the registry file), ISO 8601
  status: 'alive' | 'ended';// liveness ONLY (see §4) — NOT a "mid-turn vs idle" judgement
  capturedAt: string;       // when first captured
  lastSeenAt: string;       // when the poller last confirmed it (alive, or transitioned to ended)
  transcriptPath?: string;  // DERIVED, best-effort pointer; populated ONLY if the file exists (§4)
  tasksDir?: string;        // DERIVED, best-effort pointer; populated ONLY if the dir exists (§4)
}
```

`pid` is optional because the hook capture path (§5.2) supplies only `{sessionId, cwd, project}`.
`claudeVersion`/`entrypoint`/`kind` are carried verbatim from the registry blob (zero extra cost,
already parsed) but are **not** consumed in this patch — flagged so they aren't mistaken for
required capture. Deliberately **not** captured (they require reading content = processing,
deferred): derived title, git branch, plan/progress, token usage, mid-turn/idle activity,
transcript text.

**Sensitivity — and why it justifies the locking in §5.** Individually these are ids, paths, and a
version string. But in **aggregate** the set of `cwd` + `project` + `transcriptPath` across all
sessions enumerates the operator's entire working tree: absolute `/Users/<realname>/…` paths,
client/customer names, unreleased-product codenames, internal repo and worktree names. That index
is **medium-to-high sensitivity** — it is precisely the kind of thing the deferred sync rung would
ship off-box — so it is the explicit justification for the file locking in §5.3, and for the
non-goal that this data must not leave the machine until encryption + transport exist. We still do
**not** copy transcript bodies (the highest-sensitivity content) into our store.

## 4. Capture mechanism

Ground truth for live sessions is Claude Code's on-disk registry: `~/.claude/sessions/<pid>.json`,
one file per running CLI process, carrying `{ pid, sessionId, cwd, startedAt, procStart, version,
entrypoint, kind, … }` (verified against live files). The filename is the OS pid.

The daemon gains a **SessionCapturer**:

1. **Reconcile (source of truth) + watch (latency only).** A periodic reconcile tick (default 5 s)
   re-reads every `~/.claude/sessions/*.json` and is the **authoritative** liveness pass. An
   `fs.watch` on that directory is a *latency optimization* to react faster; correctness must not
   depend on receiving every FS event (macOS FSEvents can coalesce/miss). If the directory does not
   exist, the capturer is idle (no error).
2. **Liveness probe.** A registry file is written at launch and not refreshed, so existence ≠ alive.
   Probe with `process.kill(pid, 0)` — in-process, side-effect-free (signal 0 only checks
   existence/permission, delivers nothing), no child spawned. Dead pid → mark `status: 'ended'`,
   update `lastSeenAt`. **Known limitation:** pids recycle, so a reused pid can briefly mark an
   ended session `alive`. We accept this for capture-only (it self-corrects when the file is
   overwritten/removed); its execution impact is bounded because the waker resumes only hook-sourced
   rows (§5.2), not registry rows. `procStart` is captured now so a later precision pass can
   disambiguate recycled pids without re-capture. We never delete registry files we don't own.
3. **Upsert by sessionId, tagged `source: 'registry'`.** Parse each file and upsert a
   `CapturedSession` keyed by `sessionId` — not pid, not project. Concurrent sessions in one repo
   and same-basename checkouts each get their own row; the current collision is gone. Malformed/foreign
   files are logged and skipped, never fatal (mirrors the existing `parseRow` discipline).
4. **Machine identity.** On first run, mint an immutable `machineId` (`randomUUID()`) and persist a
   small machine-identity record `{ machineId, deviceLabel }` in the config dir, where `deviceLabel`
   is a **user-editable nickname** defaulting to the OS hostname. Reuse thereafter. Session rows
   carry only `machineId`; the nickname is resolved from this record at read time, so renaming a
   device never rewrites session rows. The nickname is changeable by editing config and via a
   minimal loopback `PUT /api/device` endpoint (for a later UI) — `machineId` itself is never editable.
5. **Best-effort pointers.** `transcriptPath`/`tasksDir` are **derived, not read from the registry**
   (the registry carries no path). Locate the transcript by **globbing
   `~/.claude/projects/*/<sessionId>.jsonl`** (robust to Claude Code's lossy cwd→slug encoding, which
   replaces `/` *and* `.` — and other non-alphanumerics — with `-`); locate tasks at
   `~/.claude/tasks/<sessionId>/`. Populate each field **only if the path actually exists** (`stat`
   at capture); otherwise leave it unset. (Observed: most sessions have a transcript; only a minority
   have a tasks dir — it is genuinely best-effort.)

## 5. Storage & safety

### 5.1 Schema change (fixes the identity collision)

Add a session-keyed registry; the migration is non-destructive and runs idempotently in the `Store`
constructor:

```sql
CREATE TABLE IF NOT EXISTS captured_sessions (
  session_id  TEXT PRIMARY KEY,
  source      TEXT NOT NULL,        -- 'registry' | 'hook'
  json        TEXT NOT NULL,        -- the full CapturedSession, Zod-validated on the way in
  updated_at  TEXT NOT NULL
);
```

No secondary index: this table holds at most a handful of live sessions on one machine, so
`getSession` scans and filters in JS (matching the existing `findReattachable` pattern). The old
`project`-keyed `sessions` table is **not dropped** — destructive DDL has no upside here and the old
table is harmless dead weight once unused; leaving it also keeps "boots fine on the old schema" true.
A Zod `CapturedSession` schema validates on insert exactly as `Card` does, so no malformed row
reaches SQLite.

### 5.2 Backward compatibility AND the waker trust boundary (the blocking fix)

The waker (`waker.ts`) takes a `{sessionId, cwd}` and spawns `claude --resume <sessionId>` detached
from `cwd`. Its own comment notes the registry is "a trusted-but-unauthenticated write surface."
If `getSession` returned the latest *registry-captured* row, any local process could plant
`~/.claude/sessions/9999.json` with an attacker-chosen `sessionId`/`cwd` and steer an auto-wake.

**Fix:** capture is observe-all, but **`getSession(project)` returns only the most-recently-updated
`source: 'hook'` row** for that project (scanned/filtered in JS). The hook is the loopback,
boardroom-originated path that exists today, so the waker's trust boundary is *unchanged* — it still
only resumes sessions boardroom itself registered. Registry-captured rows exist purely for the
future read-only console and never feed execution.

`recordSession(...)` (the hook fold-in, fired by `hooks/session-start.sh` → `POST /api/session`)
upserts a row with `source: 'hook'`, `status: 'alive'` (the hook only fires from a live session),
and no `pid`. No waker code changes; the contract test still passes.

### 5.3 "Stored in a safe way"

1. **Don't proliferate sensitive data.** Store best-effort **pointers** to transcripts/tasks, never
   their bodies — the high-sensitivity content stays where Claude Code wrote it. Shipping it
   elsewhere is a later decision, gated on encryption.
2. **Born-locked files + lock what's already loose.** Set `process.umask(0o077)` before creating the
   config dir, the SQLite DB, and any attachment files, so they are created `0600`/`0700` from birth
   — closing the TOCTOU window where better-sqlite3 would otherwise create the DB and its frequently
   rewritten `-wal`/`-shm` siblings world-readable (`0644`) before a later `chmod`. As
   belt-and-suspenders, `chmod` pre-existing files on open (guarded so missing `-wal`/`-shm` never
   throw). **Crucially, this patch also locks the already-world-readable attachment store**:
   `~/.config/boardroom/attachments` is `0755` with `0644` files today (verified) — the
   single most sensitive plaintext boardroom holds. Lock the dir to `0700` and write attachment +
   metadata files `0600`. (Correcting the earlier draft's false claim that sensitive plaintext lived
   "solely in `~/.claude`".)
3. **FDE is the at-rest baseline; app-level encryption deferred.** FileVault/LUKS is documented as a
   hard prerequisite. App-level encryption (e.g. SQLCipher) is deferred to the patch that first
   stores high-sensitivity *content* or ships data off the machine — for a local-only metadata/path
   index, `umask` + locked perms + FDE is the right bar. (The path index is medium-high sensitivity
   per §3, which is exactly why the locking above is non-optional rather than nice-to-have.)

## 6. Testing

- **Identity:** two sessions with the same `basename(cwd)`, and two concurrent sessions in one cwd,
  produce two distinct rows (regression for the collision).
- **Capture parsing:** a sample `~/.claude/sessions/<pid>.json` upserts a well-formed
  `CapturedSession` (`source: 'registry'`); a malformed file is skipped, not fatal.
- **Liveness/reaping:** a registry entry whose pid is dead transitions to `status: 'ended'`.
- **Waker trust boundary:** a planted `source: 'registry'` row is **never** returned by
  `getSession`; only `source: 'hook'` rows are eligible; the existing waker contract still holds for
  hook rows.
- **Hook fold-in:** `POST /api/session` upserts a `source: 'hook'`, `status: 'alive'`, pid-less row.
- **Pointers:** `transcriptPath`/`tasksDir` are set only when the path exists; a session with no
  tasks dir leaves `tasksDir` unset; the transcript is found via glob even when the cwd contains `.`.
- **Safe storage:** immediately after construction (not just after a later chmod) the config dir is
  `0700`, the DB is `0600`, the `-wal`/`-shm` are `0600` after a checkpoint, and the attachments dir +
  files are `0700`/`0600`.
- **Device nickname:** `deviceLabel` defaults to the hostname, can be changed (config / `PUT /api/device`)
  and persists; the immutable `machineId` is unaffected and session rows still resolve to the new nickname.
- **Migration:** boots against a DB that still has the old `sessions` table and serves the new path.

Harness: unit tests on the store/capturer, plus an integration test that boots the daemon, drops
fake registry files into a temp `~/.claude/sessions`, and asserts capture + reaping end-to-end.

## 7. Assumptions to confirm at review

1. **"All logged-in devices" → per-machine capture now.** Each machine captures its own sessions
   (tagged with `machineId`). Cross-device aggregation needs the deferred sync layer. ← confirm.
2. **Capture ≠ process.** Registry-level facts + best-effort pointers only; no transcript/tasks
   parsing, no derived title/branch/status-beyond-alive. ← confirm this matches "not even process."
3. **Safe = pointers + born-locked perms (incl. attachments) + FDE baseline; encryption deferred.**
   ← confirm acceptable for capture-only data.
4. **Keep `machineId` now, plus an editable device nickname.** Immutable `machineId` per machine + a
   user-renamable `deviceLabel` (default hostname), stored once per machine. (Confirmed at review.)
5. **Waker stays hook-only.** Registry-captured sessions are observe-only and never auto-resumed. ←
   confirm (this is the security boundary).
