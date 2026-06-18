import express, { Router, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AttachmentRef, Card, CardStatus, DecisionAnswer } from '../shared/card.js'
import { ConflictError, NotFoundError, Queue, ValidationError } from './queue.js'
import type { Store } from './store.js'

interface ApiOptions {
  attachmentDir: string
}

const DEFAULT_ATTACHMENT_LIMIT = '25mb'

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'file'
}

function safeFileName(value: string): string {
  return safeSegment(basename(value).slice(0, 180))
}

function cardAttachmentDir(root: string, cardId: string): string {
  return join(root, safeSegment(cardId))
}

function attachmentMetaPath(root: string, cardId: string, attachmentId: string): string {
  return join(cardAttachmentDir(root, cardId), `${safeSegment(attachmentId)}.json`)
}

function readAttachmentRef(root: string, cardId: string, attachmentId: string): AttachmentRef | undefined {
  const metaPath = attachmentMetaPath(root, cardId, attachmentId)
  if (!existsSync(metaPath)) return undefined
  return JSON.parse(readFileSync(metaPath, 'utf8')) as AttachmentRef
}

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

export function buildApiRouter(queue: Queue, store: Store, options: ApiOptions): Router {
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

  router.post(
    '/api/cards/:id/attachments',
    express.raw({ type: () => true, limit: DEFAULT_ATTACHMENT_LIMIT }),
    (req: Request<{ id: string }>, res) => {
      try {
        const card = store.get(req.params.id)
        if (!card) throw new NotFoundError(`no card "${req.params.id}"`)
        if (card.status === 'decided') throw new ConflictError('card is already decided')
        const answerId = String(req.header('x-answer-id') ?? '')
        if (!card.decisions.some(d => d.id === answerId)) {
          throw new ValidationError(`unknown answer id "${answerId}"`)
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          throw new ValidationError('attachment body must be raw file bytes')
        }

        const id = randomUUID()
        const originalName = String(req.header('x-file-name') ?? 'upload.bin')
        const name = originalName.trim() || 'upload.bin'
        const fileName = `${id}-${safeFileName(name)}`
        const dir = cardAttachmentDir(options.attachmentDir, card.id)
        mkdirSync(dir, { recursive: true })
        const path = join(dir, fileName)
        writeFileSync(path, req.body)

        const ref: AttachmentRef = {
          id,
          name,
          mime: req.header('content-type') ?? undefined,
          size: req.body.length,
          path,
          url: `/api/cards/${encodeURIComponent(card.id)}/attachments/${encodeURIComponent(id)}`,
          field: req.header('x-field') ?? undefined,
          uploadedAt: new Date().toISOString(),
        }
        writeFileSync(attachmentMetaPath(options.attachmentDir, card.id, id), JSON.stringify(ref, null, 2))
        res.status(201).json(ref)
      } catch (err) { sendError(res, err) }
    },
  )

  router.get('/api/cards/:id/attachments/:attachmentId', (req, res) => {
    try {
      const ref = readAttachmentRef(options.attachmentDir, req.params.id, req.params.attachmentId)
      if (!ref) throw new NotFoundError(`no attachment "${req.params.attachmentId}"`)
      if (ref.mime) res.type(ref.mime)
      res.sendFile(ref.path)
    } catch (err) { sendError(res, err) }
  })

  const decideHandler = (req: Request<{ id: string }>, res: Response): void => {
    try {
      const { card, summary, delivered } = queue.decide(req.params.id, answersFrom(req))
      res.json({ card, summary, delivered })
    } catch (err) { sendError(res, err) }
  }
  router.post('/api/cards/:id/decide', decideHandler)
  // Backward-compat alias: a long-lived dashboard tab loaded before decide()
  // absorbed offline answers may still POST here. Keep it so an out-of-date
  // tab keeps working (and never hits Express's HTML 404) — decide() already
  // handles orphaned cards and returns { card, summary }.
  router.post('/api/cards/:id/offline-answer', decideHandler)

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
