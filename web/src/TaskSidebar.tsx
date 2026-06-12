import { Archive, Armchair, Inbox } from 'lucide-react'
import type { Card } from '../../src/shared/card.js'
import { STAGE } from './stage.js'

function age(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

function Item({ card, selected }: { card: Card; selected: boolean }) {
  return (
    <a
      href={`#/card/${card.id}`}
      className={`titem${selected ? ' on' : ''}${card.status !== 'pending' ? ' done' : ''}`}
      title={card.headline}
    >
      <span className={`t-state ${card.status}`} />
      <span className="t-main">
        <p className="t-title">{card.headline}</p>
        <span className="t-meta">
          <span className="stage-dot" style={{ background: STAGE[card.stage].color }} />
          <span className="proj">{card.session.project}</span>
          <span>·</span>
          <span>{card.status === 'pending' ? 'needs you' : card.status}</span>
          <span>·</span>
          <span>{age(card.createdAt)}</span>
        </span>
      </span>
    </a>
  )
}

export function TaskSidebar({ cards, selectedId }: { cards: Card[]; selectedId: string | null }) {
  const byNewest = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const pending = byNewest.filter(c => c.status === 'pending')
  const rest = byNewest.filter(c => c.status !== 'pending')

  return (
    <aside className="sidebar">
      <div className="side-head">
        <a href="#/" className="wordmark">
          <Armchair size={17} strokeWidth={2} aria-hidden />
          boardroom
        </a>
        <span className="side-count">{pending.length > 0 ? `${pending.length} waiting` : 'idle'}</span>
      </div>

      <div className="side-group"><Inbox size={12} aria-hidden />Needs you <span className="n">{pending.length}</span></div>
      {pending.length === 0 && <p className="side-empty">Nothing waiting on you.</p>}
      {pending.map(c => <Item key={c.id} card={c} selected={c.id === selectedId} />)}

      {rest.length > 0 && (
        <div className="side-group"><Archive size={12} aria-hidden />History <span className="n">{rest.length}</span></div>
      )}
      {rest.map(c => <Item key={c.id} card={c} selected={c.id === selectedId} />)}
    </aside>
  )
}
