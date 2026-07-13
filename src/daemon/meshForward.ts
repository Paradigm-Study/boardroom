import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  PLAN_VERDICT_ID,
  PLAN_VERDICTS,
  RESULTS_VERDICT_ID,
  RESULTS_VERDICTS,
  SPEC_VERDICT_ID,
  SPEC_VERDICTS,
  type Card,
} from '../shared/card.js'
import type { Config, MeshConfig } from './config.js'
import { loadMachineIdentity } from './machine.js'
import { MeshOutbox, type MeshOutboxEntry, type MeshOutboxStatus } from './meshOutbox.js'
import type { Queue } from './queue.js'
import type { Store } from './store.js'

// Mesh forwarding remains an optional, privacy-minimized side channel. The
// contract-v0 body is unchanged; team and idempotency live in HTTP headers and
// server-owned relay metadata.
export interface BoardroomLifecycle {
  v: 0
  kind: 'card_event'
  person: string
  device: string
  project: string
  ts: string
  cardId: string
  stage: Card['stage']
  event: 'raised' | 'decided'
  verdict?: string
  artifacts: Array<{ repo: string; path: string }>
  specCriteria?: Array<{ id: string; behavior: string }>
}

export interface MeshPublishEvent {
  type: 'queued' | 'delivered' | 'retrying' | 'terminal'
  idempotencyKey: string
  cardId: string
  event: 'raised' | 'decided'
  seq?: number
  error?: string
}

export interface MeshForwarder {
  mesh: MeshConfig
  stop(): void
  flush(): Promise<void>
  close(): void
  status(): MeshOutboxStatus & {
    configured: true
    teamId: string
    authState?: 'legacy' | 'active' | 'expiring' | 'expired'
    credentialExpiresAt?: string
  }
  listPublishes(limit?: number): MeshOutboxEntry[]
  on(event: 'status', listener: (status: MeshPublishEvent) => void): void
  off(event: 'status', listener: (status: MeshPublishEvent) => void): void
}

function artifactsFor(card: Card): BoardroomLifecycle['artifacts'] {
  const paths: string[] = []
  const seen = new Set<string>()
  const add = (path: string): void => {
    if (seen.has(path)) return
    seen.add(path)
    paths.push(path)
  }
  for (const block of card.blocks) {
    if (block.type === 'diff_stat') for (const file of block.files) add(file.path)
  }
  for (const criterion of card.criteria ?? []) if (criterion.tracesTo.includes('/')) add(criterion.tracesTo)
  for (const block of card.blocks) {
    if (block.type !== 'acceptance') continue
    for (const criterion of block.criteria) if (criterion.tracesTo.includes('/')) add(criterion.tracesTo)
  }
  return paths
    .filter(path => !isSensitiveArtifactPath(path))
    .map(path => ({ repo: redactMeshText(card.session.project, 300), path: redactMeshText(path, 500) }))
}

/** Second privacy fence for the deliberately tiny mesh wire record. */
function redactMeshText(value: string, maxChars = 500): string {
  return value
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[redacted]')
    .replace(/gh[po]_[A-Za-z0-9]{10,}/g, '[redacted]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[redacted]')
    .replace(/xox[bp]-[A-Za-z0-9-]{10,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [redacted]')
    .replace(/(?<![A-Fa-f0-9])[A-Fa-f0-9]{32,}(?![A-Fa-f0-9])/g, '[redacted]')
    .slice(0, maxChars)
}

function isSensitiveArtifactPath(path: string): boolean {
  return path.split(/[\\/]+/).some(segment =>
    /^\.env(?:\..*)?$/i.test(segment)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/i.test(segment)
    || /\.pem$/i.test(segment)
    || /^credentials/i.test(segment),
  )
}

function verdictFor(card: Card): string | undefined {
  if (card.stage === 'plan') {
    const raw = card.answers?.[PLAN_VERDICT_ID]?.chosen[0]
    return PLAN_VERDICTS.find(verdict => verdict === raw)
  }
  if (card.stage === 'spec') {
    const raw = card.answers?.[SPEC_VERDICT_ID]?.chosen[0]
    return SPEC_VERDICTS.find(verdict => verdict === raw)
  }
  if (card.stage === 'results') {
    const raw = card.answers?.[RESULTS_VERDICT_ID]?.chosen[0]
    return RESULTS_VERDICTS.find(verdict => verdict === raw)
  }
  return undefined
}

function lifecycleFor(
  card: Card,
  event: BoardroomLifecycle['event'],
  mesh: MeshConfig,
  device: string,
): BoardroomLifecycle {
  const record: BoardroomLifecycle = {
    v: 0,
    kind: 'card_event',
    person: mesh.person,
    device,
    project: redactMeshText(card.session.project, 300),
    ts: event === 'raised' ? card.createdAt : (card.decidedAt ?? new Date().toISOString()),
    cardId: card.id,
    stage: card.stage,
    event,
    artifacts: artifactsFor(card),
  }
  if (event === 'decided') {
    const verdict = verdictFor(card)
    if (verdict !== undefined) record.verdict = redactMeshText(verdict, 200)
  }
  if (card.stage === 'spec' && card.criteria !== undefined) {
    record.specCriteria = card.criteria.map(criterion => ({
      id: redactMeshText(criterion.id, 200),
      behavior: redactMeshText(criterion.behavior, 1000),
    }))
  }
  return record
}

function stableKey(cardId: string, event: BoardroomLifecycle['event']): string {
  return `boardroom:${cardId}:${event}`
}

type PostResult =
  | { kind: 'delivered'; seq?: number }
  | { kind: 'terminal'; error: string }
  | { kind: 'transient'; error: string }

interface ActiveCredential {
  url: string
  token: string
  person: string
  teamId?: string
  deviceId?: string
  expiresAt?: string
}

export function createMeshForwarder(
  queue: Queue,
  config: Config,
  store?: Store,
): MeshForwarder | undefined {
  const credentialPath = join(config.configDir, 'mesh-credential.json')
  // Cleanup runs even when Team sync is currently disconnected.
  if (existsSync(credentialPath)) rmSync(credentialPath, { force: true })
  const mesh = config.mesh
  if (!mesh) return undefined

  let device = 'unknown'
  try { device = loadMachineIdentity(config.configDir).machineId } catch { /* best effort */ }
  // Older releases cached rotated hosted credentials in plaintext. Desktop is
  // now the sole credential owner and injects them through process env, so a
  // daemon restart is the credential handoff boundary. Remove the legacy cache
  // before any network work; never read a bearer from it.
  const credential: ActiveCredential = { ...mesh }
  device = credential.deviceId ?? device
  const endpoint = (): string =>
    `${credential.url.replace(/\/+$/, '')}/outbox/${encodeURIComponent(credential.person)}`
  const outbox = new MeshOutbox(join(config.configDir, 'mesh-outbox.sqlite'))
  const emitter = new EventEmitter()
  let stopped = false
  let warnedDown = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryMs = 1_000
  let blockedUntil = 0
  let chain: Promise<void> = Promise.resolve()

  const ensureFreshCredential = async (): Promise<PostResult | undefined> => {
    if (!credential.expiresAt || !credential.deviceId) return undefined // legacy static token
    const expires = Date.parse(credential.expiresAt)
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      return { kind: 'transient', error: 'mesh credential expired; desktop re-enrollment and service restart required' }
    }
    if (expires - Date.now() > 5 * 60_000) return undefined
    return { kind: 'transient', error: 'mesh credential is expiring; desktop rotation and service restart required' }
  }

  const emit = (entry: MeshOutboxEntry, type: MeshPublishEvent['type'], extra: Partial<MeshPublishEvent> = {}): void => {
    emitter.emit('status', {
      type,
      idempotencyKey: entry.idempotencyKey,
      cardId: entry.cardId,
      event: entry.event,
      ...extra,
    } satisfies MeshPublishEvent)
  }

  const enqueueRecord = (record: BoardroomLifecycle): void => {
    const idempotencyKey = stableKey(record.cardId, record.event)
    const inserted = outbox.enqueue({
      idempotencyKey,
      cardId: record.cardId,
      event: record.event,
      record: record as unknown as Record<string, unknown>,
      createdAt: record.ts,
    })
    if (inserted) {
      const entry = outbox.list(500).find(item => item.idempotencyKey === idempotencyKey)
      if (entry) emit(entry, 'queued')
    }
  }

  // One-time import of the v0 NDJSON spool. SQLite then owns durability.
  const legacySpool = join(config.configDir, 'mesh-spool.ndjson')
  if (existsSync(legacySpool)) {
    try {
      for (const line of readFileSync(legacySpool, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line) as BoardroomLifecycle
          if (record.kind === 'card_event' && record.v === 0 && record.cardId && record.event) enqueueRecord(record)
        } catch { /* discard corrupt legacy line */ }
      }
      rmSync(legacySpool, { force: true })
    } catch { /* leave it for a future successful import */ }
  }

  // Reconciliation closes the crash window between Boardroom's card commit and
  // its EventEmitter notification. Stable keys make this safe on every boot.
  for (const card of store?.list() ?? []) {
    enqueueRecord(lifecycleFor(card, 'raised', mesh, device))
    if (card.status === 'decided') enqueueRecord(lifecycleFor(card, 'decided', mesh, device))
  }

  const post = async (entry: MeshOutboxEntry): Promise<PostResult> => {
    const renewal = await ensureFreshCredential()
    if (renewal) return renewal
    try {
      const response = await fetch(endpoint(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': entry.idempotencyKey,
          ...(credential.teamId ? { 'X-Mesh-Team-ID': credential.teamId } : {}),
          ...(credential.deviceId ? { 'X-Mesh-Device-ID': credential.deviceId } : {}),
        },
        body: JSON.stringify(entry.record),
        signal: AbortSignal.timeout(2000),
      })
      if (response.ok) {
        const body = await response.json().catch(() => undefined) as { seq?: unknown } | undefined
        return { kind: 'delivered', ...(typeof body?.seq === 'number' ? { seq: body.seq } : {}) }
      }
      const error = `mesh relay returned ${response.status}`
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        return { kind: 'terminal', error }
      }
      return { kind: 'transient', error }
    } catch (error) {
      return { kind: 'transient', error: error instanceof Error ? error.message : String(error) }
    }
  }

  const scheduleRetry = (delayMs: number): void => {
    if (stopped || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      scheduleDrain()
    }, delayMs)
    retryTimer.unref()
  }

  const drain = async (force = false): Promise<void> => {
    if (!force && Date.now() < blockedUntil) return
    for (;;) {
      const entry = outbox.nextQueued()
      if (!entry) return
      const result = await post(entry)
      if (result.kind === 'delivered') {
        outbox.markDelivered(entry.idempotencyKey, result.seq)
        emit(entry, 'delivered', { ...(result.seq === undefined ? {} : { seq: result.seq }) })
        warnedDown = false
        retryMs = 1_000
        blockedUntil = 0
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = undefined
        continue
      }
      if (result.kind === 'terminal') {
        outbox.markTerminal(entry.idempotencyKey, result.error)
        emit(entry, 'terminal', { error: result.error })
        blockedUntil = 0
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = undefined
        continue
      }
      outbox.markTransient(entry.idempotencyKey, result.error)
      emit(entry, 'retrying', { error: result.error })
      if (!warnedDown) {
        warnedDown = true
        console.warn('[mesh] relay unreachable; publish retained in durable outbox')
      }
      const delay = retryMs
      blockedUntil = Date.now() + delay
      scheduleRetry(delay)
      retryMs = Math.min(retryMs * 2, 30_000)
      return // strict ordering: never overtake the oldest transient failure
    }
  }

  function scheduleDrain(force = false): void {
    chain = chain.then(() => drain(force)).catch(() => undefined)
  }

  const onCard = (card: Card): void => {
    try {
      if (card.status === 'pending') enqueueRecord(lifecycleFor(card, 'raised', mesh, device))
      else if (card.status === 'decided') enqueueRecord(lifecycleFor(card, 'decided', mesh, device))
      else return
      scheduleDrain()
    } catch {
      // Queue/card path remains load-bearing; publishing is advisory.
    }
  }
  queue.on('card', onCard)
  scheduleDrain()

  return {
    mesh,
    stop(): void {
      stopped = true
      queue.off('card', onCard)
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = undefined
    },
    flush(): Promise<void> {
      scheduleDrain(true)
      return chain
    },
    close(): void { outbox.close() },
    status: () => {
      const expires = credential.expiresAt ? Date.parse(credential.expiresAt) : undefined
      const authState = expires === undefined
        ? 'legacy'
        : expires <= Date.now()
          ? 'expired'
          : expires - Date.now() <= 5 * 60_000
            ? 'expiring'
            : 'active'
      return {
        ...outbox.status(),
        configured: true,
        teamId: credential.teamId ?? 'legacy-local',
        authState,
        ...(credential.expiresAt ? { credentialExpiresAt: credential.expiresAt } : {}),
      }
    },
    listPublishes: (limit?: number) => outbox.list(limit),
    on: (event, listener) => { emitter.on(event, listener) },
    off: (event, listener) => { emitter.off(event, listener) },
  }
}
