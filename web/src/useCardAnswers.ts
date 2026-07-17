import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { CARD_ADDON_ID, RESULTS_VERDICT_ID, type Card } from '../../src/shared/card.js'
import { loadDrafts, saveDrafts } from './drafts.js'
import type { DraftAnswer } from './helpers.js'

// One-time draft migration: before the global add-on existed, the results
// footer drafted the human's add-on onto the verdict draft's note/attachments.
// A saved draft without a CARD_ADDON_ID key is by construction pre-migration
// (the hook has seeded that key into every draft since), so move the verdict
// draft's content into the reserved slot — visible and editable in the add-on
// box — instead of letting it ride invisibly on the verdict.
function migrateLegacyDraft(
  saved: Record<string, Partial<DraftAnswer>> | null,
): Record<string, Partial<DraftAnswer>> | null {
  if (!saved || CARD_ADDON_ID in saved) return saved
  const verdict = saved[RESULTS_VERDICT_ID]
  if (!verdict?.note?.trim() && !verdict?.attachments?.length) return saved
  return {
    ...saved,
    [CARD_ADDON_ID]: { chosen: [], note: verdict.note ?? '', custom: '', attachments: verdict.attachments },
    [RESULTS_VERDICT_ID]: { ...verdict, note: '', attachments: [] },
  }
}

// Owns the in-progress answer map plus its draft persistence. Initialises from a
// saved draft (falling back to the card's finalized answers, then empty), and
// persists every keystroke/click so an arriving card, a status change, or a page
// reload never loses work — but only while the card is live. The `!pickupSummary`
// guard (matching `!readonly`) freezes the draft once the card has been recorded
// for offline pickup, so a settled card is never overwritten.
// Besides the card's decisions, the map always seeds the reserved CARD_ADDON_ID
// slot — the global add-on drafts (and survives reload) like any answer.
export function useCardAnswers(
  card: Card,
  readonly: boolean,
  pickupSummary: string | null,
): [Record<string, DraftAnswer>, Dispatch<SetStateAction<Record<string, DraftAnswer>>>] {
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>(() => {
    const saved = migrateLegacyDraft(!readonly ? loadDrafts(card.id) : null)
    const ids = [...card.decisions.map(d => d.id), CARD_ADDON_ID]
    return Object.fromEntries(
      ids.map(id => {
        const draft = saved?.[id]
        const final = card.answers?.[id]
        return [id, {
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
