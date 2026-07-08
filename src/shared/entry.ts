import { z } from 'zod'
import { Block } from './blocks.js'
import { SessionInfo } from './card.js'

export const ReportEntry = z.object({
  id: z.string().min(1),
  type: z.literal('report'),
  claudeSessionId: z.string().min(1).optional(),
  session: SessionInfo,
  headline: z.string().min(1),
  blocks: z.array(Block).min(1),
  createdAt: z.string(),
})
export type ReportEntry = z.infer<typeof ReportEntry>

export const TagEntry = z.object({
  id: z.string().min(1),
  type: z.literal('tag'),
  claudeSessionId: z.string().min(1).optional(),
  session: SessionInfo,
  tag: z.string().min(1),
  cardId: z.string().min(1),
  createdAt: z.string(),
})
export type TagEntry = z.infer<typeof TagEntry>

export const Entry = z.discriminatedUnion('type', [ReportEntry, TagEntry])
export type Entry = z.infer<typeof Entry>
