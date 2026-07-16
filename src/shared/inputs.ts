import { z } from 'zod'
import { Block } from './blocks.js'
import { CARD_ADDON_ID, Decision, PLAN_VERDICT_ID, RESULTS_VERDICT_ID, SPEC_VERDICT_ID } from './card.js'
import { Criterion } from './criterion.js'
import { Section } from './section.js'

const sessionFields = {
  project: z.string().min(1).describe('Project name or working directory — shown in the inbox'),
  title: z.string().optional().describe('Short human-readable session title'),
  sessionKey: z.string().min(1).optional().describe(
    'Your boardroom session key, injected into your context at session start ("Boardroom session key: …"). ' +
    'Pass it on EVERY boardroom call — it binds this card to your session so decisions route back to you and ' +
    'reattach/recovery works across daemon restarts. Omit only if no key was injected.',
  ),
}

// Decision ids key the answers map and block ids key blockRefs + DOM anchors: a
// duplicate silently shadows its twin — one answer covers two questions (or the
// validator demands an answer the UI can never collect, a permanently undecidable
// gate), one block renders where two were meant. Reject at the boundary, mirroring
// the criterion/claim id checks below.
function checkUniqueIds(
  input: { blocks?: Block[]; decisions?: Decision[] },
  ctx: z.RefinementCtx,
): void {
  const blockIds = (input.blocks ?? []).map(b => b.id)
  if (new Set(blockIds).size !== blockIds.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate block ids', path: ['blocks'] })
  }
  const decisionIds = (input.decisions ?? []).map(d => d.id)
  if (new Set(decisionIds).size !== decisionIds.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate decision ids', path: ['decisions'] })
  }
  // CARD_ADDON_ID keys the human's global add-on in the answers map — an
  // agent-authored decision with that id would be overwritten by the add-on
  // text at decide time (and its answer misread as the add-on).
  const addonIdx = decisionIds.indexOf(CARD_ADDON_ID)
  if (addonIdx !== -1) {
    ctx.addIssue({
      code: 'custom',
      message: `decision id "${CARD_ADDON_ID}" is reserved for the card-level add-on`,
      path: ['decisions', addonIdx, 'id'],
    })
  }
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

// Reserved for cardWorkspace's synthesized legacy sections — an agent-authored
// section using one of these ids would collide with the default layout.
const RESERVED_SECTION_IDS = new Set(['__decisions__', '__global__'])
// All verdict decision ids: a section may never place a verdict row, and the
// strict-coverage check skips them (they are appended by compile, post-validation).
const VERDICT_IDS = new Set<string>([PLAN_VERDICT_ID, SPEC_VERDICT_ID, RESULTS_VERDICT_ID])

// The mixable-sections coverage check (runs ONLY when sections is present, in place of
// checkQuestionAndGlobalContext). STRICT on decisions — every non-verdict decision must
// be placed in exactly one decide-section; LENIENT on blocks — an unplaced block simply
// does not render. Also enforces ref hygiene (refs resolve, no verdict/reserved ids).
function checkSections(
  input: { blocks?: Block[]; decisions?: Decision[]; sections?: Section[] },
  ctx: z.RefinementCtx,
): void {
  const sections = input.sections ?? []
  const blockIds = new Set((input.blocks ?? []).map(b => b.id))
  // Non-verdict decisions carry their ORIGINAL index: a pre-included verdict decision
  // (compile tolerates one) must not shift the reported issue path off the real decision.
  const nonVerdict = (input.decisions ?? []).map((d, idx) => ({ id: d.id, idx })).filter(d => !VERDICT_IDS.has(d.id))
  const decisionIds = new Set(nonVerdict.map(d => d.id))
  // Blocks referenced by a visible decision render scoped under that decision and are
  // dropped from section context (cardWorkspace), so they are exempt from the
  // at-most-one-section rule below.
  const linkedBlockIds = new Set((input.decisions ?? []).filter(d => !VERDICT_IDS.has(d.id)).flatMap(d => d.blockRefs ?? []))

  const seenSectionIds = new Set<string>()
  const blockPlacements = new Map<string, number>()   // unlinked context block id -> total section refs
  const decidePlacements = new Map<string, number>()  // decision id -> distinct decide-sections placing it

  sections.forEach((s, i) => {
    if (RESERVED_SECTION_IDS.has(s.id)) {
      ctx.addIssue({ code: 'custom', message: `section id "${s.id}" is reserved`, path: ['sections', i, 'id'] })
    }
    if (seenSectionIds.has(s.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate section id "${s.id}"`, path: ['sections', i, 'id'] })
    }
    seenSectionIds.add(s.id)

    for (const ref of s.blockRefs ?? []) {
      if (!blockIds.has(ref)) {
        ctx.addIssue({ code: 'custom', message: `section blockRefs references unknown block "${ref}"`, path: ['sections', i, 'blockRefs'] })
      } else if (!linkedBlockIds.has(ref)) {
        // A context block renders once, in at most one section. Track cross- and
        // intra-section repeats so a duplicate can't mint a duplicate #block-<id> anchor.
        blockPlacements.set(ref, (blockPlacements.get(ref) ?? 0) + 1)
      }
    }

    const decisionRefs = s.decisionRefs ?? []
    if (s.kind !== 'decide' && decisionRefs.length > 0) {
      ctx.addIssue({ code: 'custom', message: 'decisionRefs is only meaningful on a decide-section', path: ['sections', i, 'decisionRefs'] })
    }
    const seenRefs = new Set<string>()
    decisionRefs.forEach((ref, j) => {
      if (VERDICT_IDS.has(ref)) {
        ctx.addIssue({ code: 'custom', message: `section may not reference the verdict decision "${ref}"`, path: ['sections', i, 'decisionRefs', j] })
      } else if (!decisionIds.has(ref)) {
        ctx.addIssue({ code: 'custom', message: `section decisionRefs references unknown decision "${ref}"`, path: ['sections', i, 'decisionRefs', j] })
      } else if (seenRefs.has(ref)) {
        ctx.addIssue({ code: 'custom', message: `decision "${ref}" is listed more than once in this section`, path: ['sections', i, 'decisionRefs', j] })
      }
      seenRefs.add(ref)
    })
    if (s.kind === 'decide') {
      for (const ref of seenRefs) if (decisionIds.has(ref)) decidePlacements.set(ref, (decidePlacements.get(ref) ?? 0) + 1)
    }
  })

  for (const [id, count] of blockPlacements) {
    if (count > 1) {
      ctx.addIssue({ code: 'custom', message: `context block "${id}" is placed in ${count} sections (a block renders in at most one)`, path: ['sections'] })
    }
  }

  nonVerdict.forEach(({ id, idx }) => {
    const count = decidePlacements.get(id) ?? 0
    if (count !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: count === 0
          ? `decision "${id}" is not placed in any decide-section`
          : `decision "${id}" is placed in ${count} decide-sections (must be exactly one)`,
        path: ['decisions', idx],
      })
    }
  })
}

export const ClarifyInput = z.object({
  ...sessionFields,
  headline: z.string().min(1).describe('One-line summary of what you need decided'),
  blocks: z.array(Block).default([]).describe('Context blocks for the card. Include at least one global block left unreferenced and at least one question-local block referenced by each decision blockRefs.'),
  decisions: z.array(Decision).min(1).describe('The questions, as button decisions'),
  sections: z.array(Section).optional().describe('Optional mixable-sections layout — group decisions and blocks into decide/explain/report sections rendered in order. When present, every non-verdict decision must be placed in exactly one decide-section; blocks may be left unplaced.'),
}).superRefine((input, ctx) => {
  checkUniqueIds(input, ctx)
  checkBlockRefs(input, ctx)
  if (input.sections) checkSections(input, ctx)
  else checkQuestionAndGlobalContext(input, ctx)
})
export type ClarifyInput = z.infer<typeof ClarifyInput>

const STRUCTURAL = new Set(['graph', 'phases', 'options_compare'])

export const PresentPlanInput = z.object({
  ...sessionFields,
  headline: z.string().min(1).describe('One-line summary of the plan'),
  blocks: z.array(Block).min(1).describe('Plan visuals; must include at least one graph, phases, or options_compare block, at least one unreferenced global block, and at least one question-local block referenced by each plan decision blockRefs.'),
  decisions: z.array(Decision).default([]).describe('Plan-level decisions; a final approve/revise/reject verdict is appended automatically'),
  planRef: z.string().optional().describe('Absolute path to the full plan markdown on disk, for drill-down'),
  sections: z.array(Section).optional().describe('Optional mixable-sections layout — group decisions and blocks into decide/explain/report sections rendered in order. When present, every non-verdict decision must be placed in exactly one decide-section; blocks may be left unplaced.'),
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
  checkUniqueIds(input, ctx)
  checkBlockRefs(input, ctx)
  if (input.sections) checkSections(input, ctx)
  else checkQuestionAndGlobalContext(input, ctx)
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
  checkUniqueIds(input, ctx)
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

// The non-blocking report gate: convey findings/results with NO decision
// attached. No decisions, no sections in P1 — just glanceable summary blocks;
// the dashboard offers a full-size drawer for the same blocks.
export const PresentReportInput = z.object({
  ...sessionFields,
  headline: z.string().min(1).describe('One-line summary of what this report conveys'),
  blocks: z.array(Block).min(1).describe('The report content — glanceable summary blocks; the dashboard offers a full-size drawer'),
}).superRefine(checkUniqueIds)
export type PresentReportInput = z.infer<typeof PresentReportInput>
