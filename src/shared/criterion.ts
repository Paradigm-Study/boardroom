import { z } from 'zod'

// One behavior-driven acceptance criterion: the heart of the spec gate. Lives in
// its own module because BOTH blocks.ts (the `acceptance` block) and card.ts (a
// card's locked contract) need it, and blocks.ts ← card.ts already, so a Criterion
// defined in either would create an import cycle. This file imports nothing
// internal, so both can depend on it freely.
export const Criterion = z.object({
  id: z.string().min(1),
  behavior: z.string().min(1).describe('The observable behavior under test, e.g. "auth tokens are persisted client-side"'),
  good: z.string().min(1).describe('What a GOOD result looks like — the pass condition'),
  bad: z.string().min(1).describe('The anti-goal — the failure this criterion exists to prevent'),
  tracesTo: z.string().min(1).describe('The decision or goal this enforces (free text, or a plan decision id)'),
  check: z.string().optional().describe('Optional: how the criterion will be verified'),
  // Unset while the spec is being authored/locked; set at results time when claims
  // are scored against the contract.
  status: z.enum(['unknown', 'met', 'unmet']).optional(),
})
export type Criterion = z.infer<typeof Criterion>
