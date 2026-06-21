import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  port: number
  remindEveryMinutes: number
  notifications: boolean
  openOnPending: boolean
  dbPath: string
  configDir: string
}

export function loadConfig(configDir?: string): Config {
  const dir = configDir ?? process.env.BOARDROOM_CONFIG_DIR ?? join(homedir(), '.config', 'boardroom')
  mkdirSync(dir, { recursive: true })
  try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
  let file: Partial<Pick<Config, 'port' | 'remindEveryMinutes' | 'notifications' | 'openOnPending'>> = {}
  const p = join(dir, 'config.json')
  if (existsSync(p)) file = JSON.parse(readFileSync(p, 'utf8'))
  return {
    port: 4040,
    remindEveryMinutes: 10,
    notifications: true,
    openOnPending: false,
    ...file,
    dbPath: join(dir, 'boardroom.sqlite'),
    configDir: dir,
  }
}
