import { Archive, Bot, Check, Clock, FolderGit2, Inbox as InboxIcon, Unplug } from 'lucide-react'
import type { Card } from '../../src/shared/card.js'
import { STAGE } from './stage.js'

function age(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

function Row({ card }: { card: Card }) {
  const meta = STAGE[card.stage]
  return (
    <a
      href={`#/card/${card.id}`}
      className={`inbox-row fade-in${card.status !== 'pending' ? ' is-history' : ''}`}
      style={meta.vars}
    >
      <span className="stage-glyph"><meta.Icon size={21} strokeWidth={1.9} aria-hidden /></span>
      <span className="inbox-main">
        <h3 className="inbox-headline">{card.headline}</h3>
        <span className="inbox-meta">
          <span><Bot size={13} aria-hidden />{card.session.agent}</span>
          <span><FolderGit2 size={13} aria-hidden />{card.session.project}</span>
          {card.session.title && <span>{card.session.title}</span>}
        </span>
      </span>
      <span className="inbox-side">
        {card.status === 'decided' && <span className="status-chip decided"><Check size={12} aria-hidden />decided</span>}
        {card.status === 'orphaned' && <span className="status-chip orphaned"><Unplug size={12} aria-hidden />orphaned</span>}
        <span className="age"><Clock size={11} style={{ verticalAlign: -1, marginRight: 4 }} aria-hidden />{age(card.createdAt)}</span>
      </span>
    </a>
  )
}

export function Inbox({ cards }: { cards: Card[] }) {
  const byNewest = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const pending = byNewest.filter(c => c.status === 'pending')
  const rest = byNewest.filter(c => c.status !== 'pending')
  return (
    <div>
      <div className="section-label">
        <InboxIcon size={14} aria-hidden /> Needs you <span className="count">({pending.length})</span>
      </div>
      {pending.length === 0 && (
        <div className="empty">
          <svg width="72" height="44" viewBox="0 0 72 44" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <ellipse cx="36" cy="20" rx="26" ry="9" />
            <line x1="14" y1="24" x2="11" y2="38" /><line x1="58" y1="24" x2="61" y2="38" />
            <line x1="30" y1="28.5" x2="29" y2="40" /><line x1="42" y1="28.5" x2="43" y2="40" />
          </svg>
          <p>The table is clear. Nothing needs you.</p>
        </div>
      )}
      {pending.map(c => <Row key={c.id} card={c} />)}
      {rest.length > 0 && (
        <div className="section-label" style={{ marginTop: 44 }}>
          <Archive size={14} aria-hidden /> History <span className="count">({rest.length})</span>
        </div>
      )}
      {rest.map(c => <Row key={c.id} card={c} />)}
    </div>
  )
}
