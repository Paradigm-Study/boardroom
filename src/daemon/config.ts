import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
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
  /** Optional tenant selector for enrolled relay configs; omitted = legacy-local. */
  teamId?: string
  /** Hosted rotating credential scope. Omit both for legacy static tokens. */
  deviceId?: string
  expiresAt?: string
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
  /** Install-scoped API bearer; undefined keeps legacy loopback dev behavior. */
  localToken?: string
}

export function loadConfig(configDir?: string): Config {
  const dir = configDir ?? process.env.BOARDROOM_CONFIG_DIR ?? join(homedir(), '.config', 'boardroom')
  mkdirSync(dir, { recursive: true })
  try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
  let file: Partial<Pick<Config, 'port' | 'remindEveryMinutes' | 'notifications' | 'openOnPending' | 'reattachWindowMs'>>
    & { mesh?: Partial<MeshConfig> } = {}
  const p = join(dir, 'config.json')
  if (existsSync(p)) {
    const lastGood = `${p}.last-good`
    try {
      file = JSON.parse(readFileSync(p, 'utf8'))
      copyFileSync(p, lastGood)
      try { chmodSync(p, 0o600); chmodSync(lastGood, 0o600) } catch { /* best effort */ }
    } catch (error) {
      if (!existsSync(lastGood)) throw error
      const corrupt = `${p}.corrupt-${Date.now()}`
      renameSync(p, corrupt)
      copyFileSync(lastGood, p)
      try { chmodSync(p, 0o600); chmodSync(corrupt, 0o600) } catch { /* best effort */ }
      file = JSON.parse(readFileSync(p, 'utf8'))
    }
  }
  // Mesh (default-off): env overrides file, field by field; the resolved config
  // only carries `mesh` when url+token+person ALL resolve non-empty — a partial
  // mesh block is treated as "not configured", never a half-armed forwarder.
  const meshUrl = process.env.BOARDROOM_MESH_URL || file.mesh?.url
  const meshToken = process.env.BOARDROOM_MESH_TOKEN || file.mesh?.token
  const meshPerson = process.env.BOARDROOM_MESH_PERSON || file.mesh?.person
  const meshTeamId = process.env.BOARDROOM_MESH_TEAM_ID || file.mesh?.teamId
  const meshDeviceId = process.env.BOARDROOM_MESH_DEVICE_ID || file.mesh?.deviceId
  const meshExpiresAt = process.env.BOARDROOM_MESH_EXPIRES_AT || file.mesh?.expiresAt
  const hostedMesh = !!(meshDeviceId || meshExpiresAt)
  if (hostedMesh && (
    !process.env.BOARDROOM_MESH_URL ||
    !process.env.BOARDROOM_MESH_TOKEN ||
    !process.env.BOARDROOM_MESH_PERSON ||
    !process.env.BOARDROOM_MESH_TEAM_ID ||
    !process.env.BOARDROOM_MESH_DEVICE_ID ||
    !process.env.BOARDROOM_MESH_EXPIRES_AT
  )) {
    throw new Error('hosted Boardroom mesh credentials must be supplied completely through process environment')
  }
  const mesh = meshUrl && meshToken && meshPerson
    ? {
        url: meshUrl,
        token: meshToken,
        person: meshPerson,
        ...(meshTeamId ? { teamId: meshTeamId } : {}),
        ...(meshDeviceId ? { deviceId: meshDeviceId } : {}),
        ...(meshExpiresAt ? { expiresAt: meshExpiresAt } : {}),
      }
    : undefined
  const explicitTokenFile = process.env.BOARDROOM_LOCAL_TOKEN_FILE
  const tokenFile = explicitTokenFile || join(dir, 'local-token')
  let localToken = process.env.BOARDROOM_LOCAL_TOKEN?.trim() || undefined
  if (!localToken && explicitTokenFile && !existsSync(tokenFile)) {
    throw new Error('BOARDROOM_LOCAL_TOKEN_FILE does not exist')
  }
  if (!localToken && existsSync(tokenFile)) {
    try {
      chmodSync(tokenFile, 0o600)
      localToken = readFileSync(tokenFile, 'utf8').trim() || undefined
      if (!localToken && explicitTokenFile) throw new Error('local token file is empty')
    } catch (error) {
      if (explicitTokenFile) throw error
      // An unreadable auto-discovered optional token file leaves legacy dev
      // mode intact; an explicitly configured path always fails closed above.
    }
  }
  return {
    port: 4040,
    remindEveryMinutes: 10,
    notifications: true,
    openOnPending: false,
    reattachWindowMs: REATTACH_WINDOW_MS, // how long an orphaned card stays reattachable (from orphan time)
    ...file,
    mesh, // computed above; placed after ...file so a partial file block can't leak through
    ...(localToken ? { localToken } : {}),
    dbPath: join(dir, 'boardroom.sqlite'),
    configDir: dir,
  }
}
