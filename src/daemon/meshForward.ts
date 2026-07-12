import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import type { Queue } from './queue.js'

// Mesh forwarding is an optional, fire-and-forget side channel. When configured,
// card lifecycle transitions are reduced to a deliberately small privacy-safe
// record, delivered in order, and spooled locally while the relay is unavailable.
// With no mesh config, nothing subscribes and nothing leaves the machine.

interface BoardroomLifecycle {
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

export interface MeshForwarder {
  mesh: MeshConfig
  stop(): void
  flush(): Promise<void>
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
    if (block.type === 'diff_stat') {
      for (const file of block.files) add(file.path)
    }
  }
  for (const criterion of card.criteria ?? []) {
    if (criterion.tracesTo.includes('/')) add(criterion.tracesTo)
  }
  for (const block of card.blocks) {
    if (block.type !== 'acceptance') continue
    for (const criterion of block.criteria) {
      if (criterion.tracesTo.includes('/')) add(criterion.tracesTo)
    }
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

export function createMeshForwarder(queue: Queue, config: Config): MeshForwarder | undefined {
  const mesh = config.mesh
  if (!mesh) return undefined

  let device = 'unknown'
  try {
    device = loadMachineIdentity(config.configDir).machineId
  } catch {
    // Identity creation is best-effort; forwarding must never break the daemon.
  }

  const endpoint = `${mesh.url.replace(/\/+$/, '')}/outbox/${encodeURIComponent(mesh.person)}`
  const spoolPath = join(config.configDir, 'mesh-spool.ndjson')
  const raised = new Set<string>()
  const decided = new Set<string>()
  let warnedDown = false
  let chain: Promise<void> = Promise.resolve()

  const post = async (record: BoardroomLifecycle): Promise<boolean> => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mesh.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(2000),
      })
      if (!response.ok) throw new Error(`mesh relay returned ${response.status}`)
      warnedDown = false
      return true
    } catch {
      if (!warnedDown) {
        warnedDown = true
        console.warn('[mesh] relay unreachable...')
      }
      return false
    }
  }

  const loadSpool = (): BoardroomLifecycle[] => {
    if (!existsSync(spoolPath)) return []
    let contents: string
    try {
      contents = readFileSync(spoolPath, 'utf8')
    } catch {
      return []
    }

    const records: BoardroomLifecycle[] = []
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line) as BoardroomLifecycle)
      } catch {
        // Corrupt lines are intentionally discarded instead of blocking replay.
      }
    }
    return records
  }

  const rewriteSpool = (records: BoardroomLifecycle[]): void => {
    if (records.length === 0) {
      rmSync(spoolPath, { force: true })
      return
    }
    writeFileSync(spoolPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
  }

  const send = async (current: BoardroomLifecycle): Promise<void> => {
    const spooled = loadSpool()
    let kept: BoardroomLifecycle[] = []

    for (let index = 0; index < spooled.length; index += 1) {
      if (await post(spooled[index])) continue
      kept = spooled.slice(index)
      break
    }

    if (!(await post(current))) kept.push(current)
    rewriteSpool(kept)
  }

  const onCard = (card: Card): void => {
    try {
      let event: BoardroomLifecycle['event']
      let forwarded: Set<string>
      if (card.status === 'pending') {
        event = 'raised'
        forwarded = raised
      } else if (card.status === 'decided') {
        event = 'decided'
        forwarded = decided
      } else {
        return
      }

      if (forwarded.has(card.id)) return
      const record = lifecycleFor(card, event, mesh, device)
      forwarded.add(card.id)
      chain = chain.then(() => send(record)).catch(() => {})
    } catch {
      // The queue path is load-bearing; mesh mapping remains best-effort.
    }
  }

  queue.on('card', onCard)

  return {
    mesh,
    stop(): void {
      queue.off('card', onCard)
    },
    flush(): Promise<void> {
      return chain
    },
  }
}
