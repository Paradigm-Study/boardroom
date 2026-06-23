import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

export interface MachineIdentity {
  machineId: string   // immutable
  deviceLabel: string // user-editable nickname; default = hostname
}

function path(configDir: string): string {
  return join(configDir, 'machine.json')
}

// machine.json carries the device identity embedded into every captured session,
// so lock it to the owner (0600) on multi-user systems. Best-effort: chmod
// semantics differ on Windows, and an unwritable mode must not break identity.
function writeLocked(p: string, data: string): void {
  writeFileSync(p, data)
  try { chmodSync(p, 0o600) } catch { /* best-effort */ }
}

export function loadMachineIdentity(configDir: string): MachineIdentity {
  const p = path(configDir)
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<MachineIdentity>
      if (typeof raw.machineId === 'string' && raw.machineId) {
        const deviceLabel = typeof raw.deviceLabel === 'string' && raw.deviceLabel ? raw.deviceLabel : hostname()
        return { machineId: raw.machineId, deviceLabel }
      }
    } catch { /* corrupt file — fall through and re-mint */ }
  }
  const identity: MachineIdentity = { machineId: randomUUID(), deviceLabel: hostname() }
  writeLocked(p, JSON.stringify(identity, null, 2))
  return identity
}

export function setDeviceLabel(configDir: string, deviceLabel: string): MachineIdentity {
  const current = loadMachineIdentity(configDir)
  const updated: MachineIdentity = { machineId: current.machineId, deviceLabel }
  writeLocked(path(configDir), JSON.stringify(updated, null, 2))
  return updated
}
