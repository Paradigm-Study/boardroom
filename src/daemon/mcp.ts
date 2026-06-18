import { McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { Router, type Request, type Response } from 'express'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Card, CardResponse } from '../shared/card.js'
import { ClarifyInput, PresentPlanInput, ReviewResultsInput } from '../shared/inputs.js'
import { compileClarify, compilePlan, compileResults } from './compile.js'
import type { Queue } from './queue.js'

interface RequestCtx {
  onAbort(cb: () => void): void
}

const requestCtx = new AsyncLocalStorage<RequestCtx>()

const KEEPALIVE_MS = 30_000

const GLANCEABLE =
  ' AUTHORING RULES (the human reads like a CEO — keep it glanceable): every clarify/plan card must include at least one unreferenced global block plus at least one question-local block for each decision. Put question-local context in blocks and wire that decision\'s blockRefs to those block ids; leave only whole-card context unreferenced. Omit context that does not change the answer. Put anything tabular/comparative/quantitative/sequential in a structured block (table, options_compare, phases, graph, diff_stat), NOT in prose. Keep markdown to 1–2 sentences — never multi-paragraph essays; long prose gets clamped behind "show more" and just wastes the reader.'

const DESCRIPTIONS = {
  clarify:
    'Ask the human scoping questions as visual decision cards. Use BEFORE forming a plan whenever requirements are ambiguous. Each question is a decision with button options; attach blocks when a visual helps, and wire each decision\'s blockRefs to the block ids that inform that specific question — the dashboard renders that context inside the question row. The call blocks until the human answers in the boardroom dashboard — that is expected, do not time it out.' + GLANCEABLE,
  present_plan:
    "Present a formed plan for human approval as a visual card: structural blocks (graph/phases/options_compare) plus plan-level decisions, each with exactly one recommended option and blockRefs pointing at the question-local blocks that inform it. A final approve/revise/reject verdict is appended automatically. Boardroom approval is advisory-before-the-gate: still surface your app's native plan approval afterwards; never auto-accept. The call blocks until the human decides." + GLANCEABLE,
  review_results:
    'Submit your completed work for human review as claims with evidence. Each claim ("all 42 tests pass") needs at least one evidence block. Evidence must be PROOF the claim is true — test output, a diff_stat, a before/after — NOT prose explaining how you implemented it (the human is verifying, not code-reviewing your narration). The human approves or denies each claim; denial notes are your next instructions. Call this before declaring work done. The call blocks until the human decides.' + GLANCEABLE,
} as const

interface ToolResult {
  [x: string]: unknown
  content: { type: 'text'; text: string }[]
}

function makeHangingHandler<I>(
  server: McpServer,
  queue: Queue,
  compile: (input: I, agent: string) => Card,
): (input: I, ctx: ServerContext) => Promise<ToolResult> {
  return async (input, ctx) => {
    const agent = server.server.getClientVersion()?.name ?? 'unknown'
    const card = compile(input, agent)

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
    const keepaliveMs = Number(process.env.BOARDROOM_KEEPALIVE_MS) || KEEPALIVE_MS
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

    try {
      const response = await new Promise<CardResponse>((resolve, reject) => {
        const { cardId, gen } = queue.submit(card, { resolve, reject })
        const drop = (): void => queue.disconnect(cardId, gen)
        requestCtx.getStore()?.onAbort(drop)
        ctx.mcpReq.signal.addEventListener('abort', drop, { once: true })
      })
      return {
        content: [
          { type: 'text' as const, text: response.summary },
          { type: 'text' as const, text: JSON.stringify(response) },
        ],
      }
    } finally {
      clearInterval(keepalive)
    }
  }
}

function buildServer(queue: Queue): McpServer {
  const server = new McpServer({ name: 'boardroom', version: '0.1.0' })
  // Required so the keepalive may emit `notifications/message` to clients that
  // didn't request progress (see makeHangingHandler). Must precede connect().
  server.server.registerCapabilities({ logging: {} })
  server.registerTool(
    'clarify',
    { description: DESCRIPTIONS.clarify, inputSchema: ClarifyInput },
    makeHangingHandler(server, queue, compileClarify),
  )
  server.registerTool(
    'present_plan',
    { description: DESCRIPTIONS.present_plan, inputSchema: PresentPlanInput },
    makeHangingHandler(server, queue, compilePlan),
  )
  server.registerTool(
    'review_results',
    { description: DESCRIPTIONS.review_results, inputSchema: ReviewResultsInput },
    makeHangingHandler(server, queue, compileResults),
  )
  return server
}

export function buildMcpRouter(queue: Queue): Router {
  const transports = new Map<string, NodeStreamableHTTPServerTransport>()
  const router = Router()

  // Keep each client's STANDALONE GET SSE stream warm. The per-request keepalive
  // (makeHangingHandler) only covers a hanging tool call's POST response stream.
  // Clients like Claude Code (Node/undici) also open a standalone notification
  // stream and time it out after ~300s of silence ("SSE stream disconnected:
  // TimeoutError"); after 3 consecutive timeouts they CLOSE the whole transport,
  // killing any in-flight hanging call. Sending a notification with no
  // relatedRequestId routes to that standalone stream and resets the client's
  // idle timer. Interval must stay well under the client's ~300s timeout.
  const streamHeartbeatMs = Number(process.env.BOARDROOM_STREAM_HEARTBEAT_MS) || 120_000
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
      const fresh = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => { transports.set(id, fresh) },
      })
      fresh.onclose = () => {
        if (fresh.sessionId) transports.delete(fresh.sessionId)
      }
      const server = buildServer(queue)
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
    if (!transport) { res.status(400).json({ error: 'unknown or missing mcp-session-id' }); return }
    await transport.handleRequest(req, res)
  }
  router.get('/mcp', sessionHandler)
  router.delete('/mcp', sessionHandler)

  return router
}
