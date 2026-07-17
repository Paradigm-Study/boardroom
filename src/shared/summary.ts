import { CARD_ADDON_ID, OTHER_OPTION_ID, PLAN_VERDICT_ID, RESULTS_VERDICT_ID, SPEC_VERDICT_ID, type AttachmentRef, type Card, type Criterion, type DecisionAnswer, type PlanVerdict, type ResultsVerdict, type SpecVerdict } from './card.js'

// Agent-authored text (prompts, option labels, criterion fields, file names)
// is flattened to one line at render time: the summary's section headers —
// notably "Added instructions — act on these:" — are a trust boundary only the
// HUMAN's own input may start a line with. Human-authored notes stay verbatim.
export function flat(s: string): string {
  // Collapse any whitespace run that contains a LINE SEPARATOR to a single space — not
  // just LF but CR, VT, FF, and the Unicode U+2028/U+2029/U+0085 separators a naive \n
  // check misses. This is the trust boundary: an agent must not be able to start a new
  // visual line inside a prompt/label/criterion/attachment field and thereby forge the
  // "Added instructions — act on these:" header (or any other section header).
  return s.replace(/\s*[\n\r\u2028\u2029\u0085\v\f]+\s*/gu, ' ')
}

function chosenLabels(d: Card['decisions'][number], a: DecisionAnswer): string {
  return a.chosen
    .map(c => c === OTHER_OPTION_ID
      ? `Other: ${a.custom ?? ''}`
      : flat(d.options.find(o => o.id === c)?.label ?? c))
    .join(', ')
}

function attachmentLabel(a: AttachmentRef): string {
  const field = a.field ? `${flat(a.field)}: ` : ''
  return `${field}${flat(a.name)} (${flat(a.path)})`
}

function appendAttachments(lines: string[], answer: DecisionAnswer | undefined, indent = ''): void {
  if (!answer?.attachments?.length) return
  lines.push(`${indent}Attachments:`)
  for (const a of answer.attachments) lines.push(`${indent}- ${attachmentLabel(a)}`)
}

// One criterion is MET iff some claim mapped to it was approved; everything else
// (no claim, all revised, all rejected) is UNMET. The contract converges when the
// unmet set is empty.
function unmetCriteria(
  criteria: Criterion[],
  claims: Card['decisions'],
  answers: Record<string, DecisionAnswer>,
): Criterion[] {
  const approved = new Set(claims.filter(d => answers[d.id]?.chosen.includes('approve')).map(d => d.id))
  const isMet = (cr: Criterion): boolean => claims.some(d => d.criterionId === cr.id && approved.has(d.id))
  return criteria.filter(cr => !isMet(cr))
}

// The global card-level add-on (answers[CARD_ADDON_ID]) as a closing section.
// Every stage appends this LAST — the human's final word to the agent, kept
// apart from the per-decision record above it. The note rides verbatim
// (multi-line intact); legacy verdict-note add-ons (results/spec) keep their
// own inline rendering, so old decided cards are untouched.
function addonSection(answers: Record<string, DecisionAnswer>): string[] {
  const addon = answers[CARD_ADDON_ID]
  const note = addon?.note?.trim()
  if (!note && !addon?.attachments?.length) return []
  const lines = ['Added instructions — act on these:']
  if (note) lines.push(note)
  appendAttachments(lines, addon)
  return lines
}

export function buildSummary(card: Card, answers: Record<string, DecisionAnswer>): string {
  const lines: string[] = []

  if (card.stage === 'spec') {
    const verdict = answers[SPEC_VERDICT_ID]
    const locked = !!verdict?.chosen.includes('lock' satisfies SpecVerdict)
    const critDecisions = card.decisions.filter(d => d.id !== SPEC_VERDICT_ID)
    const byId = new Map((card.criteria ?? []).map(c => [c.id, c]))

    // Resolve each criterion decision first, so the lead line can react to the
    // shape of the result (notably: a lock where every criterion was dropped).
    const kept: { cr: Criterion; adjust?: string }[] = []
    const dropped: { cr: Criterion; note?: string }[] = []
    for (const d of critDecisions) {
      const a = answers[d.id]
      const cr = d.criterionId ? byId.get(d.criterionId) : undefined
      if (!a || !cr) continue
      if (a.chosen.includes('drop')) dropped.push({ cr, note: a.note })
      else kept.push({ cr, adjust: a.chosen.includes('adjust') ? a.note : undefined })
    }
    const emptyContract = locked && kept.length === 0

    lines.push(
      !locked ? 'Spec sent back — revise the criteria below and re-present with present_spec.'
        : emptyContract ? 'Spec LOCKED — every criterion was dropped; there is no contract to build against (the human scoped this work out).'
          : 'Spec LOCKED — build to this contract; every criterion must end MET before the session can complete.')

    // The verdict's note/attachments: on a send-back this is the revise
    // instruction ("Send-back note"); on a lock it only exists on legacy
    // decided cards, where it was the pre-card_addon add-on channel — keep
    // that wording so old records read as recorded.
    if (verdict?.note?.trim() || verdict?.attachments?.length) {
      const label = locked ? 'Added instructions:' : 'Send-back note:'
      lines.push(`${label}${verdict.note?.trim() ? ` ${verdict.note.trim()}` : ''}`)
      appendAttachments(lines, verdict, '  ')
    }

    if (kept.length) {
      lines.push(locked ? 'Locked contract — satisfy every criterion:' : 'Current criteria (for your revision):')
      for (const { cr, adjust } of kept) {
        lines.push(`- ${flat(cr.behavior)} · GOOD: ${flat(cr.good)} · BAD: ${flat(cr.bad)} · traces to ${flat(cr.tracesTo)}`)
        if (adjust?.trim()) lines.push(`  adjust to: ${adjust.trim()}`)
      }
    }
    if (dropped.length) {
      lines.push('Dropped (out of scope):')
      for (const { cr, note } of dropped) lines.push(`- ${flat(cr.behavior)}${note?.trim() ? ` — ${note.trim()}` : ''}`)
    }
    // Only ask the agent to persist a contract that actually exists.
    if (locked && !emptyContract && card.specRef) {
      // specRef is agent-authored too — flatten it like every other agent field so a
      // newline-laced path can't forge the "Added instructions" header (see flat()).
      lines.push(`Write this locked contract to ${flat(card.specRef)} so it survives later turns; read it back when you verify and at review_results.`)
    }
    return [...lines, ...addonSection(answers)].join('\n')
  }

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

    // When the work was judged against a locked spec, the unmet criteria are the
    // headline of "what's left" — list them before the per-claim groups so a
    // `continue` loop has a concrete target.
    const criteria = card.criteria ?? []
    if (criteria.length) {
      const unmet = unmetCriteria(criteria, claims, answers)
      if (unmet.length) {
        lines.push(`UNMET CRITERIA (${unmet.length}) — not yet satisfied:`)
        for (const cr of unmet) lines.push(`- ${flat(cr.behavior)} — avoid: ${flat(cr.bad)}`)
        if (complete) lines.push(`(Marked COMPLETE with ${unmet.length} still unmet — recorded as accepted.)`)
      } else {
        lines.push(`All ${criteria.length} acceptance criteria met.`)
      }
      // Claims the agent didn't tie to any criterion (or, defensively, tied to one
      // not in the contract) are still reviewed in the groups below — but flag that
      // they don't count toward contract convergence.
      const known = new Set(criteria.map(c => c.id))
      const unscoped = claims.filter(d => !d.criterionId || !known.has(d.criterionId))
      if (unscoped.length) lines.push(`Note: ${unscoped.length} claim(s) not tied to any criterion.`)
    }

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
        lines.push(`- ${flat(d.prompt)}${withNote ? `: ${a.note ?? '(no note)'}` : (a.note?.trim() ? ` — note: ${a.note.trim()}` : '')}`)
        appendAttachments(lines, a, '  ')
      }
    }
    group('Rejected (drop) — treat each note as your next instruction:', rejected, true)
    group('Revise (on the right track) — apply each note:', revised, true)
    group('Approved as-is:', approved, false)
    return [...lines, ...addonSection(answers)].join('\n')
  }

  for (const d of card.decisions) {
    if (d.id === PLAN_VERDICT_ID) continue
    const a = answers[d.id]
    if (!a) continue
    lines.push(`- ${flat(d.prompt)}: ${chosenLabels(d, a)}${a.note ? ` — note: ${a.note}` : ''}`)
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
  return [...lines, ...addonSection(answers)].join('\n')
}
