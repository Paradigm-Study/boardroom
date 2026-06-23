import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Card, RESULTS_VERDICT_ID, type DecisionAnswer } from '../shared/card.js'
import { ReviewResultsInput } from '../shared/inputs.js'
import { compileResults } from './compile.js'
import { buildSummary } from './summary.js'
import { Queue, ValidationError } from './queue.js'
import { Store } from './store.js'

// ---------------------------------------------------------------------------
// Seeded deterministic PRNG (mulberry32). Fixed seed so any failure reproduces.
// ---------------------------------------------------------------------------
const SEED = 0x9e3779b9
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number
const pick = <T,>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]
const chance = (rng: Rng, p: number): boolean => rng() < p

// Safe id charset: NO '/' (would collide under claim/evidence namespacing), no NUL.
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. '
function randId(rng: Rng): string {
  const n = 1 + Math.floor(rng() * 8)
  let s = ''
  for (let i = 0; i < n; i++) s += pick(rng, ID_CHARS.split(''))
  // ids must be non-empty after the schema's min(1); keep at least one solid char
  return s.trim().length ? s : 'x'
}

// Text that may contain tricky substrings, but never produces a *spurious* leak:
// we deliberately keep authored notes free of the exact leak tokens so the
// no-leak invariant is meaningful (a separate suite covers verbatim hostile notes).
const SAFE_WORDS = ['tests pass', 'docs updated', 'lint clean', 'build ok', 'covered', 'shipped', 'reviewed', 'green']
function safeText(rng: Rng): string {
  const n = 1 + Math.floor(rng() * 4)
  return Array.from({ length: n }, () => pick(rng, SAFE_WORDS)).join(' ')
}

type Verdict = 'approve' | 'revise' | 'reject'
const VERDICTS: readonly Verdict[] = ['approve', 'revise', 'reject']
const CARD_VERDICTS = ['complete', 'continue'] as const

interface Scenario {
  input: ReturnType<typeof ReviewResultsInput.parse>
  claimVotes: Map<string, { verdict: Verdict; note?: string }> // keyed by claim:<id>
  cardVerdict: 'complete' | 'continue'
  addonNote?: string
}

// Build a VALID ReviewResultsInput plus a randomized set of human answers.
function genScenario(rng: Rng): Scenario {
  const claimCount = 1 + Math.floor(rng() * 6) // 1..6 claims
  const usedClaimIds = new Set<string>()
  const claims: { id: string; claim: string; evidence: { id: string; type: 'markdown'; text: string }[] }[] = []
  for (let i = 0; i < claimCount; i++) {
    let cid = randId(rng)
    // de-dup claim ids (schema rejects duplicates); also dedupe AFTER trim
    while (usedClaimIds.has(cid)) cid = `${cid}${i}`
    usedClaimIds.add(cid)
    const evCount = 1 + Math.floor(rng() * 3)
    const usedEv = new Set<string>()
    const evidence: { id: string; type: 'markdown'; text: string }[] = []
    for (let e = 0; e < evCount; e++) {
      let eid = randId(rng)
      while (usedEv.has(eid)) eid = `${eid}${e}`
      usedEv.add(eid)
      evidence.push({ id: eid, type: 'markdown', text: safeText(rng) })
    }
    claims.push({ id: cid, claim: safeText(rng), evidence })
  }

  // If after namespacing the compiled block ids collide, the schema rejects the
  // input. Since our ids never contain '/', `${claimId}/${evId}` is collision-free
  // given the per-claim de-dup above, so parse always succeeds. Assert it.
  const input = ReviewResultsInput.parse({ project: randId(rng), headline: safeText(rng), claims })

  // Random per-claim votes. A claim may also be left entirely UNVOTED.
  const claimVotes = new Map<string, { verdict: Verdict; note?: string }>()
  for (const c of claims) {
    if (chance(rng, 0.15)) continue // unvoted
    const verdict = pick(rng, VERDICTS)
    const needsNote = verdict === 'revise' || verdict === 'reject'
    // Randomly include/withhold a note even when required, to exercise both paths.
    const provideNote = needsNote ? chance(rng, 0.7) : chance(rng, 0.3)
    const note = provideNote ? safeText(rng) : undefined
    claimVotes.set(`claim:${c.id}`, { verdict, note })
  }

  const cardVerdict = pick(rng, CARD_VERDICTS)
  const addonNote = chance(rng, 0.4) ? safeText(rng) : undefined
  return { input, claimVotes, cardVerdict, addonNote }
}

// Translate a scenario into the DecisionAnswers map the queue/summary consume.
function toAnswers(s: Scenario): Record<string, DecisionAnswer> {
  const answers: Record<string, DecisionAnswer> = {}
  for (const [id, v] of s.claimVotes) {
    answers[id] = { chosen: [v.verdict], ...(v.note !== undefined ? { note: v.note } : {}) }
  }
  answers[RESULTS_VERDICT_ID] = {
    chosen: [s.cardVerdict],
    ...(s.addonNote !== undefined ? { note: s.addonNote } : {}),
  }
  return answers
}

// Independently compute whether Queue.decide SHOULD accept this scenario, from
// the gate's stated rules — NOT by calling the code under test.
//  - "complete": every claim must be voted (non-empty chosen) AND every
//    revise/reject vote must carry a non-blank note.
//  - "continue": only the claims actually voted are in scope; an unvoted claim
//    does not block, but a voted revise/reject still needs a non-blank note.
function expectAccept(card: Card, s: Scenario): boolean {
  const claimDecisions = card.decisions.filter(d => d.id !== RESULTS_VERDICT_ID)
  for (const d of claimDecisions) {
    const v = s.claimVotes.get(d.id)
    const voted = v !== undefined
    if (!voted) {
      if (s.cardVerdict === 'complete') return false // unvoted claim blocks complete
      continue // continue: unvoted claim is out of scope
    }
    const needsNote = v.verdict === 'revise' || v.verdict === 'reject'
    if (needsNote && !(v.note && v.note.trim().length > 0)) return false
  }
  return true
}

const noop = { resolve: () => {}, reject: () => {} }

let dir: string
let store: Store
let queue: Queue

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-prop-'))
  store = new Store(join(dir, 'test.sqlite'))
  queue = new Queue(store)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const N = 400

describe('results gate — property / fuzz invariants', () => {
  it(`compileResults always yields a valid Card; results_verdict is last and unique (${N} scenarios)`, () => {
    const rng = mulberry32(SEED)
    let ran = 0
    for (let i = 0; i < N; i++) {
      const s = genScenario(rng)
      const card = compileResults(s.input, 'claude-code')
      // Invariant 1: the compiled card is a valid zod Card. A throw is a real bug.
      expect(() => Card.parse(card)).not.toThrow()
      // Invariant 2: exactly one results_verdict decision, and it is LAST.
      const verdictIdxs = card.decisions
        .map((d, idx) => ({ d, idx }))
        .filter(x => x.d.id === RESULTS_VERDICT_ID)
        .map(x => x.idx)
      expect(verdictIdxs).toHaveLength(1)
      expect(verdictIdxs[0]).toBe(card.decisions.length - 1)
      // Invariant 3: one claim decision per input claim, ids namespaced as claim:<id>.
      const claimDecisions = card.decisions.filter(d => d.id !== RESULTS_VERDICT_ID)
      expect(claimDecisions).toHaveLength(s.input.claims.length)
      // Invariant 4: every compiled block id is globally unique (no namespacing collision).
      const blockIds = card.blocks.map(b => b.id)
      expect(new Set(blockIds).size).toBe(blockIds.length)
      ran++
    }
    expect(ran).toBe(N)
  })

  it(`buildSummary never leaks coercions and always leads COMPLETE / NOT complete (${N} scenarios)`, () => {
    const rng = mulberry32(SEED ^ 0x55555555)
    for (let i = 0; i < N; i++) {
      const s = genScenario(rng)
      const card = compileResults(s.input, 'claude-code')
      const answers = toAnswers(s)
      const out = buildSummary(card, answers)

      // Lead line invariant.
      const lead = out.split('\n')[0]
      expect(lead === 'Session COMPLETE — the work is accepted.'
        || lead === 'Session NOT complete — act on the items below, then re-submit review.').toBe(true)
      // Completion must reflect the human's explicit verdict, not the votes.
      if (s.cardVerdict === 'complete') expect(lead).toMatch(/COMPLETE/)
      else expect(lead).toMatch(/NOT complete/)

      // No raw JS coercions leaked into agent-facing text.
      expect(out).not.toMatch(/undefined/)
      expect(out).not.toMatch(/\[object Object\]/)
      expect(out).not.toMatch(/NaN/)
      // No dangling " — note:" with nothing after it (optional-note rendering bug).
      expect(out).not.toMatch(/ — note: *$/m)
      // No "Added instructions:" with a trailing space when the add-on note is blank.
      expect(out).not.toMatch(/^Added instructions: $/m)
    }
  })

  it(`Queue.decide accepts IFF the gate rules say it should (${N} scenarios)`, () => {
    const rng = mulberry32(SEED ^ 0x0f0f0f0f)
    let accepts = 0
    let rejects = 0
    for (let i = 0; i < N; i++) {
      const s = genScenario(rng)
      const card = compileResults(s.input, 'claude-code')
      const cardId = card.id
      // submit reattaches by fingerprint; randomized headlines/projects keep these
      // distinct, but use a unique fingerprint per iteration to be safe.
      queue.submit({ ...card, fingerprint: `fp-${i}-${cardId}` }, noop)
      const answers = toAnswers(s)
      const shouldAccept = expectAccept(card, s)

      if (shouldAccept) {
        // Must not throw, and must record a decided card.
        const res = queue.decide(cardId, answers)
        expect(res.card.status).toBe('decided')
        accepts++
      } else {
        expect(() => queue.decide(cardId, answers)).toThrow(ValidationError)
        rejects++
      }
    }
    expect(accepts + rejects).toBe(N)
    // Sanity: the generator exercised BOTH outcomes (not a degenerate run).
    expect(accepts).toBeGreaterThan(0)
    expect(rejects).toBeGreaterThan(0)
  })

  it(`buildSummary is deterministic: same answers twice yield identical output (${N} scenarios)`, () => {
    const rng = mulberry32(SEED ^ 0x33333333)
    for (let i = 0; i < N; i++) {
      const s = genScenario(rng)
      const card = compileResults(s.input, 'claude-code')
      const answers = toAnswers(s)
      const a = buildSummary(card, answers)
      const b = buildSummary(card, answers)
      expect(a).toBe(b)
    }
  })

  it('a "continue" verdict never lets a voted revise/reject skip its note (targeted boundary)', () => {
    // A focused property: across random scenarios, force a voted reject WITHOUT a
    // note under "continue"; decide must always throw. This is the exact skew the
    // gate must close — an out-of-scope claim is dropped, but a voted one is not.
    const rng = mulberry32(SEED ^ 0x77777777)
    let exercised = 0
    for (let i = 0; i < 120; i++) {
      const s = genScenario(rng)
      const card = compileResults(s.input, 'claude-code')
      const firstClaim = card.decisions.find(d => d.id !== RESULTS_VERDICT_ID)
      if (!firstClaim) continue
      const answers: Record<string, DecisionAnswer> = {
        [firstClaim.id]: { chosen: ['reject'] }, // note deliberately absent
        [RESULTS_VERDICT_ID]: { chosen: ['continue'] },
      }
      queue.submit({ ...card, fingerprint: `fpb-${i}-${card.id}` }, noop)
      expect(() => queue.decide(card.id, answers)).toThrow(ValidationError)
      exercised++
    }
    expect(exercised).toBeGreaterThan(0)
  })

  it('a "complete" verdict with any unvoted claim always throws (targeted boundary)', () => {
    const rng = mulberry32(SEED ^ 0x12345678)
    let exercised = 0
    for (let i = 0; i < 120; i++) {
      const s = genScenario(rng)
      const card = compileResults(s.input, 'claude-code')
      const claimDecisions = card.decisions.filter(d => d.id !== RESULTS_VERDICT_ID)
      if (claimDecisions.length < 2) continue // need at least one to leave unvoted
      // Vote-approve all but the last claim; leave the last unvoted; mark complete.
      const answers: Record<string, DecisionAnswer> = { [RESULTS_VERDICT_ID]: { chosen: ['complete'] } }
      for (const d of claimDecisions.slice(0, -1)) answers[d.id] = { chosen: ['approve'] }
      queue.submit({ ...card, fingerprint: `fpc-${i}-${card.id}` }, noop)
      expect(() => queue.decide(card.id, answers)).toThrow(ValidationError)
      exercised++
    }
    expect(exercised).toBeGreaterThan(0)
  })
})
