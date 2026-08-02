import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A per-machine secret that gates the daemon's HTTP API (/api, /events). It is
// deliberately NOT required on /mcp — agents register with `claude mcp add` and no
// extra setup, and that surface is still Host/Origin-guarded and cannot decide
// cards or drive the waker. The browser dashboard and menu-bar receive this token
// transparently (a same-origin cookie / a read of this 0600 file), so it is
// invisible in normal use. Its one job: stop another local user or a rogue local
// process — which can reach 127.0.0.1 regardless of file permissions — from reading
// cards or forging verdicts. Same trust boundary as the 0600 DB permissions.
export function loadAuthToken(configDir: string): string {
  const p = join(configDir, 'token')
  if (existsSync(p)) {
    try {
      const existing = readFileSync(p, 'utf8').trim()
      if (existing) return existing
    } catch { /* unreadable — fall through and re-mint */ }
  }
  // Two UUIDs of entropy (~256 bits), hex only so it is a clean Bearer/cookie value.
  const token = (randomUUID() + randomUUID()).replace(/-/g, '')
  writeFileSync(p, token, { mode: 0o600 })
  try { chmodSync(p, 0o600) } catch { /* best-effort (Windows chmod differs) */ }
  return token
}
