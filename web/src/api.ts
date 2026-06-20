import type { AttachmentRef, Card, DecideResponse, DecisionAnswer } from '../../src/shared/card.js'

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
): Promise<DecideResponse> {
  const res = await fetch(`/api/cards/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  })
  return check(res)
}

export async function uploadAttachment(
  cardId: string,
  answerId: string,
  field: string,
  file: File,
): Promise<AttachmentRef> {
  const res = await fetch(`/api/cards/${encodeURIComponent(cardId)}/attachments`, {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-answer-id': answerId,
      'x-field': field,
      // Percent-encode so a non-ASCII file name survives the latin1 header (a raw
      // "café.png" would make fetch throw on an invalid header value).
      'x-file-name': encodeURIComponent(file.name || 'upload.bin'),
    },
    body: file,
  })
  return check(res)
}

export function subscribeCards(
  onCard: (card: Card) => void,
  onError?: (e: Event) => void,
): () => void {
  const es = new EventSource('/events')
  es.addEventListener('card', e => {
    // A malformed frame must not throw into the EventSource dispatcher (where it
    // would be swallowed and that card silently lost) — log and skip it.
    try {
      onCard(JSON.parse((e as MessageEvent).data) as Card)
    } catch (err) {
      console.warn('[boardroom] dropped a malformed card event', err)
    }
  })
  // EventSource auto-reconnects on transient drops, but a daemon that is down at
  // load or out for a while leaves it failed with no UI signal — surface it.
  es.addEventListener('error', e => {
    console.warn('[boardroom] card stream error', e)
    onError?.(e)
  })
  return () => es.close()
}
