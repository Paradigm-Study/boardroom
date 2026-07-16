import express, { Router, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { AttachmentRef, CARD_ADDON_ID, DecisionAnswers, type Card, type CardStatus, type DecisionAnswer } from '../shared/card.js'
import type { Entry } from '../shared/entry.js'
import { ConflictError, NotFoundError, Queue, ValidationError } from './queue.js'
import { loadMachineIdentity, setDeviceLabel } from './machine.js'
import type { AuthStore, CredentialKind } from './authStore.js'
import type { AuthConnector } from './authConnect.js'
import type { Store } from './store.js'
import { widgetCatalogList } from '../shared/widgetCatalog.js'
import { needsHuman, REATTACH_WINDOW_MS } from '../shared/needsHuman.js'
import { deriveSessionStatus } from '../shared/sessionStatus.js'
import { buildTrayVM } from './trayView.js'

interface ApiOptions {
  attachmentDir: string
  configDir: string
  // The daemon's configured reattach window, so the tray view-model counts
  // "reconnecting" cards against the SAME window the queue reattaches against.
  // Optional → tests and legacy callers fall back to the 24h default.
  reattachWindowMs?: number
  // The "Connect your Claude account" surfaces. Both optional so legacy/test
  // callers omit them — the /api/auth/* routes only register when present.
  authStore?: AuthStore
  authConnector?: AuthConnector
}

const DEFAULT_ATTACHMENT_LIMIT = '25mb'
// Bound the device nickname: it is persisted to machine.json and echoed into every
// /api/device and /api/sessions payload, so cap it rather than accept a multi-MB
// label (the only other limit is express's 4mb body cap).
const MAX_DEVICE_LABEL = 200

// Attachment serving policy (see the GET handler): passive types the dashboard
// renders inline (img/pdf/text fetch) under their declared mime — none can script.
const INLINE_PASSIVE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
])
// Active-content types (can carry script or script-bearing markup): render inline
// ONLY under a response-level `Content-Security-Policy: sandbox` — opaque origin,
// scripts off — so the FileViewer's static preview works but a direct/new-tab open
// cannot execute at the daemon origin. image/svg+xml lives here, not above: an
// <img> load never scripts, but a navigation to the same bytes would.
const INLINE_SANDBOXED_MIMES = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml',
])

// Exported for direct unit testing — the attachment routes' only traversal guard
// for URL-derived path segments, so it must be provably correct in isolation.
export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  // A dot-only segment ('.', '..') survives the cleaning above but would let
  // path.join climb out of the attachment root — collapse it to a literal name
  // so every segment stays a real in-tree filename.
  if (cleaned === '' || /^\.+$/.test(cleaned)) return 'file'
  return cleaned
}

function safeFileName(value: string): string {
  return safeSegment(basename(value).slice(0, 180))
}

// The uploaded file name arrives percent-encoded (the client encodes it so a
// non-ASCII name survives the latin1 header). Decode, falling back to the raw
// value if it isn't valid encoding, then to a default.
function decodeFileName(header: string | undefined): string {
  const raw = header ?? 'upload.bin'
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
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
  // The meta file is daemon-written, but a corrupt/hand-edited one must not 500
  // the route or hand a partially-attacker-shaped ref downstream. Parse + schema-
  // validate defensively (mirrors store.ts's parseRow), 404-ing on any failure.
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch {
    return undefined
  }
  const ref = AttachmentRef.safeParse(parsed)
  return ref.success ? ref.data : undefined
}

// Defense in depth for the file-serving path: even though safeSegment blocks
// traversal at the URL level, a corrupt/hand-edited metadata file could carry a
// `path` pointing outside the attachment root. Refuse to serve anything that
// resolves out of tree. Exported for direct unit testing alongside safeSegment.
export function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof NotFoundError) res.status(404).json({ error: err.message })
  else if (err instanceof ConflictError) res.status(409).json({ error: err.message })
  else if (err instanceof ValidationError) res.status(400).json({ error: err.message })
  else res.status(500).json({ error: String(err) })
}

function answersFrom(req: Request): Record<string, DecisionAnswer> {
  const body = (req.body ?? {}) as { answers?: unknown }
  const parsed = DecisionAnswers.safeParse(body.answers)
  if (!parsed.success) {
    throw new ValidationError('body must be { answers: { <decisionId>: { chosen: string[], note?, custom?, attachments? } } }')
  }
  return parsed.data
}

export function buildApiRouter(queue: Queue, store: Store, options: ApiOptions): Router {
  const router = Router()

  // Session inbox view-model: each captured session decorated with its aggregate
  // status tag (deriveSessionStatus) and card counts, so the dashboard can render
  // a session list without independently re-deriving status per row. Additive over
  // CapturedSession — existing consumers reading only the base fields are unaffected.
  router.get('/api/sessions', (_req, res) => {
    try {
      const cards = store.list()
      const nowMs = Date.now()
      // Same window the tray VM uses below (options.reattachWindowMs ?? the 24h
      // default) — a "reconnecting" boot-orphan card must count against the
      // daemon's ACTUAL configured reattach window, not always the default.
      const windowMs = options.reattachWindowMs ?? REATTACH_WINDOW_MS
      const vms = store.listCaptured().map(s => {
        // Exclude dismissed cards: a retired card must not colour the session's status
        // tag (deriveSessionStatus's activity clock) or its cardCount.
        const own = cards.filter(c => c.claudeSessionId === s.sessionId && c.status !== 'dismissed')
        return {
          ...s,
          sessionStatus: deriveSessionStatus(s, own, nowMs, windowMs),
          // needsHuman, not status === 'pending': deriveSessionStatus counts a
          // reconnecting orphan toward needs-decision, so this count must too or
          // the row contradicts its own status tag.
          pendingCount: own.filter(c => needsHuman(c, nowMs, windowMs)).length,
          cardCount: own.length,
        }
      })
      res.json(vms)
    } catch (err) { sendError(res, err) }
  })

  // That session's cards in stream order (createdAt ascending) — the per-session
  // card feed backing a session's detail view. Distinct path from /api/sessions
  // above (never shadows/is-shadowed by it); kept adjacent for readability.
  router.get('/api/sessions/:id/cards', (req, res) => {
    try {
      const own = store.list()
        .filter(c => c.claudeSessionId === req.params.id && c.status !== 'dismissed')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      res.json(own)
    } catch (err) { sendError(res, err) }
  })

  // Report/tag stream, FIFO (createdAt ascending — store.listEntries already
  // orders this way). Backs the dashboard's report feed; a stream with no
  // entries yet returns [], not 404.
  router.get('/api/entries', (_req, res) => {
    try {
      res.json(store.listEntries())
    } catch (err) { sendError(res, err) }
  })

  // That session's entries in stream order — the per-session report feed.
  // Distinct path from /api/entries above; mirrors /api/sessions/:id/cards.
  router.get('/api/sessions/:id/entries', (req, res) => {
    try {
      res.json(store.listEntriesBySession(req.params.id))
    } catch (err) { sendError(res, err) }
  })

  // The widget dialbook: a read-only catalog of every block type the agent can author
  // (name, what it conveys, when to use, a tiny example). Same body as the MCP resource.
  router.get('/api/widgets', (_req, res) => {
    res.json(widgetCatalogList())
  })

  router.get('/api/device', (_req, res) => {
    try { res.json(loadMachineIdentity(options.configDir)) } catch (err) { sendError(res, err) }
  })

  router.put('/api/device', (req, res) => {
    try {
      const { deviceLabel } = (req.body ?? {}) as { deviceLabel?: unknown }
      const trimmed = typeof deviceLabel === 'string' ? deviceLabel.trim() : ''
      if (!trimmed) {
        throw new ValidationError('body must be { deviceLabel: <non-empty string> }')
      }
      if (trimmed.length > MAX_DEVICE_LABEL) {
        throw new ValidationError(`deviceLabel must be at most ${MAX_DEVICE_LABEL} characters`)
      }
      res.json(setDeviceLabel(options.configDir, trimmed))
    } catch (err) { sendError(res, err) }
  })

  router.get('/api/cards', (req, res) => {
    try {
      const status = req.query.status as CardStatus | undefined
      res.json(store.list(status))
    } catch (err) { sendError(res, err) }
  })

  router.get('/api/cards/:id', (req, res) => {
    try {
      const card = store.get(req.params.id)
      if (!card) throw new NotFoundError(`no card "${req.params.id}"`)
      res.json(card)
    } catch (err) { sendError(res, err) }
  })

  // The SessionStart hook reports the live Claude Code session so the Phase 2
  // waker can `claude --resume` it from the correct absolute cwd when a parked
  // card for this project is decided. Pure write to the session registry.
  router.post('/api/session', (req, res) => {
    try {
      const { sessionId, cwd, project } = (req.body ?? {}) as { sessionId?: unknown; cwd?: unknown; project?: unknown }
      if (typeof sessionId !== 'string' || !sessionId || typeof cwd !== 'string' || !cwd || typeof project !== 'string' || !project) {
        throw new ValidationError('body must be { sessionId, cwd, project } (all non-empty strings)')
      }
      // cwd becomes the spawn dir for the Waker's `claude --resume`; a relative
      // path would resume from an unpredictable directory, so require absolute.
      if (!isAbsolute(cwd)) {
        throw new ValidationError('cwd must be an absolute path')
      }
      store.recordSession(project, sessionId, cwd)
      res.json({ ok: true })
    } catch (err) { sendError(res, err) }
  })

  router.post(
    '/api/cards/:id/attachments',
    express.raw({ type: () => true, limit: DEFAULT_ATTACHMENT_LIMIT }),
    (req: Request<{ id: string }>, res) => {
      try {
        const card = store.get(req.params.id)
        if (!card) throw new NotFoundError(`no card "${req.params.id}"`)
        if (card.status === 'decided') throw new ConflictError('card is already decided')
        if (card.status === 'dismissed') throw new ConflictError('card was dismissed')
        const answerId = String(req.header('x-answer-id') ?? '')
        // CARD_ADDON_ID is the reserved card-level add-on channel — a valid
        // upload target on every card, though never a decision id by design.
        if (answerId !== CARD_ADDON_ID && !card.decisions.some(d => d.id === answerId)) {
          throw new ValidationError(`unknown answer id "${answerId}"`)
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          throw new ValidationError('attachment body must be raw file bytes')
        }

        const id = randomUUID()
        // HTTP header values are latin1, so the client percent-encodes the file
        // name to survive non-ASCII characters (e.g. "café.png", "文档.pdf").
        const originalName = decodeFileName(req.header('x-file-name'))
        const name = originalName.trim() || 'upload.bin'
        const fileName = `${id}-${safeFileName(name)}`
        const dir = cardAttachmentDir(options.attachmentDir, card.id)
        mkdirSync(dir, { recursive: true })
        try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
        const path = join(dir, fileName)
        writeFileSync(path, req.body)
        try { chmodSync(path, 0o600) } catch { /* best-effort */ }

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
        const metaPath = attachmentMetaPath(options.attachmentDir, card.id, id)
        writeFileSync(metaPath, JSON.stringify(ref, null, 2))
        try { chmodSync(metaPath, 0o600) } catch { /* best-effort */ }
        res.status(201).json(ref)
      } catch (err) { sendError(res, err) }
    },
  )

  router.get('/api/cards/:id/attachments/:attachmentId', (req, res) => {
    try {
      const ref = readAttachmentRef(options.attachmentDir, req.params.id, req.params.attachmentId)
      if (!ref || !isWithinRoot(options.attachmentDir, ref.path)) {
        throw new NotFoundError(`no attachment "${req.params.attachmentId}"`)
      }
      // The stored mime is UPLOADER-SUPPLIED and the uploader (the agent) is
      // untrusted: reflecting it verbatim would let a text/html upload execute at
      // the daemon origin when opened in a new tab — stored XSS with full API
      // reach (nosniff does not stop a DECLARED dangerous type). Serve by policy:
      // passive types inline as declared; active-content types inline but under a
      // response-level CSP sandbox (opaque origin, zero script capability — the
      // in-app static preview keeps rendering, a new-tab open is inert); anything
      // else downloads as an opaque attachment.
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const mime = ref.mime?.split(';')[0].trim().toLowerCase()
      if (mime && INLINE_PASSIVE_MIMES.has(mime)) {
        res.type(mime)
      } else if (mime && INLINE_SANDBOXED_MIMES.has(mime)) {
        res.type(mime)
        res.setHeader('Content-Security-Policy', 'sandbox')
      } else {
        res.type('application/octet-stream')
        res.setHeader('Content-Disposition', 'attachment')
      }
      // res.sendFile is ASYNC: a stream error (the file was deleted out from under
      // a still-valid meta) fires AFTER this synchronous try/catch returns, so it
      // would otherwise escape to Express's default HTML error handler. Route it
      // through sendError for a consistent JSON error — but only if nothing has been
      // sent yet (a mid-stream failure can't be re-headered).
      res.sendFile(ref.path, (err: NodeJS.ErrnoException | undefined) => {
        // ECONNABORTED / already-ended = the client went away mid-stream; there is
        // nothing left to send and re-headering would throw write-after-end.
        if (err && !res.headersSent && !res.writableEnded && err.code !== 'ECONNABORTED') {
          // The file headers set above describe the body that never got sent —
          // clear them so the JSON error isn't mislabeled octet-stream/attachment.
          res.removeHeader('Content-Type')
          res.removeHeader('Content-Disposition')
          res.removeHeader('Content-Security-Policy')
          sendError(res, err.code === 'ENOENT' ? new NotFoundError(`no attachment "${req.params.attachmentId}"`) : err)
        }
      })
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

  // Boardroom-scoped soft delete: retire a card the human no longer wants on the
  // board (a stranded duplicate, or any orphaned gate). Terminal 'dismissed' status
  // drops it from every surface; nothing is pushed to the agent. 404 unknown, 409 on
  // an already-decided card (its decision is history) — same error mapping as decide.
  router.post('/api/cards/:id/dismiss', (req: Request<{ id: string }>, res: Response) => {
    try {
      res.json({ card: queue.dismiss(req.params.id) })
    } catch (err) { sendError(res, err) }
  })

  // "Connect your Claude account": lets the user hand boardroom a durable resume
  // credential so the launchd-spawned waker can authenticate. Registered only when
  // the daemon wired an authStore (legacy/test callers omit it → routes 404). The
  // status never returns the secret value — only connected/kind/age + login state.
  const { authStore, authConnector } = options
  if (authStore) {
    const authStatus = (): Record<string, unknown> => ({
      ...authStore.status(),
      login: authConnector?.getStatus() ?? { state: 'idle' },
    })

    router.get('/api/auth/status', (_req, res) => { res.json(authStatus()) })

    // Paste path: the user supplies a token they generated (`claude setup-token`).
    router.post('/api/auth/token', (req, res) => {
      try {
        const type = (req.body as { type?: string }).type
        const value = (req.body as { value?: string }).value
        if (type !== 'oauth' && type !== 'apiKey') throw new ValidationError('type must be "oauth" or "apiKey"')
        if (typeof value !== 'string' || !value.trim()) throw new ValidationError('a non-empty token value is required')
        authStore.set({ type: type as CredentialKind, value: value.trim() })
        res.json(authStatus())
      } catch (err) { sendError(res, err) }
    })

    router.post('/api/auth/disconnect', (_req, res) => {
      authStore.clear()
      res.json(authStatus())
    })

    // Browser path: boardroom drives `claude setup-token` and captures the token.
    if (authConnector) {
      router.post('/api/auth/connect', (_req, res) => {
        authConnector.start()
        res.json(authStatus())
      })
      router.post('/api/auth/connect/cancel', (_req, res) => {
        authConnector.cancel()
        res.json(authStatus())
      })
      // Relay the OAuth code the user pasted from the browser into the login prompt.
      router.post('/api/auth/connect/input', (req, res) => {
        try {
          const code = (req.body as { code?: string }).code
          if (typeof code !== 'string' || !code.trim()) throw new ValidationError('a non-empty code is required')
          authConnector.sendInput(code.trim())
          res.json(authStatus())
        } catch (err) { sendError(res, err) }
      })
    }
  }

  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(':connected\n\n')
    // The menu-bar tray renders this precomputed view-model; the web dashboard
    // ignores 'tray' frames (it only listens for 'card'). Register onCard BEFORE the
    // snapshot so a card landing mid-snapshot still pushes its own frame, emit a
    // snapshot on connect so a tray attaching after a daemon restart is immediately
    // correct, then a fresh frame alongside every card transition.
    const windowMs = options.reattachWindowMs ?? REATTACH_WINDOW_MS
    // The tray VM is TIME-dependent (a "reconnecting" card ages out of the reattach
    // window with no card event to announce it), so a card-event-only push leaves a
    // stale badge on a long-lived connection. Recompute on every heartbeat too, and
    // dedup identical frames so the steady state stays silent.
    let lastTrayFrame: string | undefined
    const sendTray = (): void => {
      const frame = JSON.stringify(buildTrayVM(store, Date.now(), windowMs))
      if (frame === lastTrayFrame) return
      lastTrayFrame = frame
      res.write(`event: tray\ndata: ${frame}\n\n`)
    }
    const onCard = (card: Card): void => {
      res.write(`event: card\ndata: ${JSON.stringify(card)}\n\n`)
      sendTray()
    }
    queue.on('card', onCard)
    // The dashboard's report feed subscribes to this same stream. Entries are a
    // separate concern from cards/tray: the tray never counts entries (spec
    // criterion tray-separation), so this listener MUST NOT call sendTray() —
    // it only forwards the raw entry frame.
    const onEntry = (entry: Entry): void => {
      res.write(`event: entry\ndata: ${JSON.stringify(entry)}\n\n`)
    }
    queue.on('entry', onEntry)
    sendTray()
    const heartbeat = setInterval(() => {
      res.write(':hb\n\n')
      sendTray()
    }, 25_000)
    req.on('close', () => {
      clearInterval(heartbeat)
      queue.off('card', onCard)
      queue.off('entry', onEntry)
    })
  })

  return router
}
