import { Armchair, BellRing } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { fetchCards, subscribeCards } from './api.js'
import { CardView } from './CardView.js'
import { Inbox } from './Inbox.js'

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

  const pendingCount = [...cards.values()].filter(c => c.status === 'pending').length
  useEffect(() => {
    document.title = pendingCount > 0 ? `(${pendingCount}) boardroom` : 'boardroom'
  }, [pendingCount])

  const cardMatch = hash.match(/^#\/card\/(.+)$/)
  const card = cardMatch ? cards.get(cardMatch[1]) : undefined

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
      {card
        ? <CardView key={`${card.id}:${card.status}`} card={card} />
        : cardMatch
          ? <p>Card not found.</p>
          : <Inbox cards={[...cards.values()]} />}
    </div>
  )
}
