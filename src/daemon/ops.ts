import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createBackup, ownerOnly, restoreBackup } from './reliability.js'

export interface DoctorCheck {
  name: string
  ok: boolean
  severity: 'info' | 'warning' | 'error'
  detail: string
  repaired?: boolean
}

export interface DoctorReport {
  ok: boolean
  configDir: string
  checks: DoctorCheck[]
}

function permissions(path: string): number {
  return statSync(path).mode & 0o777
}

function checkDb(path: string): { ok: boolean; detail: string } {
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true })
    try {
      const rows = db.pragma('quick_check') as Array<{ quick_check?: string }>
      const failed = db.prepare(
        "SELECT COUNT(*) AS n FROM migration_journal WHERE status != 'complete'",
      ).get() as { n: number }
      const ok = rows.length === 1 && rows[0]?.quick_check === 'ok' && failed.n === 0
      return { ok, detail: ok ? 'quick_check ok; migration journal complete' : 'integrity or migration journal failed' }
    } finally { db.close() }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** Read-only by default. Repair only chmods and prunes old delivered receipts. */
export function doctor(configDir: string, repair = false): DoctorReport {
  const checks: DoctorCheck[] = []
  const push = (check: DoctorCheck): void => { checks.push(check) }
  if (!existsSync(configDir)) {
    push({ name: 'config-dir', ok: false, severity: 'error', detail: 'missing config directory' })
    return { ok: false, configDir, checks }
  }
  const dirMode = permissions(configDir)
  const dirRepair = repair && dirMode !== 0o700
  if (dirRepair) ownerOnly(configDir, true)
  push({
    name: 'config-dir-permissions', ok: dirMode === 0o700 || dirRepair,
    severity: dirMode === 0o700 || dirRepair ? 'info' : 'error',
    detail: `mode ${(dirRepair ? 0o700 : dirMode).toString(8)}`,
    ...(dirRepair ? { repaired: true } : {}),
  })

  for (const name of readdirSync(configDir)) {
    if (
      !/\.(?:sqlite|json)$/.test(name)
      && !/\.sqlite(?:-wal|-shm|\.last-good)$/.test(name)
      && name !== 'local-token'
    ) continue
    const path = join(configDir, name)
    if (!statSync(path).isFile()) continue
    const mode = permissions(path)
    const repaired = repair && mode !== 0o600
    if (repaired) ownerOnly(path)
    push({
      name: `permissions:${name}`, ok: mode === 0o600 || repaired,
      severity: mode === 0o600 || repaired ? 'info' : 'error',
      detail: `mode ${(repaired ? 0o600 : mode).toString(8)}`,
      ...(repaired ? { repaired: true } : {}),
    })
  }

  for (const name of ['boardroom.sqlite', 'mesh-outbox.sqlite']) {
    const path = join(configDir, name)
    if (!existsSync(path)) {
      push({ name: `db:${name}`, ok: true, severity: 'info', detail: 'not present' })
      continue
    }
    const result = checkDb(path)
    push({ name: `db:${name}`, ok: result.ok, severity: result.ok ? 'info' : 'error', detail: result.detail })
    if (repair && result.ok && name === 'mesh-outbox.sqlite') {
      const db = new Database(path)
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
      const changes = db.prepare(
        "DELETE FROM mesh_outbox WHERE state = 'delivered' AND updated_at < ?",
      ).run(cutoff).changes
      db.close()
      push({ name: 'outbox-retention', ok: true, severity: 'info', detail: `pruned ${changes} old delivered rows`, repaired: changes > 0 })
    }
  }

  const credentialPath = join(configDir, 'mesh-credential.json')
  if (existsSync(credentialPath)) {
    if (repair) rmSync(credentialPath, { force: true })
    push({
      name: 'mesh-credential-cache', ok: repair, severity: repair ? 'info' : 'error',
      detail: repair ? 'removed deprecated plaintext credential cache' : 'deprecated plaintext credential cache exists',
      ...(repair ? { repaired: true } : {}),
    })
  }
  const tokenConfigured = !!process.env.BOARDROOM_LOCAL_TOKEN ||
    existsSync(process.env.BOARDROOM_LOCAL_TOKEN_FILE || join(configDir, 'local-token'))
  push({
    name: 'local-auth', ok: tokenConfigured, severity: tokenConfigured ? 'info' : 'warning',
    detail: tokenConfigured ? 'install token configured' : 'unset (legacy development mode only)',
  })
  return { ok: checks.every(check => check.severity !== 'error' || check.ok), configDir, checks }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'doctor'
  const configDir = arg('config-dir') ?? process.env.BOARDROOM_CONFIG_DIR ?? join(homedir(), '.config', 'boardroom')
  if (command === 'doctor') {
    const report = doctor(configDir, process.argv.includes('--repair'))
    if (process.argv.includes('--json')) console.log(JSON.stringify(report))
    else for (const check of report.checks) console.log(`${check.ok ? 'ok' : 'FAIL'} ${check.name}: ${check.detail}`)
    if (!report.ok) process.exitCode = 1
    return
  }
  if (command === 'backup') {
    const output = arg('output')
    if (!output) throw new Error('backup requires --output <directory>')
    console.log(JSON.stringify(createBackup(configDir, output)))
    return
  }
  if (command === 'restore') {
    const input = arg('input')
    if (!input) throw new Error('restore requires --input <directory>')
    console.log(JSON.stringify({ ok: true, preRestoreBackup: restoreBackup(input, configDir) }))
    return
  }
  throw new Error(`unknown operation ${command}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })
}
