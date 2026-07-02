import type { Block } from '../../src/shared/blocks.js'
import { OTHER_OPTION_ID, SPEC_VERDICT_ID, type Card, type Criterion } from '../../src/shared/card.js'

// A single agent claim mapped to a criterion, with how the human voted it.
export interface RecallClaim {
  claim: string
  vote: 'approve' | 'revise' | 'reject' | 'pending'
  evidenceRefs: string[] // block ids on the results card backing the claim
  resultsCardId: string
  decidedAt?: string
}

export interface RecallCriterion extends Omit<Criterion, 'status'> {
  // 'dropped' = the human removed it at lock time; otherwise met iff some claim
  // mapped to it was approved. (Widens the criterion's met/unmet/unknown set.)
  status: 'met' | 'unmet' | 'dropped'
  adjustedNote?: string // the human's reword note, if they chose "adjust"
  claims: RecallClaim[] // newest results-card first
}

export interface SpecRecall {
  goal?: string
  criteria: RecallCriterion[]
  metCount: number
  total: number // criteria still in the contract (dropped excluded)
  specCardId: string
}

function goalOf(card: Card): string | undefined {
  const overview = card.blocks.find((b): b is Extract<Block, { type: 'acceptance' }> => b.type === 'acceptance' && !!b.goal)
  return overview?.goal
}

// Read-model: reconstruct the locked acceptance contract for a session (project)
// and cross-reference it against every results card the agent has submitted. Pure
// over the persisted cards — no daemon round-trip — so the drawer is just a view.
// Returns undefined when the project has no decided spec card (nothing to recall).
export function buildSpecRecall(cards: Card[], project: string): SpecRecall | undefined {
  const mine = cards.filter(c => c.session.project === project)

  // Only a spec the human actually LOCKED is a contract. A decided spec whose
  // verdict was 'revise' is a send-back — recalling it would present rejected
  // criteria as the definition of done.
  const specCard = mine
    .filter(c =>
      c.stage === 'spec' && c.status === 'decided' && c.criteria && c.criteria.length > 0 &&
      c.answers?.[SPEC_VERDICT_ID]?.chosen[0] === 'lock')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!specCard?.criteria) return undefined

  // Claims are bound to THIS contract, not the project's whole history: results
  // cards carry no spec id, so bind temporally — only submissions made after the
  // recalled spec was locked can be claims against it. (Criterion ids repeat
  // across spec generations; without this, an old approval for a same-named
  // criterion would mark the new contract met.) Newest results first, so each
  // criterion's claims read latest-attempt-first.
  const lockedAt = specCard.decidedAt ?? specCard.createdAt
  const resultsCards = mine
    .filter(c => c.stage === 'results' && c.createdAt >= lockedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const criteria: RecallCriterion[] = specCard.criteria.map(c => {
    const answer = specCard.answers?.[`crit:${c.id}`]
    const chosen = answer?.chosen[0]
    if (chosen === 'drop') return { ...c, status: 'dropped', claims: [] }

    const claims: RecallClaim[] = []
    for (const rc of resultsCards) {
      for (const d of rc.decisions) {
        if (d.criterionId !== c.id) continue
        const vote = (rc.answers?.[d.id]?.chosen[0] as RecallClaim['vote']) ?? 'pending'
        claims.push({ claim: d.prompt, vote, evidenceRefs: d.blockRefs ?? [], resultsCardId: rc.id, decidedAt: rc.decidedAt })
      }
    }
    const met = claims.some(cl => cl.vote === 'approve')
    return {
      ...c,
      status: met ? 'met' : 'unmet',
      // The human's reword survives whichever path carried it: the 'adjust' note,
      // or the free-text of an "Other…" answer (which must never silently vanish).
      ...(chosen === 'adjust' && answer?.note ? { adjustedNote: answer.note } : {}),
      ...(chosen === OTHER_OPTION_ID && answer?.custom ? { adjustedNote: answer.custom } : {}),
      claims,
    }
  })

  const active = criteria.filter(c => c.status !== 'dropped')
  return {
    goal: goalOf(specCard),
    criteria,
    metCount: active.filter(c => c.status === 'met').length,
    total: active.length,
    specCardId: specCard.id,
  }
}
