import { Armchair, Bell } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import type { Entry } from '../../src/shared/entry.js'
import type { SessionVM } from './api.js'
import { fetchCards, fetchEntries, fetchSessions, subscribeStream } from './api.js'
import { CardView } from './CardView.js'
import { FileViewer } from './FileViewer.js'
import { FolderColumns } from './FolderColumns.js'
import { parseHash } from './fileView.js'
import { needsHuman } from './helpers.js'
import { notifyCard, notifyPermission, requestNotify } from './notify.js'
import { SessionStream } from './SessionStream.js'
import { TaskSidebar } from './TaskSidebar.js'

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onChange = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash
}

function sessionScrollKey(card: Card): string {
  return card.claudeSessionId ?? `${card.session.project}\u0000${card.session.title?.trim() || 'Untitled session'}\u0000${card.session.agent}`
}

interface SessionScrollEntry {
  top: number
  updatedAt: number
}

const SESSION_SCROLL_STORAGE_KEY = 'boardroom.sessionScroll.v1'
const SESSION_SCROLL_TTL_MS = 14 * 24 * 60 * 60_000
const SESSION_SCROLL_MAX_ENTRIES = 200

function readSessionScroll(now = Date.now()): Map<string, SessionScrollEntry> {
  try {
    const raw = window.sessionStorage.getItem(SESSION_SCROLL_STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()

    const entries = new Map<string, SessionScrollEntry>()
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      const { top, updatedAt } = value as { top?: unknown; updatedAt?: unknown }
      if (typeof top !== 'number' || !Number.isFinite(top)) continue
      if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue
      if (now - updatedAt > SESSION_SCROLL_TTL_MS) continue
      entries.set(key, { top: Math.max(0, top), updatedAt })
    }
    return entries
  } catch {
    return new Map()
  }
}

function pruneExpiredSessionScroll(entries: Map<string, SessionScrollEntry>, now = Date.now()): void {
  for (const [key, entry] of entries) {
    if (now - entry.updatedAt > SESSION_SCROLL_TTL_MS) entries.delete(key)
  }
}

function writeSessionScroll(entries: Map<string, SessionScrollEntry>): void {
  try {
    pruneExpiredSessionScroll(entries)
    const ordered = [...entries.entries()]
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, SESSION_SCROLL_MAX_ENTRIES)
    window.sessionStorage.setItem(SESSION_SCROLL_STORAGE_KEY, JSON.stringify(Object.fromEntries(ordered)))
  } catch {
    // Scroll memory is a convenience; the dashboard must keep working if storage
    // is unavailable or quota-restricted.
  }
}

function saveSessionScroll(entries: Map<string, SessionScrollEntry>, key: string, top: number): void {
  entries.set(key, { top: Math.max(0, Math.round(top)), updatedAt: Date.now() })
  writeSessionScroll(entries)
}

export function App() {
  const [cards, setCards] = useState<Map<string, Card>>(new Map())
  // Populated by the initial fetch + SSE below; rendered by SessionStream (merged
  // with cards) on the #/session/<id> route.
  const [entries, setEntries] = useState<Map<string, Entry>>(new Map())
  const [sessions, setSessions] = useState<SessionVM[] | null>(null)
  const [perm, setPerm] = useState<NotificationPermission>(notifyPermission())
  const [loadError, setLoadError] = useState<string | null>(null)
  // False until the initial fetch settles: a deep link must show "loading", never a
  // premature "Card not found." while the card list is still in flight.
  const [initialLoadDone, setInitialLoadDone] = useState(false)
  const seenPending = useRef<Set<string> | null>(null) // null until first load → no launch burst
  const sessionScroll = useRef<Map<string, SessionScrollEntry>>(readSessionScroll())
  const activeSessionKey = useRef<string | null>(null)
  const routeSavedSessionKey = useRef<string | null>(null)
  const hash = useHashRoute()

  useEffect(() => {
    fetchCards().then(list => {
      // Merge, don't replace: the EventSource may already have delivered a card
      // (via the setCards below) in the window before this GET resolved. A blind
      // `new Map(list)` would clobber it. Keep any id already present (it's at
      // least as fresh as the fetched copy) and only fill in the rest.
      setCards(prev => {
        const merged = new Map(prev)
        for (const c of list) if (!merged.has(c.id)) merged.set(c.id, c)
        // Seed the notification-dedup set from the MERGED pending ids, not just
        // `list`: a card the stream delivered during this load window is already
        // in `merged` and must count as seen — the same race the merge guards.
        seenPending.current = new Set([...merged.values()].filter(c => c.status === 'pending').map(c => c.id))
        return merged
      })
      setLoadError(null)
      setInitialLoadDone(true)
    }).catch((err: unknown) => {
      // A rejected initial load (daemon down, or the stale-bundle non-JSON case
      // api.ts throws for) otherwise renders identically to the empty "nothing
      // pending" state. Surface it, and still arm dedup so a later streamed card
      // can notify.
      setLoadError(err instanceof Error ? err.message : String(err))
      seenPending.current ??= new Set()
      setInitialLoadDone(true)
    })
    fetchEntries().then(list => {
      // Same merge-don't-replace reasoning as the cards fetch above: an entry may
      // already have arrived over SSE before this GET resolves.
      setEntries(prev => {
        const merged = new Map(prev)
        for (const e of list) if (!merged.has(e.id)) merged.set(e.id, e)
        return merged
      })
    }).catch((err: unknown) => {
      // Entries are supplementary; the cards fetch above already surfaces load
      // errors to the human, so this is a log-only signal for diagnosis.
      console.warn('[boardroom] failed to fetch entries', err)
    })
    return subscribeStream(
      card => {
        setCards(prev => new Map(prev).set(card.id, card))
        setLoadError(null) // a live event means the stream is connected
        const seen = seenPending.current
        if (!seen) return
        if (card.status === 'pending' && !seen.has(card.id)) {
          seen.add(card.id)
          notifyCard(card)
        } else if (card.status !== 'pending') {
          seen.delete(card.id)
        }
      },
      // Entries are one-way conveyed items (reports/tags), never gates — no
      // notifyCard, no seenPending. Tray separation (spec criterion): a report
      // must never toast like a pending card does.
      entry => {
        setEntries(prev => new Map(prev).set(entry.id, entry))
      },
      // Stream connectivity drives the same banner; it clears on reconnect ('open').
      online => setLoadError(online ? null : 'Lost the live connection to the daemon — reconnecting…'),
    )
  }, [])

  const all = [...cards.values()]
  // needsHuman, not status === 'pending': a restart-orphaned ("reconnecting") gate is
  // still awaiting the human — it must count in the title badge and participate in
  // auto-open, agreeing with the tray and the sidebar's Needs-you bucket.
  const pending = all
    .filter(c => needsHuman(c))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  useEffect(() => {
    document.title = pending.length > 0 ? `(${pending.length}) boardroom` : 'boardroom'
  }, [pending.length])

  useEffect(() => {
    const saveActiveScroll = (routeChange = false): void => {
      const key = activeSessionKey.current
      if (!key) return
      saveSessionScroll(sessionScroll.current, key, window.scrollY)
      if (routeChange) routeSavedSessionKey.current = key
    }
    const saveForRoute = (): void => saveActiveScroll(true)
    const saveForLifecycle = (): void => saveActiveScroll()
    const saveWhenHidden = (): void => {
      if (document.visibilityState === 'hidden') saveActiveScroll()
    }

    window.addEventListener('hashchange', saveForRoute)
    window.addEventListener('pagehide', saveForLifecycle)
    window.addEventListener('beforeunload', saveForLifecycle)
    document.addEventListener('visibilitychange', saveWhenHidden)
    return () => {
      window.removeEventListener('hashchange', saveForRoute)
      window.removeEventListener('pagehide', saveForLifecycle)
      window.removeEventListener('beforeunload', saveForLifecycle)
      document.removeEventListener('visibilitychange', saveWhenHidden)
    }
  }, [])

  const route = parseHash(hash)
  // An anchor hash (#block-…) is a scroll within the card that is already open —
  // keep rendering that card (tracked below) instead of treating it as a route.
  const lastCardRouteId = useRef<string | null>(null)
  const routedId = route.kind === 'card' ? route.id : route.kind === 'anchor' ? lastCardRouteId.current : null
  const routed = routedId != null ? cards.get(routedId) : undefined
  const onRoot = route.kind === 'root'
  const newestPendingId = pending[0]?.id

  useEffect(() => {
    if (route.kind === 'card') lastCardRouteId.current = route.id
  }, [hash]) // eslint-disable-line react-hooks/exhaustive-deps -- route derives from hash

  // Remember the last dashboard hash so the viewer's Back (and Esc) always lands
  // back on the dashboard — never strands the window on a file, even on a deep link.
  const returnHash = useRef('')
  useEffect(() => {
    if (route.kind !== 'file' && route.kind !== 'folders') returnHash.current = hash
  }, [hash, route.kind])

  // Sessions now feed the sidebar's status tags on every route, not just the Folders
  // overlay — so this always polls. The Folders overlay and the session stream view
  // both want fresher data (the capturer reconciles every 5s) while they're open;
  // everywhere else a slower cadence is plenty since it's only feeding status chips.
  useEffect(() => {
    const load = (): void => { void fetchSessions().then(setSessions).catch(() => { /* sidebar/overlay show last-known */ }) }
    load()
    const fast = route.kind === 'folders' || route.kind === 'session'
    const timer = setInterval(load, fast ? 4000 : 15000)
    return () => clearInterval(timer)
  }, [route.kind])

  useEffect(() => {
    if (onRoot && newestPendingId) {
      history.replaceState(null, '', `#/card/${newestPendingId}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
  }, [onRoot, newestPendingId])

  const shown = routed ?? (onRoot ? pending[0] : undefined)
  const shownSessionKey = shown ? sessionScrollKey(shown) : null

  useLayoutEffect(() => {
    const previousSessionKey = activeSessionKey.current
    if (previousSessionKey && previousSessionKey !== shownSessionKey && routeSavedSessionKey.current !== previousSessionKey) {
      saveSessionScroll(sessionScroll.current, previousSessionKey, window.scrollY)
    }
    routeSavedSessionKey.current = null
    activeSessionKey.current = shownSessionKey
    if (!shownSessionKey) return

    const top = sessionScroll.current.get(shownSessionKey)?.top ?? 0
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ left: 0, top, behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [shownSessionKey])

  if (route.kind === 'file') {
    return (
      <FileViewer
        url={route.url}
        name={route.name}
        mime={route.mime}
        onClose={() => { window.location.hash = returnHash.current }}
      />
    )
  }

  if (route.kind === 'folders') {
    return (
      <FolderColumns
        sessions={sessions}
        onClose={() => { window.location.hash = returnHash.current }}
      />
    )
  }

  if (route.kind === 'session') {
    const vm = sessions?.find(s => s.sessionId === route.id) ?? null
    const own = all
      .filter(c => c.claudeSessionId === route.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const ownEntries = [...entries.values()]
      .filter(e => e.claudeSessionId === route.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return (
      <div className="frame">
        <TaskSidebar cards={all} selectedId={null} sessions={sessions ?? undefined} entries={[...entries.values()]} />
        <main className="content"><div className="content-inner">
          <SessionStream session={vm} cards={own} entries={ownEntries} />
        </div></main>
      </div>
    )
  }

  return (
    <div className="frame">
      <TaskSidebar cards={all} selectedId={shown?.id ?? null} sessions={sessions ?? undefined} entries={[...entries.values()]} />
      <main className="content">
        {loadError && <p className="error-text" role="alert">{loadError}</p>}
        {perm === 'default' && (
          <button className="enable-alerts" onClick={() => void requestNotify().then(setPerm)}>
            <Bell size={13} aria-hidden /> Enable desktop alerts
          </button>
        )}
        <div className="content-inner">
          {shown
            ? <CardView key={shown.id} card={shown} cards={all} />
            : route.kind === 'card'
              ? <p style={{ color: 'var(--ink-3)' }}>{initialLoadDone ? 'Card not found.' : 'Loading…'}</p>
              : (
                <div className="zero">
                  <Armchair size={36} strokeWidth={1.4} aria-hidden />
                  <h2>The table is clear</h2>
                  <p>When an agent needs a decision, the task appears on the left and a notification finds you.</p>
                </div>
              )}
        </div>
      </main>
    </div>
  )
}
