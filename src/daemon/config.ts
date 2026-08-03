import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { mintLocalToken } from './authToken.js'
import { REATTACH_WINDOW_MS } from '../shared/needsHuman.js'

// Optional mesh relay wiring (mesh-v0). Present only when ALL THREE fields
// resolve (file "mesh" object, each overridable by BOARDROOM_MESH_URL/
// BOARDROOM_MESH_TOKEN/BOARDROOM_MESH_PERSON). Absent → boardroom behaves
// exactly as before: nothing subscribes, nothing leaves the machine.
export interface MeshProjectConsent {
  /** Local-only exact workspace root. Never serialized into a Mesh record. */
  workspaceRoot: string
  /** Canonical GitHub repository identity: lowercase owner/repository. */
  project: string
}

export interface MeshConfig {
  url: string
  token: string
  person: string
  /** Optional tenant selector for enrolled relay configs; omitted = legacy-local. */
  teamId?: string
  /** Hosted rotating credential scope. Omit both for legacy static tokens. */
  deviceId?: string
  expiresAt?: string
  /** Desktop-projected, team-scoped workspace allowlist for hosted forwarding. */
  projects?: MeshProjectConsent[]
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
  // The loopback token gating /api and /events. Optional so unit tests can
  // construct a Config inline without one; loadConfig ALWAYS resolves one (it
  // mints if nothing is configured), so production is never unguarded.
  localToken?: string
}

type FileConfig = Partial<Pick<Config, 'port' | 'remindEveryMinutes' | 'notifications' | 'openOnPending' | 'reattachWindowMs'>>
  & { mesh?: Partial<MeshConfig> }

// Keep only known keys of the expected type, so a hand-edited `"port": "4040"`
// (valid JSON, wrong type) can never flow into app.listen. Applied to whatever
// JSON we end up using — the live file or a restored .last-good copy.
// `mesh` passes through unvalidated by design: every mesh field is re-resolved
// (and env-overridden) below, and a partial block is dropped there.
function validateFileConfig(raw: unknown): FileConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: FileConfig = {}
  if (typeof r.port === 'number' && Number.isInteger(r.port) && r.port >= 0 && r.port <= 65535) out.port = r.port
  if (typeof r.remindEveryMinutes === 'number' && r.remindEveryMinutes > 0) out.remindEveryMinutes = r.remindEveryMinutes
  if (typeof r.notifications === 'boolean') out.notifications = r.notifications
  if (typeof r.openOnPending === 'boolean') out.openOnPending = r.openOnPending
  if (typeof r.reattachWindowMs === 'number' && r.reattachWindowMs > 0) out.reattachWindowMs = r.reattachWindowMs
  if (r.mesh && typeof r.mesh === 'object' && !Array.isArray(r.mesh)) out.mesh = r.mesh as Partial<MeshConfig>
  return out
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function hostedMeshProjects(raw: string | undefined): MeshProjectConsent[] {
  if (raw === undefined || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('BOARDROOM_MESH_PROJECTS_JSON must be valid JSON')
  }
  if (!Array.isArray(parsed) || parsed.length > 100) {
    throw new Error('BOARDROOM_MESH_PROJECTS_JSON must contain at most 100 workspace mappings')
  }
  const roots = new Map<string, string>()
  for (const value of parsed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('BOARDROOM_MESH_PROJECTS_JSON contains an invalid workspace mapping')
    }
    const candidate = value as Record<string, unknown>
    const rawRoot = typeof candidate.workspaceRoot === 'string' ? candidate.workspaceRoot.trim() : ''
    const rawProject = typeof candidate.project === 'string' ? candidate.project.trim() : ''
    if (
      !rawRoot || rawRoot.length > 1_024 || !isAbsolute(rawRoot) || hasControlCharacters(rawRoot)
      || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(rawProject)
    ) {
      throw new Error('BOARDROOM_MESH_PROJECTS_JSON contains an invalid workspace mapping')
    }
    const [owner, repository] = rawProject.split('/')
    if (owner === '.' || owner === '..' || repository === '.' || repository === '..') {
      throw new Error('BOARDROOM_MESH_PROJECTS_JSON contains an invalid project identity')
    }
    const workspaceRoot = resolve(rawRoot)
    const project = rawProject.toLowerCase()
    const previous = roots.get(workspaceRoot)
    if (previous && previous !== project) {
      throw new Error('BOARDROOM_MESH_PROJECTS_JSON maps one workspace to multiple projects')
    }
    roots.set(workspaceRoot, project)
  }
  return [...roots].map(([workspaceRoot, project]) => ({ workspaceRoot, project }))
}

export function loadConfig(configDir?: string): Config {
  const dir = configDir ?? process.env.BOARDROOM_CONFIG_DIR ?? join(homedir(), '.config', 'boardroom')
  mkdirSync(dir, { recursive: true })
  try { chmodSync(dir, 0o700) } catch { /* best-effort */ }
  let file: FileConfig = {}
  const p = join(dir, 'config.json')
  // BOARDROOM_PORT is the port convention seed.ts and every hook already honor;
  // the daemon reads it too so a dev daemon can run on its own port (paired with
  // BOARDROOM_CONFIG_DIR for its own DB) beside the production one. A non-numeric
  // value is ignored rather than crashing the boot on a typo.
  // Default 4040 (2026-07-16 decision, reverting the brief 4140 move): Paradigm.app's
  // bundled boardroom is built FROM this repo, so a diverging repo default just moves
  // the collision instead of fixing it — the repo and the app share 4040, and a
  // standalone daemon that must coexist with the running app overrides via
  // BOARDROOM_PORT or config.json rather than a forked default.
  const envPort = Number(process.env.BOARDROOM_PORT)
  if (existsSync(p)) {
    const lastGood = `${p}.last-good`
    try {
      // Snapshot last-good on a successful PARSE, before validation: a file whose
      // JSON is fine but whose `port` is a string is still the user's real
      // settings and worth preserving — validation only decides what we USE.
      file = validateFileConfig(JSON.parse(readFileSync(p, 'utf8')))
      copyFileSync(p, lastGood)
      try { chmodSync(p, 0o600); chmodSync(lastGood, 0o600) } catch { /* best effort */ }
    } catch {
      // Never throw out of loadConfig over a bad settings file. The daemon runs
      // under launchd KeepAlive, where an unhandled boot throw is an invisible
      // crash-respawn loop with nothing to diagnose from. Restore the last-good
      // copy when there is one (the user's real settings survive); otherwise warn
      // and take the built-in defaults — these are port/notification preferences,
      // nothing security-critical. (2026-08-02 decision, replacing the rethrow.)
      if (existsSync(lastGood)) {
        const corrupt = `${p}.corrupt-${Date.now()}`
        try {
          renameSync(p, corrupt)
          copyFileSync(lastGood, p)
          try { chmodSync(p, 0o600); chmodSync(corrupt, 0o600) } catch { /* best effort */ }
          file = validateFileConfig(JSON.parse(readFileSync(p, 'utf8')))
          console.warn(`[config] ${p} was unreadable — restored the last-good copy; the corrupt file is kept at ${corrupt}`)
        } catch (restoreError) {
          // Both the live file AND the last-good copy are unusable.
          console.warn(`[config] ${p} was unreadable and the last-good copy could not be restored (${(restoreError as Error).message}) — using defaults`)
          file = {}
        }
      } else {
        console.warn(`[config] ignoring unparseable ${p} (no last-good copy to restore) — using defaults`)
        file = {}
      }
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
        ...(hostedMesh ? { projects: hostedMeshProjects(process.env.BOARDROOM_MESH_PROJECTS_JSON) } : {}),
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
      // An unreadable auto-discovered token file falls through to a fresh mint
      // below; an explicitly configured path always fails closed above.
    }
  }
  // Nothing configured → mint one, rather than running the guarded surface
  // unguarded. This is the last link in the chain (env → explicit file →
  // discovered file → mint) and the reason localToken is always set in
  // production. (2026-08-02 decision: always-on, replacing "legacy dev mode",
  // where an absent token disabled the API guard entirely.)
  if (!localToken) localToken = mintLocalToken(tokenFile)
  return {
    port: 4040,
    remindEveryMinutes: 10,
    notifications: true,
    openOnPending: false,
    reattachWindowMs: REATTACH_WINDOW_MS, // how long an orphaned card stays reattachable (from orphan time)
    ...file,
    ...(Number.isInteger(envPort) && envPort > 0 ? { port: envPort } : {}),
    mesh, // computed above; placed after ...file so a partial file block can't leak through
    localToken, // always resolved above (minted if nothing was configured)
    dbPath: join(dir, 'boardroom.sqlite'),
    configDir: dir,
  }
}
