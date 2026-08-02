// Toggle the boardroom enforcement hooks (README "Enforcement hooks") into the
// user's global ~/.claude/settings.json. This mutates a file boardroom does not
// own — every read/write here is defensive: unknown keys and unrelated hook
// entries must survive untouched, and a malformed file must never be silently
// clobbered.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export interface HookSpec {
  id: string
  event: 'SessionStart' | 'PreToolUse' | 'Stop'
  matcher: string | undefined // undefined = applies to the whole event, no tool filter
  script: string // file name under hooks/
  description: string
}

export const HOOK_SPECS: HookSpec[] = [
  {
    id: 'session-start',
    event: 'SessionStart',
    matcher: undefined,
    script: 'session-start.sh',
    description: 'Injects the boardroom protocol into context and registers the session (always safe, non-blocking).',
  },
  {
    id: 'redirect-ask',
    event: 'PreToolUse',
    matcher: 'AskUserQuestion',
    script: 'redirect-ask.sh',
    description: 'Deny-once: redirects the model to call clarify instead of asking in chat.',
  },
  {
    id: 'check-plan',
    event: 'PreToolUse',
    matcher: 'ExitPlanMode',
    script: 'check-plan.sh',
    description: 'Deny-once: redirects the model to call present_plan before exiting plan mode.',
  },
  {
    id: 'require-review',
    event: 'Stop',
    matcher: undefined,
    script: 'require-review.sh',
    description: 'Deny-once: redirects the model to call review_results before ending the session.',
  },
]

// The client half of the timeout fix (README "Global setup" step 3). The gate
// tools hang until the human decides; without a long MCP_TOOL_TIMEOUT the CLIENT
// aborts the call at its default timeout and the agent moves on — the recurring
// "boardroom stopped waiting" bug. Docs alone proved non-durable (machines drift),
// so the installer owns these keys and hooksStatus reports their absence.
export interface EnvSpec {
  key: string
  value: string
  description: string
}

export const ENV_SPECS: EnvSpec[] = [
  {
    key: 'MCP_TOOL_TIMEOUT',
    value: '86400000',
    description: 'Lets gate calls hang up to a day awaiting your verdict instead of aborting at the default MCP tool timeout.',
  },
  {
    key: 'MCP_TIMEOUT',
    value: '30000',
    description: 'Keeps MCP connection attempts failing fast so the native-chat fallback still works when the daemon is down.',
  },
]

// hooks/ lives at the repo root, two levels up from this compiled/loaded module
// (src/daemon/hooksInstall.ts or dist/daemon/hooksInstall.js — either way the
// repo layout keeps hooks/ as a sibling of src/).
export function hooksDir(): string {
  return fileURLToPath(new URL('../../hooks', import.meta.url))
}

function scriptPath(spec: HookSpec): string {
  return join(hooksDir(), spec.script)
}

export function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

interface HookEntry { type: string; command: string; [key: string]: unknown }
interface MatcherGroup { matcher?: string; hooks: HookEntry[]; [key: string]: unknown }
interface SettingsShape { hooks?: Record<string, MatcherGroup[]>; env?: unknown; [key: string]: unknown }

// The env block is user-owned territory: read it only when it is a plain object,
// so a malformed value is reported unconfigured rather than crashing status.
function envObject(settings: SettingsShape): Record<string, unknown> | undefined {
  const env = settings.env
  if (typeof env === 'object' && env !== null && !Array.isArray(env)) return env as Record<string, unknown>
  return undefined
}

// Malformed JSON is surfaced (never silently discarded) — the caller decides
// whether to fail the request rather than risk overwriting a file we can't parse.
function readSettings(): SettingsShape {
  const p = claudeSettingsPath()
  if (!existsSync(p)) return {}
  const raw = readFileSync(p, 'utf8').trim()
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  // A non-object root (array, string, number) accepts property writes but drops
  // them at serialize time — install would 200 while writing nothing. Surface it
  // like malformed JSON instead of silently no-oping.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${p}: root is not a JSON object — refusing to modify`)
  }
  return parsed as SettingsShape
}

function writeSettings(settings: SettingsShape): void {
  const p = claudeSettingsPath()
  // Snapshot the pre-mutation file every time we touch it, so a bad edit is
  // always one copy away from undo — this file is outside boardroom's own
  // config dir and controls the whole Claude Code install, not just this app.
  if (existsSync(p)) writeFileSync(`${p}.bak`, readFileSync(p, 'utf8'))
  else mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify(settings, null, 2)}\n`)
}

function sameMatcher(a: string | undefined, b: string | undefined): boolean {
  const norm = (m: string | undefined): string => (m ?? '').trim()
  return norm(a) === norm(b)
}

// A configured value is any non-empty string; a finite number is the user's
// deliberate value too (JSON makes numbers an easy slip) — reported as configured
// and repaired to its string form on install, never replaced with our default.
function envValue(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim() !== '') return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return undefined
}

// Ours = this repo's script, or any absolute path ending in /hooks/<script> — a
// moved/renamed repo leaves stale entries that exact-match can neither replace on
// install nor remove on uninstall, and each stale entry fails on every session.
// (Scoped to the same event+matcher group, so an unrelated tool colliding on the
// full /hooks/<name>.sh suffix is accepted as vanishingly unlikely.)
function isOurHook(command: string, spec: HookSpec): boolean {
  return command === scriptPath(spec) || command.endsWith(`/hooks/${spec.script}`)
}

export interface HookStatusEntry extends Pick<HookSpec, 'id' | 'event' | 'matcher' | 'description'> {
  wired: boolean
}

export interface EnvStatusEntry extends Pick<EnvSpec, 'key' | 'description'> {
  recommended: string
  current?: string
  configured: boolean
}

export interface HooksStatus {
  installed: boolean // true only when every hook is wired AND every env key is configured
  entries: HookStatusEntry[]
  env: EnvStatusEntry[]
}

export function hooksStatus(): HooksStatus {
  const settings = readSettings()
  const entries = HOOK_SPECS.map(spec => {
    const groups = settings.hooks?.[spec.event] ?? []
    const group = groups.find(g => sameMatcher(g.matcher, spec.matcher))
    const wired = group?.hooks.some(h => h.command === scriptPath(spec)) ?? false
    return { id: spec.id, event: spec.event, matcher: spec.matcher, description: spec.description, wired }
  })
  const envSettings = envObject(settings)
  const env = ENV_SPECS.map(spec => {
    // Any user-set value counts as configured — a user-tuned timeout is still a
    // fixed timeout; only absence (or junk) is the silent-regression state.
    const current = envValue(envSettings?.[spec.key])
    return { key: spec.key, description: spec.description, recommended: spec.value, current, configured: current !== undefined }
  })
  return { installed: entries.every(e => e.wired) && env.every(e => e.configured), entries, env }
}

export function installHooks(): HooksStatus {
  const settings = readSettings()
  settings.hooks ??= {}
  for (const spec of HOOK_SPECS) {
    const groups = (settings.hooks[spec.event] ??= [])
    let group = groups.find(g => sameMatcher(g.matcher, spec.matcher))
    if (!group) {
      group = spec.matcher ? { matcher: spec.matcher, hooks: [] } : { hooks: [] }
      groups.push(group)
    }
    const command = scriptPath(spec)
    // Drop stale copies of our own script first (old repo locations), then wire
    // the current path — install doubles as repair after a repo move.
    group.hooks = group.hooks.filter(h => !isOurHook(h.command, spec) || h.command === command)
    if (!group.hooks.some(h => h.command === command)) {
      group.hooks.push({ type: 'command', command })
    }
  }
  // Env half: fill only what is missing — a user-tuned value is left alone (a
  // numeric slip is repaired to its string form, value preserved). A non-object
  // env (malformed) is replaced with a valid block; the .bak written by
  // writeSettings preserves whatever was there.
  const env = envObject(settings) ?? (settings.env = {}) as Record<string, unknown>
  for (const spec of ENV_SPECS) {
    const current = envValue(env[spec.key])
    if (current === undefined) env[spec.key] = spec.value
    else if (env[spec.key] !== current) env[spec.key] = current
  }
  writeSettings(settings)
  return hooksStatus()
}

export function uninstallHooks(): HooksStatus {
  const settings = readSettings()
  if (settings.hooks) {
    for (const spec of HOOK_SPECS) {
      const groups = settings.hooks[spec.event]
      if (!groups) continue
      const kept: MatcherGroup[] = []
      for (const group of groups) {
        if (!sameMatcher(group.matcher, spec.matcher)) { kept.push(group); continue }
        // Remove every entry that is ours — current path AND stale repo locations.
        const hooks = group.hooks.filter(h => !isOurHook(h.command, spec))
        if (hooks.length > 0) kept.push({ ...group, hooks })
        // else: drop the now-empty group entirely
      }
      if (kept.length > 0) settings.hooks[spec.event] = kept
      else delete settings.hooks[spec.event]
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  }
  // Remove only the exact values we install: a user-customized timeout is theirs,
  // not ours to delete. Mirrors the unrelated-hooks-survive rule above.
  const env = envObject(settings)
  if (env) {
    for (const spec of ENV_SPECS) {
      if (env[spec.key] === spec.value) delete env[spec.key]
    }
    if (Object.keys(env).length === 0) delete settings.env
  }
  writeSettings(settings)
  return hooksStatus()
}
