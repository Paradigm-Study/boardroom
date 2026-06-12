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

function Row({ card }: { card: Card }) {
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

export function Inbox({ cards }: { cards: Card[] }) {
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
