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
  blockRefs: z.array(z.string()).optional(),
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

export const DecisionAnswer = z.object({
  chosen: z.array(z.string()).min(1),
  note: z.string().optional(),
  custom: z.string().optional(),
})
export type DecisionAnswer = z.infer<typeof DecisionAnswer>

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
  answers: z.record(z.string(), DecisionAnswer).optional(),
})
export type Card = z.infer<typeof Card>

export interface CardResponse {
  cardId: string
  decisions: Record<string, DecisionAnswer>
  summary: string
}
