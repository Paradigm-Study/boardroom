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

const DESCRIPTIONS = {
  clarify:
    'Ask the human scoping questions as visual decision cards. Use BEFORE forming a plan whenever requirements are ambiguous. Each question is a decision with button options; attach blocks when a visual helps. The call blocks until the human answers in the boardroom dashboard — that is expected, do not time it out.',
  present_plan:
    "Present a formed plan for human approval as a visual card: structural blocks (graph/phases/options_compare) plus plan-level decisions, each with exactly one recommended option. A final approve/revise/reject verdict is appended automatically. Boardroom approval is advisory-before-the-gate: still surface your app's native plan approval afterwards; never auto-accept. The call blocks until the human decides.",
  review_results:
    'Submit your completed work for human review as claims with evidence. Each claim ("all 42 tests pass") needs at least one evidence block. The human approves or denies each claim; denial notes in the response are your next instructions. Call this before declaring work done. The call blocks until the human decides.',
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

    const progressToken = ctx.mcpReq._meta?.progressToken
    let beat = 0
    const keepalive = progressToken === undefined
      ? undefined
      : setInterval(() => {
          void ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken, progress: ++beat, message: 'Waiting for human decision in boardroom' },
          }).catch(() => {})
        }, KEEPALIVE_MS)

    try {
      const response = await new Promise<CardResponse>((resolve, reject) => {
        queue.add(card, { resolve, reject })
        requestCtx.getStore()?.onAbort(() => queue.orphan(card.id))
        ctx.mcpReq.signal.addEventListener('abort', () => queue.orphan(card.id), { once: true })
      })
      return {
        content: [
          { type: 'text' as const, text: response.summary },
          { type: 'text' as const, text: JSON.stringify(response) },
        ],
      }
    } finally {
      if (keepalive) clearInterval(keepalive)
    }
  }
}

function buildServer(queue: Queue): McpServer {
  const server = new McpServer({ name: 'boardroom', version: '0.1.0' })
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
