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

function Markdown({ text }: { text: string }) {
  return <div style={{ fontSize: 14, lineHeight: 1.6 }}><ReactMarkdown>{text}</ReactMarkdown></div>
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
        style: { fontSize: 13, borderRadius: 8, background: '#fff', color: '#1a1a18' },
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

function Phases({ block }: { block: Extract<Block, { type: 'phases' }> }) {
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

function OptionsCompare({ block }: { block: Extract<Block, { type: 'options_compare' }> }) {
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

function Table({ block }: { block: Extract<Block, { type: 'table' }> }) {
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

function DiffStat({ block }: { block: Extract<Block, { type: 'diff_stat' }> }) {
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

function Evidence({ block }: { block: Extract<Block, { type: 'evidence' }> }) {
  return (
    <details>
      <summary style={{ fontSize: 13, cursor: 'pointer' }}>
        {block.command ?? 'output'}{block.exitCode !== undefined && ` · exit ${block.exitCode}`}
      </summary>
      <pre style={{ fontSize: 12, overflowX: 'auto', background: 'light-dark(#f1efe8, #2a2a27)', padding: 10, borderRadius: 8 }}>{block.output}</pre>
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

  if (failed) return <pre style={{ fontSize: 12 }}>{block.source}</pre>
  if (!svg) return <p style={{ fontSize: 12, opacity: 0.5 }}>rendering…</p>
  return <div dangerouslySetInnerHTML={{ __html: svg }} />
}

export function BlockView({ block, highlighted, onClick }: {
  block: Block
  highlighted?: boolean
  onClick?: () => void
}) {
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
