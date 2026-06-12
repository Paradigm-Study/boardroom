import { Armchair, BellRing } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { fetchCards, subscribeCards } from './api.js'
import { CardView } from './CardView.js'
import { Inbox } from './Inbox.js'
import { SessionRail } from './SessionRail.js'
import { deriveSessions } from './sessions.js'

function useHashRoute() {
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
  const hash = useHashRoute()

  useEffect(() => {
    void fetchCards().then(list => setCards(new Map(list.map(c => [c.id, c]))))
    return subscribeCards(card =>
      setCards(prev => new Map(prev).set(card.id, card)),
    )
  }, [])

  const all = [...cards.values()]
  const pendingCount = all.filter(c => c.status === 'pending').length
  useEffect(() => {
    document.title = pendingCount > 0 ? `(${pendingCount}) boardroom` : 'boardroom'
  }, [pendingCount])

  const cardMatch = hash.match(/^#\/card\/(.+)$/)
  const sessMatch = hash.match(/^#\/s\/(.+)$/)
  const selectedSession = sessMatch ? decodeURIComponent(sessMatch[1]) : null
  const card = cardMatch ? cards.get(cardMatch[1]) : undefined

  const sessions = deriveSessions(all)
  const visible = selectedSession ? all.filter(c => c.session.project === selectedSession) : all
  const railSelection = card ? card.session.project : selectedSession

  return (
    <div className="shell">
      <header className="topbar">
        <a href="#/" className="wordmark">
          <Armchair size={24} strokeWidth={1.8} aria-hidden />
          boardroom
        </a>
        {pendingCount > 0 && (
          <span className="pending-chip">
            <span className="pulse" />
            {pendingCount} waiting on you
          </span>
        )}
        <span className="topbar-spacer" />
        <span className="topbar-hint">
          <BellRing size={13} aria-hidden />
          agents are held until you decide
        </span>
      </header>
      <div className="layout">
        <SessionRail sessions={sessions} selected={railSelection} />
        <main className="main-col">
          {card
            ? <CardView key={`${card.id}:${card.status}`} card={card} />
            : cardMatch
              ? <p>Card not found.</p>
              : <Inbox cards={visible} />}
        </main>
      </div>
    </div>
  )
}
