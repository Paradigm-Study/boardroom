import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The resume credential boardroom holds ON THE USER'S BEHALF so the launchd-spawned
// waker can authenticate `claude -p --resume` without touching Claude Code's own
// Keychain (which a launchd subprocess can't reliably read — the cause of the 401).
// 'oauth' is a subscription token from `claude setup-token` (1-year, free on Pro/Max,
// injected as CLAUDE_CODE_OAUTH_TOKEN); 'apiKey' is a pay-per-use ANTHROPIC_API_KEY.
export type CredentialKind = 'oauth' | 'apiKey'
export interface StoredCredential {
  type: CredentialKind
  value: string
  updatedAt: string
  // Set when a wake failed with an auth error: the token went bad after connect
  // (expiry/revocation). A stale credential is never injected again, and status
  // reports disconnected+stale so the dashboard gate re-engages with "expired".
  stale?: boolean
}

export interface AuthStatus {
  connected: boolean
  type?: CredentialKind
  updatedAt?: string
  stale?: boolean
}

// Persists the credential as a 0600 JSON file inside boardroom's own config dir
// (already a 0700 dir holding the 0600 SQLite DB — same posture, no new secret
// surface). Kept OUT of SQLite so it never rides along in a DB copy/backup and can
// be wiped independently. Read defensively: a corrupt/blank/unknown file reads as
// "not connected" rather than throwing and wedging a wake.
export class AuthStore {
  private readonly path: string

  constructor(configDir: string) {
    this.path = join(configDir, 'claude-auth.json')
  }

  // The raw record, stale or not — internal; consumers use get()/status().
  private readRaw(): StoredCredential | undefined {
    try {
      if (!existsSync(this.path)) return undefined
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoredCredential>
      const value = typeof parsed.value === 'string' ? parsed.value.trim() : ''
      if (!value) return undefined
      if (parsed.type !== 'oauth' && parsed.type !== 'apiKey') return undefined
      return {
        type: parsed.type,
        value,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        ...(parsed.stale === true ? { stale: true } : {}),
      }
    } catch {
      return undefined
    }
  }

  // The USABLE credential: a stale (known-bad) token reads as absent so it is
  // never injected into a wake again.
  get(): StoredCredential | undefined {
    const c = this.readRaw()
    return c && !c.stale ? c : undefined
  }

  set(cred: { type: CredentialKind; value: string }): void {
    // A fresh set is a reconnect: never carries staleness over.
    const record: StoredCredential = { type: cred.type, value: cred.value, updatedAt: new Date().toISOString() }
    writeFileSync(this.path, JSON.stringify(record), { mode: 0o600 })
    try { chmodSync(this.path, 0o600) } catch { /* best-effort: writeFileSync mode already applied on create */ }
  }

  // A wake 401'd with this credential: remember it's bad (persisted, so the
  // "reconnect" state survives daemon restarts). No-op when nothing is stored.
  // expectedValue (the token the failing wake actually used) scopes the retirement:
  // if a concurrent reconnect already rotated the stored token, a straggler wake's
  // failure must NOT clobber the fresh, valid credential — so mark stale only when the
  // stored value still matches. Omitting it retires whatever is stored (legacy callers).
  markStale(expectedValue?: string): void {
    const c = this.readRaw()
    if (!c || c.stale) return
    if (expectedValue !== undefined && c.value !== expectedValue) return
    writeFileSync(this.path, JSON.stringify({ ...c, stale: true }), { mode: 0o600 })
    try { chmodSync(this.path, 0o600) } catch { /* best-effort */ }
  }

  clear(): void {
    try { unlinkSync(this.path) } catch { /* already absent */ }
  }

  // Safe to expose to the dashboard: connection state + kind + age, never the secret.
  status(): AuthStatus {
    const c = this.readRaw()
    if (!c) return { connected: false }
    if (c.stale) return { connected: false, stale: true, type: c.type, updatedAt: c.updatedAt }
    return { connected: true, type: c.type, updatedAt: c.updatedAt }
  }
}

// The env a stored credential injects into the spawned `claude -p --resume`. Mirrors
// resumeCredentialEnv's mapping; the waker strips a shadowing ANTHROPIC_API_KEY when
// this is an OAuth token (see buildChildEnv).
export function credentialEnvFromStored(cred: StoredCredential): Record<string, string> {
  return cred.type === 'oauth'
    ? { CLAUDE_CODE_OAUTH_TOKEN: cred.value }
    : { ANTHROPIC_API_KEY: cred.value }
}
