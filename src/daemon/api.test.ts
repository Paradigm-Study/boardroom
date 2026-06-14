import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { buildApiRouter } from './api.js'
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
  app.use(buildApiRouter(queue, store))
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
