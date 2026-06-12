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
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 24 }}>
        <a href="#/" style={{ fontSize: 20, fontWeight: 600, textDecoration: 'none', color: 'inherit' }}>boardroom</a>
        {pendingCount > 0 && <span style={{ fontSize: 13, opacity: 0.7 }}>{pendingCount} pending</span>}
      </header>
      {card
        ? <CardView key={`${card.id}:${card.status}`} card={card} />
        : cardMatch
          ? <p>Card not found.</p>
          : <Inbox cards={[...cards.values()]} />}
    </div>
  )
}
