import { z } from 'zod'
import { Block } from './blocks.js'

export const DecisionOption = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().optional(),
  recommended: z.boolean().optional(),
})
export type DecisionOption = z.infer<typeof DecisionOption>

export const Decision = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  options: z.array(DecisionOption).min(2),
  multi: z.boolean().optional(),
  blockRefs: z.array(z.string()).optional().describe('Question-local context: ids of blocks that should appear inside this decision row. Blocks not referenced by any decision are global card context.'),
  noteRequiredOn: z.array(z.string()).optional(),
}).superRefine((d, ctx) => {
  const ids = d.options.map(o => o.id)
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'duplicate option ids', path: ['options'] })
  }
  for (const oid of d.noteRequiredOn ?? []) {
    if (!ids.includes(oid)) {
      ctx.addIssue({ code: 'custom', message: `noteRequiredOn references unknown option "${oid}"`, path: ['noteRequiredOn'] })
    }
  }
})
export type Decision = z.infer<typeof Decision>

export const SessionInfo = z.object({
  agent: z.string().min(1),
  project: z.string().min(1),
  title: z.string().optional(),
})
export type SessionInfo = z.infer<typeof SessionInfo>

export const Stage = z.enum(['clarify', 'plan', 'results'])
export type Stage = z.infer<typeof Stage>

export const CardStatus = z.enum(['pending', 'decided', 'orphaned'])
export type CardStatus = z.infer<typeof CardStatus>

export const OTHER_OPTION_ID = '__other__'

// The synthetic decision id for a plan's approve/revise/reject verdict. Shared so
// the daemon (compile/queue/summary), the schema refinements, and the web client
// all reference one symbol instead of re-typing the literal in ~8 places.
export const PLAN_VERDICT_ID = 'plan_verdict'

// The synthetic decision id for a results card's complete/continue verdict — the
// explicit "is the session done?" toggle the human sets directly (not inferred
// from the per-claim votes). Its `note`/`attachments` double as the always-on
// card-level add-on: anything the human wants to send the agent that isn't tied
// to a single claim. Same plumbing as PLAN_VERDICT_ID, referenced everywhere by
// this one symbol.
export const RESULTS_VERDICT_ID = 'results_verdict'

// The verdict option ids the human actually picks, as shared closed unions.
// compile.ts builds the verdict option lists from these, and every consumer
// (queue, summary, CardView, ResultsChecklist) types its comparisons against
// them — so renaming a verdict is a compile error at every read site instead of
// a silently-dead branch. Same intent as the *_VERDICT_ID constants above, one
// level down: the ids vs the values.
export const PLAN_VERDICTS = ['approve', 'revise', 'reject'] as const
export type PlanVerdict = (typeof PLAN_VERDICTS)[number]

export const RESULTS_VERDICTS = ['complete', 'continue'] as const
export type ResultsVerdict = (typeof RESULTS_VERDICTS)[number]

export const AttachmentRef = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().optional(),
  size: z.number().int().nonnegative(),
  path: z.string().min(1),
  url: z.string().optional(),
  field: z.string().optional(),
  uploadedAt: z.string(),
})
export type AttachmentRef = z.infer<typeof AttachmentRef>

export const DecisionAnswer = z.object({
  // `chosen` may be empty for a decision the human left unanswered — e.g. the
  // sub-decisions of a plan that was sent back ("revise"). The "you must pick
  // something" rule is contextual and enforced in Queue.validateAnswers, not here,
  // so the persisted/wire shape must allow the empty case; otherwise a stored
  // send-back card fails Card.parse on the next read and 500s the whole inbox.
  chosen: z.array(z.string()),
  note: z.string().optional(),
  custom: z.string().optional(),
  attachments: z.array(AttachmentRef).optional(),
})
export type DecisionAnswer = z.infer<typeof DecisionAnswer>

// The decide-endpoint request payload: a map of decision id -> answer. Validated
// at the HTTP boundary so malformed input becomes a clean 400, never a junk row.
export const DecisionAnswers = z.record(z.string(), DecisionAnswer)
export type DecisionAnswers = z.infer<typeof DecisionAnswers>

export const Card = z.object({
  id: z.string().min(1),
  stage: Stage,
  session: SessionInfo,
  headline: z.string().min(1),
  blocks: z.array(Block),
  decisions: z.array(Decision).min(1),
  planRef: z.string().optional(),
  status: CardStatus,
  createdAt: z.string(),
  decidedAt: z.string().optional(),
  deliveredAt: z.string().optional(),
  // When the card last entered the `orphaned` state (disconnect/park/boot-recovery).
  // The reattach window is measured from THIS, not createdAt, so a long-lived card
  // re-orphaned on boot stays reattachable. Optional → legacy rows fall back to
  // createdAt and behave exactly as before.
  orphanedAt: z.string().optional(),
  fingerprint: z.string().optional(),
  answers: z.record(z.string(), DecisionAnswer).optional(),
})
export type Card = z.infer<typeof Card>

export interface CardResponse {
  cardId: string
  decisions: Record<string, DecisionAnswer>
  summary: string
}

// The decide HTTP endpoint's response, shared so the daemon (Queue.decide) and the
// web client (decideCard) agree on one shape the type checker enforces on both sides.
export interface DecideResponse {
  card: Card
  summary: string
  delivered: boolean
}
