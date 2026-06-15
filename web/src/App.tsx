import { Armchair, Bell } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { fetchCards, subscribeCards } from './api.js'
import { CardView } from './CardView.js'
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
  const seenPending = useRef<Set<string> | null>(null) // null until first load → no launch burst
  const hash = useHashRoute()

  useEffect(() => {
    void fetchCards().then(list => {
      setCards(new Map(list.map(c => [c.id, c])))
      seenPending.current = new Set(list.filter(c => c.status === 'pending').map(c => c.id))
    })
    return subscribeCards(card => {
      setCards(prev => new Map(prev).set(card.id, card))
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

  const routeId = hash.match(/^#\/card\/(.+)$/)?.[1] ?? null
  const routed = routeId ? cards.get(routeId) : undefined
  const onRoot = routeId === null
  const newestPendingId = pending[0]?.id

  useEffect(() => {
    if (onRoot && newestPendingId) {
      history.replaceState(null, '', `#/card/${newestPendingId}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }
  }, [onRoot, newestPendingId])

  const shown = routed ?? (onRoot ? pending[0] : undefined)

  return (
    <div className="frame">
      <TaskSidebar cards={all} selectedId={shown?.id ?? null} />
      <main className="content">
        {perm === 'default' && (
          <button className="enable-alerts" onClick={() => void requestNotify().then(setPerm)}>
            <Bell size={13} aria-hidden /> Enable desktop alerts
          </button>
        )}
        <div className="content-inner">
          {shown
            ? <CardView key={shown.id} card={shown} />
            : routeId
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
