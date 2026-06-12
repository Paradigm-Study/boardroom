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

## Connect an agent

```bash
claude mcp add --transport http boardroom http://127.0.0.1:4040/mcp
```

Tool calls hang until you decide — disable the client's MCP tool timeout.
For Claude Code, set in your environment or `.claude/settings.json` `env`:

```json
{ "env": { "MCP_TOOL_TIMEOUT": "86400000", "MCP_TIMEOUT": "30000" } }
```

Then paste `docs/agent-snippet.md` into the project's CLAUDE.md.

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
