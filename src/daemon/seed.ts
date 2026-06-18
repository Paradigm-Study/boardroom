import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const PORT = process.env.BOARDROOM_PORT ?? '4040'
const URL_BASE = `http://127.0.0.1:${PORT}/mcp`

async function call(name: string, args: Record<string, unknown>): Promise<void> {
  const client = new Client({ name: 'boardroom-seed', version: '0.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_BASE)))
  console.log(`[seed] ${name} card submitted — waiting for your decision in the dashboard…`)
  const result = await client.callTool(
    { name, arguments: args },
    { resetTimeoutOnProgress: true, maxTotalTimeout: 86_400_000, timeout: 86_400_000 },
  )
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
      { id: 'run', type: 'evidence', command: "npm test -- --runInBand src/export/csv-streaming.test.ts src/routes/report-export.test.ts", exitCode: 0, output: 'Test Files  3 passed (3)\n     Tests  18 passed (18)' },
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
