# Boardroom — design spec

**Date:** 2026-06-11
**Status:** approved pending user review
**Working name:** boardroom (rename freely)

## 1. Problem and vision

Agent-generated plans are written for agents: long, exhaustive, correct — and unreadable for the human who has to approve them. The human's actual job is CEO-shaped: high-level decisions and structural design calls, best served by graphs, short titles, and buttons — not walls of markdown.

Boardroom is a visual decision layer between agents and their human. Agents send their questions, plans, and results to a local daemon; the human reads them as composed visuals on a dashboard and answers by clicking buttons; the answers flow back into the agent session as structured instructions.

The core abstraction: **decisions are always buttons; everything else is informational visuals.** Layout is composition of those two primitives, never a fixed template.

It covers the full workflow loop, mirroring how a well-run agent session already works:

1. **Clarify** — the agent asks scoping questions to nail the plan down.
2. **Plan approval** — the agent presents the formed plan; the human approves, redirects, or rejects.
3. **Results review** — the agent submits claims about what it did, with evidence; the human approves or denies each claim.

## 2. Decisions log

Every load-bearing decision from the scoping session, in order:

| # | Decision | Choice |
|---|---|---|
| 1 | Direction | Two-way: the visual is the approval surface; decisions return to the agent |
| 2 | Integration | MCP server, local-only, single user |
| 3 | Data contract | Structured schema — the agent distills its own plan at call time; no second LLM |
| 4 | Core abstraction | Decision card = visual blocks (info) + decision buttons (binding); layout is composition |
| 5 | Tool shape | Three stage-flavored facades (`clarify`, `present_plan`, `review_results`) on one shared engine |
| 6 | Visual language | Typed block library rendered by us + `mermaid` escape hatch |
| 7 | Surface | Persistent dashboard + queue; one inbox for all agent sessions |
| 8 | Interception | Protocol, not force: agent instructions say to call the tools; if the daemon is down, agent falls back to native in-app asking; the agent app's own approval remains the final proceed gate |
| 9 | Results granularity | Claim-by-claim verdicts with evidence; denial notes become the agent's next instructions |
| 10 | Waiting | Tool calls hang until the human decides; reminder system nudges; timeout/fallback is for crash scenarios only |
| 11 | V1 scope | All three stages |
| 12 | Stack | TypeScript everywhere |
| 13 | Topology | Single HTTP MCP daemon at localhost; dashboard and MCP served from one process |
| 14 | Packaging | Browser tab in v1; menu bar shell deferred (pure packaging, daemon API already supports it) |

## 3. Architecture

One long-lived TypeScript process — the **daemon** — owns everything server-side. Browsers and agents are both just clients.

```
Claude Code ──┐
Codex ────────┼── MCP (streamable HTTP) ──► daemon (localhost:4040)
any MCP agent─┘                              ├─ MCP endpoint  /mcp
                                             ├─ queue + SQLite store
                                             ├─ reminder engine (macOS notifications)
                                             └─ dashboard (static SPA) + SSE event stream
                                                          ▲ cards    │ decisions
                                                          └──────────┘
                                                            browser
```

### Components

- **MCP endpoint** (`/mcp`, streamable HTTP transport, official `@modelcontextprotocol/sdk`): exposes the three tools. Agents register it once (`claude mcp add --transport http boardroom http://localhost:4040/mcp`).
- **Queue + store**: pending/decided/orphaned cards, persisted in SQLite (file in the config dir). In-memory map of hanging tool-call resolvers keyed by card id; each resolver is tied to its transport connection so a caller disconnect is detected the moment it happens.
- **Reminder engine**: macOS notification on card arrival; re-nudge every 10 minutes (configurable) while anything is pending. Notification click opens the dashboard at that card. Orphaned cards don't nag.
- **Dashboard**: React/Vite SPA served statically by the daemon; live updates over a single `GET /events` SSE stream (browser `EventSource` reconnects automatically); decisions submitted over plain HTTP POST. No WebSocket — nothing ever flows client→server outside normal requests.

The daemon binds `127.0.0.1` exclusively; there is deliberately no host config option in v1. This is the security predicate for shipping without auth — an unauthenticated plan-approval surface must never be reachable from the LAN.

### Request lifecycle

1. Agent calls a tool. The call **does not return** — it hangs until the human decides.
2. Daemon validates the payload (Zod). Invalid → immediate MCP error listing the exact validation failures so the agent self-corrects and retries.
3. Valid → card created (`pending`), persisted, pushed to the dashboard over SSE, notification fired.
4. The hang is **unbounded by design** — the invariant is that no timeout on our side ever exists. The threat is the client's own MCP tool-call timeout, which the daemon cannot control; setup therefore requires disabling it or setting it effectively infinite, with verified per-client instructions shipped in the docs (for Claude Code: `MCP_TOOL_TIMEOUT`). The daemon additionally emits MCP progress notifications (~every 30s) as belt-and-braces for clients that reset their timeout on progress — but the design must not depend on that behavior.
5. Human submits decisions → card flips to `decided`, the hanging call resolves with the structured response, the agent continues.
6. Caller-gone path (the common failure): the agent is killed, the session closes, or a client timeout fires anyway while the card hangs. The daemon detects the transport disconnect and immediately flips the card to `orphaned` — no zombie cards nagging forever in the inbox.
7. Daemon-gone path: daemon unreachable or dies mid-hang → the agent's tool call errors → per its instructions (CLAUDE.md snippet shipped with boardroom), it falls back to asking natively in-app. On daemon restart, previously pending cards reload from SQLite as `orphaned`.

**Orphaned cards stay useful.** An orphaned card can still be answered in the dashboard: the same buttons and notes work, the daemon records the verdicts, and renders the would-be `CardResponse` summary as copyable text to paste into the (resumed) agent session manually. A live resolve is impossible and never pretended — only the copy path is offered.

### Why one daemon

Multiple simultaneous agent sessions must feed one queue, and calls must hang server-side. A per-session server can't provide a unified inbox; a shared daemon over streamable HTTP needs zero per-session plumbing. If a stdio-only MCP client ever matters, a thin stdio→HTTP forwarding shim is a later add-on, not a redesign.

## 4. Data model

Everything is a **card**:

```ts
type Stage = "clarify" | "plan" | "results";

interface Card {
  id: string;
  stage: Stage;
  session: { agent: string; project: string; title?: string };  // who's asking
  headline: string;            // the one-liner the CEO reads first
  blocks: Block[];             // visuals — purely informational
  decisions: Decision[];       // buttons — the only binding interaction
  status: "pending" | "decided" | "orphaned";
  createdAt: string;
  decidedAt?: string;
}
```

### Blocks (v1 vocabulary)

Each type is rendered by boardroom, consistently. All blocks share `{ id, type, title? }`.

| Type | Payload | Shows |
|---|---|---|
| `markdown` | `{ text }` | Short prose; the text escape hatch |
| `graph` | `{ nodes: [{id, label, kind?}], edges: [{from, to, label?}] }` | Components/dependencies; auto-layout; node clicks focus linked decisions (non-binding) |
| `phases` | `{ phases: [{title, summary?}] }` | Ordered stage timeline |
| `options_compare` | `{ options: [{label, pros[], cons[], recommended?}] }` | Side-by-side option cards |
| `table` | `{ columns[], rows[][] }` | Plain structured data |
| `diff_stat` | `{ files: [{path, additions, deletions}] }` | Change footprint evidence |
| `evidence` | `{ command?, output, exitCode? }` | Test/command output, collapsed by default |
| `mermaid` | `{ source }` | Anything outside the vocabulary; render failure shows raw source |

Invariant: **block interactions are strictly non-binding.** No click on any visual may ever record or alter a decision — clicks may only focus, highlight (via `blockRefs`), expand, or collapse. Buttons in `decisions` are the sole binding surface.

### Decisions

```ts
interface Decision {
  id: string;
  prompt: string;                              // "Token storage?"
  options: { id: string; label: string; detail?: string; recommended?: boolean }[];
  multi?: boolean;                             // pick-one (default) vs pick-many
  blockRefs?: string[];                        // which blocks explain this decision
  noteRequiredOn?: string[];                   // option ids that demand a note (e.g. deny)
}
```

Free-text note is always available on every decision; it is required when the chosen option is in `noteRequiredOn`.

### Response (tool result returned to the agent)

```ts
interface CardResponse {
  cardId: string;
  decisions: Record<string, { chosen: string[]; note?: string }>;
  summary: string;   // daemon-generated plain-text recap, e.g. for results:
                     // denied claims + notes listed first as next instructions
}
```

## 5. Tool facades

Three MCP tools, all compiling to the same card. The per-stage schemas exist to coach the agent toward good cards.

Session attribution (shared by all three): the agent name comes from MCP `clientInfo` at initialize; every tool input carries a required `project` field (the agent passes its project name or cwd) and an optional `title`. Cards missing attribution render as "unknown session" rather than failing — attribution is for the inbox, not a gate.

### `clarify`

Scoping questions before/while planning. Requires ≥1 decision; blocks optional. Maps almost 1:1 to the generic card.

### `present_plan`

Requires: `headline`, ≥1 structural block (`graph`, `phases`, or `options_compare`), every plan-level decision carries options with exactly one `recommended`, and the daemon auto-appends a final verdict decision — `approve plan` / `revise (note required)` / `reject (note required)` — if the agent didn't include one. Optional `planRef` field: path to the full plan markdown on disk, linked from the card header for drill-down.

Boardroom approval is advisory-before-the-gate: the agent app's own native approval (e.g. Claude Code plan mode) remains the final proceed gate. The shipped instruction snippet must tell the agent to still surface that native prompt and must never configure or imply auto-acceptance.

### `review_results`

Input is claims, not blocks-first:

```ts
{ headline, claims: [{ id, claim, evidence: Block[] }] }
```

Every claim requires ≥1 evidence block (Zod-enforced) — a bare assertion is exactly the trust-me pattern claim-by-claim review exists to prevent; at minimum the agent attaches a `markdown` block explaining how it knows. The daemon compiles each claim into a decision (`approve` / `deny`, note required on deny) with its evidence blocks attached via `blockRefs`. The response's `summary` leads with denied claims and their notes — the agent's next marching orders.

## 6. Dashboard UX

(Direction approved; details deliberately revisitable during implementation.)

- **Inbox**: pending cards newest-first; stage badge, session origin, headline, age. Pending count in tab title/favicon. Decided cards in a searchable history — the decision log.
- **Card view**: headline top; blocks in given order in the main column; decisions in a sticky rail. Decision ↔ block cross-highlighting via `blockRefs`. Submit activates when every decision is answered; one submit resolves the card.
- **Reminders**: arrival notification + 10-minute re-nudge while pending; click-through to the card.

## 7. Failure handling

| Failure | Behavior |
|---|---|
| Invalid tool payload | MCP error with the structured Zod failures (field path + reason); agent retries |
| Daemon down at call time | Tool call fails fast; agent falls back to native in-app asking |
| Daemon dies mid-hang | Agent's call errors → native fallback; card reloads as `orphaned` on restart; offline-answer mode available |
| Agent killed / session closed mid-hang | Transport disconnect detected → card flips to `orphaned` immediately; reminders stop; offline-answer mode available |
| Client MCP timeout fires despite config | Same as caller-gone: disconnect detected → `orphaned`. Prevented in the first place by documented disable/infinite client timeout + progress keep-alives |
| Mermaid render failure | Raw source shown in a code block |
| Browser closed | Queue persists; `EventSource` reconnects on reopen; notifications keep nudging |
| Submit races (double submit) | First write wins; clear dashboard error for the loser |
| Submit on orphaned card | Live resolve rejected with a clear error; dashboard offers the offline-answer copy path instead |

## 8. Testing

- **Unit**: Zod schema fixtures per stage — valid and invalid payloads. Assertions target the structured issues (field path + issue code) and our own framing text, never Zod's generated prose (which changes across versions); one smoke test checks the rendered MCP error names the offending field.
- **Integration**: real MCP client (SDK) connects to a live daemon, calls each tool; a fake browser submits decisions via HTTP; assert the resolved tool result, including the denied-claims-first summary.
- **UI development**: `boardroom seed` fills the queue with rich demo cards covering every block type — doubles as living documentation of the vocabulary.

## 9. Config

`~/.config/boardroom/config.json`: `port` (default 4040), `remindEveryMinutes` (default 10), `notifications` (default true). SQLite DB lives alongside. No `host` option — the bind address is hardwired to `127.0.0.1` (see §3).

## 10. V1 scope and deferrals

**V1:** daemon, three tools, full block vocabulary, dashboard (inbox + card view + history), reminders, persistence, seed command, agent-instruction snippet (CLAUDE.md fragment) documenting the protocol, the crash-only fallback, and that the agent must still surface its app's native approval gate — never auto-accept.

**Deferred, door explicitly open:**
- Menu bar / standalone app shell (Tauri tray or Electron menubar wrapping the dashboard URL + pending badge) — pure packaging on the existing API.
- stdio→HTTP shim for stdio-only MCP clients.
- Hard enforcement via Claude Code Stop hooks (block session end until review) — protocol-only in v1.
- Remote/multi-user access — local, single user, no auth by design.
