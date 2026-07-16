import { McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { Router, type Request, type Response } from 'express'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Card, CardResponse, ParkedMarker } from '../shared/card.js'
import { ClarifyInput, PresentPlanInput, PresentReportInput, ReviewResultsInput, SpecInput } from '../shared/inputs.js'
import { compileClarify, compilePlan, compileReport, compileResults, compileSpec, type CompileMeta } from './compile.js'
import { widgetCatalogList } from '../shared/widgetCatalog.js'
import type { Queue } from './queue.js'

interface RequestCtx {
  onAbort(cb: () => void): void
}

const requestCtx = new AsyncLocalStorage<RequestCtx>()

const KEEPALIVE_MS = 30_000
const STREAM_HEARTBEAT_MS = 120_000
// Parking is OPT-IN. By default a tool call hangs until the human decides — the
// dual-layer heartbeats below keep the connection alive, and a genuine drop
// (sleep, network blip, kill) orphans the card so an identical re-issue reattaches.
// Set BOARDROOM_BLOCK_MS to a positive number of milliseconds to re-enable a
// bounded park: if the human hasn't decided by then, the call resolves the
// PARKED_TEXT hard-STOP sentinel and orphans the card (never an inferred verdict;
// the waker skips plan cards so a late "approve" can't back-door an auto-resume).
// A previous build hard-coded a 10-min park as the DEFAULT, which silently
// orphaned every decision slower than 10 minutes — that is why this is now opt-in.
// Returned to the agent when an opt-in park window elapses undecided. It MUST read as a
// hard stop: a coding agent that asked a gating question is otherwise biased to
// guess and proceed, which would defeat the human-in-the-loop guarantee.
const PARKED_TEXT =
  '⏸ Boardroom: no decision yet — your turn is over. STOP here. Do NOT guess, infer, or proceed on an assumption about what the human would choose. The human will decide on the dashboard; the decision is not lost. To receive it, re-issue this EXACT same call (identical sessionKey, project and headline) on a later turn — reattachment is automatic and re-runs no work.'

// Positive-duration env override, falling back to the default for a missing,
// non-numeric, or non-positive value. (`Number(x) || default` reads as a footgun
// — it also swallows a legit 0 — so use an explicit finite-and-positive guard.)
function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

// The opt-in park window. Returns the configured positive millisecond window, or
// undefined when BOARDROOM_BLOCK_MS is unset / 0 / negative / non-numeric — and
// undefined means "never park; hang until the human decides." Values beyond Node's
// 32-bit setTimeout ceiling are clamped to it: an oversized delay would otherwise
// fire the timer after ~1ms and park the gate almost immediately — the opposite of
// the "practically never park" the caller asked for. Pure (env is passed in) so the
// opt-in contract is unit-testable without spinning up the transport.
const MAX_TIMEOUT_MS = 2 ** 31 - 1
export function parkWindowMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = Number(env.BOARDROOM_BLOCK_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_TIMEOUT_MS) : undefined
}

// Appended to every BLOCKING gate: the dashboard offers the human a global
// card-level add-on input on every card, so any gate's resolution may carry
// standing instructions the agent must treat as tasks.
const ADDON =
  ' On any gate the human may append "Added instructions" — a card-level add-on (text and attachments) that rides alongside their decision without changing it. When the resolved summary carries an "Added instructions — act on these:" section, treat each item as a task in the current session.'

const GLANCEABLE =
  ' AUTHORING RULES (the human reads like a CEO — keep it glanceable): every clarify/plan card must include at least one unreferenced global block plus at least one question-local block for each decision. Put question-local context in blocks and wire that decision\'s blockRefs to those block ids; leave only whole-card context unreferenced. For UI change requests, include lightweight wireframes or layout sketches in the option context and let each wireframe use its natural dimensions; do not force all options into one fixed card size unless readability requires it. Omit context that does not change the answer. Put anything tabular/comparative/quantitative/sequential in a structured block (table, options_compare, phases, graph, diff_stat), NOT in prose. Keep markdown to 1–2 sentences — never multi-paragraph essays; long prose gets clamped behind "show more" and just wastes the reader.'

const DESCRIPTIONS = {
  clarify:
    'Ask the human scoping questions as visual decision cards. Use BEFORE forming a plan whenever requirements are ambiguous. Each question is a decision with button options; attach blocks when a visual helps, and wire each decision\'s blockRefs to the block ids that inform that specific question — the dashboard renders that context inside the question row. The call blocks until the human decides. If you ever receive a PARKED result instead of an answer — that means STOP: end your turn, do NOT guess or proceed; the decision is saved, and re-issuing this identical call later claims it (no work is re-run). Idempotent on retry: calling again with identical sessionKey, project and headline reattaches to the same card or returns the already-made decision. Always pass your sessionKey (injected at session start) — it binds the card to your session.' + ADDON + GLANCEABLE,
  present_plan:
    "Present a formed plan for human approval as a visual card: structural blocks (graph/phases/options_compare) plus plan-level decisions, each with exactly one recommended option and blockRefs pointing at the question-local blocks that inform it. A final approve/revise/reject verdict is appended automatically. Boardroom approval is advisory-before-the-gate: still surface your app's native plan approval afterwards; never auto-accept. This call blocks until the human decides; if you receive a PARKED result instead of a verdict — that means STOP: end your turn, do NOT infer, guess, or proceed on approval; the card is saved and re-issuing this identical call later claims the verdict (re-runs no work). Idempotent on retry: re-issuing identical sessionKey, project and headline reattaches to the same card. Always pass your sessionKey (injected at session start) — it binds the card to your session." + ADDON + GLANCEABLE,
  present_spec:
    'Lock in the acceptance contract AFTER the plan is approved and BEFORE you build: the behavior-driven definition of done. Pass `goal` plus `criteria` — each criterion a `good` outcome (the pass condition), a `bad` anti-goal (the failure to avoid), and `tracesTo` (the decision/goal it enforces). Boardroom owns the GATE, not the authoring: derive criteria from the locked plan decisions (or your own spec/acceptance skill) — do not over-engineer it. The human reviews each criterion (keep / adjust / drop), may add more, and locks the contract (or sends it back to revise). On lock you get the final contract back as your definition of done: write it to `specRef` so it survives later turns, build until every criterion is MET, then call review_results echoing the spec (read back from `specRef`) with each claim tagged by `criterionId`. This call blocks until the human decides; a PARKED result means STOP and re-issue this EXACT same call (identical sessionKey, project and headline) later to claim the verdict. Idempotent on retry. Always pass your sessionKey (injected at session start) — it binds the card to your session.' + ADDON + GLANCEABLE,
  review_results:
    'Submit your completed work for human review as claims with evidence. Each claim ("all 42 tests pass") needs at least one evidence block. Evidence must be PROOF the claim is true — test output, a diff_stat, a before/after — NOT prose explaining how you implemented it (the human is verifying, not code-reviewing your narration). For each claim the human picks approve / revise / reject (revise = on the right track, reject = drop it; both carry a note), can add free-form instructions of their own, and sets an explicit verdict: "complete" (work accepted, you are done) or "keep going". Treat the returned summary as authoritative: if it says NOT complete, the rejected claims, the revise notes, and any added instructions ARE your next tasks — do them, then call review_results again. Call this before declaring work done. The call blocks until the human reviews. If you receive a PARKED result — that means STOP: end your turn, do NOT assume approval; re-issue this EXACT same call (identical sessionKey, project and headline) later to claim the verdict (no work is re-run). Always pass your sessionKey (injected at session start) — it binds the card to your session.' + ADDON + GLANCEABLE,
  present_report:
    'Post a report the human can READ — results, findings, explanations — with NO decision attached. Fire-and-forget: returns immediately, never blocks, never parks. Use it to convey information mid-session; do NOT use it to finish — review_results remains the only completion path. Always pass your sessionKey so the report lands in your session stream. Keep the blocks glanceable; the dashboard offers a full-size drawer view.',
} as const

interface ToolResult {
  [x: string]: unknown
  content: { type: 'text'; text: string }[]
}

const MAX_TRANSCRIPT_DECISIONS = 8
const MAX_TRANSCRIPT_OPTIONS = 5
const MAX_TRANSCRIPT_TEXT = 180

function clip(text: string, max = MAX_TRANSCRIPT_TEXT): string {
  // Collapse whitespace AND U+0085/NEL (which \s misses): this text is the agent-facing
  // gate transcript, so it must enforce the same "Added instructions — act on these:"
  // trust boundary as summary.ts flat() — no agent-authored field may forge a section
  // header by starting a new visual line. Then truncate.
  const flat = text.replace(/[\s\u0085]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat
}

function formatDecisionPrompt(d: Card['decisions'][number]): string {
  const options = d.options.slice(0, MAX_TRANSCRIPT_OPTIONS).map(o => {
    const suffix = o.recommended ? ' (recommended)' : ''
    return `${clip(o.label, 60)}${suffix}`
  })
  if (d.options.length > MAX_TRANSCRIPT_OPTIONS) options.push(`+${d.options.length - MAX_TRANSCRIPT_OPTIONS} more`)
  return `- ${clip(d.prompt)} Options: ${options.join(', ')}`
}

function formatGateContext(card: Card, cardId: string, state: 'opened' | 'resolved'): string {
  const lines = [
    `Boardroom gate ${state}: ${card.stage}`,
    `Card: ${cardId}`,
    `Project: ${clip(card.session.project)}`,
    `Headline: ${clip(card.headline)}`,
    'Decisions:',
  ]
  for (const d of card.decisions.slice(0, MAX_TRANSCRIPT_DECISIONS)) lines.push(formatDecisionPrompt(d))
  if (card.decisions.length > MAX_TRANSCRIPT_DECISIONS) {
    lines.push(`- +${card.decisions.length - MAX_TRANSCRIPT_DECISIONS} more decisions`)
  }
  return lines.join('\n')
}

function formatGateResult(card: Card, response: CardResponse): string {
  return `${formatGateContext(card, response.cardId, 'resolved')}\n\nHuman response:\n${response.summary}`
}

// Durable-identity resolution for a tool call. The mcpSessionId (ctx.sessionId)
// is daemon-minted and per-connection — it churns on daemon restart and on every
// waker respawn — so it is ONLY the cache key, never the identity itself.
// Task-1 spike evidence (2026-07-02): Claude Code sends no session-identifying
// header on MCP HTTP calls, so the agent-echoed sessionKey is the sole channel.
// If a future CC version adds one, check it here between (1) and (2).
//
// Trust posture: sessionKey is honor-system by design, not a secret — any local
// process can already reach this unauthenticated localhost API, so the machine
// itself is the trust boundary, not the key. A wrong/guessed sessionKey can only
// claim a card if the attacker's call ALSO produces an exact fingerprint match
// (project + headline + decisions) — strictly narrower than the pre-spine
// fingerprint-only steal this binding replaced.
export function resolveClaudeSessionId(
  ctx: { sessionId?: string },
  input: { sessionKey?: string },
  bindings: Map<string, string>,
): string | undefined {
  if (input.sessionKey) {
    if (ctx.sessionId) bindings.set(ctx.sessionId, input.sessionKey)
    return input.sessionKey
  }
  return ctx.sessionId ? bindings.get(ctx.sessionId) : undefined
}

function makeHangingHandler<I>(
  server: McpServer,
  queue: Queue,
  compile: (input: I, meta: CompileMeta) => Card,
  sessionBindings: Map<string, string>,
): (input: I, ctx: ServerContext) => Promise<ToolResult> {
  return async (input, ctx) => {
    const agent = server.server.getClientVersion()?.name ?? 'unknown'
    const claudeSessionId = resolveClaudeSessionId(ctx, input as { sessionKey?: string }, sessionBindings)
    const card = compile(input, { agent, claudeSessionId })

    // Heartbeat the hanging response so its HTTP/SSE stream never goes silent.
    // The MCP SDK has no built-in keepalive, and a decision can take many minutes
    // — longer than the idle-body timeout some MCP clients impose (Node/undici
    // defaults to 5 minutes), which aborts the request and orphans the card.
    // Codex's HTTP stack has no such idle timeout, which is why it stayed
    // connected without this. The heartbeat is routed to *this* request's stream
    // by relatedRequestId, so the bytes-on-the-wire keep it alive regardless of
    // what the client does with the payload. We send only a message the client
    // actually solicited: clients that passed a progressToken get progress (which
    // also resets their own SDK progress-timeout); clients that didn't get a
    // debug-level log notification, which conformant clients drop silently —
    // sending them an unsolicited progressToken would instead trip a per-beat
    // "unknown progress token" error in their client.
    const clientToken = ctx.mcpReq._meta?.progressToken
    const keepaliveMs = envMs('BOARDROOM_KEEPALIVE_MS', KEEPALIVE_MS)
    let beat = 0
    const keepalive = setInterval(() => {
      beat++
      if (clientToken !== undefined) {
        void ctx.mcpReq.notify({
          method: 'notifications/progress',
          params: { progressToken: clientToken, progress: beat, message: 'Waiting for human decision in boardroom' },
        }).catch(() => {})
      } else {
        void ctx.mcpReq.notify({
          method: 'notifications/message',
          params: { level: 'debug', logger: 'boardroom', data: 'Waiting for human decision in boardroom' },
        }).catch(() => {})
      }
    }, keepaliveMs)

    let parkTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await new Promise<CardResponse | ParkedMarker>((resolve, reject) => {
        const { cardId, gen } = queue.submit(card, { resolve: resolve as (r: CardResponse) => void, reject })
        const transcript = formatGateContext(card, cardId, 'opened')
        void ctx.mcpReq.notify({
          method: 'notifications/message',
          params: { level: 'info', logger: 'boardroom', data: transcript },
        }).catch(() => {})
        if (clientToken !== undefined) {
          void ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken: clientToken, progress: 0, message: transcript },
          }).catch(() => {})
        }
        const drop = (): void => queue.disconnect(cardId, gen)
        requestCtx.getStore()?.onAbort(drop)
        ctx.mcpReq.signal.addEventListener('abort', drop, { once: true })
        // Opt-in bounded park: only when BOARDROOM_BLOCK_MS is explicitly set. If
        // no decision lands within that window, PARK the card (orphan it gracefully)
        // and resolve a STOP sentinel. Unset (the default) → no timer is armed and
        // the call hangs until the human decides. queue.park no-ops if a decision
        // already arrived or a newer connection took over, so the real result always
        // wins the race.
        const blockMs = parkWindowMs()
        if (blockMs !== undefined) {
          parkTimer = setTimeout(() => {
            if (queue.park(cardId, gen)) resolve({ parked: true, cardId })
          }, blockMs)
        }
      })
      if ('parked' in response) {
        return {
          content: [
            { type: 'text' as const, text: PARKED_TEXT },
            { type: 'text' as const, text: JSON.stringify({ status: 'parked', cardId: response.cardId }) },
          ],
        }
      }
      return {
        content: [
          { type: 'text' as const, text: formatGateResult(card, response) },
          { type: 'text' as const, text: JSON.stringify(response) },
        ],
      }
    } finally {
      clearInterval(keepalive)
      if (parkTimer) clearTimeout(parkTimer)
    }
  }
}

function buildServer(queue: Queue, sessionBindings: Map<string, string>): McpServer {
  const server = new McpServer({ name: 'boardroom', version: '0.1.0' })
  // logging: so the keepalive may emit `notifications/message` to clients that didn't
  // request progress (see makeHangingHandler). resources: for the widget-catalog
  // resource below. Must precede connect().
  server.server.registerCapabilities({ logging: {}, resources: {} })
  server.registerTool(
    'clarify',
    { description: DESCRIPTIONS.clarify, inputSchema: ClarifyInput },
    makeHangingHandler(server, queue, compileClarify, sessionBindings),
  )
  // All three tools share one park policy (opt-in via BOARDROOM_BLOCK_MS). When a
  // park IS configured, present_plan parking is NOT auto-approval — it orphans the
  // card (reattachable, claimable) and resolves a STOP, never a guessed verdict.
  // The waker also skips plan cards (waker.onCard), so a late "approve" can never
  // back-door an auto-resume into building, preserving "never auto-accept."
  server.registerTool(
    'present_plan',
    { description: DESCRIPTIONS.present_plan, inputSchema: PresentPlanInput },
    makeHangingHandler(server, queue, compilePlan, sessionBindings),
  )
  // The spec gate sits between plan approval and the work: the agent distills the
  // locked decisions into acceptance criteria, the human locks/steers them, and the
  // contract becomes the definition of done that review_results is judged against.
  server.registerTool(
    'present_spec',
    { description: DESCRIPTIONS.present_spec, inputSchema: SpecInput },
    makeHangingHandler(server, queue, compileSpec, sessionBindings),
  )
  server.registerTool(
    'review_results',
    { description: DESCRIPTIONS.review_results, inputSchema: ReviewResultsInput },
    makeHangingHandler(server, queue, compileResults, sessionBindings),
  )
  // present_report is the first NON-blocking tool: no queue.submit, no waiter, no
  // park — it compiles an Entry, posts it, and returns immediately. Schema
  // rejection (e.g. zero blocks) is caught by the SDK before this handler ever
  // runs and surfaces as a tool error automatically. The remaining throw surface
  // is compile/postReport (store write) — guard it explicitly so a store failure
  // on this fire-and-forget call comes back as an ordinary tool error result
  // instead of an uncaught exception, matching how the other four tools' errors
  // surface (the SDK's own catch-and-wrap in tools/call, which produces the same
  // { content, isError: true } shape).
  server.registerTool(
    'present_report',
    { description: DESCRIPTIONS.present_report, inputSchema: PresentReportInput },
    async (input, ctx): Promise<ToolResult> => {
      try {
        const agent = server.server.getClientVersion()?.name ?? 'unknown'
        // A sessionKey on this fire-and-forget call also (re)binds the connection for
        // subsequent key-less gate calls — intentional symmetry with makeHangingHandler's
        // gates; revisit if P2 replies raise the stakes of a wrong binding here.
        const claudeSessionId = resolveClaudeSessionId(ctx, input as { sessionKey?: string }, sessionBindings)
        const entry = compileReport(input as never, { agent, claudeSessionId })
        queue.postReport(entry)
        // Stream anchor: a BOUND post points at exactly where it landed (the
        // dashboard's #/session/<id> route) rather than a vague "your session
        // stream" claim — matches the spec's "entry id + stream anchor" return.
        // Encoded for symmetry with the dashboard's own #/session links (identity
        // for today's UUID ids — but the route decodes).
        const anchor = claudeSessionId ? ` Stream: #/session/${encodeURIComponent(claudeSessionId)}` : ''
        return {
          content: [{
            type: 'text' as const,
            text: `Report posted (entry ${entry.id})${claudeSessionId ? ' to your session stream' : ' (unbound — no sessionKey)'}. ` +
                  `This is NOT a completion: review_results remains the only way to close out a session.${anchor}`,
          }],
        }
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to post report: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        }
      }
    },
  )
  // The widget dialbook as an MCP resource: any session can read the full palette
  // (name / conveys / when-to-use / a valid example per block type) before composing a
  // card. A resource, not a tool, so it never bloats the per-turn tool list.
  server.registerResource(
    'widget-catalog',
    'boardroom://widgets/catalog',
    {
      title: 'Boardroom widget catalog',
      description: 'One metadata entry per block type (name, what it conveys, when to use, a tiny valid example). Consult before authoring clarify/present_plan/present_spec/review_results blocks to pick the right widget.',
      mimeType: 'application/json',
    },
    async uri => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(widgetCatalogList(), null, 2) }],
    }),
  )
  return server
}

// An initialize request is the only POST that may open a new session (single or
// batched). Anything else without a known session id is a client/contract error.
function isInitializeRequest(body: unknown): boolean {
  const isInit = (m: unknown): boolean =>
    !!m && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize'
  return Array.isArray(body) ? body.some(isInit) : isInit(body)
}

// Unknown/stale session id → 404 so the client re-initializes cleanly.
function sessionGone(res: Response): void {
  res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'mcp session not found — re-initialize' } })
}
// No session id where one is required → plain client error.
function sessionMissing(res: Response): void {
  res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'missing mcp-session-id' } })
}

export function buildMcpRouter(queue: Queue): Router {
  const transports = new Map<string, NodeStreamableHTTPServerTransport>()
  // Per-connection claudeSessionId cache, keyed by the daemon-minted mcp-session-id.
  // Owned at router scope (outlives any single request) and cleaned up alongside
  // its transport in onclose below, so a closed connection never leaks a binding.
  const sessionBindings = new Map<string, string>()
  const router = Router()

  // Keep each client's STANDALONE GET SSE stream warm. The per-request keepalive
  // (makeHangingHandler) only covers a hanging tool call's POST response stream.
  // Clients like Claude Code (Node/undici) also open a standalone notification
  // stream and time it out after ~300s of silence ("SSE stream disconnected:
  // TimeoutError"); after 3 consecutive timeouts they CLOSE the whole transport,
  // killing any in-flight hanging call. Sending a notification with no
  // relatedRequestId routes to that standalone stream and resets the client's
  // idle timer. Interval must stay well under the client's ~300s timeout.
  const streamHeartbeatMs = envMs('BOARDROOM_STREAM_HEARTBEAT_MS', STREAM_HEARTBEAT_MS)
  const heartbeat = setInterval(() => {
    for (const transport of transports.values()) {
      void transport.send({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'debug', logger: 'boardroom', data: 'keepalive' },
      }).catch(() => {})
    }
  }, streamHeartbeatMs)
  heartbeat.unref?.()

  router.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport = sessionId ? transports.get(sessionId) : undefined

    if (!transport) {
      // A session id we don't recognize (e.g. the client still holds one from
      // before a daemon restart): tell it to re-initialize instead of silently
      // forking a fresh, never-initialized transport that then errors.
      if (sessionId) { sessionGone(res); return }
      // No session id: only an initialize request may open a new session.
      if (!isInitializeRequest(req.body)) { sessionMissing(res); return }
      const fresh = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => { transports.set(id, fresh) },
      })
      fresh.onclose = () => {
        if (fresh.sessionId) {
          transports.delete(fresh.sessionId)
          sessionBindings.delete(fresh.sessionId)
        }
      }
      const server = buildServer(queue, sessionBindings)
      await server.connect(fresh)
      transport = fresh
    }

    const aborts: (() => void)[] = []
    res.on('close', () => {
      if (!res.writableEnded) for (const cb of aborts) cb()
    })

    await requestCtx.run({ onAbort: cb => aborts.push(cb) }, () =>
      transport.handleRequest(req, res, req.body),
    )
  })

  const sessionHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const transport = sessionId ? transports.get(sessionId) : undefined
    if (!transport) { if (sessionId) sessionGone(res); else sessionMissing(res); return }
    await transport.handleRequest(req, res)
  }
  router.get('/mcp', sessionHandler)
  router.delete('/mcp', sessionHandler)

  return router
}
