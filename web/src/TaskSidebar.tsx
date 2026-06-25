import { Archive, Armchair, ChevronRight, FolderTree, Inbox } from 'lucide-react'
import { useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { age } from './helpers.js'
import { STAGE } from './stage.js'

// How many sessions a folder shows before the "View more" control. A single
// folder can hold hundreds of sessions; capping keeps it from burying the rest.
const SESSION_CAP = 5

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

// Collapsed folders are remembered per (section, project) across reloads. The
// key is scoped by section so folding a folder under History doesn't also fold
// its sibling under Needs-you. Reads/writes are guarded: localStorage can throw
// (private mode, quota) and collapse should degrade to "just don't persist".
function foldKey(section: string, projectKey: string): string {
  return `boardroom.fold.${section}::${projectKey}`
}

function readFolded(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFolded(key: string, folded: boolean): void {
  try {
    if (folded) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    // Persistence is best-effort; the in-memory toggle still works this session.
  }
}

function ProjectSection({
  project,
  section,
  projectIndex,
  selectedId,
}: {
  project: SidebarProjectGroup
  section: string
  projectIndex: number
  selectedId: string | null
}) {
  const key = foldKey(section, project.key)
  const [folded, setFolded] = useState(() => readFolded(key))
  const [showAll, setShowAll] = useState(false)

  const projectHeadingId = `${section}-project-${projectIndex}`
  const overflow = project.sessions.length - SESSION_CAP
  const visibleSessions = showAll ? project.sessions : project.sessions.slice(0, SESSION_CAP)

  const toggleFold = (): void => {
    setFolded(prev => {
      const next = !prev
      writeFolded(key, next)
      return next
    })
  }

  return (
    <section className="side-project" role="group" aria-labelledby={projectHeadingId}>
      <h3 className="side-project-head" id={projectHeadingId}>
        <button type="button" className="side-project-toggle" aria-expanded={!folded} onClick={toggleFold}>
          <ChevronRight className={`side-chev${folded ? '' : ' open'}`} size={12} aria-hidden />
          <span className="side-project-label">{project.label}</span>
          <span className="side-project-count">{project.cards.length} card{project.cards.length === 1 ? '' : 's'}</span>
        </button>
      </h3>

      {!folded && (
        <div className="side-project-body">
          {visibleSessions.map((session, sessionIndex) => {
            const sessionHeadingId = `${section}-session-${projectIndex}-${sessionIndex}`
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

          {overflow > 0 && (
            <button type="button" className="side-more" aria-expanded={showAll} onClick={() => setShowAll(s => !s)}>
              {showAll ? 'Show less' : `View ${overflow} more`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function GroupedCards({ cards, section, selectedId }: { cards: Card[]; section: string; selectedId: string | null }) {
  return (
    <>
      {groupCardsByProjectAndSession(cards).map((project, projectIndex) => (
        <ProjectSection
          key={project.key}
          project={project}
          section={section}
          projectIndex={projectIndex}
          selectedId={selectedId}
        />
      ))}
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

      <a href="#/folders" className="side-folders">
        <FolderTree size={13} aria-hidden /> Sessions by folder
      </a>

      <div className="side-group"><Inbox size={12} aria-hidden />Needs you <span className="n">{pending.length}</span></div>
      {pending.length === 0 && <p className="side-empty">Nothing waiting on you.</p>}
      <GroupedCards cards={pending} section="pending" selectedId={selectedId} />

      {rest.length > 0 && (
        <div className="side-group"><Archive size={12} aria-hidden />History <span className="n">{rest.length}</span></div>
      )}
      <GroupedCards cards={rest} section="history" selectedId={selectedId} />
    </aside>
  )
}
