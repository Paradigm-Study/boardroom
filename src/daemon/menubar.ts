import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The daemon runs from source via tsx, so this file lives at <repo>/src/daemon/
// and the repo root is two directories up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Ordered packaged-app candidates: an explicit override wins, then the per-arch
// electron-builder output. `boardroom.app` is the productName from menubar/package.json.
export function menubarAppCandidates(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot: string = REPO_ROOT,
): string[] {
  const release = join(repoRoot, 'menubar', 'release')
  return [
    env.BOARDROOM_MENUBAR_APP,
    join(release, 'mac-arm64', 'boardroom.app'),
    join(release, 'mac', 'boardroom.app'),
  ].filter((p): p is string => Boolean(p))
}

export interface LaunchPlan {
  appPath: string | null
  reason: string
}

// Decide whether — and what — to launch. Pure so the policy is unit-testable; the
// side effects (spawn) live in startMenubar. Default-on: we launch unless the dev
// opt-out is set, we're off macOS, or no bundle is built.
export function planMenubarLaunch(
  candidates: string[],
  opts: {
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    exists?: (p: string) => boolean
  } = {},
): LaunchPlan {
  const { env = process.env, platform = process.platform, exists = existsSync } = opts
  if (env.BOARDROOM_NO_MENUBAR) return { appPath: null, reason: 'disabled by BOARDROOM_NO_MENUBAR' }
  if (platform !== 'darwin') return { appPath: null, reason: `skipped: the menu-bar app is macOS-only (platform=${platform})` }
  const appPath = candidates.find(exists)
  if (!appPath) {
    return { appPath: null, reason: 'no menu-bar app bundle found — build it with: npm --prefix menubar run pack' }
  }
  return { appPath, reason: appPath }
}

// A minimal view of child_process.spawn — just enough to launch `open` and observe
// its outcome, so a test can inject a fake without reconstructing a ChildProcess.
export interface MenubarChild {
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'exit', listener: (code: number | null) => void): void
}
export type MenubarSpawn = (command: string, args: string[], options: { stdio: 'ignore' }) => MenubarChild

const defaultSpawn: MenubarSpawn = (command, args, options) => nodeSpawn(command, args, options)

export interface MenubarDeps {
  candidates?: string[]
  plan?: typeof planMenubarLaunch
  spawn?: MenubarSpawn
  log?: (msg: string) => void
  error?: (msg: string) => void
}

// Ensure the menu-bar tray app is up whenever the daemon (re)starts, binding the
// menu bar's life to the daemon's — the "auto check, then boot" the daemon owns. We
// never stop it: it degrades to a "daemon offline" badge on its own and reconnects
// when KeepAlive revives us.
export function startMenubar(deps: MenubarDeps = {}): void {
  const {
    candidates = menubarAppCandidates(),
    plan = planMenubarLaunch,
    spawn = defaultSpawn,
    log = (msg: string) => console.log(msg),
    error = (msg: string) => console.error(msg),
  } = deps

  const { appPath, reason } = plan(candidates, {})
  if (!appPath) {
    log(`[menubar] not launching — ${reason}`)
    return
  }

  // `open -g` (no -n) reuses a running instance: it boots the tray when down and is
  // a harmless no-op when it's already up. Surface BOTH a spawn failure AND a
  // non-zero `open` exit — a bundle that exists (per existsSync) but still won't
  // launch, e.g. quarantined or corrupt — so a tray that never appears is
  // diagnosable instead of a silent failure this log would otherwise report as up.
  log(`[menubar] launching tray app: ${appPath}`)
  const child = spawn('open', ['-g', appPath], { stdio: 'ignore' })
  child.on('error', err => error(`[menubar] could not run 'open' for ${appPath}: ${err.message}`))
  child.on('exit', code => {
    if (code) error(`[menubar] 'open' exited ${code} — tray app may not have started: ${appPath}`)
  })
}
