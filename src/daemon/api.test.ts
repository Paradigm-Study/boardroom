import express from 'express'
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { buildApiRouter, isWithinRoot, safeSegment } from './api.js'
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
  app.use(buildApiRouter(queue, store, { attachmentDir: join(dir, 'attachments') }))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
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
