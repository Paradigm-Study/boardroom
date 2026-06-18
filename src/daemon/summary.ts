import { OTHER_OPTION_ID, type AttachmentRef, type Card, type DecisionAnswer } from '../shared/card.js'

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
    const denied = card.decisions.filter(d => answers[d.id]?.chosen.includes('deny'))
    const approved = card.decisions.filter(d => answers[d.id]?.chosen.includes('approve'))
    if (denied.length > 0) {
      lines.push('DENIED claims — treat each note as your next instruction:')
      for (const d of denied) {
        const answer = answers[d.id]
        lines.push(`- ${d.prompt}: ${answer.note ?? '(no note)'}`)
        appendAttachments(lines, answer, '  ')
      }
    } else {
      lines.push('All claims approved.')
    }
    if (approved.length > 0) {
      lines.push('Approved claims:')
      for (const d of approved) {
        const answer = answers[d.id]
        lines.push(`- ${d.prompt}`)
        appendAttachments(lines, answer, '  ')
      }
    }
    return lines.join('\n')
  }

  for (const d of card.decisions) {
    if (d.id === 'plan_verdict') continue
    const a = answers[d.id]
    if (!a) continue
    lines.push(`- ${d.prompt}: ${chosenLabels(d, a)}${a.note ? ` — note: ${a.note}` : ''}`)
    appendAttachments(lines, a, '  ')
  }
  if (card.stage === 'plan') {
    const v = answers['plan_verdict']
    if (v) {
      const verdictLines = [`Plan verdict: ${v.chosen[0]}${v.note ? ` — ${v.note}` : ''}`]
      appendAttachments(verdictLines, v, '  ')
      lines.unshift(...verdictLines)
    }
  }
  return lines.join('\n')
}
