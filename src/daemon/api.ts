import { Router, type Request, type Response } from 'express'
import type { Card, CardStatus, DecisionAnswer } from '../shared/card.js'
import { ConflictError, NotFoundError, Queue, ValidationError } from './queue.js'
import type { Store } from './store.js'

function sendError(res: Response, err: unknown): void {
  if (err instanceof NotFoundError) res.status(404).json({ error: err.message })
  else if (err instanceof ConflictError) res.status(409).json({ error: err.message })
  else if (err instanceof ValidationError) res.status(400).json({ error: err.message })
  else res.status(500).json({ error: String(err) })
}

function answersFrom(req: Request): Record<string, DecisionAnswer> {
  const body = req.body as { answers?: Record<string, DecisionAnswer> }
  if (!body?.answers || typeof body.answers !== 'object') throw new ValidationError('body must be { answers: {...} }')
  return body.answers
}

export function buildApiRouter(queue: Queue, store: Store): Router {
  const router = Router()

  router.get('/api/cards', (req, res) => {
    const status = req.query.status as CardStatus | undefined
    res.json(store.list(status))
  })

  router.get('/api/cards/:id', (req, res) => {
    const card = store.get(req.params.id)
    if (!card) { res.status(404).json({ error: 'not found' }); return }
    res.json(card)
  })

  router.post('/api/cards/:id/decide', (req, res) => {
    try {
      const { card } = queue.decide(req.params.id, answersFrom(req))
      res.json({ card })
    } catch (err) { sendError(res, err) }
  })

  router.post('/api/cards/:id/offline-answer', (req, res) => {
    try {
      const { card, summary } = queue.offlineAnswer(req.params.id, answersFrom(req))
      res.json({ card, summary })
    } catch (err) { sendError(res, err) }
  })

  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(':connected\n\n')
    const onCard = (card: Card): void => {
      res.write(`event: card\ndata: ${JSON.stringify(card)}\n\n`)
    }
    queue.on('card', onCard)
    const heartbeat = setInterval(() => res.write(':hb\n\n'), 25_000)
    req.on('close', () => {
      clearInterval(heartbeat)
      queue.off('card', onCard)
    })
  })

  return router
}
