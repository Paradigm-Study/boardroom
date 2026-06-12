import dagre from 'dagre'
import { ArrowRight, BadgeCheck, FileDiff, FileText, GitFork, Milestone, Network, Scale, Table2, Terminal, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Block } from '../../../src/shared/blocks.js'

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

function Markdown({ text }: { text: string }) {
  return <div className="prose"><ReactMarkdown>{text}</ReactMarkdown></div>
}

function Graph({ block, onNodeClick }: {
  block: Extract<Block, { type: 'graph' }>
  onNodeClick?: () => void
}) {
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
        style: {
          fontSize: 13,
          fontFamily: 'var(--sans)',
          borderRadius: 10,
          background: 'var(--surface)',
          color: 'var(--ink)',
          border: '1.5px solid var(--line-2)',
        },
      }
    })
    const edges: Edge[] = block.edges.map((e, i) => ({
      id: `e${i}`, source: e.from, target: e.to, label: e.label,
      labelStyle: { fontSize: 11, fill: 'var(--ink-2)' },
      labelBgStyle: { fill: 'var(--surface)' },
    }))
    return { nodes, edges }
  }, [block])

  return (
    <div className="reactflow-wrap" style={{ height: Math.max(220, block.nodes.length * 52) }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={() => onNodeClick?.()}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} color="var(--line-2)" />
      </ReactFlow>
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

function Evidence({ block }: { block: Extract<Block, { type: 'evidence' }> }) {
  const ok = block.exitCode === 0
  return (
    <details className="evidence">
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

export function BlockView({ block, highlighted, onClick }: {
  block: Block
  highlighted?: boolean
  onClick?: () => void
}) {
  const kind = KIND[block.type]
  let body: React.ReactNode
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
      className={`block${highlighted ? ' highlight' : ''}`}
      onClick={block.type === 'graph' ? undefined : onClick}
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
