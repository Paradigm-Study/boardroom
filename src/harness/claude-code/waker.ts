import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Card } from '../../shared/card.js'
import { buildSummary } from '../../daemon/summary.js'
import type { Store } from '../../daemon/store.js'

// onSpawned fires once the child process actually started (Node's 'spawn' event) —
// the waker uses it to mark the card delivered. A failed launch (ENOENT etc.) must
// NOT mark: the decision then stays claimable via reattach instead of vanishing.
export type SpawnFn = (bin: string, args: string[], cwd: string, onSpawned?: () => void) => void

interface WakerOpts {
  spawn?: SpawnFn
  claudeBin?: string
  permissionMode?: string
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

  constructor(private store: Store, opts: WakerOpts = {}) {
    this.spawnFn = opts.spawn ?? defaultSpawn
    this.claudeBin = opts.claudeBin ?? process.env.BOARDROOM_CLAUDE_BIN ?? '/opt/homebrew/bin/claude'
    this.permissionMode = opts.permissionMode ?? process.env.BOARDROOM_RESUME_PERMISSION ?? 'acceptEdits'
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
    // Resolve the resume target FAIL-CLOSED: getSessionByProject returns a row only
    // when exactly one worktree maps to this basename. Two same-basename worktrees →
    // undefined → we decline to resume (dashboard copy-paste fallback) rather than
    // risk `claude --resume` editing the wrong tree under acceptEdits. (Part 2 will
    // prefer an exact match on the Claude session id when the card carries one.)
    const session = this.store.getSessionByProject(card.session.project)
    if (!session) return
    // The registry is a trusted-but-unauthenticated write surface, and cwd is the
    // dir we launch `claude --resume` from. Refuse anything that isn't an existing
    // absolute directory rather than spawning into an unpredictable location.
    if (!isAbsolute(session.cwd) || !isExistingDir(session.cwd)) {
      console.warn(`[waker] skip card ${card.id}: session cwd is not an existing absolute directory (${session.cwd})`)
      return
    }
    this.woken.add(card.id)
    const args = ['-p', '--resume', session.sessionId, resumeMessage(card), '--permission-mode', this.permissionMode]
    // Mark the card delivered once the resume actually launched: the decision now
    // travels in that session's prompt (which is told NOT to re-call the tool), so
    // leaving deliveredAt unset would keep the card claimable by ANY future call
    // with the same fingerprint — handing a stale verdict to an unrelated session,
    // the never-auto-accept violation. On a failed launch nothing is marked and the
    // reattach path stays open. The dashboard copy-paste summary works either way.
    this.spawnFn(this.claudeBin, args, session.cwd, () => this.markDelivered(card.id))
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

function defaultSpawn(bin: string, args: string[], cwd: string, onSpawned?: () => void): void {
  // Detached & stdio-ignored: the resumed turn outlives this request and must
  // never block or crash the daemon (e.g. if the claude binary isn't found).
  const child = spawn(bin, args, { cwd, stdio: 'ignore', detached: true })
  child.on('spawn', () => onSpawned?.())
  child.on('error', err => console.warn(`[waker] could not spawn ${bin}: ${err.message}`))
  // Auto-wake is a convenience over the dashboard's copy-paste fallback; a failed
  // resume is otherwise invisible (stdio ignored, one-shot), so at least log it.
  child.on('exit', code => {
    if (code) console.warn(`[waker] ${bin} exited ${code} — the resumed session may not have started`)
  })
  child.unref()
}
