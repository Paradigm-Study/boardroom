import { Armchair, Bell } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { fetchCards, subscribeCards } from './api.js'
import { CardView } from './CardView.js'
import { FileViewer } from './FileViewer.js'
import { parseHash } from './fileView.js'
import { notifyCard, notifyPermission, requestNotify } from './notify.js'
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

export function App() {
  const [cards, setCards] = useState<Map<string, Card>>(new Map())
  const [perm, setPerm] = useState<NotificationPermission>(notifyPermission())
  const [loadError, setLoadError] = useState<string | null>(null)
  const seenPending = useRef<Set<string> | null>(null) // null until first load → no launch burst
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
    }).catch((err: unknown) => {
      // A rejected initial load (daemon down, or the stale-bundle non-JSON case
      // api.ts throws for) otherwise renders identically to the empty "nothing
      // pending" state. Surface it, and still arm dedup so a later streamed card
      // can notify.
      setLoadError(err instanceof Error ? err.message : String(err))
      seenPending.current ??= new Set()
    })
    return subscribeCards(card => {
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
    })
  }, [])

  const all = [...cards.values()]
  const pending = all
    .filter(c => c.status === 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  useEffect(() => {
    document.title = pending.length > 0 ? `(${pending.length}) boardroom` : 'boardroom'
  }, [pending.length])

  const route = parseHash(hash)
  const routed = route.kind === 'card' ? cards.get(route.id) : undefined
  const onRoot = route.kind === 'root'
  const newestPendingId = pending[0]?.id

  // Remember the last dashboard hash so the viewer's Back (and Esc) always lands
  // back on the dashboard — never strands the window on a file, even on a deep link.
  const returnHash = useRef('')
  useEffect(() => {
    if (route.kind !== 'file') returnHash.current = hash
  }, [hash, route.kind])

  useEffect(() => {
    if (onRoot && newestPendingId) {
      history.replaceState(null, '', `#/card/${newestPendingId}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
  }, [onRoot, newestPendingId])

  const shown = routed ?? (onRoot ? pending[0] : undefined)

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

  return (
    <div className="frame">
      <TaskSidebar cards={all} selectedId={shown?.id ?? null} />
      <main className="content">
        {loadError && <p className="error-text" role="alert">{loadError}</p>}
        {perm === 'default' && (
          <button className="enable-alerts" onClick={() => void requestNotify().then(setPerm)}>
            <Bell size={13} aria-hidden /> Enable desktop alerts
          </button>
        )}
        <div className="content-inner">
          {shown
            ? <CardView key={shown.id} card={shown} />
            : route.kind === 'card'
              ? <p style={{ color: 'var(--ink-3)' }}>Card not found.</p>
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
