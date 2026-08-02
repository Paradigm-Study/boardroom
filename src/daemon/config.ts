import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadAuthToken } from './authToken.js'
import { REATTACH_WINDOW_MS } from '../shared/needsHuman.js'

export interface Config {
  port: number
  remindEveryMinutes: number
  notifications: boolean
  openOnPending: boolean
  reattachWindowMs: number
  dbPath: string
  configDir: string
  // The loopback token gating /api and /events. Optional so unit tests can
  // construct a Config inline without one (guard off); loadConfig always sets it.
  authToken?: string
}

type FileConfig = Partial<Pick<Config, 'port' | 'remindEveryMinutes' | 'notifications' | 'openOnPending' | 'reattachWindowMs'>>

// A corrupt or hand-edited config.json must not crash the daemon at boot: under
// launchd KeepAlive an unhandled JSON.parse throw becomes a silent respawn loop.
// Parse defensively, ignore the file on any error, and keep only known keys of the
// expected type — so a string `port` can never flow into app.listen.
function readFileConfig(p: string): FileConfig {
  if (!existsSync(p)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    console.warn(`[config] ignoring unparseable ${p} — using defaults`)
    return {}
  }
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: FileConfig = {}
  if (typeof r.port === 'number' && Number.isInteger(r.port) && r.port >= 0 && r.port <= 65535) out.port = r.port
  if (typeof r.remindEveryMinutes === 'number' && r.remindEveryMinutes > 0) out.remindEveryMinutes = r.remindEveryMinutes
  if (typeof r.notifications === 'boolean') out.notifications = r.notifications
  if (typeof r.openOnPending === 'boolean') out.openOnPending = r.openOnPending
  if (typeof r.reattachWindowMs === 'number' && r.reattachWindowMs > 0) out.reattachWindowMs = r.reattachWindowMs
  return out
}

export function loadConfig(configDir?: string): Config {
  const dir = configDir ?? process.env.BOARDROOM_CONFIG_DIR ?? join(homedir(), '.config', 'boardroom')
  mkdirSync(dir, { recursive: true })
  try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
  const file = readFileConfig(join(dir, 'config.json'))
  return {
    port: 4040,
    remindEveryMinutes: 10,
    notifications: true,
    openOnPending: false,
    reattachWindowMs: REATTACH_WINDOW_MS, // how long an orphaned card stays reattachable (from orphan time)
    ...file,
    dbPath: join(dir, 'boardroom.sqlite'),
    configDir: dir,
    authToken: loadAuthToken(dir),
  }
}
