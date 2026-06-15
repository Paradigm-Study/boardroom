import type { Card, DecisionAnswer } from '../../src/shared/card.js'

async function check<T>(res: globalThis.Response): Promise<T> {
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Non-JSON (e.g. an HTML 404 page) — usually a dashboard tab left open
    // across a daemon update calling a route that has since moved.
    throw new Error(`Boardroom returned a non-JSON response (HTTP ${res.status}). The dashboard may be out of date — reload the page.`)
  }
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
