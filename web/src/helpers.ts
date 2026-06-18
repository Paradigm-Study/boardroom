import { OTHER_OPTION_ID, type AttachmentRef, type Decision } from '../../src/shared/card.js'

export { OTHER_OPTION_ID }

export interface DraftAnswer {
  chosen: string[]
  note: string
  custom: string
  attachments?: AttachmentRef[]
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

export function answersComplete(decisions: Decision[], answers: Record<string, DraftAnswer>): boolean {
  return decisions.every(d => {
    const a = answers[d.id]
    return !!a && a.chosen.length > 0 && !noteMissing(d, a) && !customMissing(a)
  })
}

export function toApiAnswers(
  answers: Record<string, DraftAnswer>,
): Record<string, { chosen: string[]; note?: string; custom?: string; attachments?: AttachmentRef[] }> {
  return Object.fromEntries(
    Object.entries(answers).map(([id, a]) => [id, {
      chosen: a.chosen,
      ...(a.note.trim() ? { note: a.note.trim() } : {}),
      ...(a.chosen.includes(OTHER_OPTION_ID) && a.custom.trim() ? { custom: a.custom.trim() } : {}),
      ...(a.attachments?.length ? { attachments: a.attachments } : {}),
    }]),
  )
}
