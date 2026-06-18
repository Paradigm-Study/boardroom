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

function sessionLabel(card: Card): string {
  return card.session.title?.trim() || 'Untitled session'
}

function projectKey(card: Card): string {
  return card.session.project
}

function sessionKey(card: Card): string {
  return `${projectKey(card)}\u0000${sessionLabel(card)}\u0000${card.session.agent}`
}

interface SidebarSessionGroup {
  key: string
  label: string
  agent: string
  cards: Card[]
}

interface SidebarProjectGroup {
  key: string
  label: string
  cards: Card[]
  sessions: SidebarSessionGroup[]
}

export function groupCardsByProjectAndSession(cards: Card[]): SidebarProjectGroup[] {
  const projects = new Map<string, SidebarProjectGroup>()

  for (const card of [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const pKey = projectKey(card)
    let project = projects.get(pKey)
    if (!project) {
      project = { key: pKey, label: card.session.project, cards: [], sessions: [] }
      projects.set(pKey, project)
    }
    project.cards.push(card)

    const sKey = sessionKey(card)
    let session = project.sessions.find(s => s.key === sKey)
    if (!session) {
      session = { key: sKey, label: sessionLabel(card), agent: card.session.agent, cards: [] }
      project.sessions.push(session)
    }
    session.cards.push(card)
  }

  return [...projects.values()]
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
          <span>{STAGE[card.stage].label}</span>
          <span>·</span>
          <span>{card.status === 'pending' ? 'needs you' : card.status}</span>
          <span>·</span>
          <span>{age(card.createdAt)}</span>
        </span>
      </span>
    </a>
  )
}

function GroupedCards({ cards, selectedId }: { cards: Card[]; selectedId: string | null }) {
  return (
    <>
      {groupCardsByProjectAndSession(cards).map((project, projectIndex) => {
        const projectHeadingId = `project-${projectIndex}`
        return (
          <section key={project.key} className="side-project" role="group" aria-labelledby={projectHeadingId}>
            <div className="side-project-head">
              <h3 id={projectHeadingId}>{project.label}</h3>
              <span>{project.cards.length} card{project.cards.length === 1 ? '' : 's'}</span>
            </div>

            {project.sessions.map((session, sessionIndex) => {
              const sessionHeadingId = `session-${projectIndex}-${sessionIndex}`
              return (
                <section key={session.key} className="side-session" role="group" aria-labelledby={sessionHeadingId}>
                  <div className="side-session-head">
                    <h4 id={sessionHeadingId}>{session.label}</h4>
                    <span className="side-session-agent">{session.agent}</span>
                    <span>{session.cards.length} card{session.cards.length === 1 ? '' : 's'}</span>
                  </div>
                  {session.cards.map(c => <Item key={c.id} card={c} selected={c.id === selectedId} />)}
                </section>
              )
            })}
          </section>
        )
      })}
    </>
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
      <GroupedCards cards={pending} selectedId={selectedId} />

      {rest.length > 0 && (
        <div className="side-group"><Archive size={12} aria-hidden />History <span className="n">{rest.length}</span></div>
      )}
      <GroupedCards cards={rest} selectedId={selectedId} />
    </aside>
  )
}
