import type { Block } from '../../src/shared/blocks.js'
import { PLAN_VERDICT_ID, RESULTS_VERDICT_ID, SPEC_VERDICT_ID, type Card, type Decision } from '../../src/shared/card.js'
import type { Section, SectionKind } from '../../src/shared/section.js'

export interface VisualSummary {
  totalBlocks: number
  linkedBlocks: number
}

// A decision row inside a resolved section: the decision plus its GLOBAL index
// (position in choiceDecisions, so DecisionSection numbering stays stable across
// sections) and its question-local blocks.
export interface ResolvedRow {
  decision: Decision
  index: number
  blocks: Block[]
}

// A section with its block/decision ids already looked up so CardView does no id
// resolution. `blocks` are the section's context blocks, and EXCLUDE any block linked
// to a visible decision — a linked block renders only scoped under its decision, never
// duplicated here (that would mint a duplicate #block-<id> anchor).
export interface ResolvedSection {
  id: string
  title?: string
  kind: SectionKind
  rows: ResolvedRow[]
  blocks: Block[]
}

export interface CardWorkspace {
  blockById: Map<string, Block>
  choiceDecisions: Decision[]
  globalBlocks: Block[]
  sections: ResolvedSection[]
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

  const linkedBlocksFor = (decisionId: string): Block[] => {
    const decision = choiceDecisions.find(d => d.id === decisionId)
    return (decision?.blockRefs ?? []).map(id => blockById.get(id)).filter((b): b is Block => b !== undefined)
  }

  return {
    blockById,
    choiceDecisions,
    globalBlocks,
    // visualSummary stays derived from blockRefs (NOT section placement) — it is the
    // CEO-glance cockpit stat in CardHeader and must not drift for sectioned cards.
    visualSummary: {
      totalBlocks: card.blocks.length,
      linkedBlocks: linkedBlocks.length,
    },
    sections: resolveSections(card, choiceDecisions, blockById, linkedBlockIds, globalBlocks, linkedBlocksFor),
    linkedBlocksFor,
  }
}

// Resolve card.sections into render-ready sections, or — for a legacy card with no
// sections — synthesize the exact decisions-then-global layout so CardView always
// renders ONE section loop and a legacy card stays byte-identical.
function resolveSections(
  card: Card,
  choiceDecisions: Decision[],
  blockById: Map<string, Block>,
  linkedBlockIds: Set<string>,
  globalBlocks: Block[],
  linkedBlocksFor: (decisionId: string) => Block[],
): ResolvedSection[] {
  if (!card.sections) {
    const sections: ResolvedSection[] = [{
      id: '__decisions__',
      kind: 'decide',
      rows: choiceDecisions.map((decision, index) => ({ decision, index, blocks: linkedBlocksFor(decision.id) })),
      blocks: [],
    }]
    if (globalBlocks.length) sections.push({ id: '__global__', kind: 'explain', rows: [], blocks: globalBlocks })
    return sections
  }

  const decisionById = new Map(choiceDecisions.map(d => [d.id, d]))
  const indexById = new Map(choiceDecisions.map((d, i) => [d.id, i]))
  // A section's context blocks resolve its blockRefs and DROP any linked block (it is
  // already rendered scoped under its decision) and any unknown id.
  const contextBlocks = (s: Section): Block[] =>
    (s.blockRefs ?? [])
      .map(id => blockById.get(id))
      .filter((b): b is Block => b !== undefined && !linkedBlockIds.has(b.id))

  return card.sections.map(s => {
    if (s.kind === 'decide') {
      const rows = (s.decisionRefs ?? [])
        .map(id => decisionById.get(id))
        .filter((d): d is Decision => d !== undefined)
        .map(decision => ({ decision, index: indexById.get(decision.id) ?? 0, blocks: linkedBlocksFor(decision.id) }))
      return { id: s.id, title: s.title, kind: s.kind, rows, blocks: contextBlocks(s) }
    }
    return { id: s.id, title: s.title, kind: s.kind, rows: [], blocks: contextBlocks(s) }
  })
}
