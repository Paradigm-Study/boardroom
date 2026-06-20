import { OTHER_OPTION_ID, type AttachmentRef, type Decision, type DecisionAnswer } from '../../src/shared/card.js'

export { OTHER_OPTION_ID }

export interface DraftAnswer {
  chosen: string[]
  note: string
  custom: string
  attachments?: AttachmentRef[]
}

export function emptyDraft(): DraftAnswer {
  return { chosen: [], note: '', custom: '' }
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
