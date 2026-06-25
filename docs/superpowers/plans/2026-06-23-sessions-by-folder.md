# Sessions-by-folder view (Finder column layout) — implementation plan

**Date:** 2026-06-23
**Status:** awaiting approval (boardroom present_plan)
**Scope:** First read-only UI on top of the shipped session-capture data (P0). Local machine only.

## Decisions already made (boardroom clarify, card dbd3e646)

| # | Question | Choice |
|---|----------|--------|
| 1 | Layout | **Finder column (Miller) view** |
| 2 | Placement | **Separate "Folders" view, reached by a toggle** — note: "could be a new page or a modal on top" |
| 3 | Count semantics | **Count all captured (alive + ended)**; status dot per session row |

The one open item (page vs modal) is resolved in this plan: a hash-routed full-screen
overlay (`#/folders`) — own URL ("a page") rendered on top of the dashboard ("a modal"),
identical to the existing `FileViewer` pattern, Esc/Back returns to the inbox.

## Key facts grounding the design

- The daemon already captures every Claude Code session on this machine into
  `captured_sessions` (`cwd`, `project`, `status: alive|ended`, `pid`, `startedAt`,
  `lastSeenAt`, `entrypoint`, `kind`, `transcriptPath`, `tasksDir`) and serves the full
  list at **`GET /api/sessions`** (`store.listCaptured()`). `GET /api/device` gives the
  machine's `deviceLabel`. **Both endpoints already exist — no backend change.**
- Right now (real data): 8 running sessions across 3 folders —
  `~/Desktop/Playground/boardroom` (5), `~/Desktop/Paradigm/web/paradigm-study-web` (2),
  `~/Desktop/clawbench` (1).
- The web app routes via hash (`parseHash` in `fileView.ts`); `FileViewer` is a
  full-screen overlay reached at `#/file?...`, returning early from `App` to replace the
  whole `.frame`, with Esc/Back via a `returnHash` ref. We mirror that exactly.

## Build sequence

### Phase 1 — Sessions API client + types
- `web/src/api.ts`: add `fetchSessions(): Promise<CapturedSession[]>` (GET `/api/sessions`)
  and `fetchDevice(): Promise<{ deviceLabel: string; machineId: string }>` (GET `/api/device`),
  reusing the existing `check()` error wrapper.
- Reuse the `CapturedSession` type from `src/shared/session.ts` (web already imports
  `../../src/shared/card.js`), so the client and daemon share one schema.

### Phase 2 — Folder-tree core (TDD, pure, no React)
- New `web/src/folderTree.ts`: pure functions, unit-tested first.
  - `commonAncestor(cwds)` → deepest shared path prefix (the column-0 root).
  - `buildColumns(sessions, selectionPath)` → the Miller-column model: for a given
    selection path, the list of columns, each a list of `{ name, fullPath, total, running,
    hasChildren }` folder entries plus, at a leaf, the session rows.
  - Per-node counts: `total` = all captured under the node (the badge), `running` = alive
    subset (secondary accent). Status per session row from `status`.
  - `~` home abbreviation for display; absolute paths kept for keys/selection.
  - Robust to: a single session (root = its parent), sessions on different roots
    (ancestor = `/`), duplicate cwds (two sessions in one folder), `alive`+`ended` mix.
- New `web/src/folderTree.test.ts` covering each case above, written before the impl.

### Phase 3 — Finder column view component
- New `web/src/FolderColumns.tsx`: the Miller-column browser + a rightmost session-detail
  pane. Clicking a folder opens the next column; clicking a session opens detail
  (status dot, agent/entrypoint, pid, started/last-seen relative, full cwd, device label,
  whether a transcript exists). Transcript bodies are **not** opened/served (honors the
  capture spec's "pointers, not content" boundary) — we show presence only.
- `web/src/styles.css`: column strip, folder rows + count badges, alive/ended dots,
  detail pane; horizontal scroll for deep paths; dark-mode + responsive parity.
- Reuse a relative-time helper (lift `age()` from `TaskSidebar.tsx` into `helpers.ts`).
- New `web/src/FolderColumns.test.tsx`: render + drill-through interaction tests.

### Phase 4 — Route, toggle, live refresh
- `web/src/fileView.ts`: extend `Route` with `{ kind: 'folders' }`; parse `/folders`.
- `web/src/App.tsx`: when `route.kind === 'folders'`, render `<FolderColumns onClose=…/>`
  full-screen (same early-return + `returnHash` mechanism as `FileViewer`); Esc/Back →
  dashboard. Fetch sessions on open and **poll `/api/sessions` every ~4s while open**
  (the capturer ticks at 5s); stop polling on close. (SSE extension is a possible later
  optimization, noted but not built.)
- `web/src/TaskSidebar.tsx`: a "Folders" link (`<a href="#/folders">`) in `.side-head`,
  showing the running-session count — the toggle into the view.

### Phase 5 — Verify, review, commit
- Self-verify in the browser with the preview tools: open `#/folders`, confirm the three
  real folders + counts render, drill through columns, open a session detail, Esc returns.
- Multi-agent adversarial review (Workflow) + CodeRabbit; address findings.
- Commit split by scope (api client / folder-tree core / view+styles / route+wiring),
  per the established review-workflow preference.

## Files

| File | Change |
|------|--------|
| `web/src/api.ts` | + `fetchSessions`, `fetchDevice` |
| `web/src/folderTree.ts` | new — pure column/tree model |
| `web/src/folderTree.test.ts` | new — TDD |
| `web/src/FolderColumns.tsx` | new — Miller columns + detail pane |
| `web/src/FolderColumns.test.tsx` | new |
| `web/src/helpers.ts` | + shared `age()` relative-time |
| `web/src/fileView.ts` | + `folders` route |
| `web/src/App.tsx` | route → overlay, polling, return-hash |
| `web/src/TaskSidebar.tsx` | + Folders toggle |
| `web/src/styles.css` | + column/badge/detail styles |

**No `src/daemon/**` or `src/shared/**` changes** beyond importing the existing
`CapturedSession` type into web. Backend untouched → zero server risk.

## Non-goals (this slice)
- No cross-device aggregation (deferred sync rung).
- No transcript-body rendering / serving (security boundary from the capture spec).
- No retention/GC of ended rows (deferred per capture spec).
- No session control (start/resume/stop) — read-only.
