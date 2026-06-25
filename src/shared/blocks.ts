import { z } from 'zod'
import { Criterion } from './criterion.js'

const base = { id: z.string().min(1), title: z.string().optional() }

export const MarkdownBlock = z.object({ ...base, type: z.literal('markdown'), text: z.string().min(1) })

export const GraphBlock = z.object({
  ...base,
  type: z.literal('graph'),
  nodes: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), kind: z.string().optional() })).min(1),
  edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().optional() })),
})

export const PhasesBlock = z.object({
  ...base,
  type: z.literal('phases'),
  phases: z.array(z.object({ title: z.string().min(1), summary: z.string().optional() })).min(1),
})

export const OptionsCompareBlock = z.object({
  ...base,
  type: z.literal('options_compare'),
  options: z.array(z.object({
    label: z.string().min(1),
    pros: z.array(z.string()),
    cons: z.array(z.string()),
    recommended: z.boolean().optional(),
  })).min(2),
})

export const TableBlock = z.object({
  ...base,
  type: z.literal('table'),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(z.string())),
})

export const DiffStatBlock = z.object({
  ...base,
  type: z.literal('diff_stat'),
  files: z.array(z.object({
    path: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  })).min(1),
})

export const EvidenceBlock = z.object({
  ...base,
  type: z.literal('evidence'),
  command: z.string().optional(),
  output: z.string(),
  exitCode: z.number().int().optional(),
})

export const MermaidBlock = z.object({ ...base, type: z.literal('mermaid'), source: z.string().min(1) })

// The acceptance contract, rendered as a checklist of behavior-driven criteria
// (good ✓ / bad ✗ / trace, plus a met/unmet pill at results time). Strictly
// informational like every other block; the binding lives in the card's decisions.
export const AcceptanceBlock = z.object({
  ...base,
  type: z.literal('acceptance'),
  goal: z.string().optional(),
  criteria: z.array(Criterion).min(1),
})

export const Block = z.discriminatedUnion('type', [
  MarkdownBlock, GraphBlock, PhasesBlock, OptionsCompareBlock,
  TableBlock, DiffStatBlock, EvidenceBlock, MermaidBlock, AcceptanceBlock,
])
export type Block = z.infer<typeof Block>
