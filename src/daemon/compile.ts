import { randomUUID } from 'node:crypto'
import type { Card, Decision } from '../shared/card.js'
import type { ClarifyInput, PresentPlanInput, ReviewResultsInput } from '../shared/inputs.js'

const now = (): string => new Date().toISOString()

function session(input: { project: string; title?: string }, agent: string): Card['session'] {
  return { agent, project: input.project, ...(input.title ? { title: input.title } : {}) }
}

export function compileClarify(input: ClarifyInput, agent: string): Card {
  return {
    id: randomUUID(),
    stage: 'clarify',
    session: session(input, agent),
    headline: input.headline,
    blocks: input.blocks,
    decisions: input.decisions,
    status: 'pending',
    createdAt: now(),
  }
}

export const PLAN_VERDICT: Decision = {
  id: 'plan_verdict',
  prompt: 'Verdict on this plan',
  options: [
    { id: 'approve', label: 'Approve plan', recommended: true },
    { id: 'revise', label: 'Revise', detail: 'Send back with instructions' },
    { id: 'reject', label: 'Reject', detail: 'Do not proceed' },
  ],
  noteRequiredOn: ['revise', 'reject'],
}

export function compilePlan(input: PresentPlanInput, agent: string): Card {
  const decisions = [...input.decisions]
  if (!decisions.some(d => d.id === 'plan_verdict')) decisions.push(PLAN_VERDICT)
  return {
    id: randomUUID(),
    stage: 'plan',
    session: session(input, agent),
    headline: input.headline,
    blocks: input.blocks,
    decisions,
    ...(input.planRef ? { planRef: input.planRef } : {}),
    status: 'pending',
    createdAt: now(),
  }
}

export function compileResults(input: ReviewResultsInput, agent: string): Card {
  const blocks = input.claims.flatMap(c => c.evidence.map(b => ({ ...b, id: `${c.id}/${b.id}` })))
  const decisions: Decision[] = input.claims.map(c => ({
    id: `claim:${c.id}`,
    prompt: c.claim,
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny', detail: "Requires a note — it becomes the agent's next instruction" },
    ],
    noteRequiredOn: ['deny'],
    blockRefs: c.evidence.map(b => `${c.id}/${b.id}`),
  }))
  return {
    id: randomUUID(),
    stage: 'results',
    session: session(input, agent),
    headline: input.headline,
    blocks,
    decisions,
    status: 'pending',
    createdAt: now(),
  }
}
