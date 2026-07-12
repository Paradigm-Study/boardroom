import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { REATTACH_WINDOW_MS } from '../shared/needsHuman.js'

// Optional mesh relay wiring (mesh-v0). Present only when ALL THREE fields
// resolve (file "mesh" object, each overridable by BOARDROOM_MESH_URL/
// BOARDROOM_MESH_TOKEN/BOARDROOM_MESH_PERSON). Absent → boardroom behaves
// exactly as before: nothing subscribes, nothing leaves the machine.
export interface MeshConfig {
  url: string
  token: string
  person: string
}

export interface Config {
  port: number
  remindEveryMinutes: number
  notifications: boolean
  openOnPending: boolean
  reattachWindowMs: number
  dbPath: string
  configDir: string
  mesh?: MeshConfig
}

export function loadConfig(configDir?: string): Config {
  const dir = configDir ?? process.env.BOARDROOM_CONFIG_DIR ?? join(homedir(), '.config', 'boardroom')
  mkdirSync(dir, { recursive: true })
  try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
  let file: Partial<Pick<Config, 'port' | 'remindEveryMinutes' | 'notifications' | 'openOnPending' | 'reattachWindowMs'>>
    & { mesh?: Partial<MeshConfig> } = {}
  const p = join(dir, 'config.json')
  if (existsSync(p)) file = JSON.parse(readFileSync(p, 'utf8'))
  // Mesh (default-off): env overrides file, field by field; the resolved config
  // only carries `mesh` when url+token+person ALL resolve non-empty — a partial
  // mesh block is treated as "not configured", never a half-armed forwarder.
  const meshUrl = process.env.BOARDROOM_MESH_URL || file.mesh?.url
  const meshToken = process.env.BOARDROOM_MESH_TOKEN || file.mesh?.token
  const meshPerson = process.env.BOARDROOM_MESH_PERSON || file.mesh?.person
  const mesh = meshUrl && meshToken && meshPerson
    ? { url: meshUrl, token: meshToken, person: meshPerson }
    : undefined
  return {
    port: 4040,
    remindEveryMinutes: 10,
    notifications: true,
    openOnPending: false,
    reattachWindowMs: REATTACH_WINDOW_MS, // how long an orphaned card stays reattachable (from orphan time)
    ...file,
    mesh, // computed above; placed after ...file so a partial file block can't leak through
    dbPath: join(dir, 'boardroom.sqlite'),
    configDir: dir,
  }
}
