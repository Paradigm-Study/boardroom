import type { Card, DecisionAnswer } from '../../src/shared/card.js'

async function check<T>(res: globalThis.Response): Promise<T> {
  const body = await res.json()
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

export async function fetchCards(): Promise<Card[]> {
  return check(await fetch('/api/cards'))
}

export async function decideCard(
  id: string,
  answers: Record<string, DecisionAnswer>,
): Promise<{ card: Card; summary: string; delivered: boolean }> {
  const res = await fetch(`/api/cards/${id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  })
  return check(res)
}

export function subscribeCards(onCard: (card: Card) => void): () => void {
  const es = new EventSource('/events')
  es.addEventListener('card', e => onCard(JSON.parse((e as MessageEvent).data) as Card))
  return () => es.close()
}
