import { randomUUID } from 'node:crypto'
import type { Block } from '../shared/blocks.js'
import { PLAN_VERDICT_ID, RESULTS_VERDICT_ID, SPEC_VERDICT_ID, type Card, type Decision, type DecisionOption, type PlanVerdict, type ResultsVerdict, type SpecVerdict } from '../shared/card.js'

// Verdict option lists are constrained to the shared unions so a renamed verdict
// is a compile error here AND at every consumer that compares against it.
type VerdictOption<V extends string> = Omit<DecisionOption, 'id'> & { id: V }
import type { ClarifyInput, PresentPlanInput, ReviewResultsInput, SpecInput } from '../shared/inputs.js'

const now = (): string => new Date().toISOString()

export interface CompileMeta {
  agent: string
  claudeSessionId?: string
}

function session(input: { project: string; title?: string }, agent: string): Card['session'] {
  return { agent, project: input.project, ...(input.title ? { title: input.title } : {}) }
}

// Identity for retry-dedup and decide-while-disconnected claim. A retried tool
// call (same project, stage, headline) reattaches to the existing card instead
// of spawning a duplicate. Deliberately excludes agent/title so a reconnecting
// session still matches its own earlier call. The NUL (`\0`) separator is a
// deliberate, collision-proof delimiter: it cannot appear in a project name or
// headline, so distinct triples can never collapse to the same fingerprint.
export function fingerprint(project: string, stage: Card['stage'], headline: string): string {
  return [project, stage, headline].join('\0')
}

export function compileClarify(input: ClarifyInput, meta: CompileMeta): Card {
  return {
    id: randomUUID(),
    stage: 'clarify',
    session: session(input, meta.agent),
    ...(meta.claudeSessionId ? { claudeSessionId: meta.claudeSessionId } : {}),
    headline: input.headline,
    blocks: input.blocks,
    decisions: input.decisions,
    ...(input.sections ? { sections: input.sections } : {}),
    status: 'pending',
    createdAt: now(),
    fingerprint: fingerprint(input.project, 'clarify', input.headline),
  }
}

export const PLAN_VERDICT: Decision = {
  id: PLAN_VERDICT_ID,
  prompt: 'Verdict on this plan',
  options: [
    { id: 'approve', label: 'Approve plan', recommended: true },
    { id: 'revise', label: 'Revise', detail: 'Send back with instructions' },
    { id: 'reject', label: 'Reject', detail: 'Do not proceed' },
  ] satisfies VerdictOption<PlanVerdict>[],
  noteRequiredOn: ['revise', 'reject'] satisfies PlanVerdict[],
}

export function compilePlan(input: PresentPlanInput, meta: CompileMeta): Card {
  const decisions = [...input.decisions]
  if (!decisions.some(d => d.id === PLAN_VERDICT_ID)) decisions.push(PLAN_VERDICT)
  return {
    id: randomUUID(),
    stage: 'plan',
    session: session(input, meta.agent),
    ...(meta.claudeSessionId ? { claudeSessionId: meta.claudeSessionId } : {}),
    headline: input.headline,
    blocks: input.blocks,
    decisions,
    ...(input.planRef ? { planRef: input.planRef } : {}),
    ...(input.sections ? { sections: input.sections } : {}),
    status: 'pending',
    createdAt: now(),
    fingerprint: fingerprint(input.project, 'plan', input.headline),
  }
}

// The spec gate's lock/revise verdict, appended to every spec card. The note on
// `revise` is the send-back instruction; its always-on note/attachments are also
// the card-level add-on (e.g. "add a criterion: …").
export const SPEC_VERDICT: Decision = {
  id: SPEC_VERDICT_ID,
  prompt: 'Lock this acceptance contract?',
  options: [
    { id: 'lock', label: 'Lock spec', detail: 'Freeze these criteria as the definition of done', recommended: true },
    { id: 'revise', label: 'Revise', detail: 'Send back with changes' },
  ] satisfies VerdictOption<SpecVerdict>[],
  noteRequiredOn: ['revise'] satisfies SpecVerdict[],
  blockRefs: [],
}

// The spec gate. Each criterion becomes its own acceptance block (question-local)
// plus a keep/adjust/drop decision; a global acceptance "contract" block carries
// the goal + the full list. The agent supplies criteria, not blocks — boardroom
// builds the card, mirroring how compileResults turns claims into the card.
export function compileSpec(input: SpecInput, meta: CompileMeta): Card {
  const overview: Block = {
    id: 'spec_contract',
    type: 'acceptance',
    title: 'Acceptance contract',
    goal: input.goal,
    criteria: input.criteria,
  }
  const perCriterion: Block[] = input.criteria.map(c => ({
    id: `crit/${c.id}`,
    type: 'acceptance',
    criteria: [c],
  }))
  const decisions: Decision[] = input.criteria.map(c => ({
    id: `crit:${c.id}`,
    prompt: c.behavior,
    criterionId: c.id,
    options: [
      { id: 'keep', label: 'Keep', recommended: true },
      { id: 'adjust', label: 'Adjust', detail: 'Reword via the note' },
      { id: 'drop', label: 'Drop', detail: 'Remove from the contract' },
    ],
    noteRequiredOn: ['adjust', 'drop'],
    blockRefs: [`crit/${c.id}`],
  }))
  decisions.push(SPEC_VERDICT)
  return {
    id: randomUUID(),
    stage: 'spec',
    session: session(input, meta.agent),
    ...(meta.claudeSessionId ? { claudeSessionId: meta.claudeSessionId } : {}),
    headline: input.headline,
    // Overview first (global), then any extra agent context, then the per-criterion
    // local blocks the decisions reference.
    blocks: [overview, ...input.blocks, ...perCriterion],
    decisions,
    ...(input.specRef ? { specRef: input.specRef } : {}),
    criteria: input.criteria,
    status: 'pending',
    createdAt: now(),
    fingerprint: fingerprint(input.project, 'spec', input.headline),
  }
}

// The explicit "is the session complete?" verdict appended to every results card.
// The human sets it directly — completion is NOT inferred from the per-claim
// votes — and its own note/attachments are the always-on card-level add-on (asks
// not tied to any single claim). Rendered by the submit bar like PLAN_VERDICT,
// never as an answerable claim row.
export const RESULTS_VERDICT: Decision = {
  id: RESULTS_VERDICT_ID,
  prompt: 'Is the session complete?',
  options: [
    { id: 'complete', label: 'Mark complete', detail: 'Stop here — the work is accepted' },
    { id: 'continue', label: 'Keep going', detail: 'Agent acts on the notes below, then re-submits' },
  ] satisfies VerdictOption<ResultsVerdict>[],
  // No note required: the verdict note is the optional add-on, not a gate.
  blockRefs: [],
}

export function compileResults(input: ReviewResultsInput, meta: CompileMeta): Card {
  const blocks = input.claims.flatMap(c => c.evidence.map(b => ({ ...b, id: `${c.id}/${b.id}` })))
  const decisions: Decision[] = input.claims.map(c => ({
    id: `claim:${c.id}`,
    prompt: c.claim,
    // Tie the claim to its acceptance criterion (when the agent echoed a spec) so
    // the summary can compute met/unmet and the dashboard can group by criterion.
    ...(c.criterionId ? { criterionId: c.criterionId } : {}),
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'revise', label: 'Revise', detail: 'On the right track — apply the note' },
      { id: 'reject', label: 'Reject', detail: 'Drop this — wrong direction' },
    ] satisfies VerdictOption<PlanVerdict>[],
    // Both the "revise" and "reject" notes become the agent's next instructions.
    noteRequiredOn: ['revise', 'reject'] satisfies PlanVerdict[],
    blockRefs: c.evidence.map(b => `${c.id}/${b.id}`),
  }))
  decisions.push(RESULTS_VERDICT)
  return {
    id: randomUUID(),
    stage: 'results',
    session: session(input, meta.agent),
    ...(meta.claudeSessionId ? { claudeSessionId: meta.claudeSessionId } : {}),
    headline: input.headline,
    blocks,
    decisions,
    // The echoed contract being judged (stateless V1: the agent re-supplies it).
    ...(input.spec ? { criteria: input.spec.criteria } : {}),
    status: 'pending',
    createdAt: now(),
    fingerprint: fingerprint(input.project, 'results', input.headline),
  }
}
