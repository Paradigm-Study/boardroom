import type { Card, DecisionAnswer } from '../shared/card.js'

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
    const labels = d.options.filter(o => a.chosen.includes(o.id)).map(o => o.label).join(', ')
    lines.push(`- ${d.prompt}: ${labels}${a.note ? ` — note: ${a.note}` : ''}`)
  }
  if (card.stage === 'plan') {
    const v = answers['plan_verdict']
    if (v) lines.unshift(`Plan verdict: ${v.chosen[0]}${v.note ? ` — ${v.note}` : ''}`)
  }
  return lines.join('\n')
}
