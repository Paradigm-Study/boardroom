import { OTHER_OPTION_ID, type AttachmentRef, type Card, type Decision, type DecisionAnswer } from '../../src/shared/card.js'

export { OTHER_OPTION_ID }

// Mirrors the daemon's default reattach window (config.ts reattachWindowMs /
// store.findReattachable). The dashboard has no access to the configured value, so
// it keys the "reconnecting" surfacing off the same 24h default.
export const REATTACH_WINDOW_MS = 24 * 60 * 60_000

// "Reconnecting": a card a daemon restart orphaned (orphanedReason 'boot') out from
// under a live waiter while it was still awaiting a decision, still within the
// reattach window. The dashboard surfaces these as actionable rather than burying
// them in history, so a deploy/restart never silently drops a decision — deciding
// one still reaches the agent via the existing reattach + waker (claude --resume).
// Disconnect/park orphans are deliberately excluded (they stay in history).
export function isReconnecting(card: Card, nowMs: number = Date.now()): boolean {
  return (
    card.status === 'orphaned' &&
    card.orphanedReason === 'boot' &&
    nowMs - new Date(card.orphanedAt ?? card.createdAt).getTime() < REATTACH_WINDOW_MS
  )
}

// The single source of truth for "this card is still on the human's plate": live
// pending, or reconnecting after a restart. Drives the Needs-you bucket, the count,
// and which card the dashboard auto-opens.
export function needsHuman(card: Card, nowMs: number = Date.now()): boolean {
  return card.status === 'pending' || isReconnecting(card, nowMs)
}

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
    Object.entries(answers).map(([id, a]) => [id, {
      chosen: a.chosen,
      ...(a.note.trim() ? { note: a.note.trim() } : {}),
      ...(a.chosen.includes(OTHER_OPTION_ID) && a.custom.trim() ? { custom: a.custom.trim() } : {}),
      ...(a.attachments?.length ? { attachments: a.attachments } : {}),
    }]),
  )
}
