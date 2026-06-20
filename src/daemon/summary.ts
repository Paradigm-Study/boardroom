import { OTHER_OPTION_ID, PLAN_VERDICT_ID, RESULTS_VERDICT_ID, type AttachmentRef, type Card, type DecisionAnswer, type PlanVerdict, type ResultsVerdict } from '../shared/card.js'

function chosenLabels(d: Card['decisions'][number], a: DecisionAnswer): string {
  return a.chosen
    .map(c => c === OTHER_OPTION_ID
      ? `Other: ${a.custom ?? ''}`
      : d.options.find(o => o.id === c)?.label ?? c)
    .join(', ')
}

function attachmentLabel(a: AttachmentRef): string {
  const field = a.field ? `${a.field}: ` : ''
  return `${field}${a.name} (${a.path})`
}

function appendAttachments(lines: string[], answer: DecisionAnswer | undefined, indent = ''): void {
  if (!answer?.attachments?.length) return
  lines.push(`${indent}Attachments:`)
  for (const a of answer.attachments) lines.push(`${indent}- ${attachmentLabel(a)}`)
}

export function buildSummary(card: Card, answers: Record<string, DecisionAnswer>): string {
  const lines: string[] = []

  if (card.stage === 'results') {
    const claims = card.decisions.filter(d => d.id !== RESULTS_VERDICT_ID)
    const chose = (d: Card['decisions'][number], opt: PlanVerdict): boolean => !!answers[d.id]?.chosen.includes(opt)
    const rejected = claims.filter(d => chose(d, 'reject'))
    const revised = claims.filter(d => chose(d, 'revise'))
    const approved = claims.filter(d => chose(d, 'approve'))
    const verdict = answers[RESULTS_VERDICT_ID]
    // The human sets completion explicitly; it is NOT inferred from the votes, so
    // a card can read COMPLETE while still carrying denied/changed claims as record.
    const complete = !!verdict?.chosen.includes('complete' satisfies ResultsVerdict)

    lines.push(complete
      ? 'Session COMPLETE — the work is accepted.'
      : 'Session NOT complete — act on the items below, then re-submit review.')

    // The verdict's own note/attachments are the always-on card-level add-on:
    // session-level asks not tied to any single claim.
    if (verdict?.note?.trim() || verdict?.attachments?.length) {
      lines.push(`Added instructions:${verdict.note?.trim() ? ` ${verdict.note.trim()}` : ''}`)
      appendAttachments(lines, verdict, '  ')
    }

    const group = (header: string, decisions: Card['decisions'], withNote: boolean): void => {
      if (decisions.length === 0) return
      lines.push(header)
      for (const d of decisions) {
        const a = answers[d.id]
        if (!a) continue // group() only ever receives decisions the human voted on
        lines.push(`- ${d.prompt}${withNote ? `: ${a.note ?? '(no note)'}` : (a.note?.trim() ? ` — note: ${a.note.trim()}` : '')}`)
        appendAttachments(lines, a, '  ')
      }
    }
    group('Rejected (drop) — treat each note as your next instruction:', rejected, true)
    group('Revise (on the right track) — apply each note:', revised, true)
    group('Approved as-is:', approved, false)
    return lines.join('\n')
  }

  for (const d of card.decisions) {
    if (d.id === PLAN_VERDICT_ID) continue
    const a = answers[d.id]
    if (!a) continue
    lines.push(`- ${d.prompt}: ${chosenLabels(d, a)}${a.note ? ` — note: ${a.note}` : ''}`)
    appendAttachments(lines, a, '  ')
  }
  if (card.stage === 'plan') {
    const v = answers[PLAN_VERDICT_ID]
    if (v) {
      const verdictLines = [`Plan verdict: ${v.chosen[0]}${v.note ? ` — ${v.note}` : ''}`]
      appendAttachments(verdictLines, v, '  ')
      lines.unshift(...verdictLines)
    }
  }
  return lines.join('\n')
}
