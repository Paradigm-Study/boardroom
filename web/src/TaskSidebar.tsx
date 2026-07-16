import { Archive, Armchair, Bot, ChevronRight, CircleCheck, FileText, FolderTree, Inbox, ListChecks, MessageCircleQuestion, Route, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import type { Card, Stage } from '../../src/shared/card.js'
import type { Entry } from '../../src/shared/entry.js'
import type { SessionVM } from './api.js'
import { age, isReconnecting, needsHuman, orphanClockMs, REATTACH_WINDOW_MS } from './helpers.js'
import { isImplicitlyRead, readEntrySet, readStateVersion, subscribeReadState, unreadCount } from './readState.js'
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

// A Needs-you gate row: flat (no border/fill — human's call, clarify 2026-07-14),
// led by its pulsing stage icon; the pulse alone says "live". Meta drops the
// "needs you" word (everything in this section needs you — the header says it) but
// KEEPS "reconnecting": that one distinguishes a restart-orphaned gate from a live
// pending one and names what the countdown bar under it is counting.
function Item({ card, selected }: { card: Card; selected: boolean }) {
  const reconnecting = isReconnecting(card)
  const remaining = reconnecting ? reattachRemaining(card) : 0
  const Icon = STAGE_ICON[card.stage]
  return (
    <a
      href={`#/card/${card.id}`}
      className={`titem${selected ? ' on' : ''}`}
      title={card.headline}
    >
      {/* Color = status: amber (pending) or gray (reconnecting/orphaned); shape = gate type. */}
      <span className={`t-icon${reconnecting ? ' reconnecting' : ''}`}>
        <Icon size={17} aria-hidden />
      </span>
      <span className="t-main">
        <p className="t-title">{card.headline}</p>
        <span className="t-meta">
          <span>{STAGE[card.stage].label}</span>
          {reconnecting && <><span>·</span><span>reconnecting</span></>}
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

// ── Gate glyphs ──────────────────────────────────────────────────────────────
// Each stage maps to a lucide glyph: the SHAPE says which gate it is, everywhere
// it appears (history strip, Needs-you rows). COLOR is reserved for status —
// green decided, gray abandoned, amber waiting (human's rule, results round 5).
const STAGE_ICON: Record<Stage, LucideIcon> = {
  clarify: MessageCircleQuestion,
  plan: Route,
  spec: ListChecks,
  results: CircleCheck,
}

// ── Agent marks ──────────────────────────────────────────────────────────────
// The session's agent as its vendor mark (human's call: "the real icon, not a
// capital letter"). Matching is by substring because `session.agent` is free text
// from the MCP client ("claude", "claude-code", "codex-mcp-client", …); anything
// unrecognized falls back to a neutral bot glyph. The full agent name stays
// reachable via title + aria-label on the mark.
function agentKind(agent: string): 'claude' | 'openai' | 'other' {
  const a = agent.toLowerCase()
  if (a.includes('claude') || a === 'cc') return 'claude'
  if (a.includes('codex') || a.includes('openai') || a.includes('gpt')) return 'openai'
  return 'other'
}

function AgentMark({ agent }: { agent: string }) {
  const kind = agentKind(agent)
  return (
    <span className={`agent-mark agent-mark-${kind}`} title={agent} aria-label={agent} role="img">
      {kind === 'claude' && (
        // Claude's starburst (simple-icons path — the real mark, not an approximation).
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden>
          <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
        </svg>
      )}
      {kind === 'openai' && (
        // OpenAI's hexagonal knot (simple-icons path).
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden>
          <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
        </svg>
      )}
      {kind === 'other' && <Bot size={13} aria-hidden />}
    </span>
  )
}

// The hovered/focused glyph's card plus its viewport anchor. One per strip — a
// deliberate scope: hover in one strip and keyboard focus in another CAN show two
// (both accurate); per-strip state keeps the wiring flat.
interface GateTip {
  card: Card
  x: number
  y: number
  // Anchor bottom + flip flag: a glyph near the viewport top has no headroom for
  // an above-tooltip, so it renders below instead (there is no native title attr
  // fallback anymore — a clipped tooltip would leave the gate unidentifiable).
  bottom: number
  below: boolean
}

// Room the above-position needs: tooltip height (3 lines + padding, wrapped
// headline) plus the 7px gap. Below this, flip under the glyph.
const TIP_HEADROOM_PX = 84
// Half the tooltip's max width plus a margin — clamps the centered tooltip inside
// both viewport edges (the sidebar hugs the left; the ≤760px layout can put a
// strip near the right edge too).
const TIP_HALF_W_PX = 130

// One history gate as its stage glyph — a compact, clickable stand-in for the full
// Item row. Hover/focus raises a real tooltip (stage + headline + status · age) via
// the strip; the native title attr was too slow/faint to carry that job (human note,
// results review round 3). aria-label keeps the same info for screen readers, and
// aria-describedby points at the open tooltip so its status · age line is announced.
function GateIcon({ card, selected, describedBy, onTip, onTipClear }: {
  card: Card
  selected: boolean
  describedBy?: string
  onTip: (tip: GateTip) => void
  onTipClear: (cardId: string) => void
}) {
  const Icon = STAGE_ICON[card.stage]
  const orphaned = card.status === 'orphaned'
  const show = (e: { currentTarget: HTMLAnchorElement }): void => {
    const r = e.currentTarget.getBoundingClientRect()
    onTip({ card, x: r.left + r.width / 2, y: r.top, bottom: r.bottom, below: r.top < TIP_HEADROOM_PX })
  }
  const hide = (): void => onTipClear(card.id)
  return (
    <a
      href={`#/card/${card.id}`}
      // No stage color: SHAPE says which gate, COLOR says status — green (decided)
      // by default here since strips hold only resolved gates; gray for orphaned.
      className={`gate-icon${selected ? ' on' : ''}${orphaned ? ' orphaned' : ''}`}
      // The status also goes in the accessible name — the old full row said
      // "orphaned" in text, and the strip must not drop that for screen-reader /
      // keyboard users.
      aria-label={`${STAGE[card.stage].label}: ${card.headline}${orphaned ? ' (orphaned)' : ''}`}
      aria-describedby={describedBy}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <Icon size={18} aria-hidden />
    </a>
  )
}

// A history session's resolved gates as one wrapping row of stage glyphs — the
// compaction that stops a session with many decided gates from burying the sidebar.
// Pending / reconnecting gates never reach here; they stay full Item rows under
// Needs-you (see the section fork in ProjectSection). The tooltip renders fixed
// (escapes the sidebar's overflow), above the glyph normally and below it when
// there's no headroom, x-clamped inside both viewport edges.
function GateStrip({ cards, selectedId }: { cards: Card[]; selectedId: string | null }) {
  const [tip, setTip] = useState<GateTip | null>(null)
  const tipId = useId()
  // A live update can remove or resolve the hovered card out from under the
  // tooltip (the strip is fed by the SSE card feed) — never show a tip whose glyph
  // no longer exists; no boundary event will ever fire to clear it.
  const shownTip = tip && cards.some(c => c.id === tip.card.id) ? tip : null
  // Only the glyph that raised the tip clears it: with hover on one glyph and
  // focus on another, the second's blur/leave must not kill the first's tooltip.
  const clearTip = (cardId: string): void => {
    setTip(t => (t && t.card.id === cardId ? null : t))
  }
  // The anchor is a one-shot snapshot: scrolling moves the glyph but not a fixed
  // tooltip, so any scroll dismisses it (capture — the sidebar's own scroll doesn't
  // bubble to window). Escape dismisses too (WCAG 1.4.13: hoverable content must be
  // dismissable without moving the pointer).
  useEffect(() => {
    if (!shownTip) return
    const clear = (): void => setTip(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clear()
    }
    window.addEventListener('scroll', clear, { capture: true, passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', clear, { capture: true })
      window.removeEventListener('keydown', onKey)
    }
  }, [shownTip])
  return (
    <div className="side-gate-strip">
      {cards.map(c => (
        <GateIcon
          key={c.id}
          card={c}
          selected={c.id === selectedId}
          describedBy={shownTip?.card.id === c.id ? tipId : undefined}
          onTip={setTip}
          onTipClear={clearTip}
        />
      ))}
      {shownTip && (
        <div
          id={tipId}
          className={`gate-tip${shownTip.below ? ' below' : ''}`}
          role="tooltip"
          style={{
            left: Math.min(Math.max(TIP_HALF_W_PX, shownTip.x), document.documentElement.clientWidth - TIP_HALF_W_PX),
            top: shownTip.below ? shownTip.bottom : shownTip.y,
          }}
        >
          <span className="gate-tip-stage">{STAGE[shownTip.card.stage].label}</span>
          <span className="gate-tip-title">{shownTip.card.headline}</span>
          <span className="gate-tip-meta">
            {/* Status word carries its own color (decided = green, orphaned = muted)
                — "not everything gray" (human note, clarify 2026-07-14). */}
            <span className={`gate-tip-status ${shownTip.card.status}`}>{statusLabel(shownTip.card)}</span>
            {' · '}
            {age(shownTip.card.createdAt)}
          </span>
        </div>
      )}
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
  readIds,
}: {
  project: SidebarProjectGroup
  section: string
  projectIndex: number
  selectedId: string | null
  sessions?: SessionVM[]
  entriesBySession: Map<string, Entry[]>
  readIds: Set<string>
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
            // call, results review 2026-07-13). A BOUND session's tags still render
            // in its #/session stream view; an unbound group's tags are intentionally
            // invisible (same duplication verdict — its gates already show as rows/
            // glyphs). sessionEntries feeds the unread dot and the report rows below.
            // Unread dot: readIds is read from localStorage exactly ONCE per render
            // pass (in TaskSidebar), so this is a plain Set lookup per report — O(1)
            // per entry, not a localStorage re-read per entry. Age-implies-read: a
            // report older than readState.READ_TTL_MS counts as read even if its id
            // fell out of (or never entered) storage — see isImplicitlyRead.
            const hasUnreadReport = sessionEntries.some(e => e.type === 'report' && !isImplicitlyRead(e) && !readIds.has(e.id))
            // "When did this session last do something?" — the newest gate or entry.
            // The card COUNT was dropped from the meta line (clarify 2026-07-14): the
            // gates render right below the head, so the number said nothing new.
            const lastActivity = [...session.cards.map(c => c.createdAt), ...sessionEntries.map(e => e.createdAt)]
              .reduce((max, t) => (t > max ? t : max), '')

            return (
              <section key={session.key} className="side-session" role="group" aria-labelledby={sessionHeadingId}>
                {/* Two-line layout: title on its own row (finally readable), meta below —
                    the human couldn't read the title when agent chip + count + button
                    shared one line. No stream/chat affordance at all (round-3 verdict):
                    the bound title already links to the SAME #/session stream view, and
                    reports carry their own rows, so the button was a duplicate. */}
                <div className="side-session-head">
                  <h4 id={sessionHeadingId}>
                    {session.bound
                      ? <a href={`#/session/${encodeURIComponent(session.key)}`}>{session.label}</a>
                      : session.label}
                  </h4>
                  {hasUnreadReport && <span className="side-unread-dot" aria-label="Unread report" />}
                </div>
                <div className="side-session-meta">
                  <AgentMark agent={session.agent} />
                  {vm && <span className={`stream-status stream-status-${vm.sessionStatus}`}>{vm.sessionStatus}</span>}
                  {lastActivity !== '' && <span>{age(lastActivity)}</span>}
                </div>
                {section === 'history'
                  ? session.cards.length > 0 && <GateStrip cards={session.cards} selectedId={selectedId} />
                  : session.cards.map(c => <Item key={c.id} card={c} selected={c.id === selectedId} />)}
                {sessionEntries
                  .filter((e): e is Extract<Entry, { type: 'report' }> => e.type === 'report')
                  .map(e => (
                    <ReportRow key={e.id} entry={e} unread={!isImplicitlyRead(e) && !readIds.has(e.id)} />
                  ))}
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
  readIds,
  orphanEntries = [],
}: {
  cards: Card[]
  section: string
  selectedId: string | null
  sessions?: SessionVM[]
  entriesBySession: Map<string, Entry[]>
  readIds: Set<string>
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
          readIds={readIds}
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

export function TaskSidebar({ cards, selectedId, sessions, entries = [] }: {
  cards: Card[]
  selectedId: string | null
  sessions?: SessionVM[]
  entries?: Entry[]
}) {
  const byNewest = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  // needsHuman, not status === 'pending': a restart-orphaned ("reconnecting") gate
  // is still awaiting the human and must not sink into History (see shared/needsHuman).
  const pending = byNewest.filter(c => needsHuman(c))
  const rest = byNewest.filter(c => !needsHuman(c))

  const entriesBySession = groupEntriesBySession(entries)
  // Entries whose session has NO cards anywhere (pending or history): they get
  // synthesized entry-only groups in the History section below, so every counted
  // report has a surface. Keyed against ALL cards — an entry matching a pending
  // session must not also spawn a history twin.
  const cardSessionKeys = new Set(cards.map(c => sessionKey(c)))
  const orphanEntries = entries.filter(e => !cardSessionKeys.has(entrySessionKey(e)))
  // Re-render when anything (e.g. the #/report/<id> view) marks an entry read —
  // the dots and the aggregate count below read localStorage during render and
  // would otherwise stay stale.
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
      <GroupedCards cards={pending} section="pending" selectedId={selectedId} sessions={sessions} entriesBySession={entriesBySession} readIds={readIds} />

      {(rest.length > 0 || orphanEntries.length > 0) && (
        <div className="side-group"><Archive size={12} aria-hidden />History <span className="n">{rest.length}</span></div>
      )}
      <GroupedCards cards={rest} section="history" selectedId={selectedId} sessions={sessions} entriesBySession={entriesBySession} readIds={readIds} orphanEntries={orphanEntries} />
    </aside>
  )
}
