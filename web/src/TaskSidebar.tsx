import { Archive, Armchair, ChevronRight, CircleCheck, FileText, FolderTree, Inbox, ListChecks, MessageCircleQuestion, MessagesSquare, Route, type LucideIcon } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Card, Stage } from '../../src/shared/card.js'
import type { Entry } from '../../src/shared/entry.js'
import type { SessionVM } from './api.js'
import { age, isReconnecting, needsHuman, orphanClockMs, REATTACH_WINDOW_MS } from './helpers.js'
import { isImplicitlyRead, readEntrySet, readStateVersion, subscribeReadState, unreadCount } from './readState.js'
import { STAGE } from './stage.js'
import { StreamDrawer } from './StreamDrawer.js'

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

export function groupCardsByProjectAndSession(cards: Card[], orphanEntries: Entry[] = []): SidebarProjectGroup[] {
  const projects = new Map<string, SidebarProjectGroup>()

  // Group-level ordering (which project/session appears first) stays newest-first —
  // iterating in that order determines each Map's insertion order, so a NEW session
  // still lands above an OLDER one at the group level. The human's FIFO rule is
  // scoped strictly to the cards WITHIN a single session stack (below).
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

  // FIFO within each session stack ONLY (first-in-at-top): the loop above appended
  // cards newest-first (it walks the newest-first list), so each session's `cards`
  // needs a final reverse to read oldest-first — group/session order above is
  // untouched, this only reorders inside a single session's own card list.
  for (const project of projects.values()) {
    for (const session of project.sessions) session.cards.reverse()
  }

  // Entry-only session groups: a report/tag whose session opened no gate yet still
  // needs a surface (the unread badge counts every report — an invisible one would
  // be uncleareable). Callers prefilter to entries matching NO card session key
  // ANYWHERE (not just this call's card subset), so nothing renders twice. Groups
  // merge into their existing project folder or append a new one; within a project
  // they land AFTER card sessions — informational, never above a gate.
  for (const entry of [...orphanEntries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const pKey = entry.session.project
    let project = projects.get(pKey)
    if (!project) {
      project = { key: pKey, label: entry.session.project, cards: [], sessions: [] }
      projects.set(pKey, project)
    }
    const sKey = entrySessionKey(entry)
    if (!project.sessions.some(s => s.key === sKey)) {
      project.sessions.push({
        key: sKey,
        label: entry.session.title?.trim() || 'Untitled session',
        agent: entry.session.agent,
        cards: [],
        bound: !!entry.claudeSessionId,
      })
    }
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

// Fraction (0–1) of the reattach window still REMAINING for a reconnecting gate —
// drives the width of the countdown bar under its row. Mirrors isReconnecting's
// clock handling: prefer orphanedAt, fall back to createdAt, and fail OPEN (full
// bar) on an unparseable timestamp so a corrupt clock never reads as "expired".
function reattachRemaining(card: Card, nowMs: number = Date.now()): number {
  const t = orphanClockMs(card)
  if (!Number.isFinite(t)) return 1
  return Math.max(0, Math.min(1, 1 - (nowMs - t) / REATTACH_WINDOW_MS))
}

function Item({ card, selected }: { card: Card; selected: boolean }) {
  const reconnecting = isReconnecting(card)
  const remaining = reconnecting ? reattachRemaining(card) : 0
  return (
    <a
      href={`#/card/${card.id}`}
      className={`titem${selected ? ' on' : ''}${needsHuman(card) ? '' : ' done'}`}
      title={card.headline}
    >
      <span className={`t-state ${reconnecting ? 'reconnecting' : card.status}`} />
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
        {reconnecting && (
          <span
            className="recon-bar"
            role="progressbar"
            aria-label="Reattach window remaining"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(remaining * 100)}
          >
            <span className="recon-bar-fill" style={{ width: `${remaining * 100}%` }} />
          </span>
        )}
      </span>
    </a>
  )
}

// ── History gate glyphs ──────────────────────────────────────────────────────
// Each stage maps to a lucide glyph so a resolved gate collapses to a single colored
// icon in its session's strip: the icon says WHICH gate it was, the color reinforces
// it. An abandoned (orphaned) gate renders muted — no dashed ring, because the only
// place a status ring earned its keep (a live reconnecting gate) now shows its state
// as the reattach countdown bar above.
const STAGE_ICON: Record<Stage, LucideIcon> = {
  clarify: MessageCircleQuestion,
  plan: Route,
  spec: ListChecks,
  results: CircleCheck,
}

// One history gate as its stage glyph — a compact, clickable stand-in for the full
// Item row. Hover/title + aria-label keep the headline reachable, so collapsing the
// row loses nothing the human needs to identify or open it.
function GateIcon({ card, selected }: { card: Card; selected: boolean }) {
  const Icon = STAGE_ICON[card.stage]
  const orphaned = card.status === 'orphaned'
  return (
    <a
      href={`#/card/${card.id}`}
      className={`gate-icon${selected ? ' on' : ''}${orphaned ? ' orphaned' : ''}`}
      style={STAGE[card.stage].vars}
      title={card.headline}
      // Abandoned gates read identically to decided ones by shape + color, so the
      // status also goes in the accessible name — the old full row said "orphaned"
      // in text, and the strip must not drop that for screen-reader / keyboard users.
      aria-label={`${STAGE[card.stage].label}: ${card.headline}${orphaned ? ' (orphaned)' : ''}`}
    >
      <Icon size={18} aria-hidden />
    </a>
  )
}

// A history session's resolved gates as one wrapping row of stage glyphs — the
// compaction that stops a session with many decided gates from burying the sidebar.
// Pending / reconnecting gates never reach here; they stay full Item rows under
// Needs-you (see the section fork in ProjectSection).
function GateStrip({ cards, selectedId }: { cards: Card[]; selectedId: string | null }) {
  return (
    <div className="side-gate-strip">
      {cards.map(c => <GateIcon key={c.id} card={c} selected={c.id === selectedId} />)}
    </div>
  )
}

// A session's own report entries render as first-class rows too — the human's
// direction that a report is "additional information", never a second-class
// citizen tucked away behind a drawer. Appended AFTER the session's card
// rendering (the Item list OR the GateStrip) rather than interleaved by FIFO
// timestamp: History's GateStrip is a compact icon strip, not a row list a report
// could interleave into, so one append rule keeps both sections' structure simple
// and uniform. `unread` is computed by the caller (readIds is read once per
// render pass — see TaskSidebar below), so this stays a plain presentational row.
function ReportRow({ entry, unread }: { entry: Extract<Entry, { type: 'report' }>; unread: boolean }) {
  return (
    <a href={`#/report/${encodeURIComponent(entry.id)}`} className="side-report-row" title={entry.headline}>
      <FileText size={12} aria-hidden />
      <span className="side-report-title">{entry.headline}</span>
      {unread && <span className="side-unread-dot" aria-label="Unread report" />}
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
  entriesBySession,
  cardsBySession,
  readIds,
  openStreamKey,
  onOpenStream,
}: {
  project: SidebarProjectGroup
  section: string
  projectIndex: number
  selectedId: string | null
  sessions?: SessionVM[]
  entriesBySession: Map<string, Entry[]>
  cardsBySession: Map<string, Card[]>
  readIds: Set<string>
  openStreamKey: string | null
  onOpenStream: (key: string | null) => void
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
            // Only a bound group (a real claudeSessionId) has a SessionVM to look a
            // status up on — the legacy pseudo-key has no session record. Entries,
            // though, are keyed the same way for both (entrySessionKey mirrors
            // sessionKey's pseudo-key), so an unbound group's reports/tags are found
            // here too — they must surface under their project like unbound cards do.
            const vm = session.bound ? sessions?.find(s => s.sessionId === session.key) : undefined
            const sessionEntries = entriesBySession.get(session.key) ?? []
            // NOTE: tag entries deliberately do NOT render in the sidebar. The stage
            // chips they used to paint here said the same thing the Needs-you rows /
            // history glyph strip already say per gate — pure duplication (human's
            // call, results review 2026-07-13). Tags still render in the stream views;
            // sessionEntries feeds the unread dot and the StreamDrawer below.
            // Unread dot: readIds is read from localStorage exactly ONCE per render
            // pass (in TaskSidebar), so this is a plain Set lookup per report — O(1)
            // per entry, not a localStorage re-read per entry. Age-implies-read: a
            // report older than readState.READ_TTL_MS counts as read even if its id
            // fell out of (or never entered) storage — see isImplicitlyRead.
            const hasUnreadReport = sessionEntries.some(e => e.type === 'report' && !isImplicitlyRead(e) && !readIds.has(e.id))
            // Section-scoped: the SAME session can render once under Needs-you and
            // once under History; the open-drawer key must tell those apart or both
            // instances render a (stacked) drawer at once.
            const streamKey = `${section}:${session.key}`
            const streamOpen = openStreamKey === streamKey

            return (
              <section key={session.key} className="side-session" role="group" aria-labelledby={sessionHeadingId}>
                <div className="side-session-head">
                  <h4 id={sessionHeadingId}>
                    {session.bound
                      ? <a href={`#/session/${encodeURIComponent(session.key)}`}>{session.label}</a>
                      : session.label}
                  </h4>
                  {hasUnreadReport && <span className="side-unread-dot" aria-label="Unread report" />}
                  <span className="side-session-agent">{session.agent}</span>
                  <span>{session.cards.length} card{session.cards.length === 1 ? '' : 's'}</span>
                  {vm && <span className={`stream-status stream-status-${vm.sessionStatus}`}>{vm.sessionStatus}</span>}
                  {/* The stream affordance opens StreamDrawer for BOTH bound and unbound
                      groups — SessionStream already accepts session={null}, so an unbound
                      (legacy pseudo-key) group's cards+entries render the same way. */}
                  <button
                    type="button"
                    className="side-stream-btn"
                    aria-label="Open session stream"
                    title="Open session stream"
                    onClick={() => onOpenStream(streamKey)}
                  >
                    <MessagesSquare size={12} aria-hidden />
                  </button>
                </div>
                {section === 'history'
                  ? session.cards.length > 0 && <GateStrip cards={session.cards} selectedId={selectedId} />
                  : session.cards.map(c => <Item key={c.id} card={c} selected={c.id === selectedId} />)}
                {sessionEntries
                  .filter((e): e is Extract<Entry, { type: 'report' }> => e.type === 'report')
                  .map(e => (
                    <ReportRow key={e.id} entry={e} unread={!isImplicitlyRead(e) && !readIds.has(e.id)} />
                  ))}
                {streamOpen && (
                  <StreamDrawer
                    session={vm ?? null}
                    // The FULL session's cards (cardsBySession spans both sidebar
                    // sections), not this section's subset — the drawer promises the
                    // same stream the #/session/<id> route renders.
                    cards={cardsBySession.get(session.key) ?? session.cards}
                    entries={sessionEntries}
                    onClose={() => onOpenStream(null)}
                  />
                )}
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
  entriesBySession,
  cardsBySession,
  readIds,
  openStreamKey,
  onOpenStream,
  orphanEntries = [],
}: {
  cards: Card[]
  section: string
  selectedId: string | null
  sessions?: SessionVM[]
  entriesBySession: Map<string, Entry[]>
  cardsBySession: Map<string, Card[]>
  readIds: Set<string>
  openStreamKey: string | null
  onOpenStream: (key: string | null) => void
  orphanEntries?: Entry[]
}) {
  return (
    <>
      {groupCardsByProjectAndSession(cards, orphanEntries).map((project, projectIndex) => (
        <ProjectSection
          key={project.key}
          project={project}
          section={section}
          projectIndex={projectIndex}
          selectedId={selectedId}
          sessions={sessions}
          entriesBySession={entriesBySession}
          cardsBySession={cardsBySession}
          readIds={readIds}
          openStreamKey={openStreamKey}
          onOpenStream={onOpenStream}
        />
      ))}
    </>
  )
}

// The entry-side counterpart of TaskSidebar's `sessionKey(card)`: a bound entry
// (real claudeSessionId) keys by that id; an UNBOUND entry (no claudeSessionId —
// e.g. a legacy agent's present_report call) keys by the same pseudo-key
// (project, title, agent) that groupCardsByProjectAndSession already uses for
// unbound CARDS, so an unbound report/tag joins the matching legacy session group
// instead of vanishing. Must stay byte-identical to `sessionKey`'s pseudo-key
// construction or an unbound entry silently stops matching its group.
function entrySessionKey(entry: Entry): string {
  return entry.claudeSessionId
    ?? `${entry.session.project}\u0000${entry.session.title?.trim() || 'Untitled session'}\u0000${entry.session.agent}`
}

// Groups entries by session key (real claudeSessionId, or the unbound pseudo-key
// above), each list kept FIFO (createdAt ASC) — computed ONCE per render pass
// rather than per session, so a sidebar with many sessions doesn't re-filter/
// re-sort the whole entries array per group (O(sessions), not O(sessions × entries)).
function groupEntriesBySession(entries: Entry[]): Map<string, Entry[]> {
  const bySession = new Map<string, Entry[]>()
  for (const entry of [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = entrySessionKey(entry)
    const list = bySession.get(key)
    if (list) list.push(entry)
    else bySession.set(key, [entry])
  }
  return bySession
}

// ALL of a session's cards keyed the same way the sidebar groups them — the
// pending/history sections each see only their own subset, but the StreamDrawer
// must render the whole session regardless of which section it was opened from.
// FIFO (createdAt ASC) to match stream order.
function groupAllCardsBySession(cards: Card[]): Map<string, Card[]> {
  const bySession = new Map<string, Card[]>()
  for (const card of [...cards].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = sessionKey(card)
    const list = bySession.get(key)
    if (list) list.push(card)
    else bySession.set(key, [card])
  }
  return bySession
}

export function TaskSidebar({ cards, selectedId, sessions, entries = [] }: {
  cards: Card[]
  selectedId: string | null
  sessions?: SessionVM[]
  entries?: Entry[]
}) {
  // ONE open stream drawer for the whole sidebar (the drawer is a fixed overlay —
  // per-section state would let two stack). Keys are section-scoped ProjectSection
  // stream keys, so the same session under Needs-you and History can't both open.
  const [openStreamKey, setOpenStreamKey] = useState<string | null>(null)

  const byNewest = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  // needsHuman, not status === 'pending': a restart-orphaned ("reconnecting") gate
  // is still awaiting the human and must not sink into History (see shared/needsHuman).
  const pending = byNewest.filter(c => needsHuman(c))
  const rest = byNewest.filter(c => !needsHuman(c))

  const entriesBySession = groupEntriesBySession(entries)
  const cardsBySession = groupAllCardsBySession(cards)
  // Entries whose session has NO cards anywhere (pending or history): they get
  // synthesized entry-only groups in the History section below, so every counted
  // report has a surface. Keyed against ALL cards — an entry matching a pending
  // session must not also spawn a history twin.
  const cardSessionKeys = new Set(cards.map(c => sessionKey(c)))
  const orphanEntries = entries.filter(e => !cardSessionKeys.has(entrySessionKey(e)))
  // Re-render when a ReportDrawer (possibly deep inside this sidebar's own
  // StreamDrawer) marks an entry read — the dot and the aggregate count below
  // read localStorage during render and would otherwise stay stale.
  useSyncExternalStore(subscribeReadState, readStateVersion)
  // ONE localStorage read for the whole render pass (see readState.readEntrySet) —
  // every session's unread-dot check below is then a plain Set lookup, not a
  // localStorage re-parse per session or per entry.
  const readIds = readEntrySet()
  // Aggregated unread-report count for the side-head (spec: the inbox aggregates
  // unread-report counts). unreadCount already applies age-implies-read and skips
  // tag entries — tray-separation: this NEVER folds into side-count/pending.length.
  const unread = unreadCount(entries)

  return (
    <aside className="sidebar">
      <div className="side-head">
        <a href="#/" className="wordmark">
          <Armchair size={17} strokeWidth={2} aria-hidden />
          boardroom
        </a>
        <span className="side-count">{pending.length > 0 ? `${pending.length} waiting` : 'idle'}</span>
        {/* Separate element from .side-count (tray-separation): unread reports never
            fold into the "N waiting" gate count — see readState.unreadCount. */}
        {unread > 0 && <span className="side-unread-count">{unread} unread</span>}
      </div>

      <a href="#/folders" className="side-folders">
        <FolderTree size={13} aria-hidden /> Sessions by folder
      </a>

      <div className="side-group"><Inbox size={12} aria-hidden />Needs you <span className="n">{pending.length}</span></div>
      {pending.length === 0 && <p className="side-empty">Nothing waiting on you.</p>}
      <GroupedCards cards={pending} section="pending" selectedId={selectedId} sessions={sessions} entriesBySession={entriesBySession} cardsBySession={cardsBySession} readIds={readIds} openStreamKey={openStreamKey} onOpenStream={setOpenStreamKey} />

      {(rest.length > 0 || orphanEntries.length > 0) && (
        <div className="side-group"><Archive size={12} aria-hidden />History <span className="n">{rest.length}</span></div>
      )}
      <GroupedCards cards={rest} section="history" selectedId={selectedId} sessions={sessions} entriesBySession={entriesBySession} cardsBySession={cardsBySession} readIds={readIds} openStreamKey={openStreamKey} onOpenStream={setOpenStreamKey} orphanEntries={orphanEntries} />
    </aside>
  )
}
