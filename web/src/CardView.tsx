import type { Card } from '../../src/shared/card.js'

export function CardView({ card }: { card: Card }) {
  return <pre>{JSON.stringify(card, null, 2)}</pre>
}
