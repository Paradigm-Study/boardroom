import { describe, expect, it } from 'vitest'
import type { Decision } from '../../src/shared/card.js'
import { answersComplete, noteMissing, OTHER_OPTION_ID, toApiAnswers, toggleChoice } from './helpers.js'

const decision: Decision = {
  id: 'd1', prompt: 'p',
  options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  noteRequiredOn: ['b'],
}
const multi: Decision = { ...decision, id: 'd2', multi: true, noteRequiredOn: [] }

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
