import type { Block } from '../../src/shared/blocks.js'
import { PLAN_VERDICT_ID, RESULTS_VERDICT_ID, SPEC_VERDICT_ID, type Card, type Decision } from '../../src/shared/card.js'

export interface VisualSummary {
  totalBlocks: number
  linkedBlocks: number
}

export interface CardWorkspace {
  blockById: Map<string, Block>
  choiceDecisions: Decision[]
  globalBlocks: Block[]
  visualSummary: VisualSummary
  linkedBlocksFor(decisionId: string): Block[]
}

// The synthetic verdict decisions (plan_verdict / spec_verdict / results_verdict)
// are driven by the submit bar, never rendered as a row to answer, so they are
// filtered out of the decisions the card actually shows.
function visibleDecisions(card: Card): Decision[] {
  if (card.stage === 'plan') return card.decisions.filter(d => d.id !== PLAN_VERDICT_ID)
  if (card.stage === 'spec') return card.decisions.filter(d => d.id !== SPEC_VERDICT_ID)
  if (card.stage === 'results') return card.decisions.filter(d => d.id !== RESULTS_VERDICT_ID)
  return card.decisions
}

export function prepareCardWorkspace(card: Card): CardWorkspace {
  const blockById = new Map(card.blocks.map(b => [b.id, b]))
  const choiceDecisions = visibleDecisions(card)
  const linkedBlockIds = new Set(choiceDecisions.flatMap(d => d.blockRefs ?? []))
  const linkedBlocks = card.blocks.filter(b => linkedBlockIds.has(b.id))
  const globalBlocks = card.blocks.filter(b => !linkedBlockIds.has(b.id))

  return {
    blockById,
    choiceDecisions,
    globalBlocks,
    visualSummary: {
      totalBlocks: card.blocks.length,
      linkedBlocks: linkedBlocks.length,
    },
    linkedBlocksFor(decisionId: string): Block[] {
      const decision = choiceDecisions.find(d => d.id === decisionId)
      return (decision?.blockRefs ?? []).map(id => blockById.get(id)).filter(b => b !== undefined)
    },
  }
}
