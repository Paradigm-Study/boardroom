import type { Block } from '../../src/shared/blocks.js'
import type { Card, Decision, DecisionOption } from '../../src/shared/card.js'

export interface VisualSummary {
  totalBlocks: number
  linkedBlocks: number
  backgroundBlocks: number
}

export interface CardWorkspace {
  blockById: Map<string, Block>
  choiceDecisions: Decision[]
  planVerdict?: Decision
  visualBlocks: Block[]
  globalBlocks: Block[]
  backgroundBlocks: Block[]
  recommendedByDecision: Map<string, DecisionOption>
  visualSummary: VisualSummary
  linkedBlocksFor(decisionId: string): Block[]
}

function visibleDecisions(card: Card): { choiceDecisions: Decision[]; planVerdict?: Decision } {
  if (card.stage !== 'plan') return { choiceDecisions: card.decisions }
  return {
    choiceDecisions: card.decisions.filter(d => d.id !== 'plan_verdict'),
    planVerdict: card.decisions.find(d => d.id === 'plan_verdict'),
  }
}

export function prepareCardWorkspace(card: Card): CardWorkspace {
  const blockById = new Map(card.blocks.map(b => [b.id, b]))
  const { choiceDecisions, planVerdict } = visibleDecisions(card)
  const linkedBlockIds = new Set(choiceDecisions.flatMap(d => d.blockRefs ?? []))
  const linkedBlocks = card.blocks.filter(b => linkedBlockIds.has(b.id))
  const backgroundBlocks = card.blocks.filter(b => !linkedBlockIds.has(b.id))
  const recommendedByDecision = new Map(
    choiceDecisions
      .map(d => [d.id, d.options.find(o => o.recommended)] as const)
      .filter((entry): entry is readonly [string, DecisionOption] => entry[1] !== undefined),
  )

  return {
    blockById,
    choiceDecisions,
    planVerdict,
    visualBlocks: [...linkedBlocks, ...backgroundBlocks],
    globalBlocks: backgroundBlocks,
    backgroundBlocks,
    recommendedByDecision,
    visualSummary: {
      totalBlocks: card.blocks.length,
      linkedBlocks: linkedBlocks.length,
      backgroundBlocks: backgroundBlocks.length,
    },
    linkedBlocksFor(decisionId: string): Block[] {
      const decision = choiceDecisions.find(d => d.id === decisionId)
      return (decision?.blockRefs ?? []).map(id => blockById.get(id)).filter(b => b !== undefined)
    },
  }
}
