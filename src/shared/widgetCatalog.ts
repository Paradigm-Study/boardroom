import { z } from 'zod'
import { Block } from './blocks.js'

// The "dialbook": a callable registry of every widget the agent can author, with a
// one-line "what it conveys" and a neighbor-disambiguated "when to use it", plus a
// tiny valid example. Exposed as an MCP resource (boardroom://widgets/catalog) and an
// HTTP GET (/api/widgets) so any session can look up the palette before composing a card.
export interface WidgetCatalogEntry {
  type: Block['type']
  name: string
  conveys: string
  whenToUse: string
  // The INPUT type (z.input), not z.infer/output: a minimal example may omit fields that
  // carry a .default() (e.g. callout.tone) — exactly what Block.parse accepts at runtime.
  example: z.input<typeof Block>
}

// Record over the discriminator union: adding a 14th block widens Block['type'] and
// breaks this literal ("Property 'X' is missing") until an entry is added — and an
// entry for a NON-type is also a compile error. So the catalog can never drift from
// the union under `tsc`.
export type WidgetCatalog = Record<Block['type'], WidgetCatalogEntry>

export const WIDGET_CATALOG: WidgetCatalog = {
  markdown: {
    type: 'markdown', name: 'Context', conveys: 'short prose / notes',
    whenToUse: '1–2 sentences of framing; never multi-paragraph essays (they get clamped)',
    example: { id: 'ex', type: 'markdown', text: 'A one-line note.' },
  },
  graph: {
    type: 'graph', name: 'Structure', conveys: 'a node/edge relationship or flow',
    whenToUse: 'dependencies, data flow, or a small DAG; use phases for a linear sequence, mermaid for richer diagrams',
    example: { id: 'ex', type: 'graph', nodes: [{ id: 'a', label: 'Ingest' }, { id: 'b', label: 'Publish' }], edges: [{ from: 'a', to: 'b', label: 'stream' }] },
  },
  phases: {
    type: 'phases', name: 'Phases', conveys: 'a linear, ordered sequence of steps',
    whenToUse: 'a rollout or plan in stages; use graph when steps branch or merge',
    example: { id: 'ex', type: 'phases', phases: [{ title: 'Scaffold', summary: 'wire the daemon' }, { title: 'Ship' }] },
  },
  options_compare: {
    type: 'options_compare', name: 'Trade-offs', conveys: 'options weighed by pros and cons',
    whenToUse: 'a decision between 2+ approaches; mark exactly one recommended on a plan card',
    example: { id: 'ex', type: 'options_compare', options: [{ label: 'SQLite', pros: ['Zero-config'], cons: ['Single writer'], recommended: true }, { label: 'Postgres', pros: ['Concurrent'], cons: ['Ops overhead'] }] },
  },
  table: {
    type: 'table', name: 'Data', conveys: 'a grid of rows and columns',
    whenToUse: 'tabular/quantitative data; use key_facts for a few headline numbers, bar_list for ranking',
    example: { id: 'ex', type: 'table', columns: ['Region', 'Quota'], rows: [['us-east', '40'], ['eu-west', '25']] },
  },
  diff_stat: {
    type: 'diff_stat', name: 'Change footprint', conveys: 'per-file additions and deletions',
    whenToUse: 'the size/shape of a code change on a plan or results card',
    example: { id: 'ex', type: 'diff_stat', files: [{ path: 'src/store.ts', additions: 12, deletions: 3 }] },
  },
  evidence: {
    type: 'evidence', name: 'Evidence', conveys: 'collapsible command output with an exit code',
    whenToUse: 'PROOF on a results card — test/build output; not prose explaining how you implemented it',
    example: { id: 'ex', type: 'evidence', command: 'npm test', output: 'PASS 42 tests', exitCode: 0 },
  },
  mermaid: {
    type: 'mermaid', name: 'Diagram', conveys: 'a rendered mermaid diagram',
    whenToUse: 'sequence/flow/state diagrams richer than graph; renders with securityLevel strict',
    example: { id: 'ex', type: 'mermaid', source: 'graph TD; A-->B;' },
  },
  acceptance: {
    type: 'acceptance', name: 'Acceptance criteria', conveys: 'a behavior-driven contract scored met/unmet',
    whenToUse: 'the locked spec gate — each criterion has a good/bad outcome and traces to a decision',
    example: { id: 'ex', type: 'acceptance', goal: 'ship securely', criteria: [{ id: 'c1', behavior: 'tokens are secure', good: 'httpOnly cookie only', bad: 'token in localStorage', tracesTo: 'token_storage' }] },
  },
  callout: {
    type: 'callout', name: 'Callout', conveys: 'a tone-tinted aside with an optional "Explain more"',
    whenToUse: 'a short "why this matters / why this option"; put the deeper rationale in detail',
    example: { id: 'ex', type: 'callout', tone: 'warn', summary: 'Touches auth — slower rollout.', detail: 'The token-storage path changes, so we stage it behind a flag.' },
  },
  key_facts: {
    type: 'key_facts', name: 'Key facts', conveys: 'a glanceable label/value/delta scoreboard',
    whenToUse: 'a few headline numbers; use table for many rows, bar_list to rank, progress for one target',
    example: { id: 'ex', type: 'key_facts', facts: [{ label: 'Tests', value: '142', delta: '+12', tone: 'good' }] },
  },
  bar_list: {
    type: 'bar_list', name: 'Ranking', conveys: 'ranked horizontal bars (pure CSS)',
    whenToUse: 'compare magnitudes across items ("top offenders"); use progress for one value vs a target',
    example: { id: 'ex', type: 'bar_list', items: [{ label: 'auth.ts', value: 320, display: '320 ms' }, { label: 'db.ts', value: 120, display: '120 ms' }] },
  },
  progress: {
    type: 'progress', name: 'Progress', conveys: 'one value toward a target (static snapshot)',
    whenToUse: 'completion against a goal ("18/24 done"); use bar_list to compare several items',
    example: { id: 'ex', type: 'progress', label: 'Migration', value: 18, total: 24, tone: 'good' },
  },
  visual: {
    type: 'visual', name: 'Visual', conveys: 'an agent-authored static SVG/HTML figure the built-ins can\'t express',
    whenToUse: 'a bespoke wireframe, badge, gauge, or custom diagram where graph/table/bar_list don\'t fit; STATIC only, no interactivity. An svg sizes itself from its viewBox so the whole figure is always shown (aspectRatio optional); for html set height generously — the frame shows exactly that many pixels and taller content gets stuck behind an inner scrollbar',
    example: { id: 'ex', type: 'visual', format: 'svg', aspectRatio: 16 / 9, source: '<svg viewBox="0 0 160 90"><rect width="160" height="90" fill="var(--bg-2)"></rect><text x="80" y="48" text-anchor="middle" fill="var(--ink)" font-size="12">Wireframe</text></svg>' },
  },
}

export const widgetCatalogList = (): WidgetCatalogEntry[] => Object.values(WIDGET_CATALOG)

// Fail-loud at daemon boot if a sample is invalid: `tsc` proves the literal's SHAPE but
// not zod runtime refinements (min-2 options, the Criterion shape, the visual .refine
// guards). Runs once on import; a bad example bricks boot until fixed — intended.
for (const entry of Object.values(WIDGET_CATALOG)) Block.parse(entry.example)
