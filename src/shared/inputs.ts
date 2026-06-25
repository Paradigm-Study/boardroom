import { z } from 'zod'
import { Block } from './blocks.js'
import { Decision, PLAN_VERDICT_ID, SPEC_VERDICT_ID } from './card.js'
import { Criterion } from './criterion.js'

const sessionFields = {
  project: z.string().min(1).describe('Project name or working directory — shown in the inbox'),
  title: z.string().optional().describe('Short human-readable session title'),
}

function checkBlockRefs(
  input: { blocks?: Block[]; decisions?: Decision[] },
  ctx: z.RefinementCtx,
): void {
  const blockIds = new Set((input.blocks ?? []).map(b => b.id))
  ;(input.decisions ?? []).forEach((d, i) => {
    for (const ref of d.blockRefs ?? []) {
      if (!blockIds.has(ref)) {
        ctx.addIssue({
          code: 'custom',
          message: `blockRefs references unknown block "${ref}"`,
          path: ['decisions', i, 'blockRefs'],
        })
      }
    }
  })
}

function checkQuestionAndGlobalContext(
  input: { blocks?: Block[]; decisions?: Decision[] },
  ctx: z.RefinementCtx,
): void {
  const blockIds = new Set((input.blocks ?? []).map(b => b.id))
  const referenced = new Set<string>()

  ;(input.decisions ?? []).forEach((d, i) => {
    if (d.id === PLAN_VERDICT_ID) return
    if ((d.blockRefs ?? []).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'each decision must reference at least one question-local context block',
        path: ['decisions', i, 'blockRefs'],
      })
    }
    for (const ref of d.blockRefs ?? []) referenced.add(ref)
  })

  const hasGlobal = [...blockIds].some(id => !referenced.has(id))
  if (!hasGlobal) {
    ctx.addIssue({
      code: 'custom',
      message: 'card requires at least one global context block that is not referenced by any decision',
      path: ['blocks'],
    })
  }
}

export const ClarifyInput = z.object({
  ...sessionFields,
  headline: z.string().min(1).describe('One-line summary of what you need decided'),
  blocks: z.array(Block).default([]).describe('Context blocks for the card. Include at least one global block left unreferenced and at least one question-local block referenced by each decision blockRefs.'),
  decisions: z.array(Decision).min(1).describe('The questions, as button decisions'),
}).superRefine((input, ctx) => {
  checkBlockRefs(input, ctx)
  checkQuestionAndGlobalContext(input, ctx)
})
export type ClarifyInput = z.infer<typeof ClarifyInput>

const STRUCTURAL = new Set(['graph', 'phases', 'options_compare'])

export const PresentPlanInput = z.object({
  ...sessionFields,
  headline: z.string().min(1).describe('One-line summary of the plan'),
  blocks: z.array(Block).min(1).describe('Plan visuals; must include at least one graph, phases, or options_compare block, at least one unreferenced global block, and at least one question-local block referenced by each plan decision blockRefs.'),
  decisions: z.array(Decision).default([]).describe('Plan-level decisions; a final approve/revise/reject verdict is appended automatically'),
  planRef: z.string().optional().describe('Absolute path to the full plan markdown on disk, for drill-down'),
}).superRefine((input, ctx) => {
  if (!input.blocks.some(b => STRUCTURAL.has(b.type))) {
    ctx.addIssue({
      code: 'custom',
      message: 'present_plan requires at least one structural block (graph, phases, or options_compare)',
      path: ['blocks'],
    })
  }
  input.decisions.forEach((d, i) => {
    if (d.id === PLAN_VERDICT_ID) return
    if (d.options.filter(o => o.recommended).length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'each plan decision must mark exactly one recommended option',
        path: ['decisions', i, 'options'],
      })
    }
  })
  checkBlockRefs(input, ctx)
  checkQuestionAndGlobalContext(input, ctx)
})
export type PresentPlanInput = z.infer<typeof PresentPlanInput>

// The spec gate. The agent distills the locked plan decisions into behavior-driven
// criteria; the human locks or reshapes them. A thin facade by design — boardroom
// owns the GATE, not the authoring (the agent uses whatever spec skill it has).
// Criterion-id hygiene shared by the spec card (SpecInput) and the echoed contract
// at results time (SpecEcho): ids become decision ids (`crit:<id>`) and the Map key
// in the summary builder, so duplicates silently shadow one another, and a criterion
// sharing the reserved verdict id would be shadowed by the lock-verdict row. Reject
// both at whichever boundary the contract enters — so an echoed contract is held to
// the same invariants the present_spec gate enforced.
function checkCriterionIds(criteria: { id: string }[], ctx: z.RefinementCtx, path: (string | number)[]): void {
  const ids = criteria.map(c => c.id)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate criterion ids', path })
  }
  if (ids.includes(SPEC_VERDICT_ID)) {
    ctx.addIssue({ code: 'custom', message: `criterion id "${SPEC_VERDICT_ID}" is reserved for the lock verdict`, path })
  }
}

export const SpecInput = z.object({
  ...sessionFields,
  headline: z.string().min(1).describe('One-line summary of what "done and good" means here'),
  goal: z.string().min(1).describe('1–2 sentences: the overarching outcome the criteria serve'),
  criteria: z.array(Criterion).min(1).describe('Acceptance criteria — each a good outcome, a bad anti-goal, and the decision it traces to'),
  specRef: z.string().optional().describe('Absolute path to the on-disk spec file; the agent writes the locked contract here and reads it back to verify/review'),
  blocks: z.array(Block).default([]).describe('Optional extra context blocks'),
}).superRefine((input, ctx) => {
  checkCriterionIds(input.criteria, ctx, ['criteria'])
})
export type SpecInput = z.infer<typeof SpecInput>

// The locked contract the agent echoes back into review_results (stateless V1:
// the daemon keeps no copy, so the agent re-supplies it from its session spec file).
// Held to the SAME id invariants as the spec card it came from.
export const SpecEcho = z.object({
  goal: z.string().optional(),
  criteria: z.array(Criterion).min(1),
}).superRefine((input, ctx) => {
  checkCriterionIds(input.criteria, ctx, ['criteria'])
})
export type SpecEcho = z.infer<typeof SpecEcho>

export const ReviewResultsInput = z.object({
  ...sessionFields,
  headline: z.string().min(1).describe('One-line summary of what was delivered'),
  spec: SpecEcho.optional().describe('The locked acceptance contract, echoed so results can be judged criterion by criterion'),
  claims: z.array(z.object({
    id: z.string().min(1),
    claim: z.string().min(1).describe('One outcome you are claiming, e.g. "all 42 tests pass"'),
    criterionId: z.string().optional().describe('The acceptance criterion this claim satisfies (from the locked spec)'),
    evidence: z.array(Block).min(1).describe('At least one block backing this claim'),
  })).min(1),
}).superRefine((input, ctx) => {
  // Claim ids become decision ids (`claim:<id>`) and evidence-block id prefixes in
  // compileResults; duplicates would collide and silently drop a claim. Reject them
  // at the boundary, mirroring the duplicate-option-id check on Decision.
  const ids = input.claims.map(c => c.id)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate claim ids', path: ['claims'] })
  }
  // compileResults namespaces evidence blocks as `${claimId}/${blockId}`. Since
  // "/" can appear in BOTH ids, distinct (claim, evidence) pairs can alias to the
  // same compiled block id (claim "a"+"b/e" and "a/b"+"e" both -> "a/b/e"),
  // silently routing a decision's blockRef to the wrong claim's evidence. Reject
  // any input whose compiled block ids are not globally unique.
  const blockIds = input.claims.flatMap(c => c.evidence.map(b => `${c.id}/${b.id}`))
  if (new Set(blockIds).size !== blockIds.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'evidence block ids collide after claim-id namespacing — avoid "/" in claim or evidence ids',
      path: ['claims'],
    })
  }
  // When a spec is echoed, every tagged claim must point at a real criterion. A
  // criterionId with no match would otherwise silently leave that criterion UNMET
  // no matter how the claim is voted — a self-defeating typo. Fail fast at the
  // boundary (mirroring ClarifyInput's blockRefs check) so the agent self-corrects.
  // An untagged claim is allowed: a claim need not bind to the contract.
  if (input.spec) {
    const specIds = new Set(input.spec.criteria.map(c => c.id))
    input.claims.forEach((c, i) => {
      if (c.criterionId && !specIds.has(c.criterionId)) {
        ctx.addIssue({
          code: 'custom',
          message: `claim criterionId "${c.criterionId}" is not a criterion in the echoed spec`,
          path: ['claims', i, 'criterionId'],
        })
      }
    })
  }
})
export type ReviewResultsInput = z.infer<typeof ReviewResultsInput>
