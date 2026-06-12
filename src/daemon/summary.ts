import { OTHER_OPTION_ID, type Card, type DecisionAnswer } from '../shared/card.js'

function chosenLabels(d: Card['decisions'][number], a: DecisionAnswer): string {
  return a.chosen
    .map(c => c === OTHER_OPTION_ID
      ? `Other: ${a.custom ?? ''}`
      : d.options.find(o => o.id === c)?.label ?? c)
    .join(', ')
}

export function buildSummary(card: Card, answers: Record<string, DecisionAnswer>): string {
  const lines: string[] = []

  if (card.stage === 'results') {
    const denied = card.decisions.filter(d => answers[d.id]?.chosen.includes('deny'))
    const approved = card.decisions.filter(d => answers[d.id]?.chosen.includes('approve'))
    if (denied.length > 0) {
      lines.push('DENIED claims — treat each note as your next instruction:')
      for (const d of denied) lines.push(`- ${d.prompt}: ${answers[d.id].note ?? '(no note)'}`)
    } else {
      lines.push('All claims approved.')
    }
    if (approved.length > 0) {
      lines.push('Approved claims:')
      for (const d of approved) lines.push(`- ${d.prompt}`)
    }
    return lines.join('\n')
  }

  for (const d of card.decisions) {
    if (d.id === 'plan_verdict') continue
    const a = answers[d.id]
    if (!a) continue
    lines.push(`- ${d.prompt}: ${chosenLabels(d, a)}${a.note ? ` — note: ${a.note}` : ''}`)
  }
  if (card.stage === 'plan') {
    const v = answers['plan_verdict']
    if (v) lines.unshift(`Plan verdict: ${v.chosen[0]}${v.note ? ` — ${v.note}` : ''}`)
  }
  return lines.join('\n')
}
