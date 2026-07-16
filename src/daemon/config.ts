import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { REATTACH_WINDOW_MS } from '../shared/needsHuman.js'

export interface Config {
  port: number
  remindEveryMinutes: number
  notifications: boolean
  openOnPending: boolean
  reattachWindowMs: number
  dbPath: string
  configDir: string
}

export function loadConfig(configDir?: string): Config {
  const dir = configDir ?? process.env.BOARDROOM_CONFIG_DIR ?? join(homedir(), '.config', 'boardroom')
  mkdirSync(dir, { recursive: true })
  try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
  let file: Partial<Pick<Config, 'port' | 'remindEveryMinutes' | 'notifications' | 'openOnPending' | 'reattachWindowMs'>> = {}
  const p = join(dir, 'config.json')
  if (existsSync(p)) file = JSON.parse(readFileSync(p, 'utf8'))
  // BOARDROOM_PORT is the port convention seed.ts and every hook already honor;
  // the daemon reads it too so a dev daemon can run on its own port (paired with
  // BOARDROOM_CONFIG_DIR for its own DB) beside the production one on 4140. A
  // non-numeric value is ignored rather than crashing the boot on a typo.
  // 4140 (not 4040): 4040 is deliberately ceded to Paradigm.app's bundled
  // boardroom, which is validation-pinned there (its config layer drops any other
  // port) and respawn-grabs it forever while the app runs — sharing that port
  // caused the 2026-07-15 nine-hour 401 outage. Nothing production points at 4040.
  const envPort = Number(process.env.BOARDROOM_PORT)
  return {
    port: 4140,
    remindEveryMinutes: 10,
    notifications: true,
    openOnPending: false,
    reattachWindowMs: REATTACH_WINDOW_MS, // how long an orphaned card stays reattachable (from orphan time)
    ...file,
    ...(Number.isInteger(envPort) && envPort > 0 ? { port: envPort } : {}),
    dbPath: join(dir, 'boardroom.sqlite'),
    configDir: dir,
  }
}
