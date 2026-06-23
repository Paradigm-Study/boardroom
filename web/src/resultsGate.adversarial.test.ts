import { describe, expect, it } from 'vitest'
import type { Card, Decision } from '../../src/shared/card.js'
import { RESULTS_VERDICT_ID } from '../../src/shared/card.js'
import { answersComplete, claimNotesValid, OTHER_OPTION_ID, toApiAnswers } from './helpers.js'
import { prepareCardWorkspace } from './cardWorkspace.js'

// A 3-way claim: approve / revise / reject; revise & reject require a note.
const claim = (id: string): Decision => ({
  id,
  prompt: id,
  options: [
    { id: 'approve', label: 'Approve' },
    { id: 'revise', label: 'Revise' },
    { id: 'reject', label: 'Reject' },
  ],
  noteRequiredOn: ['revise', 'reject'],
})

describe('claimNotesValid — adversarial', () => {
  it('treats a whitespace-only note on a voted reject as INVALID (not just empty string)', () => {
    // Spec: revise/reject require a note. A note of "   " or tabs/newlines is not a note.
    expect(claimNotesValid([claim('claim:a')], { 'claim:a': { chosen: ['reject'], note: '   ', custom: '' } })).toBe(false)
    expect(claimNotesValid([claim('claim:a')], { 'claim:a': { chosen: ['revise'], note: '\t\n  ', custom: '' } })).toBe(false)
  })

  it('treats a voted APPROVE with an empty note as VALID (approve never needs a note)', () => {
    expect(claimNotesValid([claim('claim:a')], { 'claim:a': { chosen: ['approve'], note: '', custom: '' } })).toBe(true)
  })

  it('ignores unreviewed claims among a mix, but still blocks a bad voted one', () => {
    const claims = [claim('claim:a'), claim('claim:b'), claim('claim:c')]
    const answers = {
      // claim:a unreviewed (absent) -> ignored
      'claim:b': { chosen: ['approve'], note: '', custom: '' }, // approved, fine
      'claim:c': { chosen: ['revise'], note: '   ', custom: '' }, // revise w/ blank note -> invalid
    }
    expect(claimNotesValid(claims, answers)).toBe(false)
  })

  it('treats a chosen:[] answer (touched then cleared) as unreviewed, not invalid', () => {
    expect(claimNotesValid([claim('claim:a')], { 'claim:a': { chosen: [], note: '', custom: '' } })).toBe(true)
  })

  it('returns true on an empty claims list (no crash, vacuously valid)', () => {
    expect(claimNotesValid([], {})).toBe(true)
    expect(claimNotesValid([], { stray: { chosen: ['reject'], note: '', custom: '' } })).toBe(true)
  })
})

describe('answersComplete (mark-complete gate) — adversarial', () => {
  it('is false if ANY claim is unanswered, even when the rest are valid', () => {
    const claims = [claim('claim:a'), claim('claim:b')]
    expect(answersComplete(claims, { 'claim:a': { chosen: ['approve'], note: '', custom: '' } })).toBe(false)
  })

  it('is false when a revise/reject claim has only a whitespace note', () => {
    expect(answersComplete([claim('claim:a')], { 'claim:a': { chosen: ['reject'], note: '  \t', custom: '' } })).toBe(false)
  })

  it('is true only when every claim is fully answered with required notes present', () => {
    const claims = [claim('claim:a'), claim('claim:b')]
    expect(answersComplete(claims, {
      'claim:a': { chosen: ['approve'], note: '', custom: '' },
      'claim:b': { chosen: ['reject'], note: 'broken', custom: '' },
    })).toBe(true)
  })

  it('returns true on an empty decisions list (vacuous, no crash)', () => {
    expect(answersComplete([], {})).toBe(true)
  })
})

describe('toApiAnswers — adversarial', () => {
  it('NEVER emits a note key for a whitespace-only string', () => {
    const api = toApiAnswers({ d1: { chosen: ['approve'], note: '   \t\n', custom: '' } })
    expect('note' in api.d1).toBe(false)
    expect(api.d1).toEqual({ chosen: ['approve'] })
  })

  it('trims a non-empty note rather than passing raw padded text', () => {
    const api = toApiAnswers({ d1: { chosen: ['revise'], note: '  fix it  ', custom: '' } })
    expect(api.d1.note).toBe('fix it')
  })

  it('drops custom unless __other__ is actually chosen, even if custom text is present', () => {
    const api = toApiAnswers({ d1: { chosen: ['approve'], note: '', custom: 'stale leftover' } })
    expect('custom' in api.d1).toBe(false)
  })

  it('keeps custom (trimmed) only for __other__ with non-blank text', () => {
    const api = toApiAnswers({
      yes: { chosen: [OTHER_OPTION_ID], note: '', custom: '  mine  ' },
      no: { chosen: [OTHER_OPTION_ID], note: '', custom: '   ' }, // blank custom -> dropped
    })
    expect(api.yes.custom).toBe('mine')
    expect('custom' in api.no).toBe(false)
  })

  it('does not emit an attachments key for an empty attachments array', () => {
    const api = toApiAnswers({ d1: { chosen: ['approve'], note: '', custom: '', attachments: [] } })
    expect('attachments' in api.d1).toBe(false)
  })
})

describe('prepareCardWorkspace on a results card — adversarial', () => {
  const resultsCard = (decisions: Decision[], blocks: Card['blocks'] = []): Card => ({
    id: 'r1',
    stage: 'results',
    session: { agent: 'codex', project: 'boardroom' },
    headline: 'Results',
    blocks,
    decisions,
    status: 'pending',
    createdAt: '2026-06-16T12:00:00.000Z',
  })

  it('excludes results_verdict from choiceDecisions even when it is not last in the list', () => {
    const card = resultsCard([
      { id: RESULTS_VERDICT_ID, prompt: 'complete?', options: [{ id: 'complete', label: 'C' }, { id: 'continue', label: 'K' }] },
      claim('claim:a'),
      claim('claim:b'),
    ])
    expect(prepareCardWorkspace(card).choiceDecisions.map(d => d.id)).toEqual(['claim:a', 'claim:b'])
  })

  it('works (does not crash) on a results card with NO verdict decision at all', () => {
    const card = resultsCard([claim('claim:a')])
    const ws = prepareCardWorkspace(card)
    expect(ws.choiceDecisions.map(d => d.id)).toEqual(['claim:a'])
  })

  it('globalBlocks excludes blocks linked to a claim; linkedBlocksFor resolves only real blocks', () => {
    const card = resultsCard(
      [{ ...claim('claim:a'), blockRefs: ['diff', 'ghost'] }, claim('claim:b')],
      [
        { id: 'diff', type: 'markdown', text: 'the diff' },
        { id: 'orphan', type: 'markdown', text: 'unlinked' },
      ],
    )
    const ws = prepareCardWorkspace(card)
    expect(ws.globalBlocks.map(b => b.id)).toEqual(['orphan'])
    // 'ghost' blockRef has no matching block -> filtered out, no undefined leaks through.
    expect(ws.linkedBlocksFor('claim:a').map(b => b.id)).toEqual(['diff'])
    expect(ws.linkedBlocksFor('claim:a').every(b => b !== undefined)).toBe(true)
  })

  it('linkedBlocksFor on the filtered-out verdict id returns empty (verdict not in choiceDecisions)', () => {
    const card = resultsCard([
      claim('claim:a'),
      { id: RESULTS_VERDICT_ID, prompt: 'complete?', blockRefs: ['diff'], options: [{ id: 'complete', label: 'C' }] },
    ], [{ id: 'diff', type: 'markdown', text: 'x' }])
    expect(prepareCardWorkspace(card).linkedBlocksFor(RESULTS_VERDICT_ID)).toEqual([])
  })
})
