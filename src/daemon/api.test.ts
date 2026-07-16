import express from 'express'
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { CapturedSession } from '../shared/session.js'
import { buildApiRouter, isWithinRoot, safeSegment } from './api.js'
import { Block } from '../shared/blocks.js'
import type { Entry } from '../shared/entry.js'
import { Queue } from './queue.js'
import { Store } from './store.js'

function card(id: string): Card {
  return {
    id, stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'pending', createdAt: new Date().toISOString(),
  }
}

// Small local factory for a fully-formed pending Card, with overrides — used by
// the session view-model tests below where cards are inserted directly via
// store.insert (not queue.submit) so they can carry a specific claudeSessionId
// and createdAt without going through the queue's fingerprint/reattach machinery.
function cardFixture(overrides: Partial<Card> & { id: string }): Card {
  return {
    stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'pending', createdAt: new Date().toISOString(),
    ...overrides,
  }
}

// Small local factory for a CapturedSession, with overrides.
function capturedFixture(overrides: Partial<CapturedSession> & { sessionId: string }): CapturedSession {
  return {
    machineId: 'm', pid: 1, cwd: '/tmp/x', project: 'x',
    status: 'alive', capturedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
    ...overrides,
  }
}

// Small local factory for a ReportEntry, with overrides — used by the entries
// route + SSE tests below.
function reportFixture(overrides: Partial<Entry> & { id: string }): Entry {
  return {
    type: 'report',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h',
    blocks: [{ id: 'b1', type: 'markdown', text: 'content' }],
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Entry
}

const noop = { resolve: () => {}, reject: () => {} }

let dir: string
let store: Store
let queue: Queue
let app: express.Express

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-'))
  store = new Store(join(dir, 'test.sqlite'))
  queue = new Queue(store)
  app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use(buildApiRouter(queue, store, { attachmentDir: join(dir, 'attachments'), configDir: dir }))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/widgets', () => {
  it('returns the widget catalog — one entry per block type', async () => {
    const res = await request(app).get('/api/widgets')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toHaveLength(Block.options.length)
    expect(res.body.every((e: { type?: string; name?: string; whenToUse?: string }) => !!e.type && !!e.name && !!e.whenToUse)).toBe(true)
  })
})

describe('GET /api/cards', () => {
  it('lists all cards, filterable by status', async () => {
    queue.submit(card('c1'), noop)
    queue.submit(card('c2'), noop)
    queue.decide('c2', { d1: { chosen: ['a'] } })
    const all = await request(app).get('/api/cards').expect(200)
    expect(all.body).toHaveLength(2)
    const pending = await request(app).get('/api/cards?status=pending').expect(200)
    expect(pending.body.map((c: Card) => c.id)).toEqual(['c1'])
  })
})

describe('GET /api/cards/:id', () => {
  it('returns the card or 404', async () => {
    queue.submit(card('c1'), noop)
    const res = await request(app).get('/api/cards/c1').expect(200)
    expect(res.body.id).toBe('c1')
    await request(app).get('/api/cards/nope').expect(404)
  })
})

describe('POST /api/cards/:id/decide', () => {
  it('decides a pending card', async () => {
    queue.submit(card('c1'), noop)
    const res = await request(app)
      .post('/api/cards/c1/decide')
      .send({ answers: { d1: { chosen: ['a'] } } })
      .expect(200)
    expect(res.body.card.status).toBe('decided')
  })

  it('maps errors: 400 validation, 404 unknown, 409 conflict', async () => {
    queue.submit(card('c1'), noop)
    await request(app).post('/api/cards/c1/decide').send({ answers: {} }).expect(400)
    await request(app).post('/api/cards/nope/decide').send({ answers: {} }).expect(404)
    queue.decide('c1', { d1: { chosen: ['a'] } })
    const res = await request(app).post('/api/cards/c1/decide').send({ answers: { d1: { chosen: ['a'] } } }).expect(409)
    expect(res.body.error).toMatch(/decided/)
  })

  it('rejects a body with no answers key as 400 (not 500)', async () => {
    queue.submit(card('c1'), noop)
    const res = await request(app).post('/api/cards/c1/decide').send({}).expect(400)
    expect(res.body.error).toMatch(/answers/)
  })

  it('rejects a malformed answer shape (chosen not an array) as 400, not 500', async () => {
    queue.submit(card('c1'), noop)
    const res = await request(app)
      .post('/api/cards/c1/decide')
      .send({ answers: { d1: { chosen: 5 } } })
      .expect(400)
    expect(res.body.error).toMatch(/answers/)
  })
})

describe('POST /api/cards/:id/dismiss', () => {
  it('dismisses an orphaned card and drops it from the actionable surfaces', async () => {
    const { cardId, gen } = queue.submit(card('c1'), noop)
    queue.disconnect(cardId, gen)                                   // orphaned
    const res = await request(app).post('/api/cards/c1/dismiss').expect(200)
    expect(res.body.card.status).toBe('dismissed')
    expect(store.get('c1')?.status).toBe('dismissed')
    await request(app).get('/api/cards?status=orphaned').expect(200).then(r => expect(r.body).toHaveLength(0))
  })

  it('maps errors: 404 unknown, 409 on an already-decided card', async () => {
    await request(app).post('/api/cards/nope/dismiss').expect(404)
    queue.submit(card('c1'), noop)
    queue.decide('c1', { d1: { chosen: ['a'] } })
    const res = await request(app).post('/api/cards/c1/dismiss').expect(409)
    expect(res.body.error).toMatch(/decided/)
  })
})

describe('POST /api/cards/:id/attachments', () => {
  it('stores an uploaded file and returns a durable attachment reference', async () => {
    queue.submit(card('c1'), noop)

    const res = await request(app)
      .post('/api/cards/c1/attachments')
      .set('content-type', 'image/png')
      .set('x-answer-id', 'd1')
      .set('x-field', 'note')
      .set('x-file-name', 'broken layout.png')
      .send(Buffer.from('fake-image-bytes'))
      .expect(201)

    expect(res.body).toMatchObject({
      name: 'broken layout.png',
      mime: 'image/png',
      size: 16,
      field: 'note',
      url: expect.stringContaining('/api/cards/c1/attachments/'),
    })
    expect(res.body.path).toContain(join(dir, 'attachments'))
    expect(existsSync(res.body.path)).toBe(true)
    expect(readFileSync(res.body.path, 'utf8')).toBe('fake-image-bytes')

    const downloaded = await request(app).get(res.body.url).expect(200)
    expect(Buffer.from(downloaded.body).toString('utf8')).toBe('fake-image-bytes')
  })

  // The global card-level add-on is a reserved answer channel, never a decision
  // id — the answer-id guard must accept it or the add-on is attachment-dead on
  // every stage (the human's file just 400s).
  it('accepts an upload for the reserved card_addon channel', async () => {
    queue.submit(card('c1'), noop)

    const res = await request(app)
      .post('/api/cards/c1/attachments')
      .set('content-type', 'image/png')
      .set('x-answer-id', 'card_addon')
      .set('x-field', 'note')
      .set('x-file-name', 'mockup.png')
      .send(Buffer.from('addon-bytes'))
      .expect(201)

    expect(res.body).toMatchObject({ name: 'mockup.png', field: 'note' })
    expect(existsSync(res.body.path)).toBe(true)
  })

  it('returns 404 when uploading to a nonexistent card', async () => {
    const res = await request(app)
      .post('/api/cards/nope/attachments')
      .set('content-type', 'image/png')
      .set('x-answer-id', 'd1')
      .send(Buffer.from('bytes'))
      .expect(404)
    expect(res.body.error).toMatch(/nope/)
  })

  it('returns 409 when uploading to an already-decided card', async () => {
    queue.submit(card('c1'), noop)
    queue.decide('c1', { d1: { chosen: ['a'] } })
    const res = await request(app)
      .post('/api/cards/c1/attachments')
      .set('content-type', 'image/png')
      .set('x-answer-id', 'd1')
      .send(Buffer.from('bytes'))
      .expect(409)
    expect(res.body.error).toMatch(/decided/)
  })

  it('returns 400 for a missing x-answer-id header', async () => {
    queue.submit(card('c1'), noop)
    const res = await request(app)
      .post('/api/cards/c1/attachments')
      .set('content-type', 'image/png')
      .send(Buffer.from('bytes'))
      .expect(400)
    expect(res.body.error).toMatch(/answer id/)
  })

  it('returns 400 for an unknown x-answer-id header', async () => {
    queue.submit(card('c1'), noop)
    const res = await request(app)
      .post('/api/cards/c1/attachments')
      .set('content-type', 'image/png')
      .set('x-answer-id', 'does-not-exist')
      .send(Buffer.from('bytes'))
      .expect(400)
    expect(res.body.error).toMatch(/does-not-exist/)
  })

  it('returns 400 for an empty attachment body', async () => {
    queue.submit(card('c1'), noop)
    const res = await request(app)
      .post('/api/cards/c1/attachments')
      .set('content-type', 'image/png')
      .set('x-answer-id', 'd1')
      .send(Buffer.alloc(0))
      .expect(400)
    expect(res.body.error).toMatch(/raw file bytes/)
  })

  it('decodes a percent-encoded (non-ASCII) file name', async () => {
    // The client percent-encodes x-file-name so a non-ASCII name survives the
    // latin1 header; the server must decode it back for the stored ref.
    queue.submit(card('c1'), noop)
    const res = await request(app)
      .post('/api/cards/c1/attachments')
      .set('content-type', 'image/png')
      .set('x-answer-id', 'd1')
      .set('x-file-name', encodeURIComponent('café 文档.png'))
      .send(Buffer.from('bytes'))
      .expect(201)
    expect(res.body.name).toBe('café 文档.png')
  })
})

describe('GET /api/cards/:id/attachments/:attachmentId', () => {
  it('returns 404 for a missing attachment id', async () => {
    queue.submit(card('c1'), noop)
    await request(app).get('/api/cards/c1/attachments/no-such-id').expect(404)
  })

  it('neutralizes a traversing card-id segment so metadata cannot be read from outside the root', async () => {
    const root = join(dir, 'attachments')
    mkdirSync(root, { recursive: true })
    // A real, servable file INSIDE the root, so isWithinRoot would pass on it.
    const inRoot = join(root, 'real.bin')
    writeFileSync(inRoot, 'in-root-bytes')
    // GET /api/cards/..%2fsomething/attachments/secret reaches the handler with
    // id="../something" (the %2f survives URL normalization). WITHOUT safeSegment
    // that resolves to join(root, "../something", "secret.json") = <dir>/something/
    // secret.json — so plant a valid ref THERE, pointing at the in-root file (which
    // isWithinRoot would happily serve). safeSegment rewrites the "/" to "_", so the
    // real lookup misses → 404. This test fails (200) if the guard is ever removed.
    const escaped = join(dir, 'something')
    mkdirSync(escaped, { recursive: true })
    writeFileSync(
      join(escaped, 'secret.json'),
      JSON.stringify({ id: 'secret', name: 's', size: 13, path: inRoot, uploadedAt: 'now' }),
    )

    const res = await request(app).get('/api/cards/..%2fsomething/attachments/secret').expect(404)
    expect(res.body.error).toMatch(/no attachment/)
  })

  it('a valid ref whose underlying file is gone returns a clean JSON error, not an escaped sendFile throw', async () => {
    const root = join(dir, 'attachments')
    // A meta that passes the existsSync + isWithinRoot guards, but whose `path`
    // points at a file that no longer exists on disk (deleted out from under us).
    // res.sendFile is ASYNC, so its ENOENT fires AFTER the synchronous try/catch —
    // without an error callback wired to sendError, it escapes to Express's default
    // HTML handler. The handler must instead surface a JSON error and not 200/crash.
    const inRoot = join(root, 'c1')
    mkdirSync(inRoot, { recursive: true })
    const gonePath = join(inRoot, 'gone.bin') // inside root → isWithinRoot passes; never written → missing
    writeFileSync(
      join(inRoot, 'ghost.json'),
      JSON.stringify({ id: 'ghost', name: 'g', size: 0, path: gonePath, uploadedAt: 'now' }),
    )

    const res = await request(app).get('/api/cards/c1/attachments/ghost')
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toMatch(/json/)
    expect(res.body.error).toMatch(/no attachment/)
  })

  // The stored mime is uploader-supplied (the agent is untrusted): serving it
  // verbatim would execute a text/html upload at the daemon origin (stored XSS).
  async function uploadAs(mime: string, body = '<h1>x</h1>'): Promise<string> {
    queue.submit(card('att-mime'), noop)
    const res = await request(app)
      .post('/api/cards/att-mime/attachments')
      .set('content-type', mime)
      .set('x-answer-id', 'd1')
      .send(Buffer.from(body))
      .expect(201)
    return res.body.url as string
  }

  it('serves passive types (png) inline under their declared mime', async () => {
    const url = await uploadAs('image/png', 'fake-png')
    const res = await request(app).get(url).expect(200)
    expect(res.headers['content-type']).toMatch(/^image\/png/)
    expect(res.headers['content-disposition']).toBeUndefined()
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('serves active-content types (text/html) ONLY under a response-level CSP sandbox', async () => {
    const url = await uploadAs('text/html; charset=utf-8', '<script>fetch("/api/cards")</script>')
    const res = await request(app).get(url).expect(200)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.headers['content-security-policy']).toBe('sandbox')
  })

  it('serves svg (scriptable on navigation) under the CSP sandbox too', async () => {
    const url = await uploadAs('image/svg+xml', '<svg onload="x()"/>')
    const res = await request(app).get(url).expect(200)
    expect(res.headers['content-security-policy']).toBe('sandbox')
  })

  it('forces unknown/unlisted mimes to an opaque download (octet-stream + attachment)', async () => {
    const url = await uploadAs('application/x-anything')
    const res = await request(app).get(url).expect(200)
    expect(res.headers['content-type']).toMatch(/^application\/octet-stream/)
    expect(res.headers['content-disposition']).toBe('attachment')
  })
})

describe('safeSegment / isWithinRoot — the attachment path-traversal guards', () => {
  it('collapses a dot-only segment to a literal in-tree name', () => {
    expect(safeSegment('.')).toBe('file')
    expect(safeSegment('..')).toBe('file')
    expect(safeSegment('...')).toBe('file')
  })

  it('strips path separators so a segment can never traverse', () => {
    expect(safeSegment('a/b')).toBe('a_b')
    expect(safeSegment('../../etc/passwd')).not.toContain('/')
    expect(safeSegment('normal-name.png')).toBe('normal-name.png')
  })

  it('rejects a stored ref path that resolves outside the attachment root', () => {
    const root = join(dir, 'attachments')
    expect(isWithinRoot(root, join(root, 'a.bin'))).toBe(true)
    expect(isWithinRoot(root, join(root, 'sub', 'a.bin'))).toBe(true)
    expect(isWithinRoot(root, join(root, '..', 'escape.bin'))).toBe(false)
    expect(isWithinRoot(root, '/etc/passwd')).toBe(false)
  })
})

describe('POST /api/cards/:id/decide — delivery flag', () => {
  it('reports delivered=true when a live waiter is attached', async () => {
    queue.submit(card('c1'), noop)
    const res = await request(app).post('/api/cards/c1/decide').send({ answers: { d1: { chosen: ['a'] } } }).expect(200)
    expect(res.body.delivered).toBe(true)
  })

  it('decides an orphaned card with delivered=false and a copyable summary', async () => {
    const { cardId, gen } = queue.submit(card('c1'), noop)
    queue.disconnect(cardId, gen)
    const res = await request(app).post('/api/cards/c1/decide').send({ answers: { d1: { chosen: ['a'] } } }).expect(200)
    expect(res.body.delivered).toBe(false)
    expect(res.body.summary).toContain('p: A')
    expect(res.body.card.status).toBe('decided')
  })

  it('honors the legacy /offline-answer alias (stale tabs keep working)', async () => {
    const { cardId, gen } = queue.submit(card('c1'), noop)
    queue.disconnect(cardId, gen)
    const res = await request(app)
      .post('/api/cards/c1/offline-answer')
      .send({ answers: { d1: { chosen: ['a'], note: 'quotes " backticks ` <tag> & emoji ✓' } } })
      .expect(200)
    expect(res.body.summary).toContain('quotes " backticks')
    expect(res.body.card.status).toBe('decided')
  })
})

describe('attachment storage perms', () => {
  it('locks the attachment dir to 0700 and files to 0600', async () => {
    queue.submit(card('att1'), noop)
    const res = await request(app)
      .post('/api/cards/att1/attachments')
      .set('x-answer-id', 'd1')
      .set('content-type', 'application/octet-stream')
      .set('x-file-name', 'note.txt')
      .send(Buffer.from('hello'))
    expect(res.status).toBe(201)
    expect(statSync(join(dir, 'attachments', 'att1')).mode & 0o777).toBe(0o700)
    expect(statSync(res.body.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'attachments', 'att1', `${res.body.id}.json`)).mode & 0o777).toBe(0o600)
  })
})

describe('GET /events', () => {
  it('responds with an SSE stream', async () => {
    const res = await request(app)
      .get('/events')
      .buffer(false)
      .parse((res, done) => {
        res.on('data', () => { (res as unknown as { destroy(): void }).destroy(); done(null, null) })
      })
    expect(res.headers['content-type']).toContain('text/event-stream')
  })

  // The menu-bar tray subscribes to this same stream. It must receive a precomputed
  // tray view-model on connect (so a tray connecting after a daemon restart sees the
  // current state immediately) and a fresh one on every card transition.
  // Collect tray-frame view-models off the SSE stream until `enough` of them arrive,
  // optionally running `onFrame(n)` after the nth. Destroying the stream rejects the
  // supertest promise, so capture into a local and assert after it settles.
  async function collectTrayFrames(
    enough: number,
    onFrame?: (count: number) => void,
  ): Promise<Record<string, unknown>[]> {
    const frames: Record<string, unknown>[] = []
    await request(app)
      .get('/events')
      .buffer(false)
      .parse((res, done) => {
        let buf = ''
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString()
          let idx
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
            if (!frame.includes('event: tray')) continue
            const dataLine = frame.split('\n').find(l => l.startsWith('data:'))!
            frames.push(JSON.parse(dataLine.slice(5).trim()))
            onFrame?.(frames.length)
            if (frames.length >= enough) { (res as unknown as { destroy(): void }).destroy(); done(null, null); return }
          }
        })
      })
      .catch(() => {})
    return frames
  }

  it('writes an initial tray snapshot frame on connect', async () => {
    queue.submit(card('c1'), noop) // one pending card before connecting
    const [snapshot] = await collectTrayFrames(1)
    expect(snapshot.total).toBe(1)
    expect(snapshot.byStage).toMatchObject({ clarify: 1 })
  })

  it('pushes a fresh tray frame when a card is decided', async () => {
    queue.submit(card('c1'), noop)
    const frames = await collectTrayFrames(2, n => {
      if (n === 1) queue.decide('c1', { d1: { chosen: ['a'] } })
    })
    expect(frames[0].total).toBe(1) // snapshot: one pending
    expect(frames[1].total).toBe(0) // after decide: cleared
  })

  // Collect every SSE frame (any event type) until `enough` arrive, tagging each
  // with its `event:` line so callers can filter by frame kind. Mirrors
  // collectTrayFrames's destroy-on-enough pattern.
  async function collectFrames(
    enough: number,
    onFrame?: (count: number) => void,
  ): Promise<{ event: string; data: Record<string, unknown> }[]> {
    const frames: { event: string; data: Record<string, unknown> }[] = []
    await request(app)
      .get('/events')
      .buffer(false)
      .parse((res, done) => {
        let buf = ''
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString()
          let idx
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
            const eventLine = frame.split('\n').find(l => l.startsWith('event:'))
            const dataLine = frame.split('\n').find(l => l.startsWith('data:'))
            if (!eventLine || !dataLine) continue
            frames.push({ event: eventLine.slice(6).trim(), data: JSON.parse(dataLine.slice(5).trim()) })
            onFrame?.(frames.length)
            if (frames.length >= enough) { (res as unknown as { destroy(): void }).destroy(); done(null, null); return }
          }
        })
      })
      .catch(() => {})
    return frames
  }

  // Open the stream, wait for the initial tray snapshot (proof the listener is
  // registered), THEN call postReport and assert the entry frame arrives.
  it('emits `event: entry` with the entry JSON after queue.postReport (listener attached before firing)', async () => {
    const report = reportFixture({ id: 'e1', claudeSessionId: 'cc-1' })
    const frames = await collectFrames(2, n => {
      if (n === 1) queue.postReport(report) // n===1 is the connect-time tray snapshot
    })
    const entryFrame = frames.find(f => f.event === 'entry')
    expect(entryFrame).toBeDefined()
    expect(entryFrame!.data).toEqual(report)
  })

  // HARD constraint (spec criterion tray-separation): the entry listener must
  // NEVER call sendTray() — the tray never counts entries. Prove it directly:
  // post several reports on an open connection and assert not one extra tray
  // frame appears beyond the single connect-time snapshot.
  it('tray-separation: entry activity never emits a tray frame (only the connect-time snapshot)', async () => {
    const frames = await collectFrames(4, n => {
      if (n === 1) {
        queue.postReport(reportFixture({ id: 'e1' }))
        queue.postReport(reportFixture({ id: 'e2' }))
        queue.postReport(reportFixture({ id: 'e3' }))
      }
    })
    const trayFrames = frames.filter(f => f.event === 'tray')
    const entryFrames = frames.filter(f => f.event === 'entry')
    expect(entryFrames).toHaveLength(3)
    // Exactly the single connect-time snapshot — no tray frame was triggered by
    // any of the three postReport calls above.
    expect(trayFrames).toHaveLength(1)
  })
})

describe('POST /api/session (Phase 2 wake registry)', () => {
  it('records the reporting session id + absolute cwd for the project', async () => {
    const res = await request(app)
      .post('/api/session')
      .send({ sessionId: 'sid-abc', cwd: '/Users/me/work/demo', project: 'demo' })
    expect(res.status).toBe(200)
    expect(store.getSession('demo')).toEqual({ sessionId: 'sid-abc', cwd: '/Users/me/work/demo' })
  })

  it('rejects an incomplete body', async () => {
    const res = await request(app).post('/api/session').send({ sessionId: 'x' })
    expect(res.status).toBe(400)
    expect(store.getSession('demo')).toBeUndefined()
  })

  it('rejects a non-absolute cwd (the waker would spawn from an unpredictable dir)', async () => {
    const res = await request(app)
      .post('/api/session')
      .send({ sessionId: 'sid', cwd: 'relative/dir', project: 'demo' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/absolute/)
    expect(store.getSession('demo')).toBeUndefined()
  })
})

describe('GET /api/sessions', () => {
  it('lists captured sessions', async () => {
    store.upsertCaptured(CapturedSession.parse({
      sessionId: 's1', machineId: 'm1', pid: 1, cwd: '/x/p', project: 'p',
      status: 'alive', capturedAt: 'T', lastSeenAt: 'T',
    }))
    const res = await request(app).get('/api/sessions').expect(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].sessionId).toBe('s1')
  })

  it('decorates captured sessions with status + counts', async () => {
    store.upsertCaptured(capturedFixture({ sessionId: 'cc-1', status: 'alive' }))
    store.insert(cardFixture({ id: 'k1', claudeSessionId: 'cc-1' })) // status 'pending'
    const res = await request(app).get('/api/sessions').expect(200)
    const s = res.body.find((x: { sessionId: string }) => x.sessionId === 'cc-1')
    expect(s.sessionStatus).toBe('needs-decision')
    expect(s.pendingCount).toBe(1)
    expect(s.cardCount).toBe(1)
  })

  it('reports zero counts and an idle-ish status for a session with no cards', async () => {
    store.upsertCaptured(capturedFixture({ sessionId: 'cc-empty', status: 'alive' }))
    const res = await request(app).get('/api/sessions').expect(200)
    const s = res.body.find((x: { sessionId: string }) => x.sessionId === 'cc-empty')
    expect(s.pendingCount).toBe(0)
    expect(s.cardCount).toBe(0)
    expect(s.sessionStatus).toBe('idle')
  })

  it('excludes dismissed cards from session status and cardCount', async () => {
    store.upsertCaptured(capturedFixture({ sessionId: 'cc-dis', status: 'ended' }))
    store.insert(cardFixture({ id: 'gone', claudeSessionId: 'cc-dis', status: 'dismissed', dismissedAt: new Date().toISOString() }))
    const res = await request(app).get('/api/sessions').expect(200)
    const s = res.body.find((x: { sessionId: string }) => x.sessionId === 'cc-dis')
    expect(s.cardCount).toBe(0)                 // a dismissed card is not counted
    expect(s.pendingCount).toBe(0)
    expect(s.sessionStatus).toBe('ended')       // not derived from the dismissed card's createdAt
  })

  // NEW: the route must thread options.reattachWindowMs into deriveSessionStatus —
  // same requirement as the tray VM (buildTrayVM) right below it in api.ts — so a
  // reconnecting boot-orphan card's status honors the daemon's CONFIGURED window,
  // not always the 24h default.
  it('honors options.reattachWindowMs for a reconnecting boot-orphan card', async () => {
    const customApp = express()
    customApp.use(express.json({ limit: '4mb' }))
    customApp.use(buildApiRouter(queue, store, {
      attachmentDir: join(dir, 'attachments'),
      configDir: dir,
      reattachWindowMs: 5 * 60_000, // 5 minutes — much shorter than the 24h default
    }))
    store.upsertCaptured(capturedFixture({ sessionId: 'cc-boot', status: 'alive' }))
    store.insert(cardFixture({
      id: 'k-boot', claudeSessionId: 'cc-boot', status: 'orphaned',
      orphanedReason: 'boot', orphanedAt: new Date(Date.now() - 10 * 60_000).toISOString(), // 10m ago
    }))
    const res = await request(customApp).get('/api/sessions').expect(200)
    const s = res.body.find((x: { sessionId: string }) => x.sessionId === 'cc-boot')
    // 10 minutes old vs a configured 5-minute window → already expired, so this must
    // NOT be reported as needs-decision (it would be, under the 24h default).
    expect(s.sessionStatus).not.toBe('needs-decision')
  })

  // pendingCount must agree with sessionStatus: both count "on the human's plate"
  // (needsHuman), not the literal status string. A reconnecting boot-orphan inside
  // the reattach window drives sessionStatus to needs-decision — a pendingCount of 0
  // beside that status would be a self-contradicting view-model row.
  it('counts a reconnecting boot-orphan card in pendingCount, matching sessionStatus', async () => {
    store.upsertCaptured(capturedFixture({ sessionId: 'cc-orphan', status: 'alive' }))
    store.insert(cardFixture({
      id: 'k-orphan', claudeSessionId: 'cc-orphan', status: 'orphaned',
      orphanedReason: 'boot', orphanedAt: new Date().toISOString(), // just now — inside any window
    }))
    const res = await request(app).get('/api/sessions').expect(200)
    const s = res.body.find((x: { sessionId: string }) => x.sessionId === 'cc-orphan')
    expect(s.sessionStatus).toBe('needs-decision')
    expect(s.pendingCount).toBe(1)
  })
})

describe("GET /api/sessions/:id/cards", () => {
  it("returns only that session's cards in stream order (createdAt ascending)", async () => {
    store.insert(cardFixture({ id: 'k1', claudeSessionId: 'cc-1', createdAt: '2026-07-02T10:00:00.000Z' }))
    store.insert(cardFixture({ id: 'k2', claudeSessionId: 'cc-1', createdAt: '2026-07-02T11:00:00.000Z' }))
    store.insert(cardFixture({ id: 'other', claudeSessionId: 'cc-2' }))
    const res = await request(app).get('/api/sessions/cc-1/cards').expect(200)
    expect(res.body.map((c: { id: string }) => c.id)).toEqual(['k1', 'k2'])
  })

  it('returns an empty array for a session with no cards (not 404)', async () => {
    const res = await request(app).get('/api/sessions/no-such-session/cards').expect(200)
    expect(res.body).toEqual([])
  })
})

describe('GET /api/entries', () => {
  it('returns all entries in FIFO order (adversarial insert order)', async () => {
    // Insert the LATER-timestamped entry first — the route must sort by
    // created_at, not by insertion/table order.
    store.insertEntry(reportFixture({ id: 'e2', createdAt: '2026-07-07T10:01:00.000Z' }))
    store.insertEntry(reportFixture({ id: 'e1', createdAt: '2026-07-07T10:00:00.000Z' }))
    const res = await request(app).get('/api/entries').expect(200)
    expect(res.body.map((e: Entry) => e.id)).toEqual(['e1', 'e2'])
  })

  it('returns an empty array when there are no entries', async () => {
    const res = await request(app).get('/api/entries').expect(200)
    expect(res.body).toEqual([])
  })
})

describe("GET /api/sessions/:id/entries", () => {
  it("returns only that session's entries in FIFO order", async () => {
    store.insertEntry(reportFixture({ id: 'e2', claudeSessionId: 'cc-1', createdAt: '2026-07-07T11:00:00.000Z' }))
    store.insertEntry(reportFixture({ id: 'e1', claudeSessionId: 'cc-1', createdAt: '2026-07-07T10:00:00.000Z' }))
    store.insertEntry(reportFixture({ id: 'other', claudeSessionId: 'cc-2', createdAt: '2026-07-07T09:00:00.000Z' }))
    const res = await request(app).get('/api/sessions/cc-1/entries').expect(200)
    expect(res.body.map((e: Entry) => e.id)).toEqual(['e1', 'e2'])
  })

  it('returns an empty array for a session with no entries (not 404)', async () => {
    const res = await request(app).get('/api/sessions/no-such-session/entries').expect(200)
    expect(res.body).toEqual([])
  })
})

describe('device identity', () => {
  it('renames the nickname and keeps machineId', async () => {
    const before = (await request(app).get('/api/device').expect(200)).body
    const res = await request(app).put('/api/device').send({ deviceLabel: 'Studio Mac' }).expect(200)
    expect(res.body.deviceLabel).toBe('Studio Mac')
    expect(res.body.machineId).toBe(before.machineId)
  })

  it('rejects an empty nickname', async () => {
    await request(app).put('/api/device').send({ deviceLabel: '  ' }).expect(400)
  })

  it('rejects an over-long nickname (bounded write)', async () => {
    await request(app).put('/api/device').send({ deviceLabel: 'x'.repeat(201) }).expect(400)
  })
})
