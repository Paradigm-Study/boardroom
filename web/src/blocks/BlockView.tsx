import dagre from 'dagre'
import { ArrowRight, BadgeCheck, FileDiff, FileText, GitFork, Milestone, Network, Scale, Table2, Terminal, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Block } from '../../../src/shared/blocks.js'
import { basename, fileHash, viewableHref } from '../fileView.js'

// Links inside agent prose: a file we can show (image/pdf/html/text or an
// attachment url) opens in the in-app viewer so the window is never stranded;
// anything else is a normal external link in a new tab.
function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href && viewableHref(href)) {
    const name = basename(href)
    const target = fileHash({ url: href, name })
    return (
      <a href={target} onClick={e => { e.preventDefault(); window.location.hash = target }}>
        {children}
      </a>
    )
  }
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
}

const KIND: Record<Block['type'], { label: string; Icon: LucideIcon }> = {
  markdown: { label: 'Context', Icon: FileText },
  graph: { label: 'Structure', Icon: Network },
  phases: { label: 'Phases', Icon: Milestone },
  options_compare: { label: 'Trade-offs', Icon: Scale },
  table: { label: 'Data', Icon: Table2 },
  diff_stat: { label: 'Change footprint', Icon: FileDiff },
  evidence: { label: 'Evidence', Icon: Terminal },
  mermaid: { label: 'Diagram', Icon: GitFork },
}

// Prose is clamped to a few lines with a Show more toggle so a verbose agent
// can't bury the decision under an essay. remark-gfm renders any markdown
// tables / lists / task-lists as real structure instead of raw pipe text.
function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (el) setOverflows(el.scrollHeight > el.clientHeight + 4)
  }, [text, expanded])
  return (
    <div>
      <div ref={ref} className={`prose${expanded ? '' : ' clamped'}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>{text}</ReactMarkdown>
      </div>
      {(overflows || expanded) && (
        <button className="clamp-toggle" onClick={() => setExpanded(e => !e)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

// The DOM anchor id for a block, optionally namespaced to a decision. Shared by
// BlockView (which stamps the id) and Decision's Evidence links (which target it)
// so the two can never drift apart.
export function blockAnchorId(blockId: string, scope?: string): string {
  return scope ? `block-${scope}-${blockId}` : `block-${blockId}`
}

const NODE_W = 164
const NODE_H = 50

export function labelLines(label: string): string[] {
  const words = label.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > 18 && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
    if (lines.length === 2) break
  }
  if (current && lines.length < 2) lines.push(current)
  if (lines.length === 0) lines.push(label)
  if (words.join(' ').length > lines.join(' ').length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\.+$/, '')}...`
  }
  return lines
}

// Static, on-brand SVG graph: dagre for layout, plain SVG for render. No canvas,
// no dotted grid, no pan/zoom — and edge labels we actually control the contrast of.
function Graph({ block }: { block: Extract<Block, { type: 'graph' }> }) {
  const { nodes, edges, width, height } = useMemo(() => {
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 64, marginx: 8, marginy: 8 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const n of block.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H, label: n.label })
    for (const e of block.edges) g.setEdge(e.from, e.to, { label: e.label })
    dagre.layout(g)
    const nodes = block.nodes.map(n => ({ ...g.node(n.id), label: n.label }))
    const edges = block.edges.map(e => {
      const ge = g.edge(e.from, e.to) as { points: { x: number; y: number }[] }
      const pts = ge.points
      const mid = pts[Math.floor(pts.length / 2)]
      return { points: pts, label: e.label, mid }
    })
    const { width, height } = g.graph()
    return { nodes, edges, width: width ?? 400, height: height ?? 200 }
  }, [block])

  return (
    <div className="graph-scroll">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ maxHeight: Math.max(170, height), minWidth: Math.min(680, Math.max(420, width)), display: 'block' }} role="img">
      <defs>
        <marker id="b-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 1 L8 5 L0 9 z" className="g-arrow" />
        </marker>
      </defs>
      {edges.map((e, i) => (
        <g key={i}>
          <polyline
            points={e.points.map(p => `${p.x},${p.y}`).join(' ')}
            className="g-edge" fill="none" markerEnd="url(#b-arrow)"
          />
          {e.label && (
            <text x={e.mid.x} y={e.mid.y - 4} textAnchor="middle" className="g-edge-label"
              style={{ paintOrder: 'stroke', stroke: 'var(--bg)', strokeWidth: 4, strokeLinejoin: 'round' }}>
              {e.label}
            </text>
          )}
        </g>
      ))}
      {nodes.map((n, i) => (
        <g key={i}>
          <rect x={n.x - NODE_W / 2} y={n.y - NODE_H / 2} width={NODE_W} height={NODE_H} rx="8" className="g-node" />
          <text x={n.x} y={n.y - (labelLines(n.label).length - 1) * 7} textAnchor="middle" dominantBaseline="central" className="g-node-label">
            {labelLines(n.label).map((line, lineIndex) => (
              <tspan key={lineIndex} x={n.x} dy={lineIndex === 0 ? 0 : 14}>{line}</tspan>
            ))}
          </text>
        </g>
      ))}
      </svg>
    </div>
  )
}

function Phases({ block }: { block: Extract<Block, { type: 'phases' }> }) {
  return (
    <div className="phases">
      {block.phases.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="phase">
            <span className="phase-num">{String(i + 1).padStart(2, '0')}</span>
            <span className="phase-title">{p.title}</span>
            {p.summary && <div className="phase-sum">{p.summary}</div>}
          </div>
          {i < block.phases.length - 1 && <ArrowRight size={15} className="phase-arrow" aria-hidden />}
        </div>
      ))}
    </div>
  )
}

function OptionsCompare({ block }: { block: Extract<Block, { type: 'options_compare' }> }) {
  return (
    <div className="compare">
      {block.options.map((o, i) => (
        <div key={i} className={`compare-opt${o.recommended ? ' rec' : ''}`}>
          {o.recommended && <span className="rec-badge"><BadgeCheck size={11} aria-hidden />rec</span>}
          <div className="compare-label">{o.label}</div>
          {o.pros.map((p, j) => <div key={`p${j}`} className="pro"><span>+</span>{p}</div>)}
          {o.cons.map((c, j) => <div key={`c${j}`} className="con"><span>−</span>{c}</div>)}
        </div>
      ))}
    </div>
  )
}

function Table({ block }: { block: Extract<Block, { type: 'table' }> }) {
  return (
    <table className="tbl">
      <thead>
        <tr>{block.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {block.rows.map((row, i) => (
          <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}

function DiffStat({ block }: { block: Extract<Block, { type: 'diff_stat' }> }) {
  return (
    <div className="diff">
      {block.files.map((f, i) => (
        <div key={i} className="diff-row">
          <span className="path">{f.path}</span>
          <span className="add">+{f.additions}</span>
          <span className="del">−{f.deletions}</span>
        </div>
      ))}
    </div>
  )
}

function Evidence({ block, forceOpen }: { block: Extract<Block, { type: 'evidence' }>; forceOpen?: boolean }) {
  const ok = block.exitCode === 0
  return (
    <details className="evidence" open={forceOpen}>
      <summary>
        {block.command ?? 'output'}
        {block.exitCode !== undefined && (
          <span className={ok ? 'exit-ok' : 'exit-bad'}>exit {block.exitCode}</span>
        )}
      </summary>
      <pre>{block.output}</pre>
    </details>
  )
}

function Mermaid({ block }: { block: Extract<Block, { type: 'mermaid' }> }) {
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

  if (failed) return <pre style={{ fontSize: 12, fontFamily: 'var(--mono)' }}>{block.source}</pre>
  if (!svg) return <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>rendering…</p>
  return <div dangerouslySetInnerHTML={{ __html: svg }} />
}

// `anchorScope` (a decision id) namespaces the DOM anchor so the same block can be
// shown under two decisions without their ids colliding — an unscoped `block-<id>`
// would appear twice and an Evidence link would jump to the wrong row. The
// matching href is built in Decision.tsx.
export function BlockView({ block, highlighted, forceOpen, anchorScope }: {
  block: Block
  highlighted?: boolean
  forceOpen?: boolean
  anchorScope?: string
}) {
  const kind = KIND[block.type]
  let body: ReactNode
  switch (block.type) {
    case 'markdown': body = <Markdown text={block.text} />; break
    case 'graph': body = <Graph block={block} />; break
    case 'phases': body = <Phases block={block} />; break
    case 'options_compare': body = <OptionsCompare block={block} />; break
    case 'table': body = <Table block={block} />; break
    case 'diff_stat': body = <DiffStat block={block} />; break
    case 'evidence': body = <Evidence block={block} forceOpen={forceOpen} />; break
    case 'mermaid': body = <Mermaid block={block} />; break
  }
  return (
    <div
      id={blockAnchorId(block.id, anchorScope)}
      className={`block${highlighted ? ' highlight' : ''}`}
    >
      <div className="block-kind">
        <kind.Icon size={13} strokeWidth={2} aria-hidden />
        {kind.label}
        {block.title && <span className="title">· {block.title}</span>}
      </div>
      {body}
    </div>
  )
}
