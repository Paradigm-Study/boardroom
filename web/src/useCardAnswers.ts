import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { Card } from '../../src/shared/card.js'
import { loadDrafts, saveDrafts } from './drafts.js'
import type { DraftAnswer } from './helpers.js'

// Owns the in-progress answer map plus its draft persistence. Initialises from a
// saved draft (falling back to the card's finalized answers, then empty), and
// persists every keystroke/click so an arriving card, a status change, or a page
// reload never loses work — but only while the card is live. The `!pickupSummary`
// guard (matching `!readonly`) freezes the draft once the card has been recorded
// for offline pickup, so a settled card is never overwritten.
export function useCardAnswers(
  card: Card,
  readonly: boolean,
  pickupSummary: string | null,
): [Record<string, DraftAnswer>, Dispatch<SetStateAction<Record<string, DraftAnswer>>>] {
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>(() => {
    const saved = !readonly ? loadDrafts(card.id) : null
    return Object.fromEntries(
      card.decisions.map(d => {
        const draft = saved?.[d.id]
        const final = card.answers?.[d.id]
        return [d.id, {
          chosen: draft?.chosen ?? final?.chosen ?? [],
          note: draft?.note ?? final?.note ?? '',
          custom: draft?.custom ?? final?.custom ?? '',
          attachments: draft?.attachments ?? final?.attachments ?? [],
        }]
      }),
    )
  })

  useEffect(() => {
    if (!readonly && !pickupSummary) saveDrafts(card.id, answers)
  }, [card.id, answers, readonly, pickupSummary])

  return [answers, setAnswers]
}
