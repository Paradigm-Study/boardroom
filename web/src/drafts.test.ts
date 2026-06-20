// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { DraftAnswer } from './helpers.js'
import { clearDrafts, loadDrafts, saveDrafts } from './drafts.js'

afterEach(() => {
  localStorage.clear()
})

describe('drafts', () => {
  it('round-trips: saveDrafts then loadDrafts returns the same object', () => {
    const drafts: Record<string, DraftAnswer> = {
      'claim-1': { chosen: ['a', 'b'], note: 'looks good', custom: '' },
      'claim-2': { chosen: ['other'], note: '', custom: 'a third way' },
    }
    saveDrafts('card-1', drafts)
    expect(loadDrafts('card-1')).toEqual(drafts)
  })

  it('returns null for an unset card id', () => {
    expect(loadDrafts('never-saved')).toBe(null)
  })

  it('returns null (without throwing) when the key holds invalid JSON', () => {
    localStorage.setItem('boardroom-draft-card-garbage', '{not valid json')
    expect(() => loadDrafts('card-garbage')).not.toThrow()
    expect(loadDrafts('card-garbage')).toBe(null)
  })

  it('clearDrafts removes the key', () => {
    const drafts: Record<string, DraftAnswer> = {
      'claim-1': { chosen: ['a'], note: '', custom: '' },
    }
    saveDrafts('card-1', drafts)
    expect(loadDrafts('card-1')).toEqual(drafts)
    clearDrafts('card-1')
    expect(loadDrafts('card-1')).toBe(null)
  })
})
