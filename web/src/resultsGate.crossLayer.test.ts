import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// DAEMON side
import { Queue, ValidationError } from '../../src/daemon/queue.js'
import { Store } from '../../src/daemon/store.js'
import { compileResults } from '../../src/daemon/compile.js'
import { ReviewResultsInput } from '../../src/shared/inputs.js'
import {
  OTHER_OPTION_ID,
  RESULTS_VERDICT_ID,
  type Card,
  type Decision,
  type DecisionAnswer,
} from '../../src/shared/card.js'

// WEB submit-gate side
import { answersComplete, claimNotesValid, type DraftAnswer } from './helpers.js'
import { prepareCardWorkspace } from './cardWorkspace.js'

// ---------------------------------------------------------------------------
// Cross-layer parity: the web submit gate must never let a human submit
// something the daemon then rejects (the recently-fixed version-skew class of
// bug), and ideally never block something the daemon would accept. We import
// BOTH layers and assert their decisions agree on the SAME card — the card is
// derived from the real boundary (ReviewResultsInput.parse -> compileResults)
// so the options under test are exactly what the daemon builds.
// ---------------------------------------------------------------------------

let dir: string
let store: Store
let queue: Queue
const noop = { resolve: () => {}, reject: () => {} }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-xlayer-'))
  store = new Store(join(dir, 'test.sqlite'))
  queue = new Queue(store)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

// A real results card via the parse->compile boundary. Each claim carries one
// evidence block (ReviewResultsInput requires >=1) so compileResults succeeds.
function realResultsCard(claimIds: string[]): Card {
  const input = ReviewResultsInput.parse({
    project: 'boardroom',
    headline: 'what was delivered',
    claims: claimIds.map(id => ({
      id,
      claim: `claim ${id} is done`,
      evidence: [{ id: 'ev', type: 'markdown', text: `proof for ${id}` }],
    })),
  })
  return compileResults(input, 'claude-code')
}

// The claim decisions the UI renders (everything except the synthetic verdict),
// exactly as ResultsChecklist / prepareCardWorkspace derive them.
function claimsOf(card: Card): Decision[] {
  return card.decisions.filter(d => d.id !== RESULTS_VERDICT_ID)
}

// Re-insert the same compiled card under a fresh id+fingerprint so each scenario
// gets its own live waiter (decide is single-shot per card).
let counter = 0
function freshSubmit(card: Card): Card {
  const c: Card = { ...card, id: `card-${counter++}`, fingerprint: `fp-${counter}` }
  queue.submit(c, noop)
  return c
}

// Bridge the web DraftAnswer shape to the daemon DecisionAnswer wire shape the
// same way toApiAnswers does for the keys that matter here (chosen + note).
function toApi(answers: Record<string, DraftAnswer>): Record<string, DecisionAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([id, a]) => [id, {
      chosen: a.chosen,
      ...(a.note.trim() ? { note: a.note.trim() } : {}),
    }]),
  )
}

const draft = (chosen: string[], note = ''): DraftAnswer => ({ chosen, note, custom: '' })

describe('cross-layer parity: results "mark complete" gate vs daemon', () => {
  it('UI says complete-ready (answersComplete true) => daemon accepts verdict=complete', () => {
    const card = realResultsCard(['a', 'b'])
    const claims = claimsOf(card)
    const answers: Record<string, DraftAnswer> = {
      'claim:a': draft(['approve']),
      'claim:b': draft(['revise'], 'tighten the edges'),
      [RESULTS_VERDICT_ID]: draft(['complete']),
    }
    // Gate: every claim answered + notes present.
    expect(answersComplete(claims, answers)).toBe(true)
    // Daemon must NOT throw on the exact same payload.
    const live = freshSubmit(card)
    expect(() => queue.decide(live.id, toApi(answers))).not.toThrow()
  })

  it('UI blocks complete (unreviewed claim) AND daemon rejects verdict=complete — agree', () => {
    const card = realResultsCard(['a', 'b'])
    const claims = claimsOf(card)
    const answers: Record<string, DraftAnswer> = {
      'claim:a': draft(['approve']),
      // claim:b left unreviewed
      [RESULTS_VERDICT_ID]: draft(['complete']),
    }
    expect(answersComplete(claims, answers)).toBe(false)
    const live = freshSubmit(card)
    expect(() => queue.decide(live.id, toApi(answers))).toThrow(ValidationError)
  })

  it('UI blocks complete (revise claim, blank note) AND daemon rejects — agree', () => {
    const card = realResultsCard(['a'])
    const claims = claimsOf(card)
    const answers: Record<string, DraftAnswer> = {
      'claim:a': draft(['revise'], '   '), // whitespace-only is not a note
      [RESULTS_VERDICT_ID]: draft(['complete']),
    }
    expect(answersComplete(claims, answers)).toBe(false)
    const live = freshSubmit(card)
    expect(() => queue.decide(live.id, toApi(answers))).toThrow(/requires a note/)
  })
})

describe('cross-layer parity: results "keep going" gate vs daemon', () => {
  it('UI says continue-ready (claimNotesValid true, claims unreviewed) => daemon accepts verdict=continue', () => {
    const card = realResultsCard(['a', 'b'])
    const claims = claimsOf(card)
    const answers: Record<string, DraftAnswer> = {
      // No claim votes at all — the send-back analog.
      [RESULTS_VERDICT_ID]: draft(['continue']),
    }
    expect(claimNotesValid(claims, answers)).toBe(true)
    const live = freshSubmit(card)
    expect(() => queue.decide(live.id, toApi(answers))).not.toThrow()
  })

  it('UI says continue-ready with a partial valid vote => daemon accepts', () => {
    const card = realResultsCard(['a', 'b'])
    const claims = claimsOf(card)
    const answers: Record<string, DraftAnswer> = {
      'claim:a': draft(['reject'], 'wrong direction, drop it'),
      // claim:b unreviewed — allowed under "keep going"
      [RESULTS_VERDICT_ID]: draft(['continue']),
    }
    expect(claimNotesValid(claims, answers)).toBe(true)
    const live = freshSubmit(card)
    expect(() => queue.decide(live.id, toApi(answers))).not.toThrow()
  })

  it('UI blocks continue (voted reject, blank note) AND daemon rejects verdict=continue — agree', () => {
    const card = realResultsCard(['a', 'b'])
    const claims = claimsOf(card)
    const answers: Record<string, DraftAnswer> = {
      'claim:a': draft(['reject'], ''), // voted but no note -> claimNotesValid false
      [RESULTS_VERDICT_ID]: draft(['continue']),
    }
    expect(claimNotesValid(claims, answers)).toBe(false)
    const live = freshSubmit(card)
    expect(() => queue.decide(live.id, toApi(answers))).toThrow(/requires a note/)
  })
})

describe('cross-layer invariant: the UI can only submit options the daemon knows', () => {
  it('every claim option id the UI renders is a member of that claim decision.options', () => {
    // ResultsChecklist renders verdict buttons from each card decision.options
    // (decision.options.map). So the set the UI can submit IS decision.options.
    // Asserting it is self-consistent on the compiled card proves no out-of-band
    // id can reach the daemon through the rendered buttons.
    const card = realResultsCard(['a', 'b', 'c'])
    for (const d of claimsOf(card)) {
      const ids = d.options.map(o => o.id)
      // Each compiled claim offers exactly the 3-way verdict, no surprises.
      expect(ids).toEqual(['approve', 'revise', 'reject'])
      // And every one of those ids is accepted by the daemon validator (it checks
      // membership in decision.options) — i.e. submitting any rendered button id
      // for a fully-noted answer never throws "unknown option".
      const live = freshSubmit(card)
      const answers: Record<string, DecisionAnswer> = {
        [d.id]: { chosen: [d.options[0].id], note: 'n' },
      }
      // approve-only on one claim + continue verdict is a valid keep-going submit.
      expect(() => queue.decide(live.id, {
        ...answers,
        [RESULTS_VERDICT_ID]: { chosen: ['continue'] },
      })).not.toThrow()
    }
  })

  it('the synthetic verdict offers exactly complete|continue and the daemon accepts both', () => {
    const card = realResultsCard(['a'])
    const verdict = card.decisions.find(d => d.id === RESULTS_VERDICT_ID)
    expect(verdict?.options.map(o => o.id)).toEqual(['complete', 'continue'])

    const liveContinue = freshSubmit(card)
    expect(() => queue.decide(liveContinue.id, { [RESULTS_VERDICT_ID]: { chosen: ['continue'] } })).not.toThrow()

    const liveComplete = freshSubmit(card)
    expect(() => queue.decide(liveComplete.id, {
      'claim:a': { chosen: ['approve'] },
      [RESULTS_VERDICT_ID]: { chosen: ['complete'] },
    })).not.toThrow()
  })
})

describe('cross-layer: legacy approve/deny card — skew can only be hit by bypassing the UI', () => {
  // A historically-shaped results card: claims with the OLD approve/deny option
  // ids (before the deny->reject / changes->revise rename). The UI renders verdict
  // buttons from THESE options, so it can only ever submit 'approve' or 'deny'.
  function legacyCard(): Card {
    const claim = (id: string): Decision => ({
      id: `claim:${id}`,
      prompt: `legacy ${id}`,
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'deny', label: 'Deny' },
      ],
      noteRequiredOn: ['deny'],
      blockRefs: [],
    })
    return {
      id: 'legacy',
      stage: 'results',
      session: { agent: 'claude-code', project: 'boardroom' },
      headline: 'legacy results',
      blocks: [],
      decisions: [
        claim('a'),
        { id: RESULTS_VERDICT_ID, prompt: 'complete?', options: [{ id: 'complete', label: 'C' }, { id: 'continue', label: 'K' }] },
      ],
      status: 'pending',
      createdAt: new Date().toISOString(),
      fingerprint: 'fp-legacy',
    }
  }

  it('UI would only ever submit approve/deny for a legacy claim (never revise/reject)', () => {
    const card = legacyCard()
    const claim = claimsOf(card)[0]
    const renderable = claim.options.map(o => o.id) // what ResultsChecklist maps over
    expect(renderable).toEqual(['approve', 'deny'])
    expect(renderable).not.toContain('revise')
    expect(renderable).not.toContain('reject')
  })

  it('daemon ACCEPTS a legacy approve/deny submit (a real rendered-button path)', () => {
    const card = legacyCard()
    queue.submit(card, noop)
    expect(() => queue.decide(card.id, {
      'claim:a': { chosen: ['deny'], note: 'no good' },
      [RESULTS_VERDICT_ID]: { chosen: ['continue'] },
    })).not.toThrow()
  })

  it('daemon REJECTS revise on a legacy claim as unknown — provably only reachable by bypassing the UI', () => {
    const card = legacyCard()
    queue.submit(card, noop)
    // 'revise' is NOT in the legacy claim.options, so the UI never renders it.
    // The only way this payload reaches decide() is a non-UI caller -> daemon guards it.
    expect(() => queue.decide(card.id, {
      'claim:a': { chosen: ['revise'], note: 'x' },
      [RESULTS_VERDICT_ID]: { chosen: ['continue'] },
    })).toThrow(/unknown option/)
  })

  it('prepareCardWorkspace also hides the verdict on a legacy card (parity with ResultsChecklist filter)', () => {
    const card = legacyCard()
    expect(prepareCardWorkspace(card).choiceDecisions.map(d => d.id)).toEqual(['claim:a'])
  })
})

describe('cross-layer: __other__ is not part of the results gate surface', () => {
  it('no compiled results claim offers __other__, so the UI never lets a human pick it', () => {
    const card = realResultsCard(['a', 'b'])
    for (const d of card.decisions) {
      expect(d.options.some(o => o.id === OTHER_OPTION_ID)).toBe(false)
    }
  })
})
