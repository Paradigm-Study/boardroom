// src/daemon/sessionCapturer.ts
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CapturedSession } from '../shared/session.js'
import type { Store } from './store.js'

export interface CapturerOpts {
  claudeDir?: string
  intervalMs?: number
  isAlive?: (pid: number) => boolean
  now?: () => string
}

// Captures EVERY Claude Code session on the machine from ~/.claude/sessions/*.json.
// The reconcile tick is authoritative; fs.watch is only a latency optimization
// (macOS FSEvents can coalesce/miss events). Liveness is process.kill(pid,0),
// side-effect-free. Writes the separate captured_sessions table only — never the
// hook-fed `sessions` table the waker reads.
export class SessionCapturer {
  private timer?: ReturnType<typeof setInterval>
  private watcher?: FSWatcher
  private readonly sessionsDir: string
  private readonly projectsDir: string
  private readonly tasksDir: string
  private readonly intervalMs: number
  private readonly isAlive: (pid: number) => boolean
  private readonly now: () => string

  constructor(private store: Store, private machineId: string, opts: CapturerOpts = {}) {
    const claudeDir = opts.claudeDir ?? join(homedir(), '.claude')
    this.sessionsDir = join(claudeDir, 'sessions')
    this.projectsDir = join(claudeDir, 'projects')
    this.tasksDir = join(claudeDir, 'tasks')
    this.intervalMs = opts.intervalMs ?? 5000
    this.isAlive = opts.isAlive ?? defaultIsAlive
    this.now = opts.now ?? (() => new Date().toISOString())
  }

  start(): void {
    this.reconcile()
    try {
      this.watcher = watch(this.sessionsDir, () => this.reconcile())
    } catch { /* dir may not exist yet; the interval still reconciles */ }
    this.timer = setInterval(() => this.reconcile(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.watcher?.close()
    this.watcher = undefined
    this.timer = undefined
  }

  reconcile(): void {
    let files: string[]
    try {
      files = readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'))
    } catch {
      return // sessions dir absent → nothing to capture
    }
    for (const file of files) {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(readFileSync(join(this.sessionsDir, file), 'utf8'))
      } catch {
        continue // malformed/foreign file — skip, never fatal
      }
      if (typeof raw.sessionId !== 'string' || typeof raw.cwd !== 'string' || typeof raw.pid !== 'number') continue
      const ts = this.now()
      const session: CapturedSession = {
        sessionId: raw.sessionId,
        machineId: this.machineId,
        pid: raw.pid,
        procStart: typeof raw.procStart === 'string' ? raw.procStart : undefined,
        cwd: raw.cwd,
        project: basename(raw.cwd),
        claudeVersion: typeof raw.version === 'string' ? raw.version : undefined,
        entrypoint: typeof raw.entrypoint === 'string' ? raw.entrypoint : undefined,
        kind: typeof raw.kind === 'string' ? raw.kind : undefined,
        startedAt: toIso(raw.startedAt),
        status: this.isAlive(raw.pid) ? 'alive' : 'ended',
        capturedAt: this.store.getCaptured(raw.sessionId)?.capturedAt ?? ts,
        lastSeenAt: ts,
        transcriptPath: this.findTranscript(raw.sessionId),
        tasksDir: this.findTasksDir(raw.sessionId),
      }
      this.store.upsertCaptured(session)
    }
  }

  // DERIVED pointer: glob ~/.claude/projects/*/<sessionId>.jsonl rather than trust
  // the lossy cwd→slug encoding. Populate only if the file actually exists.
  private findTranscript(sessionId: string): string | undefined {
    try {
      for (const slug of readdirSync(this.projectsDir)) {
        try {
          if (!statSync(join(this.projectsDir, slug)).isDirectory()) continue
        } catch { continue }
        const p = join(this.projectsDir, slug, `${sessionId}.jsonl`)
        if (existsSync(p)) return p
      }
    } catch { /* projects dir absent */ }
    return undefined
  }

  private findTasksDir(sessionId: string): string | undefined {
    const p = join(this.tasksDir, sessionId)
    try { if (statSync(p).isDirectory()) return p } catch { /* none */ }
    return undefined
  }
}

function toIso(value: unknown): string | undefined {
  if (typeof value === 'number') return new Date(value).toISOString()
  if (typeof value === 'string') return value
  return undefined
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // signal 0 = existence/permission check only, delivers nothing
    return true
  } catch {
    return false
  }
}
