import { describe, expect, it } from 'vitest'
import type { Decision } from '../../src/shared/card.js'
import { answersComplete, noteMissing, toggleChoice } from './helpers.js'

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
    expect(noteMissing(decision, { chosen: ['b'], note: '' })).toBe(true)
    expect(noteMissing(decision, { chosen: ['b'], note: 'because' })).toBe(false)
    expect(noteMissing(decision, { chosen: ['a'], note: '' })).toBe(false)
  })
})

describe('answersComplete', () => {
  it('requires every decision answered with required notes present', () => {
    expect(answersComplete([decision], {})).toBe(false)
    expect(answersComplete([decision], { d1: { chosen: ['b'], note: '' } })).toBe(false)
    expect(answersComplete([decision], { d1: { chosen: ['a'], note: '' } })).toBe(true)
  })
})
