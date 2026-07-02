import { describe, expect, it } from 'vitest'
import type { Card, Decision } from '../../src/shared/card.js'
import { answersComplete, claimNotesValid, deriveResultsVerdict, isReconnecting, needsHuman, noteMissing, OTHER_OPTION_ID, toApiAnswers, toggleChoice, type DraftAnswer } from './helpers.js'
import type { AttachmentRef } from '../../src/shared/card.js'

const decision: Decision = {
  id: 'd1', prompt: 'p',
  options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  noteRequiredOn: ['b'],
}
const multi: Decision = { ...decision, id: 'd2', multi: true, noteRequiredOn: [] }

describe('needsHuman / isReconnecting', () => {
  const NOW = Date.parse('2026-06-23T12:00:00.000Z')
  const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString()
  function card(o: Partial<Card>): Card {
    return {
      id: 'c', stage: 'clarify', session: { agent: 'claude-code', project: 'p' },
      headline: 'h', blocks: [], decisions: [decision],
      status: 'pending', createdAt: minutesAgo(5), ...o,
    }
  }

  it('a pending card needs the human', () => {
    expect(needsHuman(card({ status: 'pending' }), NOW)).toBe(true)
  })

  it('a card a restart orphaned (reason "boot") within the window is reconnecting and still needs the human', () => {
    const c = card({ status: 'orphaned', orphanedReason: 'boot', orphanedAt: minutesAgo(2) })
    expect(isReconnecting(c, NOW)).toBe(true)
    expect(needsHuman(c, NOW)).toBe(true)
  })

  it('a card orphaned by a disconnect or park is NOT reconnecting (stays in history)', () => {
    for (const reason of ['disconnect', 'park'] as const) {
      const c = card({ status: 'orphaned', orphanedReason: reason, orphanedAt: minutesAgo(2) })
      expect(isReconnecting(c, NOW)).toBe(false)
      expect(needsHuman(c, NOW)).toBe(false)
    }
  })

  it('a boot-orphaned card past the 24h reattach window is no longer reconnecting', () => {
    const c = card({ status: 'orphaned', orphanedReason: 'boot', orphanedAt: minutesAgo(25 * 60) })
    expect(isReconnecting(c, NOW)).toBe(false)
    expect(needsHuman(c, NOW)).toBe(false)
  })

  it('a decided card never needs the human', () => {
    expect(needsHuman(card({ status: 'decided' }), NOW)).toBe(false)
  })
})

describe('toggleChoice', () => {
  it('single-select replaces the choice', () => {
    expect(toggleChoice(decision, ['a'], 'b')).toEqual(['b'])
  })
  it('multi-select toggles membership', () => {
    expect(toggleChoice(multi, ['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleChoice(multi, ['a', 'b'], 'b')).toEqual(['a'])
  })
})

describe('noteMissing', () => {
  it('is true when a note-required option is chosen without a note', () => {
    expect(noteMissing(decision, { chosen: ['b'], note: '', custom: '' })).toBe(true)
    expect(noteMissing(decision, { chosen: ['b'], note: 'because', custom: '' })).toBe(false)
    expect(noteMissing(decision, { chosen: ['a'], note: '', custom: '' })).toBe(false)
  })
})

describe('answersComplete', () => {
  it('requires every decision answered with required notes present', () => {
    expect(answersComplete([decision], {})).toBe(false)
    expect(answersComplete([decision], { d1: { chosen: ['b'], note: '', custom: '' } })).toBe(false)
    expect(answersComplete([decision], { d1: { chosen: ['a'], note: '', custom: '' } })).toBe(true)
  })

  it('requires custom text when "other" is chosen', () => {
    expect(answersComplete([decision], { d1: { chosen: [OTHER_OPTION_ID], note: '', custom: '' } })).toBe(false)
    expect(answersComplete([decision], { d1: { chosen: [OTHER_OPTION_ID], note: '', custom: 'my own take' } })).toBe(true)
  })
})

describe('claimNotesValid', () => {
  const claim: Decision = {
    id: 'claim:a', prompt: 'A',
    options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }],
    noteRequiredOn: ['revise', 'reject'],
  }

  it('ignores unreviewed claims but requires a note on any voted revise/reject', () => {
    // "Keep going" should not be blocked by claims the human chose not to touch.
    expect(claimNotesValid([claim], {})).toBe(true)
    expect(claimNotesValid([claim], { 'claim:a': { chosen: ['approve'], note: '', custom: '' } })).toBe(true)
    expect(claimNotesValid([claim], { 'claim:a': { chosen: ['reject'], note: '', custom: '' } })).toBe(false)
    expect(claimNotesValid([claim], { 'claim:a': { chosen: ['revise'], note: 'do x', custom: '' } })).toBe(true)
  })
})

describe('deriveResultsVerdict', () => {
  const claim = (id: string): Decision => ({
    id, prompt: id,
    options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }],
    noteRequiredOn: ['revise', 'reject'],
  })
  const addon = (note = '', attachments?: AttachmentRef[]): DraftAnswer => ({ chosen: [], note, custom: '', ...(attachments ? { attachments } : {}) })
  const file: AttachmentRef = { id: 'f1', name: 'x.png', size: 1, path: '/x', uploadedAt: '2026-06-30T00:00:00.000Z' }

  it('is "complete" only when every claim is approved and the add-on is empty', () => {
    const claims = [claim('a'), claim('b')]
    const answers = { a: { chosen: ['approve'], note: '', custom: '' }, b: { chosen: ['approve'], note: '', custom: '' } }
    expect(deriveResultsVerdict(claims, answers, addon())).toBe('complete')
  })

  it('is "continue" when any claim is rejected or revised', () => {
    const claims = [claim('a'), claim('b')]
    const answers = { a: { chosen: ['approve'], note: '', custom: '' }, b: { chosen: ['reject'], note: 'drop it', custom: '' } }
    expect(deriveResultsVerdict(claims, answers, addon())).toBe('continue')
  })

  it('is "continue" when any claim is still unreviewed', () => {
    const claims = [claim('a'), claim('b')]
    const answers = { a: { chosen: ['approve'], note: '', custom: '' } }
    expect(deriveResultsVerdict(claims, answers, addon())).toBe('continue')
  })

  it('is "continue" when all approved but the human added an instruction note', () => {
    const claims = [claim('a')]
    const answers = { a: { chosen: ['approve'], note: '', custom: '' } }
    expect(deriveResultsVerdict(claims, answers, addon('also bump the version'))).toBe('continue')
  })

  it('is "continue" when all approved but the add-on carries an attachment', () => {
    const claims = [claim('a')]
    const answers = { a: { chosen: ['approve'], note: '', custom: '' } }
    expect(deriveResultsVerdict(claims, answers, addon('', [file]))).toBe('continue')
  })

  it('ignores a whitespace-only add-on note (still "complete")', () => {
    const claims = [claim('a')]
    const answers = { a: { chosen: ['approve'], note: '', custom: '' } }
    expect(deriveResultsVerdict(claims, answers, addon('   '))).toBe('complete')
  })

  it('is "continue" for a degenerate results card with zero claims', () => {
    expect(deriveResultsVerdict([], {}, addon())).toBe('continue')
  })
})

describe('toApiAnswers', () => {
  it('includes custom only when "other" is chosen', () => {
    const api = toApiAnswers({
      d1: { chosen: [OTHER_OPTION_ID], note: '', custom: 'hybrid approach' },
      d2: { chosen: ['a'], note: 'fine', custom: 'stale text' },
    })
    expect(api.d1).toEqual({ chosen: [OTHER_OPTION_ID], custom: 'hybrid approach' })
    expect(api.d2).toEqual({ chosen: ['a'], note: 'fine' })
  })

  it('preserves attachment references when submitting answers', () => {
    const api = toApiAnswers({
      d1: {
        chosen: ['a'],
        note: 'see attached',
        custom: '',
        attachments: [{
          id: 'att-1',
          name: 'screenshot.png',
          mime: 'image/png',
          size: 100,
          path: '/tmp/screenshot.png',
          url: '/api/cards/c1/attachments/att-1',
          field: 'note',
          uploadedAt: '2026-06-16T12:00:00.000Z',
        }],
      },
    })

    expect(api.d1.attachments?.[0].path).toBe('/tmp/screenshot.png')
  })
})
