import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  port: number
  remindEveryMinutes: number
  notifications: boolean
  dbPath: string
  configDir: string
}

export function loadConfig(configDir?: string): Config {
  const dir = configDir ?? process.env.BOARDROOM_CONFIG_DIR ?? join(homedir(), '.config', 'boardroom')
  mkdirSync(dir, { recursive: true })
  let file: Partial<Pick<Config, 'port' | 'remindEveryMinutes' | 'notifications'>> = {}
  const p = join(dir, 'config.json')
  if (existsSync(p)) file = JSON.parse(readFileSync(p, 'utf8'))
  return {
    port: 4040,
    remindEveryMinutes: 10,
    notifications: true,
    ...file,
    dbPath: join(dir, 'boardroom.sqlite'),
    configDir: dir,
  }
}
