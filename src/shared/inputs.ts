import { z } from 'zod'
import { Block } from './blocks.js'
import { Decision, PLAN_VERDICT_ID } from './card.js'

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

export const ReviewResultsInput = z.object({
  ...sessionFields,
  headline: z.string().min(1).describe('One-line summary of what was delivered'),
  claims: z.array(z.object({
    id: z.string().min(1),
    claim: z.string().min(1).describe('One outcome you are claiming, e.g. "all 42 tests pass"'),
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
})
export type ReviewResultsInput = z.infer<typeof ReviewResultsInput>
