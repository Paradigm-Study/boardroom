import type { AttachmentRef, Card, DecideResponse, DecisionAnswer } from '../../src/shared/card.js'
import type { Entry } from '../../src/shared/entry.js'
import type { CapturedSession } from '../../src/shared/session.js'

export interface DeviceIdentity {
  machineId: string
  deviceLabel: string
}

// The "Connect your Claude account" status. Mirrors the daemon's AuthStatus +
// ConnectStatus (kept local like DeviceIdentity, not imported) — never the token.
export interface AuthStatusVM {
  connected: boolean
  type?: 'oauth' | 'apiKey'
  updatedAt?: string
  // The stored login went bad after connect (a wake hit an auth error) — the UI
  // says "expired, reconnect" instead of the first-time connect wording.
  stale?: boolean
  login: { state: 'idle' | 'running' | 'connected' | 'failed'; url?: string; detail?: string; awaitingCode?: boolean }
}

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

// A captured session plus the dashboard-facing rollup the daemon derives from its
// cards: sessionStatus (the sidebar's status chip), and the pending/total card
// counts. Read-only; the Folders view and the sidebar/stream view both consume it.
export type SessionVM = CapturedSession & {
  sessionStatus: 'needs-decision' | 'awaiting-review' | 'running' | 'idle' | 'ended'
  pendingCount: number
  cardCount: number
}

// Every Claude Code session the daemon has captured on this machine (alive + ended).
export async function fetchSessions(): Promise<SessionVM[]> {
  return check(await fetch('/api/sessions'))
}

// The report/tag stream, FIFO (createdAt ascending) — backs the dashboard's report
// feed. Distinct from cards: an entry is a one-way conveyed item, never a gate.
export async function fetchEntries(): Promise<Entry[]> {
  return check(await fetch('/api/entries'))
}

// This machine's identity — the editable device nickname is shown in the Folders view.
export async function fetchDevice(): Promise<DeviceIdentity> {
  return check(await fetch('/api/device'))
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

// Boardroom-scoped soft delete: retire a stranded/unwanted card. Returns the
// dismissed card; the SSE 'card' event (status 'dismissed') then drops it from every
// surface. Never touches the agent session.
export async function dismissCard(id: string): Promise<Card> {
  const res = await fetch(`/api/cards/${encodeURIComponent(id)}/dismiss`, { method: 'POST' })
  return (await check<{ card: Card }>(res)).card
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

// "Connect your Claude account" — lets boardroom hold a durable resume credential
// so the background waker can authenticate. All return the fresh status. The routes
// only exist when the daemon wired an authStore; getAuthStatus tolerates the 404 by
// letting the caller treat a throw as "feature unavailable".
export async function getAuthStatus(): Promise<AuthStatusVM> {
  return check(await fetch('/api/auth/status'))
}

// Start the browser-driven login (`claude setup-token`). Poll getAuthStatus until
// login.state settles on 'connected' or 'failed'.
export async function connectAuth(): Promise<AuthStatusVM> {
  return check(await fetch('/api/auth/connect', { method: 'POST' }))
}

export async function cancelAuthConnect(): Promise<AuthStatusVM> {
  return check(await fetch('/api/auth/connect/cancel', { method: 'POST' }))
}

// Relay the OAuth code the user pasted from the browser callback into the login.
export async function sendAuthConnectInput(code: string): Promise<AuthStatusVM> {
  return check(await fetch('/api/auth/connect/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }))
}

// Paste path: store a token the user generated themselves.
export async function postAuthToken(type: 'oauth' | 'apiKey', value: string): Promise<AuthStatusVM> {
  return check(await fetch('/api/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, value }),
  }))
}

export async function disconnectAuth(): Promise<AuthStatusVM> {
  return check(await fetch('/api/auth/disconnect', { method: 'POST' }))
}

// ONE EventSource for the whole dashboard: cards and entries are independent
// listeners on the same '/events' stream (the SSE model is listener-per-event-type,
// not stream-per-consumer), so a card-only and an entry-only caller never fight
// over the connection.
export function subscribeStream(
  onCard: (card: Card) => void,
  onEntry?: (entry: Entry) => void,
  onStatus?: (online: boolean) => void,
): () => void {
  const es = new EventSource('/events')
  // 'open' fires on the initial connect and every auto-reconnect, so the caller's
  // offline indicator self-clears on recovery.
  es.addEventListener('open', () => onStatus?.(true))
  es.addEventListener('card', e => {
    // A malformed frame must not throw into the EventSource dispatcher (where it
    // would be swallowed and that card silently lost) — log and skip it.
    try {
      onCard(JSON.parse((e as MessageEvent).data) as Card)
    } catch (err) {
      console.warn('[boardroom] dropped a malformed card event', err)
    }
  })
  es.addEventListener('entry', e => {
    // Same malformed-frame guard as the card listener above — one bad entry frame
    // must not take down the whole stream.
    try {
      onEntry?.(JSON.parse((e as MessageEvent).data) as Entry)
    } catch (err) {
      console.warn('[boardroom] dropped a malformed entry event', err)
    }
  })
  // EventSource auto-reconnects on transient drops, but a daemon that is down at
  // load or out for a while leaves it failed with no UI signal — surface it.
  es.addEventListener('error', e => {
    console.warn('[boardroom] card stream error', e)
    onStatus?.(false)
  })
  return () => es.close()
}

// Thin wrapper kept for existing tests/callers that only care about cards — a
// no-op onEntry so nothing else breaks.
export function subscribeCards(
  onCard: (card: Card) => void,
  onStatus?: (online: boolean) => void,
): () => void {
  return subscribeStream(onCard, undefined, onStatus)
}
