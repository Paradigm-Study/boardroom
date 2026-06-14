import type { DraftAnswer } from './helpers.js'

// In-progress answers are persisted per card so a new card arriving, a status
// change (e.g. the agent disconnecting), or even a full page reload never wipes
// what you've started filling in. Cleared once the card is decided.
const key = (cardId: string): string => `boardroom-draft-${cardId}`

export function loadDrafts(cardId: string): Record<string, DraftAnswer> | null {
  try {
    const raw = localStorage.getItem(key(cardId))
    return raw ? (JSON.parse(raw) as Record<string, DraftAnswer>) : null
  } catch {
    return null
  }
}

export function saveDrafts(cardId: string, drafts: Record<string, DraftAnswer>): void {
  try {
    localStorage.setItem(key(cardId), JSON.stringify(drafts))
  } catch {
    /* storage full or unavailable — drafts just won't persist, no crash */
  }
}

export function clearDrafts(cardId: string): void {
  try {
    localStorage.removeItem(key(cardId))
  } catch {
    /* ignore */
  }
}
