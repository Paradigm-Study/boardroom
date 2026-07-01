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

// A tone-tinted aside with a one-line summary and an optional markdown `detail`
// rendered behind an "Explain more" disclosure — the per-question "why this".
export const CalloutBlock = z.object({
  ...base,
  type: z.literal('callout'),
  tone: z.enum(['info', 'success', 'warn', 'danger']).default('info'),
  summary: z.string().min(1),
  detail: z.string().optional(),
})

// A glanceable label/value/delta scoreboard. value/delta are pre-formatted
// strings — the daemon does no math.
export const KeyFactsBlock = z.object({
  ...base,
  type: z.literal('key_facts'),
  facts: z.array(z.object({
    label: z.string().min(1),
    value: z.string().min(1),
    delta: z.string().optional(),
    tone: z.enum(['neutral', 'good', 'bad']).optional(),
  })).min(1),
})

// Ranked horizontal bars (pure CSS, no chart lib). Bars scale to `max` (default
// = the largest value). `display` is the pre-formatted value label.
export const BarListBlock = z.object({
  ...base,
  type: z.literal('bar_list'),
  items: z.array(z.object({
    label: z.string().min(1),
    value: z.number().nonnegative(),
    display: z.string().optional(),
  })).min(1),
  max: z.number().positive().optional(),
})

// A single bar toward a target — a static snapshot, never live.
export const ProgressBlock = z.object({
  ...base,
  type: z.literal('progress'),
  label: z.string().optional(),
  value: z.number().nonnegative(),
  total: z.number().positive(),
  tone: z.enum(['neutral', 'good', 'bad']).optional(),
})

// An agent-authored STATIC visual (SVG or HTML), rendered in a sandboxed iframe on
// the dashboard — the safe form of the deliberately-skipped raw `html` widget. The
// SINGLE security boundary is that iframe's `sandbox=""` attribute (see BlockView);
// these refine() guards are DEFENSE-IN-DEPTH only — case/whitespace/entity bypassable,
// so they shrink the attack surface but are NEVER the boundary.
const MAX_VISUAL_SOURCE = 24_000
export const VisualBlock = z.object({
  ...base,
  type: z.literal('visual'),
  format: z.enum(['svg', 'html']),
  source: z.string().min(1).max(MAX_VISUAL_SOURCE)
    .refine(s => !/<script[\s>]/i.test(s), { message: 'inline <script> is not allowed in a static visual' })
    .refine(s => !/\son\w+\s*=/i.test(s), { message: 'inline event handlers (onload=, onclick=, …) are not allowed' })
    .refine(s => !/javascript:/i.test(s), { message: 'javascript: URLs are not allowed' })
    .refine(s => !/<meta\b/i.test(s), { message: '<meta> (incl. http-equiv refresh) is not allowed' })
    .refine(s => !/<base\b/i.test(s), { message: '<base> is not allowed' })
    .refine(s => !/<link\b/i.test(s), { message: '<link> is not allowed' })
    .refine(s => !/<(iframe|object|embed|applet)\b/i.test(s), { message: 'nested embedding elements are not allowed' })
    .refine(s => !/<(animate|animateTransform|animateMotion|set)\b/i.test(s), { message: 'SVG SMIL animation is not allowed (v1 is static)' })
    .refine(s => !/<!doctype|<!entity/i.test(s), { message: 'DOCTYPE / internal DTD entities are not allowed' }),
  // Height WITHOUT scripts: aspectRatio (preferred) holds the box and content fills it;
  // height is the explicit fallback. Both clamped (720 cap mitigates attention-hijack).
  aspectRatio: z.number().positive().max(20).optional(),
  height: z.number().int().min(40).max(720).optional(),
})

export const Block = z.discriminatedUnion('type', [
  MarkdownBlock, GraphBlock, PhasesBlock, OptionsCompareBlock,
  TableBlock, DiffStatBlock, EvidenceBlock, MermaidBlock, AcceptanceBlock,
  CalloutBlock, KeyFactsBlock, BarListBlock, ProgressBlock, VisualBlock,
])
export type Block = z.infer<typeof Block>
