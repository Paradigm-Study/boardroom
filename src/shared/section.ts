import { z } from 'zod'

// A mixable section groups EXISTING block ids and decision ids (by id — it embeds
// nothing and mints nothing) into a region of a clarify/plan card. `kind` decides how
// it renders: decide = decision rows with their question-local context; explain/report
// = a group of context blocks (report renders identically to explain for now, carried
// separately for a future report page). Coverage rules — every non-verdict decision in
// exactly one decide-section; blocks may be left unplaced — are enforced in inputs.ts
// (checkSections), NOT here, so Section stays a pure shape importable by both card.ts
// (the Card field) and inputs.ts (the refinement) without an import cycle.
export const SectionKind = z.enum(['decide', 'explain', 'report'])
export type SectionKind = z.infer<typeof SectionKind>

export const Section = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  kind: SectionKind,
  blockRefs: z.array(z.string()).optional().describe('Existing block ids to render in this section (may be empty; an unplaced block just does not render)'),
  decisionRefs: z.array(z.string()).optional().describe('Existing non-verdict decision ids placed in this section. Meaningful only for kind "decide"'),
  collapsible: z.boolean().optional(),
})
export type Section = z.infer<typeof Section>
