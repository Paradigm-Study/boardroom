import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Card } from '../../shared/card.js'
import { buildSummary } from '../../daemon/summary.js'
import type { Store } from '../../daemon/store.js'

// The spawn implementation settles exactly one hook: onSuccess when the resumed
// turn EXITS 0, onFailure with a human-readable detail otherwise (launch error,
// non-zero exit, or signal). Delivery is gated on onSuccess — a wake that merely
// launched proves nothing (the 401 era: every resume spawned fine, then died on
// its first API call, and spawn-event stamping consumed the decision anyway).
export interface WakeHooks {
  label?: string
  onSuccess?: () => void
  onFailure?: (detail: string) => void
}
export type SpawnFn = (bin: string, args: string[], cwd: string, hooks?: WakeHooks) => void

interface WakerOpts {
  spawn?: SpawnFn
  claudeBin?: string
  permissionMode?: string
  onWakeFailed?: (card: Card, detail: string) => void
  wakeLogDir?: string
}

// Resumes the agent's Claude Code session when a card it left behind (parked, or
// otherwise orphaned) gets decided. The daemon is an MCP server and cannot push
// the agent, so this spawns an EXTERNAL `claude --resume` from the session's
// absolute cwd — the only legitimate "wake". Guarded reuse of the SAME session:
// one-shot per card, and only for decided-but-undelivered cards (deliveredAt
// unset ⇒ the agent's connection had dropped, so we're not racing a live turn
// that already received the answer). Injecting `spawn` keeps the gating logic
// unit-testable without launching a real CLI.
export class Waker {
  private woken = new Set<string>()
  private spawnFn: SpawnFn
  private claudeBin: string
  private permissionMode: string
  private onWakeFailed?: (card: Card, detail: string) => void

  constructor(private store: Store, opts: WakerOpts = {}) {
    this.spawnFn = opts.spawn ?? makeDefaultSpawn(opts.wakeLogDir ?? join(homedir(), 'Library', 'Logs', 'boardroom-waker'))
    this.claudeBin = opts.claudeBin ?? process.env.BOARDROOM_CLAUDE_BIN ?? '/opt/homebrew/bin/claude'
    this.permissionMode = opts.permissionMode ?? process.env.BOARDROOM_RESUME_PERMISSION ?? 'acceptEdits'
    this.onWakeFailed = opts.onWakeFailed
  }

  // Wire via queue.on('card', card => waker.onCard(card)).
  onCard(card: Card): void {
    if (card.status !== 'decided' || card.deliveredAt) return // live delivery already reached the agent
    if (!card.answers) return
    if (this.woken.has(card.id)) return
    // A plan card is an approval GATE: its verdict must be claimed by the agent
    // re-issuing present_plan (which re-surfaces the app-native approval), never
    // pushed via an unsolicited `claude --resume` — that would auto-resume the
    // agent into building on a late "approve", the exact auto-green-light the gate
    // exists to prevent. (present_plan now parks like clarify/review_results.)
    if (card.stage === 'plan') return
    // Exact spine resolution first: the card knows its owning session. Only
    // legacy cards (pre-spine, no claudeSessionId) fall back to the fail-closed
    // project-basename guess. getSessionByProject returns a row only when exactly
    // one worktree maps to this basename — two same-basename worktrees → undefined
    // → we decline to resume (dashboard copy-paste fallback) rather than risk
    // `claude --resume` editing the wrong tree under acceptEdits.
    const session = card.claudeSessionId
      ? this.store.getRegisteredSession(card.claudeSessionId)
      : this.store.getSessionByProject(card.session.project)
    if (!session) {
      // The "offline-start" case: the SessionStart hook bound this claudeSessionId
      // onto the card, but the daemon never saw a POST /api/session registering it
      // (e.g. the daemon was offline/cold at session start and only came up later).
      // Not a hard failure — the decision stays claimable via reattach — but silent
      // otherwise, so at least log the miss.
      if (card.claudeSessionId) {
        console.warn(`[waker] skip card ${card.id}: claudeSessionId ${card.claudeSessionId} is bound but not registered (offline-start) — reattach still works`)
      }
      return
    }
    // The registry is a trusted-but-unauthenticated write surface, and cwd is the
    // dir we launch `claude --resume` from. Refuse anything that isn't an existing
    // absolute directory rather than spawning into an unpredictable location.
    if (!isAbsolute(session.cwd) || !isExistingDir(session.cwd)) {
      console.warn(`[waker] skip card ${card.id}: session cwd is not an existing absolute directory (${session.cwd})`)
      return
    }
    this.woken.add(card.id)
    const args = ['-p', '--resume', session.sessionId, resumeMessage(card), '--permission-mode', this.permissionMode]
    // Mark the card delivered only when the resumed turn EXITS 0 — a launched
    // process proves nothing (the 401 era: every resume spawned, then died on its
    // first API call, and spawn-stamping consumed the decision unread). Leaving a
    // failed wake undelivered is safe because reattach claims are scoped to the
    // card's own claudeSessionId — the only session that can reclaim the verdict
    // is the one we just failed to wake. Corollary: if the daemon restarts while
    // the resumed turn is still running, the exit event is lost and the card stays
    // claimable — worst case the same session receives its own verdict twice.
    this.spawnFn(this.claudeBin, args, session.cwd, {
      label: card.id,
      onSuccess: () => this.markDelivered(card.id),
      onFailure: detail => {
        console.warn(`[waker] wake FAILED for card ${card.id} ("${card.headline}") — decision NOT delivered; still claimable via reattach and dashboard copy-paste. ${detail}`)
        // The handler runs inside a ChildProcess event; letting it throw would be
        // an uncaughtException that takes the daemon down over a lost toast.
        try {
          this.onWakeFailed?.(card, detail)
        } catch (err) {
          console.warn(`[waker] onWakeFailed handler failed: ${(err as Error).message}`)
        }
      },
    })
  }

  private markDelivered(cardId: string): void {
    try {
      const fresh = this.store.get(cardId)
      if (fresh?.status === 'decided' && !fresh.deliveredAt) {
        this.store.update({ ...fresh, deliveredAt: new Date().toISOString() })
      }
    } catch (err) {
      console.warn(`[waker] could not mark card ${cardId} delivered: ${(err as Error).message}`)
    }
  }
}

function resumeMessage(card: Card): string {
  const summary = buildSummary(card, card.answers ?? {})
  return (
    `The human decided on the boardroom (card ${card.id}, "${card.headline}"). ` +
    'Continue the work you paused, using this decision. Do NOT re-call the boardroom tool for it — the decision is below.\n\n' +
    summary
  )
}

function isExistingDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const STDERR_TAIL_BYTES = 2048
const WAKE_LOG_RETENTION_MS = 30 * 24 * 60 * 60_000

// The child stays detached (the resumed turn outlives the daemon and must never
// block or crash it), but its stderr goes to a per-wake FILE rather than a pipe:
// a pipe back into this process would break on a daemon restart mid-turn (EPIPE
// could kill the resumed session), and the file survives for forensics. The log
// is removed on a clean exit and kept on failure — except when the daemon dies
// before the exit event, which strands the log; the boot-time sweep below bounds
// that accumulation.
export function makeDefaultSpawn(logDir: string): SpawnFn {
  sweepStaleWakeLogs(logDir)
  return (bin, args, cwd, hooks) => {
    let logPath: string | undefined
    let fd: number | undefined
    try {
      mkdirSync(logDir, { recursive: true })
      logPath = join(logDir, `wake-${hooks?.label ?? Date.now()}.log`)
      fd = openSync(logPath, 'w')
    } catch (err) {
      // Best-effort (a wake without stderr capture beats no wake), but never
      // silent: an amputated forensic channel must be visible in the daemon log.
      console.warn(`[waker] stderr capture unavailable (${(err as Error).message}) — wake proceeds without forensics`)
      logPath = undefined
    }
    const closeFd = () => {
      if (fd === undefined) return
      try { closeSync(fd) } catch { /* already closed */ }
      fd = undefined
    }
    const removeLog = () => {
      if (!logPath) return
      try { unlinkSync(logPath) } catch { /* best-effort */ }
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', fd ?? 'ignore'], detached: true })
    } catch (err) {
      // A synchronous spawn throw would otherwise propagate through the queue's
      // 'card' emit into the decide HTTP handler — 500ing a decision that was
      // already persisted and resolved.
      closeFd()
      removeLog()
      hooks?.onFailure?.(`could not spawn ${bin}: ${(err as Error).message}`)
      return
    }
    let settled = false // 'error' may or may not be followed by 'exit'; first signal wins
    child.on('spawn', closeFd)
    child.on('error', err => {
      if (settled) return
      settled = true
      closeFd()
      removeLog() // nothing ran, nothing written
      hooks?.onFailure?.(`could not spawn ${bin}: ${err.message}`)
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      closeFd()
      if (code === 0) {
        removeLog()
        hooks?.onSuccess?.()
        return
      }
      hooks?.onFailure?.(`${bin} exited ${code ?? `on signal ${signal}`}${stderrTail(logPath)}`)
    })
    child.unref()
  }
}

function stderrTail(logPath: string | undefined): string {
  if (!logPath) return ''
  try {
    const buf = readFileSync(logPath)
    if (buf.length === 0) return ` (no stderr; log kept at ${logPath})`
    const tail = buf.subarray(-STDERR_TAIL_BYTES).toString('utf8').trim()
    return `; stderr tail (log kept at ${logPath}): ${tail}`
  } catch (err) {
    // The kept file is the whole forensic trail — even unreadable, point at it.
    return ` (stderr log ${logPath} unreadable: ${(err as Error).message})`
  }
}

// Bounds the accumulation of stranded wake logs (a daemon restart mid-turn loses
// the exit event that would have cleaned a successful wake's log). Runs once per
// construction; only touches files matching our own naming scheme.
function sweepStaleWakeLogs(logDir: string): void {
  try {
    const cutoff = Date.now() - WAKE_LOG_RETENTION_MS
    for (const name of readdirSync(logDir)) {
      if (!name.startsWith('wake-') || !name.endsWith('.log')) continue
      const path = join(logDir, name)
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
      } catch { /* best-effort per file */ }
    }
  } catch { /* dir absent on first boot — nothing to sweep */ }
}
