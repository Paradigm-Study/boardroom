# Boardroom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local daemon + dashboard that turns agent plans/questions/results into visual decision cards a human approves with buttons, returning structured decisions to the hanging MCP tool call.

**Architecture:** One TypeScript daemon (Express, bound to 127.0.0.1:4040) exposes three MCP tools over streamable HTTP (`clarify`, `present_plan`, `review_results`), all compiling to one Card model (visual blocks + decision buttons) persisted in SQLite. Tool calls hang until a human decides in the React dashboard (served by the daemon, live via SSE); caller disconnects orphan cards; macOS notifications nag while anything is pending.

**Tech Stack:** Node ≥20, TypeScript, `@modelcontextprotocol/server`+`node`+`client` (MCP SDK v2), Zod, Express 4, better-sqlite3, node-notifier, Vite + React, @xyflow/react + dagre (graphs), mermaid, react-markdown, vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-06-11-boardroom-design.md` — read it first. Non-negotiable invariants: hang is unbounded (no server-side timeout, ever); block interactions are never binding; daemon binds `127.0.0.1` only; orphaned cards remain answerable offline (copyable summary, never a fake resolve).

**Working directory for ALL commands:** the repo root `boardroom/` (where this plan's `docs/` lives).

**SDK API note (verified against MCP TS SDK v2 docs, 2026-06):** packages are `@modelcontextprotocol/server` (`McpServer`), `@modelcontextprotocol/node` (`NodeStreamableHTTPServerTransport`), `@modelcontextprotocol/client` (`Client`, `StreamableHTTPClientTransport`). `registerTool(name, { description, inputSchema: z.object(...) }, async (args, ctx) => result)`. Progress notifications: `ctx.mcpReq._meta?.progressToken` + `await ctx.mcpReq.notify({ method: 'notifications/progress', params: {...} })`. If any option/property name differs in the installed version, check the `.d.ts` files in `node_modules/@modelcontextprotocol/*/dist/` and adapt — do not guess.

---

## File map

```
boardroom/
  package.json  tsconfig.json  vitest.config.ts  .gitignore
  src/shared/blocks.ts        # Zod schemas: 8 block types + Block union
  src/shared/card.ts          # Decision, SessionInfo, Card, CardResponse, DecisionAnswer
  src/shared/inputs.ts        # per-stage tool input schemas (the agent-facing contract)
  src/daemon/config.ts        # ~/.config/boardroom/config.json loader
  src/daemon/compile.ts       # stage input → Card (auto plan verdict, claims → decisions)
  src/daemon/summary.ts       # CardResponse.summary builder (denied-claims-first)
  src/daemon/store.ts         # SQLite persistence, boot orphaning
  src/daemon/queue.ts         # pending waiters, decide/orphan/offlineAnswer, events
  src/daemon/api.ts           # REST + SSE router for the dashboard
  src/daemon/mcp.ts           # MCP router: 3 tools, keep-alive, disconnect→orphan
  src/daemon/notify.ts        # macOS notifications + reminder loop
  src/daemon/app.ts           # createDaemon(config) factory (testable)
  src/daemon/index.ts         # entry: createDaemon + listen 127.0.0.1 + notifications
  src/daemon/seed.ts          # demo MCP client filling the queue (npm run seed)
  web/index.html  web/vite.config.ts
  web/src/main.tsx  web/src/App.tsx  web/src/api.ts  web/src/helpers.ts
  web/src/Inbox.tsx  web/src/CardView.tsx  web/src/DecisionRail.tsx
  web/src/blocks/BlockView.tsx   # all 8 block renderers
  tests/integration.test.ts   # real MCP client end-to-end
  docs/agent-snippet.md       # CLAUDE.md fragment users paste into their projects
  README.md
```

Unit tests are colocated: `src/shared/blocks.test.ts` next to `src/shared/blocks.ts`, etc.

---

### Task 1: Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`

- [ ] **Step 1: Init package and install dependencies**

```bash
npm init -y
npm pkg set type=module name=boardroom version=0.1.0 private=true
npm pkg set scripts.dev="tsx src/daemon/index.ts" scripts.dev:web="vite web" scripts.build:web="vite build web" scripts.seed="tsx src/daemon/seed.ts" scripts.test="vitest run" scripts.typecheck="tsc --noEmit"
npm i @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/client zod express better-sqlite3 node-notifier react react-dom react-markdown @xyflow/react dagre mermaid
npm i -D typescript tsx vitest supertest vite @vitejs/plugin-react @types/express @types/node @types/supertest @types/better-sqlite3 @types/dagre @types/react @types/react-dom @testing-library/react jsdom
```

If npm reports a peer-dependency conflict between the MCP SDK and zod, install the zod major the SDK declares (check `npm info @modelcontextprotocol/server peerDependencies`) and re-run.

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "web/src", "tests"]
}
```

Note: `module: NodeNext` requires `.js` extensions on relative imports in `src/` (e.g. `import { Block } from './blocks.js'`). Vite ignores this for `web/`, but use `.js` extensions everywhere for consistency.

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'web/src/**/*.test.ts', 'web/src/**/*.test.tsx', 'tests/**/*.test.ts'],
    environmentMatchGlobs: [['web/src/**', 'jsdom']],
    testTimeout: 15000,
  },
})
```

- [ ] **Step 4: Write `.gitignore`**

```
node_modules/
web/dist/
*.sqlite
*.sqlite-*
.DS_Store
```

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit` — Expected: exits 0 (no source files yet is fine).
Run: `node -e "require('better-sqlite3')" 2>/dev/null || node -e "import('better-sqlite3').then(()=>console.log('ok'))"` — Expected: `ok` (native module built).

```bash
git add -A && git commit -m "chore: scaffold boardroom package"
```

---

### Task 2: Shared block and card schemas

**Files:**
- Create: `src/shared/blocks.ts`, `src/shared/card.ts`
- Test: `src/shared/card.test.ts`

- [ ] **Step 1: Write the failing test**

`src/shared/card.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Block } from './blocks.js'
import { Card, Decision } from './card.js'

const markdown = { id: 'b1', type: 'markdown', text: 'hello' }

const decision = {
  id: 'd1',
  prompt: 'Token storage?',
  options: [
    { id: 'cookie', label: 'Cookie + refresh', recommended: true },
    { id: 'local', label: 'LocalStorage' },
  ],
}

const card = {
  id: 'c1',
  stage: 'clarify',
  session: { agent: 'claude-code', project: 'demo' },
  headline: 'Need a call on token storage',
  blocks: [markdown],
  decisions: [decision],
  status: 'pending',
  createdAt: '2026-06-11T00:00:00.000Z',
}

describe('Block', () => {
  it('accepts every block type', () => {
    const blocks = [
      markdown,
      { id: 'g', type: 'graph', nodes: [{ id: 'n1', label: 'web' }], edges: [{ from: 'n1', to: 'n1' }] },
      { id: 'p', type: 'phases', phases: [{ title: 'Phase 1' }] },
      { id: 'o', type: 'options_compare', options: [
        { label: 'A', pros: ['fast'], cons: [] },
        { label: 'B', pros: [], cons: ['slow'] },
      ] },
      { id: 't', type: 'table', columns: ['k'], rows: [['v']] },
      { id: 'df', type: 'diff_stat', files: [{ path: 'a.ts', additions: 1, deletions: 2 }] },
      { id: 'e', type: 'evidence', output: 'all tests pass', command: 'npm test', exitCode: 0 },
      { id: 'm', type: 'mermaid', source: 'graph TD; a-->b' },
    ]
    for (const b of blocks) expect(Block.parse(b).id).toBe(b.id)
  })

  it('rejects an unknown type with the field path', () => {
    const r = Block.safeParse({ id: 'x', type: 'gif', url: 'nope' })
    expect(r.success).toBe(false)
  })
})

describe('Decision', () => {
  it('rejects duplicate option ids', () => {
    const r = Decision.safeParse({ ...decision, options: [decision.options[0], decision.options[0]] })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].path).toEqual(['options'])
  })

  it('rejects noteRequiredOn pointing at unknown options', () => {
    const r = Decision.safeParse({ ...decision, noteRequiredOn: ['missing'] })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].path).toEqual(['noteRequiredOn'])
  })

  it('requires at least two options', () => {
    expect(Decision.safeParse({ ...decision, options: [decision.options[0]] }).success).toBe(false)
  })
})

describe('Card', () => {
  it('parses a full card and defaults nothing silently', () => {
    const parsed = Card.parse(card)
    expect(parsed.status).toBe('pending')
    expect(parsed.session.agent).toBe('claude-code')
  })

  it('rejects a card with zero decisions', () => {
    expect(Card.safeParse({ ...card, decisions: [] }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/card.test.ts`
Expected: FAIL — cannot resolve `./blocks.js` / `./card.js`.

- [ ] **Step 3: Write `src/shared/blocks.ts`**

```ts
import { z } from 'zod'

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

export const Block = z.discriminatedUnion('type', [
  MarkdownBlock, GraphBlock, PhasesBlock, OptionsCompareBlock,
  TableBlock, DiffStatBlock, EvidenceBlock, MermaidBlock,
])
export type Block = z.infer<typeof Block>
```

- [ ] **Step 4: Write `src/shared/card.ts`**

```ts
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

export const DecisionAnswer = z.object({
  chosen: z.array(z.string()).min(1),
  note: z.string().optional(),
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
```

Zod version note: `z.record(key, value)` two-argument form is zod v4. If zod v3 got installed (SDK peer range), change to `z.record(DecisionAnswer)` and `ctx.addIssue({ code: z.ZodIssueCode.custom, ... })`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/shared/card.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared && git commit -m "feat: shared block, decision, and card schemas"
```

---

### Task 3: Tool input schemas (the agent-facing contract)

**Files:**
- Create: `src/shared/inputs.ts`
- Test: `src/shared/inputs.test.ts`

- [ ] **Step 1: Write the failing test**

`src/shared/inputs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ClarifyInput, PresentPlanInput, ReviewResultsInput } from './inputs.js'

const decision = {
  id: 'd1',
  prompt: 'Approach?',
  options: [
    { id: 'a', label: 'Option A', recommended: true },
    { id: 'b', label: 'Option B' },
  ],
}

describe('ClarifyInput', () => {
  it('requires at least one decision', () => {
    const r = ClarifyInput.safeParse({ project: 'demo', headline: 'h', decisions: [] })
    expect(r.success).toBe(false)
  })

  it('rejects blockRefs pointing at unknown blocks', () => {
    const r = ClarifyInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [{ id: 'b1', type: 'markdown', text: 'x' }],
      decisions: [{ ...decision, blockRefs: ['nope'] }],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(JSON.stringify(r.error.issues[0].path)).toContain('blockRefs')
  })

  it('accepts a minimal valid input', () => {
    const r = ClarifyInput.safeParse({ project: 'demo', headline: 'h', decisions: [decision] })
    expect(r.success).toBe(true)
  })
})

describe('PresentPlanInput', () => {
  const structural = { id: 'ph', type: 'phases', phases: [{ title: 'Phase 1' }] }

  it('requires at least one structural block', () => {
    const r = PresentPlanInput.safeParse({
      project: 'demo', headline: 'h',
      blocks: [{ id: 'b1', type: 'markdown', text: 'x' }],
      decisions: [decision],
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toMatch(/structural/)
  })

  it('requires exactly one recommended option per plan decision', () => {
    const bad = { ...decision, options: decision.options.map(o => ({ ...o, recommended: true })) }
    const r = PresentPlanInput.safeParse({ project: 'demo', headline: 'h', blocks: [structural], decisions: [bad] })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toMatch(/recommended/)
  })

  it('accepts a plan with structural block and zero extra decisions', () => {
    const r = PresentPlanInput.safeParse({ project: 'demo', headline: 'h', blocks: [structural], planRef: '/tmp/plan.md' })
    expect(r.success).toBe(true)
  })
})

describe('ReviewResultsInput', () => {
  it('requires at least one evidence block per claim', () => {
    const r = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      claims: [{ id: 'c1', claim: 'tests pass', evidence: [] }],
    })
    expect(r.success).toBe(false)
  })

  it('accepts a claim with evidence', () => {
    const r = ReviewResultsInput.safeParse({
      project: 'demo', headline: 'h',
      claims: [{ id: 'c1', claim: 'tests pass', evidence: [{ id: 'e1', type: 'evidence', output: '42 passed', exitCode: 0 }] }],
    })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/inputs.test.ts`
Expected: FAIL — cannot resolve `./inputs.js`.

- [ ] **Step 3: Write `src/shared/inputs.ts`**

```ts
import { z } from 'zod'
import { Block } from './blocks.js'
import { Decision } from './card.js'

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

export const ClarifyInput = z.object({
  ...sessionFields,
  headline: z.string().min(1).describe('One-line summary of what you need decided'),
  blocks: z.array(Block).default([]).describe('Optional visuals that help the human decide'),
  decisions: z.array(Decision).min(1).describe('The questions, as button decisions'),
}).superRefine(checkBlockRefs)
export type ClarifyInput = z.infer<typeof ClarifyInput>

const STRUCTURAL = new Set(['graph', 'phases', 'options_compare'])

export const PresentPlanInput = z.object({
  ...sessionFields,
  headline: z.string().min(1).describe('One-line summary of the plan'),
  blocks: z.array(Block).min(1).describe('Plan visuals; must include at least one graph, phases, or options_compare block'),
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
    if (d.id === 'plan_verdict') return
    if (d.options.filter(o => o.recommended).length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'each plan decision must mark exactly one recommended option',
        path: ['decisions', i, 'options'],
      })
    }
  })
  checkBlockRefs(input, ctx)
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
})
export type ReviewResultsInput = z.infer<typeof ReviewResultsInput>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/inputs.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/inputs.ts src/shared/inputs.test.ts
git commit -m "feat: per-stage tool input schemas"
```

---

### Task 4: Compile — stage inputs become cards

**Files:**
- Create: `src/daemon/compile.ts`
- Test: `src/daemon/compile.test.ts`

- [ ] **Step 1: Write the failing test**

`src/daemon/compile.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Card } from '../shared/card.js'
import { compileClarify, compilePlan, compileResults, PLAN_VERDICT } from './compile.js'

const decision = {
  id: 'd1',
  prompt: 'Approach?',
  options: [
    { id: 'a', label: 'A', recommended: true },
    { id: 'b', label: 'B' },
  ],
}

describe('compileClarify', () => {
  it('builds a pending clarify card with session attribution', () => {
    const card = compileClarify(
      { project: 'demo', title: 'auth work', headline: 'h', blocks: [], decisions: [decision] },
      'claude-code',
    )
    expect(Card.parse(card).stage).toBe('clarify')
    expect(card.status).toBe('pending')
    expect(card.session).toEqual({ agent: 'claude-code', project: 'demo', title: 'auth work' })
    expect(card.id).toBeTruthy()
    expect(card.createdAt).toMatch(/^\d{4}-/)
  })
})

describe('compilePlan', () => {
  const input = {
    project: 'demo', headline: 'the plan',
    blocks: [{ id: 'ph', type: 'phases' as const, phases: [{ title: 'Phase 1' }] }],
    decisions: [decision],
    planRef: '/tmp/plan.md',
  }

  it('auto-appends the plan verdict decision', () => {
    const card = compilePlan(input, 'codex')
    const verdict = card.decisions.find(d => d.id === 'plan_verdict')
    expect(verdict).toBeDefined()
    expect(verdict!.noteRequiredOn).toEqual(['revise', 'reject'])
    expect(card.decisions).toHaveLength(2)
    expect(card.planRef).toBe('/tmp/plan.md')
  })

  it('does not duplicate a verdict the agent already included', () => {
    const card = compilePlan({ ...input, decisions: [PLAN_VERDICT] }, 'codex')
    expect(card.decisions.filter(d => d.id === 'plan_verdict')).toHaveLength(1)
  })
})

describe('compileResults', () => {
  it('turns claims into approve/deny decisions wired to prefixed evidence blocks', () => {
    const card = compileResults({
      project: 'demo', headline: 'done',
      claims: [
        { id: 'c1', claim: 'tests pass', evidence: [{ id: 'e1', type: 'evidence' as const, output: '42 passed' }] },
        { id: 'c2', claim: 'docs updated', evidence: [{ id: 'e1', type: 'markdown' as const, text: 'see README' }] },
      ],
    }, 'claude-code')

    expect(Card.parse(card).stage).toBe('results')
    expect(card.blocks.map(b => b.id)).toEqual(['c1/e1', 'c2/e1'])
    const d1 = card.decisions[0]
    expect(d1.id).toBe('claim:c1')
    expect(d1.prompt).toBe('tests pass')
    expect(d1.options.map(o => o.id)).toEqual(['approve', 'deny'])
    expect(d1.noteRequiredOn).toEqual(['deny'])
    expect(d1.blockRefs).toEqual(['c1/e1'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/compile.test.ts`
Expected: FAIL — cannot resolve `./compile.js`.

- [ ] **Step 3: Write `src/daemon/compile.ts`**

```ts
import { randomUUID } from 'node:crypto'
import type { Card, Decision } from '../shared/card.js'
import type { ClarifyInput, PresentPlanInput, ReviewResultsInput } from '../shared/inputs.js'

const now = (): string => new Date().toISOString()

function session(input: { project: string; title?: string }, agent: string): Card['session'] {
  return { agent, project: input.project, ...(input.title ? { title: input.title } : {}) }
}

export function compileClarify(input: ClarifyInput, agent: string): Card {
  return {
    id: randomUUID(),
    stage: 'clarify',
    session: session(input, agent),
    headline: input.headline,
    blocks: input.blocks,
    decisions: input.decisions,
    status: 'pending',
    createdAt: now(),
  }
}

export const PLAN_VERDICT: Decision = {
  id: 'plan_verdict',
  prompt: 'Verdict on this plan',
  options: [
    { id: 'approve', label: 'Approve plan', recommended: true },
    { id: 'revise', label: 'Revise', detail: 'Send back with instructions' },
    { id: 'reject', label: 'Reject', detail: 'Do not proceed' },
  ],
  noteRequiredOn: ['revise', 'reject'],
}

export function compilePlan(input: PresentPlanInput, agent: string): Card {
  const decisions = [...input.decisions]
  if (!decisions.some(d => d.id === 'plan_verdict')) decisions.push(PLAN_VERDICT)
  return {
    id: randomUUID(),
    stage: 'plan',
    session: session(input, agent),
    headline: input.headline,
    blocks: input.blocks,
    decisions,
    ...(input.planRef ? { planRef: input.planRef } : {}),
    status: 'pending',
    createdAt: now(),
  }
}

export function compileResults(input: ReviewResultsInput, agent: string): Card {
  const blocks = input.claims.flatMap(c => c.evidence.map(b => ({ ...b, id: `${c.id}/${b.id}` })))
  const decisions: Decision[] = input.claims.map(c => ({
    id: `claim:${c.id}`,
    prompt: c.claim,
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny', detail: 'Requires a note — it becomes the agent\'s next instruction' },
    ],
    noteRequiredOn: ['deny'],
    blockRefs: c.evidence.map(b => `${c.id}/${b.id}`),
  }))
  return {
    id: randomUUID(),
    stage: 'results',
    session: session(input, agent),
    headline: input.headline,
    blocks,
    decisions,
    status: 'pending',
    createdAt: now(),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/daemon/compile.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/compile.ts src/daemon/compile.test.ts
git commit -m "feat: compile stage inputs into cards"
```

### Task 5: Summary builder

**Files:**
- Create: `src/daemon/summary.ts`
- Test: `src/daemon/summary.test.ts`

- [ ] **Step 1: Write the failing test**

`src/daemon/summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { buildSummary } from './summary.js'

function resultsCard(): Card {
  return {
    id: 'c1', stage: 'results',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'done', blocks: [],
    decisions: [
      { id: 'claim:c1', prompt: 'tests pass', options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }], noteRequiredOn: ['deny'] },
      { id: 'claim:c2', prompt: 'docs updated', options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }], noteRequiredOn: ['deny'] },
    ],
    status: 'pending', createdAt: '2026-06-11T00:00:00.000Z',
  }
}

describe('buildSummary — results', () => {
  it('leads with denied claims and their notes', () => {
    const s = buildSummary(resultsCard(), {
      'claim:c1': { chosen: ['deny'], note: 'tests are flaky, rerun and pin the seed' },
      'claim:c2': { chosen: ['approve'] },
    })
    const lines = s.split('\n')
    expect(lines[0]).toMatch(/DENIED/)
    expect(lines[1]).toContain('tests pass')
    expect(lines[1]).toContain('rerun and pin the seed')
    expect(s.indexOf('DENIED')).toBeLessThan(s.indexOf('Approved'))
  })

  it('says all approved when nothing is denied', () => {
    const s = buildSummary(resultsCard(), {
      'claim:c1': { chosen: ['approve'] },
      'claim:c2': { chosen: ['approve'] },
    })
    expect(s).toMatch(/All claims approved/)
  })
})

describe('buildSummary — plan', () => {
  it('leads with the verdict and lists chosen options with labels', () => {
    const card: Card = {
      ...resultsCard(), stage: 'plan',
      decisions: [
        { id: 'd1', prompt: 'Storage?', options: [{ id: 'a', label: 'Cookie' }, { id: 'b', label: 'Local' }] },
        { id: 'plan_verdict', prompt: 'Verdict on this plan', options: [{ id: 'approve', label: 'Approve plan' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }] },
      ],
    }
    const s = buildSummary(card, {
      d1: { chosen: ['a'], note: 'rotate refresh tokens weekly' },
      plan_verdict: { chosen: ['approve'] },
    })
    const lines = s.split('\n')
    expect(lines[0]).toBe('Plan verdict: approve')
    expect(s).toContain('Storage?: Cookie')
    expect(s).toContain('rotate refresh tokens weekly')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/summary.test.ts`
Expected: FAIL — cannot resolve `./summary.js`.

- [ ] **Step 3: Write `src/daemon/summary.ts`**

```ts
import type { Card, DecisionAnswer } from '../shared/card.js'

export function buildSummary(card: Card, answers: Record<string, DecisionAnswer>): string {
  const lines: string[] = []

  if (card.stage === 'results') {
    const denied = card.decisions.filter(d => answers[d.id]?.chosen.includes('deny'))
    const approved = card.decisions.filter(d => answers[d.id]?.chosen.includes('approve'))
    if (denied.length > 0) {
      lines.push('DENIED claims — treat each note as your next instruction:')
      for (const d of denied) lines.push(`- ${d.prompt}: ${answers[d.id].note ?? '(no note)'}`)
    } else {
      lines.push('All claims approved.')
    }
    if (approved.length > 0) {
      lines.push('Approved claims:')
      for (const d of approved) lines.push(`- ${d.prompt}`)
    }
    return lines.join('\n')
  }

  for (const d of card.decisions) {
    if (d.id === 'plan_verdict') continue
    const a = answers[d.id]
    if (!a) continue
    const labels = d.options.filter(o => a.chosen.includes(o.id)).map(o => o.label).join(', ')
    lines.push(`- ${d.prompt}: ${labels}${a.note ? ` — note: ${a.note}` : ''}`)
  }
  if (card.stage === 'plan') {
    const v = answers['plan_verdict']
    if (v) lines.unshift(`Plan verdict: ${v.chosen[0]}${v.note ? ` — ${v.note}` : ''}`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/daemon/summary.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/summary.ts src/daemon/summary.test.ts
git commit -m "feat: decision summary builder, denied claims first"
```

---

### Task 6: Config loader and SQLite store

**Files:**
- Create: `src/daemon/config.ts`, `src/daemon/store.ts`
- Test: `src/daemon/store.test.ts`

- [ ] **Step 1: Write the failing test**

`src/daemon/store.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { loadConfig } from './config.js'
import { Store } from './store.js'

function card(id: string): Card {
  return {
    id, stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'pending', createdAt: new Date().toISOString(),
  }
}

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-'))
  store = new Store(join(dir, 'test.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Store', () => {
  it('round-trips a card', () => {
    store.insert(card('c1'))
    expect(store.get('c1')?.headline).toBe('h')
    expect(store.get('missing')).toBeUndefined()
  })

  it('lists by status, newest first', () => {
    const a = { ...card('c1'), createdAt: '2026-06-11T00:00:00.000Z' }
    const b = { ...card('c2'), createdAt: '2026-06-11T01:00:00.000Z' }
    store.insert(a)
    store.insert(b)
    store.update({ ...a, status: 'decided' })
    expect(store.list('pending').map(c => c.id)).toEqual(['c2'])
    expect(store.list().map(c => c.id)).toEqual(['c2', 'c1'])
  })

  it('orphans all pending cards on demand (boot recovery)', () => {
    store.insert(card('c1'))
    store.insert({ ...card('c2'), status: 'decided' })
    expect(store.orphanAllPending()).toBe(1)
    expect(store.get('c1')?.status).toBe('orphaned')
    expect(store.get('c2')?.status).toBe('decided')
  })
})

describe('loadConfig', () => {
  it('uses defaults when no config file exists', () => {
    const cfg = loadConfig(join(dir, 'cfgdir'))
    expect(cfg.port).toBe(4040)
    expect(cfg.remindEveryMinutes).toBe(10)
    expect(cfg.notifications).toBe(true)
    expect(cfg.dbPath).toBe(join(dir, 'cfgdir', 'boardroom.sqlite'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/store.test.ts`
Expected: FAIL — cannot resolve `./config.js` / `./store.js`.

- [ ] **Step 3: Write `src/daemon/config.ts`**

```ts
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  port: number
  remindEveryMinutes: number
  notifications: boolean
  dbPath: string
  configDir: string
}

export function loadConfig(configDir?: string): Config {
  const dir = configDir ?? process.env.BOARDROOM_CONFIG_DIR ?? join(homedir(), '.config', 'boardroom')
  mkdirSync(dir, { recursive: true })
  let file: Partial<Pick<Config, 'port' | 'remindEveryMinutes' | 'notifications'>> = {}
  const p = join(dir, 'config.json')
  if (existsSync(p)) file = JSON.parse(readFileSync(p, 'utf8'))
  return {
    port: 4040,
    remindEveryMinutes: 10,
    notifications: true,
    ...file,
    dbPath: join(dir, 'boardroom.sqlite'),
    configDir: dir,
  }
}
```

There is deliberately no `host` option — the bind address is hardwired to `127.0.0.1` in the entry point (spec §3: security predicate for no-auth).

- [ ] **Step 4: Write `src/daemon/store.ts`**

```ts
import Database from 'better-sqlite3'
import { Card, type CardStatus } from '../shared/card.js'

export class Store {
  private db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
      )
    `)
  }

  insert(card: Card): void {
    this.db.prepare('INSERT INTO cards (id, status, created_at, json) VALUES (?, ?, ?, ?)')
      .run(card.id, card.status, card.createdAt, JSON.stringify(card))
  }

  update(card: Card): void {
    this.db.prepare('UPDATE cards SET status = ?, json = ? WHERE id = ?')
      .run(card.status, JSON.stringify(card), card.id)
  }

  get(id: string): Card | undefined {
    const row = this.db.prepare('SELECT json FROM cards WHERE id = ?').get(id) as { json: string } | undefined
    return row ? Card.parse(JSON.parse(row.json)) : undefined
  }

  list(status?: CardStatus): Card[] {
    const rows = (status
      ? this.db.prepare('SELECT json FROM cards WHERE status = ? ORDER BY created_at DESC').all(status)
      : this.db.prepare('SELECT json FROM cards ORDER BY created_at DESC').all()) as { json: string }[]
    return rows.map(r => Card.parse(JSON.parse(r.json)))
  }

  orphanAllPending(): number {
    const pending = this.list('pending')
    for (const card of pending) this.update({ ...card, status: 'orphaned' })
    return pending.length
  }

  close(): void {
    this.db.close()
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/daemon/store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/daemon/config.ts src/daemon/store.ts src/daemon/store.test.ts
git commit -m "feat: config loader and sqlite card store"
```

---

### Task 7: Queue — waiters, decide, orphan, offline answer

**Files:**
- Create: `src/daemon/queue.ts`
- Test: `src/daemon/queue.test.ts`

- [ ] **Step 1: Write the failing test**

`src/daemon/queue.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../shared/card.js'
import { ConflictError, NotFoundError, Queue, ValidationError } from './queue.js'
import { Store } from './store.js'

function card(id: string): Card {
  return {
    id, stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [{
      id: 'd1', prompt: 'p', multi: false,
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      noteRequiredOn: ['b'],
    }],
    status: 'pending', createdAt: new Date().toISOString(),
  }
}

let dir: string
let store: Store
let queue: Queue

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-'))
  store = new Store(join(dir, 'test.sqlite'))
  queue = new Queue(store)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Queue.decide', () => {
  it('resolves the waiter with answers and summary, persists decided', () => {
    const resolve = vi.fn()
    queue.add(card('c1'), { resolve, reject: vi.fn() })
    const { card: updated, response } = queue.decide('c1', { d1: { chosen: ['a'] } })
    expect(updated.status).toBe('decided')
    expect(updated.answers?.d1.chosen).toEqual(['a'])
    expect(resolve).toHaveBeenCalledWith(response)
    expect(response.summary).toContain('p: A')
    expect(store.get('c1')?.status).toBe('decided')
  })

  it('rejects double-decide with ConflictError', () => {
    queue.add(card('c1'))
    queue.decide('c1', { d1: { chosen: ['a'] } })
    expect(() => queue.decide('c1', { d1: { chosen: ['a'] } })).toThrow(ConflictError)
  })

  it('throws NotFoundError for unknown cards', () => {
    expect(() => queue.decide('nope', {})).toThrow(NotFoundError)
  })

  it('validates: missing answer, unknown option, multi violation, missing required note', () => {
    queue.add(card('c1'))
    expect(() => queue.decide('c1', {})).toThrow(ValidationError)
    expect(() => queue.decide('c1', { d1: { chosen: ['zzz'] } })).toThrow(ValidationError)
    expect(() => queue.decide('c1', { d1: { chosen: ['a', 'b'] } })).toThrow(ValidationError)
    expect(() => queue.decide('c1', { d1: { chosen: ['b'] } })).toThrow(/requires a note/)
  })
})

describe('Queue.orphan', () => {
  it('rejects the waiter and flips status; decide on orphaned conflicts', () => {
    const reject = vi.fn()
    queue.add(card('c1'), { resolve: vi.fn(), reject })
    queue.orphan('c1')
    expect(reject).toHaveBeenCalled()
    expect(store.get('c1')?.status).toBe('orphaned')
    expect(() => queue.decide('c1', { d1: { chosen: ['a'] } })).toThrow(ConflictError)
  })

  it('is a no-op on already-decided cards', () => {
    queue.add(card('c1'))
    queue.decide('c1', { d1: { chosen: ['a'] } })
    queue.orphan('c1')
    expect(store.get('c1')?.status).toBe('decided')
  })
})

describe('Queue.offlineAnswer', () => {
  it('only works on orphaned cards and returns a copyable summary', () => {
    queue.add(card('c1'))
    expect(() => queue.offlineAnswer('c1', { d1: { chosen: ['a'] } })).toThrow(ConflictError)
    queue.orphan('c1')
    const { summary, card: updated } = queue.offlineAnswer('c1', { d1: { chosen: ['a'] } })
    expect(summary).toContain('p: A')
    expect(updated.status).toBe('orphaned')
    expect(updated.answers?.d1.chosen).toEqual(['a'])
  })
})

describe('Queue events', () => {
  it('emits card on add, decide, and orphan', () => {
    const events: string[] = []
    queue.on('card', (c: Card) => events.push(c.status))
    queue.add(card('c1'))
    queue.decide('c1', { d1: { chosen: ['a'] } })
    queue.add(card('c2'))
    queue.orphan('c2')
    expect(events).toEqual(['pending', 'decided', 'pending', 'orphaned'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/queue.test.ts`
Expected: FAIL — cannot resolve `./queue.js`.

- [ ] **Step 3: Write `src/daemon/queue.ts`**

```ts
import { EventEmitter } from 'node:events'
import type { Card, CardResponse, DecisionAnswer } from '../shared/card.js'
import type { Store } from './store.js'
import { buildSummary } from './summary.js'

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ValidationError extends Error {}

export interface Waiter {
  resolve(response: CardResponse): void
  reject(error: Error): void
}

export class Queue extends EventEmitter {
  private waiters = new Map<string, Waiter>()

  constructor(private store: Store) {
    super()
  }

  add(card: Card, waiter?: Waiter): void {
    this.store.insert(card)
    if (waiter) this.waiters.set(card.id, waiter)
    this.emit('card', card)
  }

  private getOrThrow(id: string): Card {
    const card = this.store.get(id)
    if (!card) throw new NotFoundError(`no card "${id}"`)
    return card
  }

  private validateAnswers(card: Card, answers: Record<string, DecisionAnswer>): void {
    for (const d of card.decisions) {
      const a = answers[d.id]
      if (!a || a.chosen.length === 0) throw new ValidationError(`missing answer for decision "${d.id}"`)
      for (const chosen of a.chosen) {
        if (!d.options.some(o => o.id === chosen)) {
          throw new ValidationError(`decision "${d.id}": unknown option "${chosen}"`)
        }
      }
      if (!d.multi && a.chosen.length !== 1) {
        throw new ValidationError(`decision "${d.id}" is single-choice`)
      }
      if ((d.noteRequiredOn ?? []).some(o => a.chosen.includes(o)) && !a.note?.trim()) {
        throw new ValidationError(`decision "${d.id}" requires a note for the chosen option`)
      }
    }
  }

  decide(id: string, answers: Record<string, DecisionAnswer>): { card: Card; response: CardResponse } {
    const card = this.getOrThrow(id)
    if (card.status !== 'pending') throw new ConflictError(`card is ${card.status}`)
    this.validateAnswers(card, answers)
    const summary = buildSummary(card, answers)
    const updated: Card = { ...card, status: 'decided', decidedAt: new Date().toISOString(), answers }
    this.store.update(updated)
    const response: CardResponse = { cardId: id, decisions: answers, summary }
    const waiter = this.waiters.get(id)
    this.waiters.delete(id)
    waiter?.resolve(response)
    this.emit('card', updated)
    return { card: updated, response }
  }

  orphan(id: string): void {
    const card = this.store.get(id)
    if (!card || card.status !== 'pending') return
    const updated: Card = { ...card, status: 'orphaned' }
    this.store.update(updated)
    const waiter = this.waiters.get(id)
    this.waiters.delete(id)
    waiter?.reject(new Error('caller disconnected before a decision was made'))
    this.emit('card', updated)
  }

  offlineAnswer(id: string, answers: Record<string, DecisionAnswer>): { card: Card; summary: string } {
    const card = this.getOrThrow(id)
    if (card.status !== 'orphaned') throw new ConflictError(`offline answers only apply to orphaned cards (card is ${card.status})`)
    this.validateAnswers(card, answers)
    const summary = buildSummary(card, answers)
    const updated: Card = { ...card, decidedAt: new Date().toISOString(), answers }
    this.store.update(updated)
    this.emit('card', updated)
    return { card: updated, summary }
  }

  pendingCount(): number {
    return this.store.list('pending').length
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/daemon/queue.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/queue.ts src/daemon/queue.test.ts
git commit -m "feat: queue with waiters, decide, orphan, offline answers"
```

---

### Task 8: REST + SSE API router

**Files:**
- Create: `src/daemon/api.ts`
- Test: `src/daemon/api.test.ts`

- [ ] **Step 1: Write the failing test**

`src/daemon/api.test.ts`:

```ts
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { buildApiRouter } from './api.js'
import { Queue } from './queue.js'
import { Store } from './store.js'

function card(id: string): Card {
  return {
    id, stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'h', blocks: [],
    decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'pending', createdAt: new Date().toISOString(),
  }
}

let dir: string
let store: Store
let queue: Queue
let app: express.Express

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-'))
  store = new Store(join(dir, 'test.sqlite'))
  queue = new Queue(store)
  app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use(buildApiRouter(queue, store))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/cards', () => {
  it('lists all cards, filterable by status', async () => {
    queue.add(card('c1'))
    queue.add(card('c2'))
    queue.decide('c2', { d1: { chosen: ['a'] } })
    const all = await request(app).get('/api/cards').expect(200)
    expect(all.body).toHaveLength(2)
    const pending = await request(app).get('/api/cards?status=pending').expect(200)
    expect(pending.body.map((c: Card) => c.id)).toEqual(['c1'])
  })
})

describe('GET /api/cards/:id', () => {
  it('returns the card or 404', async () => {
    queue.add(card('c1'))
    const res = await request(app).get('/api/cards/c1').expect(200)
    expect(res.body.id).toBe('c1')
    await request(app).get('/api/cards/nope').expect(404)
  })
})

describe('POST /api/cards/:id/decide', () => {
  it('decides a pending card', async () => {
    queue.add(card('c1'))
    const res = await request(app)
      .post('/api/cards/c1/decide')
      .send({ answers: { d1: { chosen: ['a'] } } })
      .expect(200)
    expect(res.body.card.status).toBe('decided')
  })

  it('maps errors: 400 validation, 404 unknown, 409 conflict', async () => {
    queue.add(card('c1'))
    await request(app).post('/api/cards/c1/decide').send({ answers: {} }).expect(400)
    await request(app).post('/api/cards/nope/decide').send({ answers: {} }).expect(404)
    queue.decide('c1', { d1: { chosen: ['a'] } })
    const res = await request(app).post('/api/cards/c1/decide').send({ answers: { d1: { chosen: ['a'] } } }).expect(409)
    expect(res.body.error).toMatch(/decided/)
  })
})

describe('POST /api/cards/:id/offline-answer', () => {
  it('returns the copyable summary for orphaned cards, 409 otherwise', async () => {
    queue.add(card('c1'))
    await request(app).post('/api/cards/c1/offline-answer').send({ answers: { d1: { chosen: ['a'] } } }).expect(409)
    queue.orphan('c1')
    const res = await request(app)
      .post('/api/cards/c1/offline-answer')
      .send({ answers: { d1: { chosen: ['a'] } } })
      .expect(200)
    expect(res.body.summary).toContain('p: A')
  })
})

describe('GET /events', () => {
  it('responds with an SSE stream', async () => {
    const res = await request(app)
      .get('/events')
      .buffer(false)
      .parse((res, done) => {
        res.on('data', () => { res.destroy(); done(null, null) })
      })
    expect(res.headers['content-type']).toContain('text/event-stream')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/daemon/api.test.ts`
Expected: FAIL — cannot resolve `./api.js`.

- [ ] **Step 3: Write `src/daemon/api.ts`**

```ts
import { Router, type Request, type Response } from 'express'
import type { Card, CardStatus, DecisionAnswer } from '../shared/card.js'
import { ConflictError, NotFoundError, Queue, ValidationError } from './queue.js'
import type { Store } from './store.js'

function sendError(res: Response, err: unknown): void {
  if (err instanceof NotFoundError) res.status(404).json({ error: err.message })
  else if (err instanceof ConflictError) res.status(409).json({ error: err.message })
  else if (err instanceof ValidationError) res.status(400).json({ error: err.message })
  else res.status(500).json({ error: String(err) })
}

function answersFrom(req: Request): Record<string, DecisionAnswer> {
  const body = req.body as { answers?: Record<string, DecisionAnswer> }
  if (!body?.answers || typeof body.answers !== 'object') throw new ValidationError('body must be { answers: {...} }')
  return body.answers
}

export function buildApiRouter(queue: Queue, store: Store): Router {
  const router = Router()

  router.get('/api/cards', (req, res) => {
    const status = req.query.status as CardStatus | undefined
    res.json(store.list(status))
  })

  router.get('/api/cards/:id', (req, res) => {
    const card = store.get(req.params.id)
    if (!card) { res.status(404).json({ error: 'not found' }); return }
    res.json(card)
  })

  router.post('/api/cards/:id/decide', (req, res) => {
    try {
      const { card } = queue.decide(req.params.id, answersFrom(req))
      res.json({ card })
    } catch (err) { sendError(res, err) }
  })

  router.post('/api/cards/:id/offline-answer', (req, res) => {
    try {
      const { card, summary } = queue.offlineAnswer(req.params.id, answersFrom(req))
      res.json({ card, summary })
    } catch (err) { sendError(res, err) }
  })

  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(':connected\n\n')
    const onCard = (card: Card): void => {
      res.write(`event: card\ndata: ${JSON.stringify(card)}\n\n`)
    }
    queue.on('card', onCard)
    const heartbeat = setInterval(() => res.write(':hb\n\n'), 25_000)
    req.on('close', () => {
      clearInterval(heartbeat)
      queue.off('card', onCard)
    })
  })

  return router
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/daemon/api.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api.ts src/daemon/api.test.ts
git commit -m "feat: REST and SSE api for the dashboard"
```

### Task 9: MCP router — three tools, keep-alive, disconnect→orphan

This task has no isolated unit test; it is covered end-to-end by Task 11's integration test. Get it compiling here, prove it there.

**Files:**
- Create: `src/daemon/mcp.ts`

- [ ] **Step 1: Confirm installed SDK surface**

Before writing code, open and skim:
- `node_modules/@modelcontextprotocol/server/dist/` type definitions for `McpServer.registerTool` and the handler context (`ctx.mcpReq`)
- `node_modules/@modelcontextprotocol/node/dist/` for `NodeStreamableHTTPServerTransport` constructor options (`sessionIdGenerator`, the session-initialized callback name) and `handleRequest` signature

The code below matches the v2 docs; adjust property names only if the installed `.d.ts` disagrees.

- [ ] **Step 2: Write `src/daemon/mcp.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { Router, type Request, type Response } from 'express'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Card, CardResponse } from '../shared/card.js'
import { ClarifyInput, PresentPlanInput, ReviewResultsInput } from '../shared/inputs.js'
import { compileClarify, compilePlan, compileResults } from './compile.js'
import type { Queue } from './queue.js'

interface RequestCtx {
  onAbort(cb: () => void): void
}

const requestCtx = new AsyncLocalStorage<RequestCtx>()

function clientName(server: McpServer): string {
  const anyServer = server as unknown as {
    server?: { getClientVersion?: () => { name?: string } | undefined }
  }
  try {
    return anyServer.server?.getClientVersion?.()?.name ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const KEEPALIVE_MS = 30_000

function buildServer(queue: Queue): McpServer {
  const server = new McpServer({ name: 'boardroom', version: '0.1.0' })

  const tools = [
    {
      name: 'clarify',
      description: 'Ask the human scoping questions as visual decision cards. Use BEFORE forming a plan whenever requirements are ambiguous. Each question is a decision with button options; attach blocks when a visual helps. The call blocks until the human answers in the boardroom dashboard — that is expected, do not time it out.',
      schema: ClarifyInput,
      compile: (input: unknown, agent: string): Card => compileClarify(ClarifyInput.parse(input), agent),
    },
    {
      name: 'present_plan',
      description: 'Present a formed plan for human approval as a visual card: structural blocks (graph/phases/options_compare) plus plan-level decisions, each with exactly one recommended option. A final approve/revise/reject verdict is appended automatically. Boardroom approval is advisory-before-the-gate: still surface your app\'s native plan approval afterwards; never auto-accept. The call blocks until the human decides.',
      schema: PresentPlanInput,
      compile: (input: unknown, agent: string): Card => compilePlan(PresentPlanInput.parse(input), agent),
    },
    {
      name: 'review_results',
      description: 'Submit your completed work for human review as claims with evidence. Each claim ("all 42 tests pass") needs at least one evidence block. The human approves or denies each claim; denial notes in the response are your next instructions. Call this before declaring work done. The call blocks until the human decides.',
      schema: ReviewResultsInput,
      compile: (input: unknown, agent: string): Card => compileResults(ReviewResultsInput.parse(input), agent),
    },
  ] as const

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (input: unknown, ctx: { mcpReq: { _meta?: { progressToken?: string | number }; notify(n: object): Promise<void> } }) => {
        const card = tool.compile(input, clientName(server))

        const progressToken = ctx.mcpReq._meta?.progressToken
        let beat = 0
        const keepalive = progressToken === undefined
          ? undefined
          : setInterval(() => {
              void ctx.mcpReq.notify({
                method: 'notifications/progress',
                params: { progressToken, progress: ++beat, message: 'Waiting for human decision in boardroom' },
              }).catch(() => {})
            }, KEEPALIVE_MS)

        try {
          const response = await new Promise<CardResponse>((resolve, reject) => {
            queue.add(card, { resolve, reject })
            requestCtx.getStore()?.onAbort(() => queue.orphan(card.id))
          })
          return {
            content: [
              { type: 'text' as const, text: response.summary },
              { type: 'text' as const, text: JSON.stringify(response) },
            ],
          }
        } finally {
          if (keepalive) clearInterval(keepalive)
        }
      },
    )
  }

  return server
}

export function buildMcpRouter(queue: Queue): Router {
  const transports = new Map<string, NodeStreamableHTTPServerTransport>()
  const router = Router()

  router.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport = sessionId ? transports.get(sessionId) : undefined

    if (!transport) {
      const fresh = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => { transports.set(id, fresh) },
      })
      fresh.onclose = () => {
        if (fresh.sessionId) transports.delete(fresh.sessionId)
      }
      const server = buildServer(queue)
      await server.connect(fresh)
      transport = fresh
    }

    const aborts: (() => void)[] = []
    res.on('close', () => {
      if (!res.writableEnded) for (const cb of aborts) cb()
    })

    await requestCtx.run({ onAbort: cb => aborts.push(cb) }, () =>
      transport.handleRequest(req, res, req.body),
    )
  })

  const sessionHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const transport = sessionId ? transports.get(sessionId) : undefined
    if (!transport) { res.status(400).json({ error: 'unknown or missing mcp-session-id' }); return }
    await transport.handleRequest(req, res)
  }
  router.get('/mcp', sessionHandler)
  router.delete('/mcp', sessionHandler)

  return router
}
```

Why each piece exists:
- **AsyncLocalStorage**: correlates a hanging tool call with the HTTP response socket it arrived on. The tool handler runs inside `transport.handleRequest(...)`, so `requestCtx.getStore()` inside the handler returns the context seeded by the express route. When the socket closes without a normal end (`res.writableEnded === false`), every card created during that request gets orphaned — that is the spec's caller-gone path (agent killed, session closed, client timeout fired).
- **Keep-alive**: progress notifications every 30s, only if the client sent a `progressToken`. Failures are swallowed — the disconnect path handles a dead connection; the keep-alive must never crash the daemon.
- **Per-session `McpServer`**: one server per MCP session so `clientName` reflects that session's `clientInfo` (agent attribution; falls back to `'unknown'` defensively).
- **`inputSchema: tool.schema` + `tool.compile` re-parse**: the SDK validates with our Zod schema (agents get exact field-path errors), and `compile` re-parses defensively so the daemon never trusts the SDK's parse alone.

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: exits 0. If `registerTool`'s handler context type or `onsessioninitialized` differ in the installed SDK, fix against the `.d.ts` — the behavior contract above stays the same.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/mcp.ts
git commit -m "feat: MCP router with hanging tools, keep-alive, disconnect orphaning"
```

---

### Task 10: Daemon factory, notifications, entry point

**Files:**
- Create: `src/daemon/app.ts`, `src/daemon/notify.ts`, `src/daemon/index.ts`

- [ ] **Step 1: Write `src/daemon/app.ts`**

```ts
import express, { type Express } from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildApiRouter } from './api.js'
import type { Config } from './config.js'
import { buildMcpRouter } from './mcp.js'
import { Queue } from './queue.js'
import { Store } from './store.js'

export interface Daemon {
  app: Express
  queue: Queue
  store: Store
  orphanedOnBoot: number
}

export function createDaemon(config: Config): Daemon {
  const store = new Store(config.dbPath)
  const orphanedOnBoot = store.orphanAllPending()
  const queue = new Queue(store)

  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use(buildMcpRouter(queue))
  app.use(buildApiRouter(queue, store))

  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  if (existsSync(webDist)) app.use(express.static(webDist))

  return { app, queue, store, orphanedOnBoot }
}
```

- [ ] **Step 2: Write `src/daemon/notify.ts`**

```ts
import notifier from 'node-notifier'
import type { Card } from '../shared/card.js'
import type { Config } from './config.js'
import type { Queue } from './queue.js'

function cardUrl(port: number, id: string): string {
  return `http://127.0.0.1:${port}/#/card/${id}`
}

export function startNotifications(queue: Queue, config: Config): void {
  if (!config.notifications) return

  const seen = new Set<string>()
  queue.on('card', (card: Card) => {
    if (card.status !== 'pending' || seen.has(card.id)) return
    seen.add(card.id)
    notifier.notify({
      title: `boardroom · ${card.stage} · ${card.session.project}`,
      message: card.headline,
      open: cardUrl(config.port, card.id),
      timeout: 10,
    })
  })

  setInterval(() => {
    const n = queue.pendingCount()
    if (n === 0) return
    notifier.notify({
      title: 'boardroom',
      message: `${n} decision${n === 1 ? '' : 's'} waiting for you`,
      open: `http://127.0.0.1:${config.port}/`,
      timeout: 10,
    })
  }, config.remindEveryMinutes * 60_000).unref()
}
```

- [ ] **Step 3: Write `src/daemon/index.ts`**

```ts
import { createDaemon } from './app.js'
import { loadConfig } from './config.js'
import { startNotifications } from './notify.js'

const config = loadConfig()
const { app, queue, orphanedOnBoot } = createDaemon(config)

app.listen(config.port, '127.0.0.1', () => {
  console.log(`boardroom daemon on http://127.0.0.1:${config.port}`)
  console.log(`  MCP endpoint: http://127.0.0.1:${config.port}/mcp`)
  if (orphanedOnBoot > 0) console.log(`  recovered ${orphanedOnBoot} pending card(s) as orphaned`)
})

startNotifications(queue, config)
```

The bind address `'127.0.0.1'` is a hard requirement (spec §3) — never make it configurable.

- [ ] **Step 4: Smoke test by hand**

Run: `npx tsc --noEmit` — Expected: exits 0.
Run: `BOARDROOM_CONFIG_DIR=/tmp/boardroom-smoke npm run dev` (leave running)
In a second shell: `curl -s http://127.0.0.1:4040/api/cards` — Expected: `[]`
Also: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4040/events --max-time 1` — Expected: `200` (times out after 1s, that's the stream staying open).
Stop the daemon (Ctrl-C).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/app.ts src/daemon/notify.ts src/daemon/index.ts
git commit -m "feat: daemon factory, notifications, 127.0.0.1 entry point"
```

---

### Task 11: Integration test — real MCP client end-to-end

**Files:**
- Test: `tests/integration.test.ts`

- [ ] **Step 1: Write the test**

`tests/integration.test.ts`:

```ts
import { Client } from '@modelcontextprotocol/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Card } from '../src/shared/card.js'
import { createDaemon, type Daemon } from '../src/daemon/app.js'

let dir: string
let daemon: Daemon
let baseUrl: string
let httpServer: ReturnType<Daemon['app']['listen']>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-int-'))
  daemon = createDaemon({
    port: 0, remindEveryMinutes: 10, notifications: false,
    dbPath: join(dir, 'int.sqlite'), configDir: dir,
  })
  await new Promise<void>(resolve => {
    httpServer = daemon.app.listen(0, '127.0.0.1', () => resolve())
  })
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => httpServer.close(() => resolve()))
  daemon.store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function connect(): Promise<Client> {
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)))
  return client
}

async function pollPendingCard(): Promise<Card> {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${baseUrl}/api/cards?status=pending`)
    const cards = (await res.json()) as Card[]
    if (cards.length > 0) return cards[0]
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('no pending card appeared')
}

describe('present_plan end-to-end', () => {
  it('hangs until the human decides, then returns the summary', async () => {
    const client = await connect()

    const pending = client.callTool({
      name: 'present_plan',
      arguments: {
        project: 'demo',
        headline: 'Auth refactor plan',
        blocks: [
          { id: 'ph', type: 'phases', phases: [{ title: 'Tokens' }, { title: 'Cutover' }] },
        ],
        decisions: [{
          id: 'storage',
          prompt: 'Token storage?',
          options: [
            { id: 'cookie', label: 'Cookie + refresh', recommended: true },
            { id: 'local', label: 'LocalStorage' },
          ],
        }],
      },
    })

    const card = await pollPendingCard()
    expect(card.stage).toBe('plan')
    expect(card.decisions.map(d => d.id)).toEqual(['storage', 'plan_verdict'])

    const decideRes = await fetch(`${baseUrl}/api/cards/${card.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: {
          storage: { chosen: ['cookie'] },
          plan_verdict: { chosen: ['approve'] },
        },
      }),
    })
    expect(decideRes.status).toBe(200)

    const result = await pending
    const text = (result.content as { type: string; text: string }[])
      .filter(c => c.type === 'text').map(c => c.text).join('\n')
    expect(text).toContain('Plan verdict: approve')
    expect(text).toContain('Token storage?: Cookie + refresh')

    await client.close()
  })

  it('rejects an invalid payload with the offending field named', async () => {
    const client = await connect()
    let message = ''
    try {
      const result = await client.callTool({
        name: 'present_plan',
        arguments: { project: 'demo', blocks: [], decisions: [] },
      })
      message = JSON.stringify(result)
    } catch (err) {
      message = String(err)
    }
    expect(message).toMatch(/headline/i)
    await client.close()
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/integration.test.ts`
Expected: PASS (2 tests). If the import of `StreamableHTTPClientTransport` fails, check the export path in `node_modules/@modelcontextprotocol/client/package.json` (it may live at a subpath export) and adjust the import.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: every test from Tasks 2–11 passes.

- [ ] **Step 4: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: end-to-end MCP client integration"
```

---

### Task 12: Dashboard scaffold — vite, hash routing, SSE, inbox

**Files:**
- Create: `web/index.html`, `web/vite.config.ts`, `web/src/main.tsx`, `web/src/api.ts`, `web/src/helpers.ts`, `web/src/App.tsx`, `web/src/Inbox.tsx`
- Test: `web/src/helpers.test.ts`

- [ ] **Step 1: Write the failing helper test**

`web/src/helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Decision } from '../../src/shared/card.js'
import { answersComplete, noteMissing, toggleChoice } from './helpers.js'

const decision: Decision = {
  id: 'd1', prompt: 'p',
  options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  noteRequiredOn: ['b'],
}
const multi: Decision = { ...decision, id: 'd2', multi: true, noteRequiredOn: [] }

describe('toggleChoice', () => {
  it('single-select replaces the choice', () => {
    expect(toggleChoice(decision, ['a'], 'b')).toEqual(['b'])
  })
  it('multi-select toggles membership', () => {
    expect(toggleChoice(multi, ['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleChoice(multi, ['a', 'b'], 'b')).toEqual(['a'])
  })
})

describe('noteMissing', () => {
  it('is true when a note-required option is chosen without a note', () => {
    expect(noteMissing(decision, { chosen: ['b'], note: '' })).toBe(true)
    expect(noteMissing(decision, { chosen: ['b'], note: 'because' })).toBe(false)
    expect(noteMissing(decision, { chosen: ['a'], note: '' })).toBe(false)
  })
})

describe('answersComplete', () => {
  it('requires every decision answered with required notes present', () => {
    expect(answersComplete([decision], {})).toBe(false)
    expect(answersComplete([decision], { d1: { chosen: ['b'], note: '' } })).toBe(false)
    expect(answersComplete([decision], { d1: { chosen: ['a'], note: '' } })).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run web/src/helpers.test.ts`
Expected: FAIL — cannot resolve `./helpers.js`.

- [ ] **Step 3: Write `web/src/helpers.ts`**

```ts
import type { Decision } from '../../src/shared/card.js'

export interface DraftAnswer {
  chosen: string[]
  note: string
}

export function toggleChoice(decision: Decision, chosen: string[], optionId: string): string[] {
  if (!decision.multi) return [optionId]
  return chosen.includes(optionId) ? chosen.filter(c => c !== optionId) : [...chosen, optionId]
}

export function noteMissing(decision: Decision, answer: DraftAnswer): boolean {
  return (decision.noteRequiredOn ?? []).some(o => answer.chosen.includes(o)) && answer.note.trim() === ''
}

export function answersComplete(decisions: Decision[], answers: Record<string, DraftAnswer>): boolean {
  return decisions.every(d => {
    const a = answers[d.id]
    return !!a && a.chosen.length > 0 && !noteMissing(d, a)
  })
}

export function toApiAnswers(answers: Record<string, DraftAnswer>): Record<string, { chosen: string[]; note?: string }> {
  return Object.fromEntries(
    Object.entries(answers).map(([id, a]) => [id, { chosen: a.chosen, ...(a.note.trim() ? { note: a.note.trim() } : {}) }]),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run web/src/helpers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the shell files**

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>boardroom</title>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
      body { margin: 0; background: light-dark(#fafaf8, #1a1a18); color: light-dark(#1a1a18, #ececea); }
      * { box-sizing: border-box; }
      button { font: inherit; cursor: pointer; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4040',
      '/events': 'http://127.0.0.1:4040',
    },
  },
})
```

`web/src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client'
import { App } from './App.js'

createRoot(document.getElementById('root')!).render(<App />)
```

`web/src/api.ts`:

```ts
import type { Card, DecisionAnswer } from '../../src/shared/card.js'

async function check<T>(res: globalThis.Response): Promise<T> {
  const body = await res.json()
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

export async function fetchCards(): Promise<Card[]> {
  return check(await fetch('/api/cards'))
}

export async function decideCard(id: string, answers: Record<string, DecisionAnswer>): Promise<Card> {
  const res = await fetch(`/api/cards/${id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  })
  return (await check<{ card: Card }>(res)).card
}

export async function offlineAnswerCard(
  id: string,
  answers: Record<string, DecisionAnswer>,
): Promise<{ card: Card; summary: string }> {
  const res = await fetch(`/api/cards/${id}/offline-answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  })
  return check(res)
}

export function subscribeCards(onCard: (card: Card) => void): () => void {
  const es = new EventSource('/events')
  es.addEventListener('card', e => onCard(JSON.parse((e as MessageEvent).data) as Card))
  return () => es.close()
}
```

`web/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { fetchCards, subscribeCards } from './api.js'
import { CardView } from './CardView.js'
import { Inbox } from './Inbox.js'

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

export function App(): JSX.Element {
  const [cards, setCards] = useState<Map<string, Card>>(new Map())
  const hash = useHashRoute()

  useEffect(() => {
    void fetchCards().then(list => setCards(new Map(list.map(c => [c.id, c]))))
    return subscribeCards(card =>
      setCards(prev => new Map(prev).set(card.id, card)),
    )
  }, [])

  const pendingCount = [...cards.values()].filter(c => c.status === 'pending').length
  useEffect(() => {
    document.title = pendingCount > 0 ? `(${pendingCount}) boardroom` : 'boardroom'
  }, [pendingCount])

  const cardMatch = hash.match(/^#\/card\/(.+)$/)
  const card = cardMatch ? cards.get(cardMatch[1]) : undefined

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 24 }}>
        <a href="#/" style={{ fontSize: 20, fontWeight: 600, textDecoration: 'none', color: 'inherit' }}>boardroom</a>
        {pendingCount > 0 && <span style={{ fontSize: 13, opacity: 0.7 }}>{pendingCount} pending</span>}
      </header>
      {card
        ? <CardView key={card.id} card={card} />
        : cardMatch
          ? <p>Card not found.</p>
          : <Inbox cards={[...cards.values()]} />}
    </div>
  )
}
```

`web/src/Inbox.tsx`:

```tsx
import type { Card } from '../../src/shared/card.js'

const STAGE_COLOR: Record<Card['stage'], string> = {
  clarify: '#7C5CBF',
  plan: '#1D9E75',
  results: '#D85A30',
}

function age(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

function Row({ card }: { card: Card }): JSX.Element {
  return (
    <a
      href={`#/card/${card.id}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
        border: '1px solid light-dark(#e3e2dd, #3a3a36)', borderRadius: 10,
        textDecoration: 'none', color: 'inherit', marginBottom: 8,
      }}
    >
      <span style={{
        fontSize: 11, fontWeight: 600, color: '#fff', background: STAGE_COLOR[card.stage],
        padding: '2px 8px', borderRadius: 6, textTransform: 'uppercase',
      }}>{card.stage}</span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontWeight: 500 }}>{card.headline}</span>
        <span style={{ fontSize: 12, opacity: 0.6 }}>
          {card.session.agent} · {card.session.project}{card.session.title ? ` · ${card.session.title}` : ''}
        </span>
      </span>
      <span style={{ fontSize: 12, opacity: 0.6 }}>{card.status !== 'pending' ? `${card.status} · ` : ''}{age(card.createdAt)}</span>
    </a>
  )
}

export function Inbox({ cards }: { cards: Card[] }): JSX.Element {
  const byNewest = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const pending = byNewest.filter(c => c.status === 'pending')
  const rest = byNewest.filter(c => c.status !== 'pending')
  return (
    <div>
      <h2 style={{ fontSize: 15, opacity: 0.7 }}>Needs you ({pending.length})</h2>
      {pending.length === 0 && <p style={{ opacity: 0.5 }}>Nothing pending. Enjoy it.</p>}
      {pending.map(c => <Row key={c.id} card={c} />)}
      <h2 style={{ fontSize: 15, opacity: 0.7, marginTop: 32 }}>History</h2>
      {rest.map(c => <Row key={c.id} card={c} />)}
    </div>
  )
}
```

- [ ] **Step 6: Verify it builds**

Run: `npx tsc --noEmit` — Expected: errors ONLY about the missing `./CardView.js` import (created in Task 14). Create a placeholder so the build is green:

`web/src/CardView.tsx` (placeholder, replaced in Task 14):

```tsx
import type { Card } from '../../src/shared/card.js'

export function CardView({ card }: { card: Card }): JSX.Element {
  return <pre>{JSON.stringify(card, null, 2)}</pre>
}
```

Run: `npx tsc --noEmit` — Expected: exits 0.
Run: `npm run build:web` — Expected: vite build succeeds, `web/dist/` created.

- [ ] **Step 7: Commit**

```bash
git add web package.json
git commit -m "feat: dashboard shell with inbox, SSE live updates, hash routing"
```

### Task 13: Block renderers — all eight types

**Files:**
- Create: `web/src/blocks/BlockView.tsx`

No unit tests here (visual components; covered by the seed command in Task 15 and the helpers already tested). Keep every renderer dumb: props in, JSX out, no state except Mermaid's async render.

- [ ] **Step 1: Write `web/src/blocks/BlockView.tsx`**

```tsx
import dagre from 'dagre'
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Block } from '../../../src/shared/blocks.js'

const cardStyle: React.CSSProperties = {
  border: '1px solid light-dark(#e3e2dd, #3a3a36)',
  borderRadius: 10,
  padding: '14px 16px',
  marginBottom: 14,
}

function Markdown({ text }: { text: string }): JSX.Element {
  return <div style={{ fontSize: 14, lineHeight: 1.6 }}><ReactMarkdown>{text}</ReactMarkdown></div>
}

function Graph({ block, onNodeClick }: {
  block: Extract<Block, { type: 'graph' }>
  onNodeClick?: () => void
}): JSX.Element {
  const { nodes, edges } = useMemo(() => {
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 70 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const n of block.nodes) g.setNode(n.id, { width: 170, height: 44 })
    for (const e of block.edges) g.setEdge(e.from, e.to)
    dagre.layout(g)
    const nodes: Node[] = block.nodes.map(n => {
      const pos = g.node(n.id)
      return {
        id: n.id,
        position: { x: pos.x - 85, y: pos.y - 22 },
        data: { label: n.label },
        style: { fontSize: 13, borderRadius: 8 },
      }
    })
    const edges: Edge[] = block.edges.map((e, i) => ({
      id: `e${i}`, source: e.from, target: e.to, label: e.label,
    }))
    return { nodes, edges }
  }, [block])

  return (
    <div style={{ height: Math.max(220, block.nodes.length * 52) }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={() => onNodeClick?.()}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
      </ReactFlow>
    </div>
  )
}

function Phases({ block }: { block: Extract<Block, { type: 'phases' }> }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap' }}>
      {block.phases.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ background: 'light-dark(#EEEDFE, #3C3489)', color: 'light-dark(#3C3489, #CECBF6)', borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{i + 1}. {p.title}</div>
            {p.summary && <div style={{ fontSize: 12, opacity: 0.8 }}>{p.summary}</div>}
          </div>
          {i < block.phases.length - 1 && <span style={{ opacity: 0.4 }}>→</span>}
        </div>
      ))}
    </div>
  )
}

function OptionsCompare({ block }: { block: Extract<Block, { type: 'options_compare' }> }): JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
      {block.options.map((o, i) => (
        <div key={i} style={{
          border: o.recommended ? '2px solid #1D9E75' : '1px solid light-dark(#e3e2dd, #3a3a36)',
          borderRadius: 10, padding: 12,
        }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>
            {o.label}{o.recommended && <span style={{ fontSize: 11, color: '#1D9E75', marginLeft: 6 }}>recommended</span>}
          </div>
          {o.pros.map((p, j) => <div key={`p${j}`} style={{ fontSize: 12 }}>+ {p}</div>)}
          {o.cons.map((c, j) => <div key={`c${j}`} style={{ fontSize: 12, opacity: 0.7 }}>− {c}</div>)}
        </div>
      ))}
    </div>
  )
}

function Table({ block }: { block: Extract<Block, { type: 'table' }> }): JSX.Element {
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
      <thead>
        <tr>{block.columns.map((c, i) => <th key={i} style={{ textAlign: 'left', padding: '4px 10px 4px 0', borderBottom: '1px solid light-dark(#e3e2dd, #3a3a36)' }}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {block.rows.map((row, i) => (
          <tr key={i}>{row.map((cell, j) => <td key={j} style={{ padding: '4px 10px 4px 0' }}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}

function DiffStat({ block }: { block: Extract<Block, { type: 'diff_stat' }> }): JSX.Element {
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
      {block.files.map((f, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, padding: '2px 0' }}>
          <span style={{ flex: 1 }}>{f.path}</span>
          <span style={{ color: '#1D9E75' }}>+{f.additions}</span>
          <span style={{ color: '#D85A30' }}>−{f.deletions}</span>
        </div>
      ))}
    </div>
  )
}

function Evidence({ block }: { block: Extract<Block, { type: 'evidence' }> }): JSX.Element {
  return (
    <details>
      <summary style={{ fontSize: 13, cursor: 'pointer' }}>
        {block.command ?? 'output'}{block.exitCode !== undefined && ` · exit ${block.exitCode}`}
      </summary>
      <pre style={{ fontSize: 12, overflowX: 'auto', background: 'light-dark(#f1efe8, #2a2a27)', padding: 10, borderRadius: 8 }}>{block.output}</pre>
    </details>
  )
}

function Mermaid({ block }: { block: Extract<Block, { type: 'mermaid' }> }): JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
        const { svg } = await mermaid.render(`m${block.id.replace(/[^a-zA-Z0-9]/g, '')}`, block.source)
        if (!cancelled) setSvg(svg)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => { cancelled = true }
  }, [block])

  if (failed) return <pre style={{ fontSize: 12 }}>{block.source}</pre>
  if (!svg) return <p style={{ fontSize: 12, opacity: 0.5 }}>rendering…</p>
  return <div dangerouslySetInnerHTML={{ __html: svg }} />
}

export function BlockView({ block, highlighted, onClick }: {
  block: Block
  highlighted?: boolean
  onClick?: () => void
}): JSX.Element {
  let body: JSX.Element
  switch (block.type) {
    case 'markdown': body = <Markdown text={block.text} />; break
    case 'graph': body = <Graph block={block} onNodeClick={onClick} />; break
    case 'phases': body = <Phases block={block} />; break
    case 'options_compare': body = <OptionsCompare block={block} />; break
    case 'table': body = <Table block={block} />; break
    case 'diff_stat': body = <DiffStat block={block} />; break
    case 'evidence': body = <Evidence block={block} />; break
    case 'mermaid': body = <Mermaid block={block} />; break
  }
  return (
    <div
      onClick={block.type === 'graph' ? undefined : onClick}
      style={{
        ...cardStyle,
        ...(highlighted ? { borderColor: '#7C5CBF', boxShadow: '0 0 0 1px #7C5CBF' } : {}),
      }}
    >
      {block.title && <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.6, marginBottom: 8 }}>{block.title}</div>}
      {body}
    </div>
  )
}
```

Block clicks call `onClick` for cross-highlighting only — they are never binding (spec §4 invariant).

- [ ] **Step 2: Verify it compiles and builds**

Run: `npx tsc --noEmit` — Expected: exits 0.
Run: `npm run build:web` — Expected: succeeds (mermaid becomes a lazy chunk).

- [ ] **Step 3: Commit**

```bash
git add web/src/blocks
git commit -m "feat: renderers for all eight block types"
```

---

### Task 14: Card view — decision rail, submit, orphaned offline answers

**Files:**
- Create: `web/src/DecisionRail.tsx`
- Modify: `web/src/CardView.tsx` (replace the Task 12 placeholder entirely)

- [ ] **Step 1: Write `web/src/DecisionRail.tsx`**

```tsx
import type { Card, Decision } from '../../src/shared/card.js'
import { noteMissing, toggleChoice, type DraftAnswer } from './helpers.js'

function DecisionBox({ decision, answer, readonly, focused, onFocus, onChange }: {
  decision: Decision
  answer: DraftAnswer
  readonly: boolean
  focused: boolean
  onFocus(): void
  onChange(a: DraftAnswer): void
}): JSX.Element {
  const needsNote = noteMissing(decision, answer)
  return (
    <div
      onClick={onFocus}
      style={{
        border: focused ? '2px solid #7C5CBF' : '1px solid light-dark(#e3e2dd, #3a3a36)',
        borderRadius: 10, padding: 12, marginBottom: 10,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{decision.prompt}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {decision.options.map(o => {
          const chosen = answer.chosen.includes(o.id)
          return (
            <button
              key={o.id}
              disabled={readonly}
              title={o.detail}
              onClick={e => {
                e.stopPropagation()
                onFocus()
                onChange({ ...answer, chosen: toggleChoice(decision, answer.chosen, o.id) })
              }}
              style={{
                border: chosen ? '2px solid #1D9E75' : '1px solid light-dark(#c9c8c2, #4a4a45)',
                background: chosen ? 'light-dark(#E1F5EE, #0F4437)' : 'transparent',
                color: 'inherit', borderRadius: 8, padding: '6px 10px', fontSize: 13,
              }}
            >
              {o.label}{o.recommended ? ' ✓rec' : ''}
            </button>
          )
        })}
      </div>
      {(answer.chosen.length > 0 || !readonly) && (
        <textarea
          placeholder={needsNote ? 'Note required for this choice…' : 'Optional note'}
          value={answer.note}
          disabled={readonly}
          onChange={e => onChange({ ...answer, note: e.target.value })}
          style={{
            width: '100%', marginTop: 8, fontSize: 13, fontFamily: 'inherit',
            borderRadius: 8, padding: 8, minHeight: 36, resize: 'vertical',
            border: needsNote ? '2px solid #D85A30' : '1px solid light-dark(#c9c8c2, #4a4a45)',
            background: 'transparent', color: 'inherit',
          }}
        />
      )}
    </div>
  )
}

export function DecisionRail({ card, answers, readonly, focusedDecision, onFocusDecision, onChange }: {
  card: Card
  answers: Record<string, DraftAnswer>
  readonly: boolean
  focusedDecision: string | null
  onFocusDecision(id: string): void
  onChange(id: string, a: DraftAnswer): void
}): JSX.Element {
  return (
    <div>
      {card.decisions.map(d => (
        <DecisionBox
          key={d.id}
          decision={d}
          answer={answers[d.id] ?? { chosen: [], note: '' }}
          readonly={readonly}
          focused={focusedDecision === d.id}
          onFocus={() => onFocusDecision(d.id)}
          onChange={a => onChange(d.id, a)}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Replace `web/src/CardView.tsx`**

```tsx
import { useMemo, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { decideCard, offlineAnswerCard } from './api.js'
import { BlockView } from './blocks/BlockView.js'
import { DecisionRail } from './DecisionRail.js'
import { answersComplete, toApiAnswers, type DraftAnswer } from './helpers.js'

export function CardView({ card }: { card: Card }): JSX.Element {
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>(() =>
    Object.fromEntries(
      card.decisions.map(d => {
        const saved = card.answers?.[d.id]
        return [d.id, { chosen: saved?.chosen ?? [], note: saved?.note ?? '' }]
      }),
    ),
  )
  const [focusedDecision, setFocusedDecision] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [offlineSummary, setOfflineSummary] = useState<string | null>(null)

  const readonly = card.status === 'decided' || (card.status === 'orphaned' && !!card.answers)
  const highlightedBlocks = useMemo(() => {
    const d = card.decisions.find(d => d.id === focusedDecision)
    return new Set(d?.blockRefs ?? [])
  }, [card, focusedDecision])

  function focusBlock(blockId: string): void {
    const linked = card.decisions.find(d => (d.blockRefs ?? []).includes(blockId))
    if (linked) setFocusedDecision(linked.id)
  }

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      if (card.status === 'pending') {
        await decideCard(card.id, toApiAnswers(answers))
      } else {
        const { summary } = await offlineAnswerCard(card.id, toApiAnswers(answers))
        setOfflineSummary(summary)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const ready = answersComplete(card.decisions, answers)

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 19, margin: '0 0 4px' }}>{card.headline}</h1>
        <div style={{ fontSize: 12, opacity: 0.6 }}>
          {card.stage} · {card.session.agent} · {card.session.project}
          {card.planRef && <> · <code>{card.planRef}</code></>}
          {card.status !== 'pending' && <strong> · {card.status}</strong>}
        </div>
        {card.status === 'orphaned' && !offlineSummary && (
          <p style={{ fontSize: 13, background: 'light-dark(#FAEEDA, #4a3a14)', padding: '8px 12px', borderRadius: 8 }}>
            The agent that asked this is gone. You can still answer — you'll get a summary to copy into the session yourself.
          </p>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 20, alignItems: 'start' }}>
        <div>
          {card.blocks.length === 0 && <p style={{ opacity: 0.5, fontSize: 13 }}>No visuals attached.</p>}
          {card.blocks.map(b => (
            <BlockView
              key={b.id}
              block={b}
              highlighted={highlightedBlocks.has(b.id)}
              onClick={() => focusBlock(b.id)}
            />
          ))}
        </div>

        <div style={{ position: 'sticky', top: 20 }}>
          <DecisionRail
            card={card}
            answers={answers}
            readonly={readonly || busy}
            focusedDecision={focusedDecision}
            onFocusDecision={setFocusedDecision}
            onChange={(id, a) => setAnswers(prev => ({ ...prev, [id]: a }))}
          />

          {!readonly && !offlineSummary && (
            <button
              disabled={!ready || busy}
              onClick={() => void submit()}
              style={{
                width: '100%', padding: '10px 0', fontSize: 14, fontWeight: 600,
                borderRadius: 10, border: 'none', color: '#fff',
                background: ready ? '#1D9E75' : 'light-dark(#c9c8c2, #4a4a45)',
              }}
            >
              {card.status === 'pending' ? 'Submit decisions' : 'Record offline answer'}
            </button>
          )}

          {error && <p style={{ color: '#D85A30', fontSize: 13 }}>{error}</p>}

          {offlineSummary && (
            <div>
              <p style={{ fontSize: 13, fontWeight: 600 }}>Copy this into the agent session:</p>
              <textarea readOnly value={offlineSummary} style={{ width: '100%', minHeight: 120, fontSize: 12, fontFamily: 'ui-monospace, monospace', borderRadius: 8, padding: 8 }} />
              <button onClick={() => void navigator.clipboard.writeText(offlineSummary)} style={{ marginTop: 6, padding: '6px 12px', borderRadius: 8 }}>
                Copy to clipboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — Expected: exits 0.
Run: `npm test` — Expected: all tests still pass.
Run: `npm run build:web` — Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src
git commit -m "feat: card view with decision rail, cross-highlighting, offline answers"
```

---

### Task 15: Seed command — live demo cards through the real pipeline

**Files:**
- Create: `src/daemon/seed.ts`

- [ ] **Step 1: Write `src/daemon/seed.ts`**

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const PORT = process.env.BOARDROOM_PORT ?? '4040'
const URL_BASE = `http://127.0.0.1:${PORT}/mcp`

async function call(name: string, args: object): Promise<void> {
  const client = new Client({ name: 'boardroom-seed', version: '0.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_BASE)))
  console.log(`[seed] ${name} card submitted — waiting for your decision in the dashboard…`)
  const result = await client.callTool({ name, arguments: args })
  const texts = (result.content as { type: string; text?: string }[])
    .filter(c => c.type === 'text').map(c => c.text).join('\n')
  console.log(`[seed] ${name} RESOLVED:\n${texts}\n`)
  await client.close()
}

const clarify = call('clarify', {
  project: 'seed-demo', title: 'demo session',
  headline: 'Two scoping questions about the export feature',
  blocks: [
    { id: 'ctx', type: 'markdown', text: 'We are adding **CSV export** to the report page. Two calls needed before planning.' },
    { id: 'cmp', type: 'options_compare', options: [
      { label: 'Stream rows', pros: ['constant memory', 'starts instantly'], cons: ['no progress bar'], recommended: true },
      { label: 'Buffer then send', pros: ['simple', 'progress bar'], cons: ['memory blows up on big reports'] },
    ] },
  ],
  decisions: [
    { id: 'strategy', prompt: 'Export strategy?', blockRefs: ['cmp'], options: [
      { id: 'stream', label: 'Stream rows', recommended: true },
      { id: 'buffer', label: 'Buffer then send' },
    ] },
    { id: 'auth', prompt: 'Who can export?', multi: true, options: [
      { id: 'admin', label: 'Admins' },
      { id: 'editor', label: 'Editors' },
      { id: 'viewer', label: 'Viewers' },
    ] },
  ],
})

const plan = call('present_plan', {
  project: 'seed-demo', title: 'demo session',
  headline: 'CSV export implementation plan',
  planRef: '/tmp/example-plan.md',
  blocks: [
    { id: 'arch', type: 'graph',
      nodes: [
        { id: 'ui', label: 'Report page' },
        { id: 'api', label: 'Export endpoint' },
        { id: 'job', label: 'Row streamer' },
        { id: 'db', label: 'Postgres' },
      ],
      edges: [
        { from: 'ui', to: 'api', label: 'GET /export' },
        { from: 'api', to: 'job' },
        { from: 'job', to: 'db', label: 'cursor' },
      ] },
    { id: 'ph', type: 'phases', phases: [
      { title: 'Endpoint + streaming', summary: 'happy path' },
      { title: 'Permissions', summary: 'role checks' },
      { title: 'Polish', summary: 'filename, BOM, tests' },
    ] },
    { id: 'risk', type: 'table', columns: ['Risk', 'Mitigation'], rows: [
      ['Huge reports', 'cursor + backpressure'],
      ['Unicode mangling', 'UTF-8 BOM'],
    ] },
  ],
  decisions: [
    { id: 'fmt', prompt: 'Date format in cells?', blockRefs: ['risk'], options: [
      { id: 'iso', label: 'ISO 8601', recommended: true },
      { id: 'locale', label: 'User locale', detail: 'pretty but ambiguous' },
    ] },
  ],
})

const results = call('review_results', {
  project: 'seed-demo', title: 'demo session',
  headline: 'CSV export shipped — review the claims',
  claims: [
    { id: 'tests', claim: 'All 18 new tests pass', evidence: [
      { id: 'run', type: 'evidence', command: 'npm test', exitCode: 0, output: 'Test Files  3 passed (3)\n     Tests  18 passed (18)' },
    ] },
    { id: 'scope', claim: 'Only export-related files were touched', evidence: [
      { id: 'diff', type: 'diff_stat', files: [
        { path: 'src/export/csv.ts', additions: 142, deletions: 0 },
        { path: 'src/routes/report.ts', additions: 18, deletions: 2 },
      ] },
    ] },
    { id: 'flow', claim: 'The streaming flow matches the approved design', evidence: [
      { id: 'seq', type: 'mermaid', source: 'sequenceDiagram\n  UI->>API: GET /export\n  API->>DB: open cursor\n  loop rows\n    DB-->>API: batch\n    API-->>UI: csv chunk\n  end' },
    ] },
  ],
})

await Promise.all([clarify, plan, results])
console.log('[seed] all three cards decided. Done.')
```

Note the second argument to `callTool` — if the installed SDK's default request timeout kills the hanging call during seeding, pass options per the SDK docs (`{ resetTimeoutOnProgress: true, maxTotalTimeout: 86_400_000 }` as the third parameter of `callTool(params, resultSchema?, options?)` — check the installed signature in the `.d.ts`).

- [ ] **Step 2: Verify the full loop by hand**

```bash
npm run build:web
BOARDROOM_CONFIG_DIR=/tmp/boardroom-smoke npm run dev   # shell 1, leave running
npm run seed                                            # shell 2
```

Open `http://127.0.0.1:4040` — Expected: three pending cards (clarify, plan, results) exercising every block type. Decide each in the dashboard; shell 2 prints each RESOLVED summary (the results one leads with any denied claims). Ctrl-C shell 2 mid-way on a rerun and watch the remaining cards flip to orphaned in the inbox — that is the disconnect→orphan path working.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/seed.ts
git commit -m "feat: seed command demos all stages through the real MCP pipeline"
```

---

### Task 16: Agent snippet, README, final verification

**Files:**
- Create: `docs/agent-snippet.md`, `README.md`

- [ ] **Step 1: Write `docs/agent-snippet.md`**

````markdown
# Boardroom protocol (paste into your project's CLAUDE.md / agent instructions)

```
## Boardroom — visual decisions

A boardroom MCP server may be connected (tools: clarify, present_plan, review_results).

- Before forming a plan, call `clarify` with your scoping questions as decision
  cards (button options + visual blocks). Prefer it over asking in chat.
- When you have a plan, call `present_plan`: structural blocks (graph / phases /
  options_compare), each decision with exactly one recommended option. After
  boardroom approval, STILL surface the app's native plan approval — boardroom
  is advisory-before-the-gate. Never auto-accept anything on the human's behalf.
- Before declaring work done, call `review_results` with claim-by-claim evidence.
  Denied claims come back with notes — treat each note as your next instruction.
- These calls block until the human decides. That is intended. Do not treat a
  long wait as an error.
- If a boardroom tool call fails because the server is unreachable, fall back to
  asking the same questions natively in chat. Do not retry in a loop.
```
````

- [ ] **Step 2: Write `README.md`**

````markdown
# boardroom

A visual decision layer between coding agents and you. Agents send questions,
plans, and results to a local daemon over MCP; you decide with buttons on a
dashboard; your decisions return as the tool result. Spec:
`docs/superpowers/specs/2026-06-11-boardroom-design.md`.

## Run

```bash
npm install
npm run build:web
npm run dev          # daemon + dashboard on http://127.0.0.1:4040
```

## Connect an agent

```bash
claude mcp add --transport http boardroom http://127.0.0.1:4040/mcp
```

Tool calls hang until you decide — disable the client's MCP tool timeout.
For Claude Code, set in your environment or `.claude/settings.json` `env`:

```json
{ "env": { "MCP_TOOL_TIMEOUT": "86400000", "MCP_TIMEOUT": "30000" } }
```

Then paste `docs/agent-snippet.md` into the project's CLAUDE.md.

## Try it without an agent

```bash
npm run seed   # three demo cards through the real MCP pipeline
```

## Dev

```bash
npm test           # unit + integration
npm run dev:web    # vite dev server with proxy to the daemon
npm run typecheck
```

Config: `~/.config/boardroom/config.json` — `port` (4040),
`remindEveryMinutes` (10), `notifications` (true). The daemon only ever
binds 127.0.0.1.
````

- [ ] **Step 3: Final verification — the whole suite, typecheck, build**

```bash
npm test && npx tsc --noEmit && npm run build:web
```

Expected: all green. Then repeat the Task 15 manual loop once more (daemon + seed + decide all three cards) as the final acceptance check: this exercises hang→decide→resolve, every block type, notifications (a macOS notification should appear per card), and the inbox/history flow.

- [ ] **Step 4: Commit**

```bash
git add docs/agent-snippet.md README.md
git commit -m "docs: README and agent protocol snippet"
```

---

## Deferred (spec §10 — do NOT build these)

Menu bar shell, stdio→HTTP shim, Claude Code Stop-hook enforcement, remote/multi-user access.

## Plan self-review notes

- Spec coverage: §3 architecture → Tasks 9–10; §4 data model → Tasks 2–4; §5 facades → Tasks 3–4, 9; §6 dashboard → Tasks 12–14; §7 failure table → Tasks 7–9 (orphan paths), 8 (error mapping), 13 (mermaid fallback), 12 (SSE reconnect via EventSource); §8 testing → Tasks 2–8, 11, 12; §9 config → Task 6; reminders → Task 10; seed → Task 15; agent snippet + native-gate rule → Task 16.
- Known API risk, called out inline: exact MCP SDK v2 property names (`onsessioninitialized`, handler ctx shape, `callTool` options position). Tasks 9, 11, 15 each say to verify against the installed `.d.ts` rather than guess.
- Type consistency: `Card`/`Decision`/`DecisionAnswer`/`CardResponse` defined once in Task 2 and imported everywhere; `DraftAnswer` (UI-only, note always a string) defined in Task 12 and converted at the API boundary via `toApiAnswers`.

