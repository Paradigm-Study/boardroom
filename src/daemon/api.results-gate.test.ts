import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RESULTS_VERDICT_ID, type Card } from '../shared/card.js'
import { ReviewResultsInput } from '../shared/inputs.js'
import { buildApiRouter } from './api.js'
import { compileResults } from './compile.js'
import { Queue } from './queue.js'
import { Store } from './store.js'

// FULL HTTP round-trip through the real Express decide endpoint, asserting the
// cross-layer invariants of the "results gate": the compile step's claim ids
// (claim:<id>) + synthetic results_verdict, the queue's validationScope
// (continue = verdict + voted claims only; complete = every claim), the summary
// lead/groups/add-on, and the real status-code mapping (200/400/409).

const noop = { resolve: () => {}, reject: () => {} }

// A real, schema-valid results input with three claims, so the compiled card
// carries claim:approve-me / claim:revise-me / claim:reject-me + results_verdict.
function resultsInput() {
  return ReviewResultsInput.parse({
    project: 'demo',
    headline: 'shipped the thing',
    claims: [
      { id: 'approve-me', claim: 'tests pass', evidence: [{ id: 'e1', type: 'evidence', output: 'ok' }] },
      { id: 'revise-me', claim: 'docs updated', evidence: [{ id: 'e2', type: 'evidence', output: 'partial' }] },
      { id: 'reject-me', claim: 'perf improved', evidence: [{ id: 'e3', type: 'evidence', output: 'regressed' }] },
    ],
  })
}

let dir: string
let store: Store
let queue: Queue
let app: express.Express

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-rg-'))
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

// Submit a fresh results card through the queue (live waiter attached) and
// return its id. Mirrors the daemon's real path: compileResults -> submit.
function submitResults(): string {
  const card = compileResults(resultsInput(), { agent: 'claude-code' })
  return queue.submit(card, noop).cardId
}

describe('results gate — full HTTP decide round-trip', () => {
  it('compileResults produces approve/revise/reject claims + the synthetic results_verdict', async () => {
    const id = submitResults()
    const res = await request(app).get(`/api/cards/${id}`).expect(200)
    const card: Card = res.body
    expect(card.stage).toBe('results')
    const ids = card.decisions.map(d => d.id)
    // Claim ids are namespaced `claim:<id>` by compile.ts; the verdict is appended.
    expect(ids).toContain('claim:approve-me')
    expect(ids).toContain('claim:revise-me')
    expect(ids).toContain('claim:reject-me')
    expect(ids).toContain(RESULTS_VERDICT_ID)
    // Every claim row offers exactly the three verdicts the UI renders from
    // decision.options (web/daemon skew guard depends on these being present).
    const claim = card.decisions.find(d => d.id === 'claim:reject-me')!
    expect(claim.options.map(o => o.id).sort()).toEqual(['approve', 'reject', 'revise'])
    expect(claim.noteRequiredOn).toEqual(['revise', 'reject'])
  })

  it('continue: approves one, revises one, rejects one — 200, summary has NOT-complete lead + groups + add-on, card stored decided', async () => {
    const id = submitResults()
    const res = await request(app)
      .post(`/api/cards/${id}/decide`)
      .send({
        answers: {
          'claim:approve-me': { chosen: ['approve'] },
          'claim:revise-me': { chosen: ['revise'], note: 'tighten the prose' },
          'claim:reject-me': { chosen: ['reject'], note: 'wrong benchmark' },
          [RESULTS_VERDICT_ID]: { chosen: ['continue'], note: 'also add a changelog entry' },
        },
      })
      .expect(200)

    const { summary, card, delivered } = res.body
    expect(delivered).toBe(true)
    // The lead is set explicitly by the verdict, NOT inferred from votes.
    expect(summary).toContain('Session NOT complete')
    expect(summary).not.toContain('Session COMPLETE')
    // The verdict's own note is the always-on card-level add-on.
    expect(summary).toContain('Added instructions: also add a changelog entry')
    // Rejected + Revise groups carry their notes; Approved group is present.
    expect(summary).toMatch(/Rejected[\s\S]*wrong benchmark/)
    expect(summary).toMatch(/Revise[\s\S]*tighten the prose/)
    expect(summary).toContain('Approved as-is:')
    // The HTTP response card mirrors what is persisted.
    expect(card.status).toBe('decided')

    // And GET reflects the same stored answers (status + verdict + claim votes).
    const stored = await request(app).get(`/api/cards/${id}`).expect(200)
    expect(stored.body.status).toBe('decided')
    expect(stored.body.answers['claim:reject-me'].chosen).toEqual(['reject'])
    expect(stored.body.answers['claim:reject-me'].note).toBe('wrong benchmark')
    expect(stored.body.answers[RESULTS_VERDICT_ID].chosen).toEqual(['continue'])
  })

  it('continue validates ONLY the verdict + voted claims: an unreviewed claim does NOT block — 200', async () => {
    const id = submitResults()
    // Only one claim voted; the other two are left entirely unreviewed.
    await request(app)
      .post(`/api/cards/${id}/decide`)
      .send({
        answers: {
          'claim:approve-me': { chosen: ['approve'] },
          [RESULTS_VERDICT_ID]: { chosen: ['continue'] },
        },
      })
      .expect(200)
  })

  it('reject with no note is a 400 ValidationError (note required on revise/reject)', async () => {
    const id = submitResults()
    const res = await request(app)
      .post(`/api/cards/${id}/decide`)
      .send({
        answers: {
          'claim:reject-me': { chosen: ['reject'] }, // missing required note
          [RESULTS_VERDICT_ID]: { chosen: ['continue'] },
        },
      })
      .expect(400)
    expect(res.body.error).toMatch(/note/)
  })

  it('complete with a claim left unreviewed is a 400 — completion is strict', async () => {
    const id = submitResults()
    const res = await request(app)
      .post(`/api/cards/${id}/decide`)
      .send({
        answers: {
          'claim:approve-me': { chosen: ['approve'] },
          // claim:revise-me + claim:reject-me unreviewed
          [RESULTS_VERDICT_ID]: { chosen: ['complete'] },
        },
      })
      .expect(400)
    // The unreviewed claim is what fails validation.
    expect(res.body.error).toMatch(/missing answer for decision "claim:(revise-me|reject-me)"/)
  })

  it('complete with every claim reviewed succeeds and the summary reads COMPLETE even with a reject on record', async () => {
    const id = submitResults()
    const res = await request(app)
      .post(`/api/cards/${id}/decide`)
      .send({
        answers: {
          'claim:approve-me': { chosen: ['approve'] },
          'claim:revise-me': { chosen: ['revise'], note: 'minor' },
          'claim:reject-me': { chosen: ['reject'], note: 'drop it' },
          [RESULTS_VERDICT_ID]: { chosen: ['complete'] },
        },
      })
      .expect(200)
    expect(res.body.summary).toContain('Session COMPLETE')
    // Completion is the human's explicit toggle, not inferred — a rejected claim
    // is still recorded alongside a COMPLETE verdict.
    expect(res.body.summary).toMatch(/Rejected[\s\S]*drop it/)
  })

  it('malformed body (answers not an object) is a 400, never a 500', async () => {
    const id = submitResults()
    const res = await request(app)
      .post(`/api/cards/${id}/decide`)
      .send({ answers: 'nope' })
      .expect(400)
    expect(res.body.error).toMatch(/answers/)
  })

  it('a missing answers key is a 400', async () => {
    const id = submitResults()
    const res = await request(app).post(`/api/cards/${id}/decide`).send({}).expect(400)
    expect(res.body.error).toMatch(/answers/)
  })

  it('an unknown verdict option the stale UI might offer is rejected as 400', async () => {
    const id = submitResults()
    // results_verdict only has complete|continue; "deny" is not an option here.
    // Vote every claim so the ONLY thing left to fail is the bad verdict value —
    // also pins the ordering invariant: an unrecognized verdict value is NOT
    // treated as "continue", so validationScope does not narrow, and the bad
    // option surfaces as the validation error (not silently accepted).
    const res = await request(app)
      .post(`/api/cards/${id}/decide`)
      .send({
        answers: {
          'claim:approve-me': { chosen: ['approve'] },
          'claim:revise-me': { chosen: ['revise'], note: 'n' },
          'claim:reject-me': { chosen: ['reject'], note: 'n' },
          [RESULTS_VERDICT_ID]: { chosen: ['deny'] },
        },
      })
      .expect(400)
    expect(res.body.error).toMatch(/unknown option "deny"/)
  })

  it('double-decide is a 409 conflict and the second body never overwrites the first', async () => {
    const id = submitResults()
    await request(app)
      .post(`/api/cards/${id}/decide`)
      .send({
        answers: {
          'claim:approve-me': { chosen: ['approve'] },
          [RESULTS_VERDICT_ID]: { chosen: ['continue'] },
        },
      })
      .expect(200)
    const res = await request(app)
      .post(`/api/cards/${id}/decide`)
      .send({
        answers: {
          'claim:approve-me': { chosen: ['reject'], note: 'changed my mind' },
          [RESULTS_VERDICT_ID]: { chosen: ['complete'] },
        },
      })
      .expect(409)
    expect(res.body.error).toMatch(/decided/)
    // The original decision is intact — the conflicting second body was a no-op.
    const stored = await request(app).get(`/api/cards/${id}`).expect(200)
    expect(stored.body.answers['claim:approve-me'].chosen).toEqual(['approve'])
    expect(stored.body.answers[RESULTS_VERDICT_ID].chosen).toEqual(['continue'])
  })
})
