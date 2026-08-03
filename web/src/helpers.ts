import { CARD_ADDON_ID, OTHER_OPTION_ID, type AttachmentRef, type Decision, type DecisionAnswer, type ResultsVerdict } from '../../src/shared/card.js'

export { CARD_ADDON_ID, OTHER_OPTION_ID }

// The "reconnecting"/"needs the human" predicate and the reattach window now live in
// src/shared so the daemon's tray view-model and the dashboard share ONE definition.
// Re-exported here so existing dashboard imports (from './helpers.js') keep working.
export { REATTACH_WINDOW_MS, isReconnecting, needsHuman, orphanClockMs } from '../../src/shared/needsHuman.js'

export interface DraftAnswer {
  chosen: string[]
  note: string
  custom: string
  attachments?: AttachmentRef[]
}

export function emptyDraft(): DraftAnswer {
  return { chosen: [], note: '', custom: '' }
}

// Compact relative age ("now" / "5m" / "3h" / "2d") for sidebar + session rows.
// Returns '' for an unparseable timestamp so a bad value renders as nothing rather
// than "NaNd".
export function age(iso: string): string {
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  const mins = Math.round((Date.now() - ms) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export function toggleChoice(decision: Decision, chosen: string[], optionId: string): string[] {
  if (!decision.multi) return [optionId]
  return chosen.includes(optionId) ? chosen.filter(c => c !== optionId) : [...chosen, optionId]
}

export function noteMissing(decision: Decision, answer: DraftAnswer): boolean {
  return (decision.noteRequiredOn ?? []).some(o => answer.chosen.includes(o)) && answer.note.trim() === ''
}

export function customMissing(answer: DraftAnswer): boolean {
  return answer.chosen.includes(OTHER_OPTION_ID) && answer.custom.trim() === ''
}

// The single source of truth for "this decision is fully answered": a choice is
// made and any required note / custom-answer text is present. The submit gate and
// every progress counter derive from this, so they can never silently disagree.
export function decisionAnswered(decision: Decision, answer: DraftAnswer | undefined): boolean {
  return !!answer && answer.chosen.length > 0 && !noteMissing(decision, answer) && !customMissing(answer)
}

export function answersComplete(decisions: Decision[], answers: Record<string, DraftAnswer>): boolean {
  return decisions.every(d => decisionAnswered(d, answers[d.id]))
}

// "Keep going" readiness for the results gate: every claim the human DID vote on
// carries its required note, but unreviewed claims are allowed. (Marking the
// session complete is stricter — it uses answersComplete, which requires a verdict
// on every claim.)
export function claimNotesValid(claims: Decision[], answers: Record<string, DraftAnswer>): boolean {
  return claims.every(d => {
    const a = answers[d.id]
    return !a || a.chosen.length === 0 || !noteMissing(d, a)
  })
}

// Whether the global card-level add-on carries anything worth sending: a
// non-blank note or at least one attachment. Gates both the payload (an empty
// add-on never rides the wire) and the results verdict derivation below.
export function addonHasContent(addon: DraftAnswer): boolean {
  return addon.note.trim() !== '' || (addon.attachments?.length ?? 0) > 0
}

// The results gate collapses to ONE submit button whose verdict is derived, never
// hand-picked: the per-claim votes plus the card-level add-on already say whether
// there is work left. It is "complete" ONLY when every claim is approved AND the
// add-on carries no instruction (note or attachment); any reject/revise, any
// unreviewed claim, or any add-on means "continue" (the agent acts and re-submits).
// Standing instructions ≠ a flag on the decisions: the claim approvals ride
// through unchanged — the add-on only says the session still has work.
export function deriveResultsVerdict(
  claims: Decision[],
  answers: Record<string, DraftAnswer>,
  addon: DraftAnswer,
): ResultsVerdict {
  const allApproved = claims.length > 0 && claims.every(d => {
    const a = answers[d.id]
    return !!a && a.chosen.length === 1 && a.chosen[0] === 'approve'
  })
  return allApproved && !addonHasContent(addon) ? 'complete' : 'continue'
}

// Draft-attachment helpers — the per-field filter and the immutable add/remove
// updates live here once; Decision and ResultsChecklist both reuse them.
export function attachmentsForField(answer: DraftAnswer, field: string): AttachmentRef[] {
  return answer.attachments?.filter(a => a.field === field) ?? []
}

export function withAttachment(answer: DraftAnswer, attachment: AttachmentRef): DraftAnswer {
  return { ...answer, attachments: [...(answer.attachments ?? []), attachment] }
}

export function withoutAttachment(answer: DraftAnswer, id: string): DraftAnswer {
  return { ...answer, attachments: (answer.attachments ?? []).filter(a => a.id !== id) }
}

export function toApiAnswers(answers: Record<string, DraftAnswer>): Record<string, DecisionAnswer> {
  return Object.fromEntries(
    Object.entries(answers)
      // The global add-on is a channel, not a decision: when the human left it
      // empty there is nothing to say — drop the key entirely from the wire.
      .filter(([id, a]) => id !== CARD_ADDON_ID || addonHasContent(a))
      .map(([id, a]) => [id, {
        chosen: a.chosen,
        ...(a.note.trim() ? { note: a.note.trim() } : {}),
        ...(a.chosen.includes(OTHER_OPTION_ID) && a.custom.trim() ? { custom: a.custom.trim() } : {}),
        ...(a.attachments?.length ? { attachments: a.attachments } : {}),
      }]),
  )
}
