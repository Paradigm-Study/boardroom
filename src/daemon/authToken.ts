import { randomUUID } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'

// A per-machine secret that gates the daemon's HTTP API (/api, /events). It is
// deliberately NOT required on /mcp — agents register with `claude mcp add` and no
// extra setup, and that surface is still Host/Origin-guarded and cannot decide
// cards or drive the waker. The browser dashboard and menu-bar receive this token
// transparently (a same-origin cookie / a read of this 0600 file), so it is
// invisible in normal use. Its one job: stop another local user or a rogue local
// process — which can reach 127.0.0.1 regardless of file permissions — from reading
// cards or forging verdicts. Same trust boundary as the 0600 DB permissions.
//
// Minting is the LAST link in loadConfig's token chain (env → explicit file →
// discovered file → mint). Before 2026-08-02 an absent token meant "no auth at
// all" (origin/main's "legacy dev mode"); it now means "mint one", so the guarded
// surface is never unguarded on a fresh install. The caller passes the full path
// so the filename convention stays in one place (config.ts).
export function mintLocalToken(tokenFile: string): string {
  // Two UUIDs of entropy (~256 bits), hex only so it is a clean Bearer/cookie value.
  const token = (randomUUID() + randomUUID()).replace(/-/g, '')
  writeFileSync(tokenFile, token, { mode: 0o600 })
  try { chmodSync(tokenFile, 0o600) } catch { /* best-effort (Windows chmod differs) */ }
  return token
}
