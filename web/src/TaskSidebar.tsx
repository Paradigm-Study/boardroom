import { Archive, Armchair, ChevronRight, FolderTree, Inbox } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import type { SessionVM } from './api.js'
import { age, isReconnecting, needsHuman } from './helpers.js'
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

// The real session key when the card is bound to a captured Claude Code session
// (Task 2's spine); a pseudo-key (project+title+agent) ONLY for legacy/unbound
// cards that predate the spine. Two sessions that happen to share project/title/
// agent are still distinct groups once they carry real claudeSessionIds.
function sessionKey(card: Card): string {
  return card.claudeSessionId ?? `${projectKey(card)}\u0000${sessionLabel(card)}\u0000${card.session.agent}`
}

interface SidebarSessionGroup {
  key: string
  label: string
  agent: string
  cards: Card[]
  // True when this group's key is a real claudeSessionId (not the legacy pseudo-key)
  // — only bound groups link to the #/session/<id> stream view or show a status chip.
  bound: boolean
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
      session = { key: sKey, label: sessionLabel(card), agent: card.session.agent, cards: [], bound: !!card.claudeSessionId }
      project.sessions.push(session)
    }
    session.cards.push(card)
  }

  return [...projects.values()]
}

// A boot-orphaned card inside the reattach window is "reconnecting" — still on the
// human's plate (needsHuman), so it renders live, not done, and says so.
function statusLabel(card: Card): string {
  if (card.status === 'pending') return 'needs you'
  if (isReconnecting(card)) return 'reconnecting'
  return card.status
}

function Item({ card, selected }: { card: Card; selected: boolean }) {
  return (
    <a
      href={`#/card/${card.id}`}
      className={`titem${selected ? ' on' : ''}${needsHuman(card) ? '' : ' done'}`}
      title={card.headline}
    >
      <span className={`t-state ${isReconnecting(card) ? 'reconnecting' : card.status}`} />
      <span className="t-main">
        <p className="t-title">{card.headline}</p>
        <span className="t-meta">
          <span className="stage-dot" style={{ background: STAGE[card.stage].color }} />
          <span>{STAGE[card.stage].label}</span>
          <span>·</span>
          <span>{statusLabel(card)}</span>
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
  sessions,
}: {
  project: SidebarProjectGroup
  section: string
  projectIndex: number
  selectedId: string | null
  sessions?: SessionVM[]
}) {
  const key = foldKey(section, project.key)
  const [folded, setFolded] = useState(() => readFolded(key))
  const [showAll, setShowAll] = useState(false)

  // Navigating to a card must never land on an invisible selection: unfold the
  // project and lift the session cap when the selected card lives behind them.
  // Keyed on selectedId alone so a manual fold while the card stays selected
  // isn't fought; the unfold is per-view state, not persisted.
  const selectedInProject = selectedId != null && project.cards.some(c => c.id === selectedId)
  const selectedSessionIndex = selectedId == null
    ? -1
    : project.sessions.findIndex(s => s.cards.some(c => c.id === selectedId))
  useEffect(() => {
    if (!selectedInProject) return
    setFolded(false)
    if (selectedSessionIndex >= SESSION_CAP) setShowAll(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to selection changes only
  }, [selectedId])

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
            // Only a bound group (a real claudeSessionId) links to the stream view or
            // carries a status chip — the legacy pseudo-key has no session record to
            // fetch cards for, and no SessionVM to look a status up on.
            const vm = session.bound ? sessions?.find(s => s.sessionId === session.key) : undefined
            return (
              <section key={session.key} className="side-session" role="group" aria-labelledby={sessionHeadingId}>
                <div className="side-session-head">
                  <h4 id={sessionHeadingId}>
                    {session.bound
                      ? <a href={`#/session/${encodeURIComponent(session.key)}`}>{session.label}</a>
                      : session.label}
                  </h4>
                  <span className="side-session-agent">{session.agent}</span>
                  <span>{session.cards.length} card{session.cards.length === 1 ? '' : 's'}</span>
                  {vm && <span className={`stream-status stream-status-${vm.sessionStatus}`}>{vm.sessionStatus}</span>}
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

function GroupedCards({
  cards,
  section,
  selectedId,
  sessions,
}: {
  cards: Card[]
  section: string
  selectedId: string | null
  sessions?: SessionVM[]
}) {
  return (
    <>
      {groupCardsByProjectAndSession(cards).map((project, projectIndex) => (
        <ProjectSection
          key={project.key}
          project={project}
          section={section}
          projectIndex={projectIndex}
          selectedId={selectedId}
          sessions={sessions}
        />
      ))}
    </>
  )
}

export function TaskSidebar({ cards, selectedId, sessions }: { cards: Card[]; selectedId: string | null; sessions?: SessionVM[] }) {
  const byNewest = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  // needsHuman, not status === 'pending': a restart-orphaned ("reconnecting") gate
  // is still awaiting the human and must not sink into History (see shared/needsHuman).
  const pending = byNewest.filter(c => needsHuman(c))
  const rest = byNewest.filter(c => !needsHuman(c))

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
      <GroupedCards cards={pending} section="pending" selectedId={selectedId} sessions={sessions} />

      {rest.length > 0 && (
        <div className="side-group"><Archive size={12} aria-hidden />History <span className="n">{rest.length}</span></div>
      )}
      <GroupedCards cards={rest} section="history" selectedId={selectedId} sessions={sessions} />
    </aside>
  )
}
