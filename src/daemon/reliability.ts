import { createHash } from 'node:crypto'
import {
  closeSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import Database from 'better-sqlite3'

export interface Migration {
  version: number
  name: string
  up(db: Database.Database): void
}

function safeStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function ownerOnly(path: string, directory = false): void {
  if (!existsSync(path)) return
  chmodSync(path, directory ? 0o700 : 0o600)
}

export function ownerOnlyDatabase(path: string): void {
  if (path === ':memory:') return
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}.last-good`]) ownerOnly(candidate)
}

function snapshotDatabase(db: Database.Database, path: string, label: string): string | undefined {
  if (path === ':memory:') return undefined
  const dir = join(dirname(path), 'migration-snapshots')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  ownerOnly(dir, true)
  const target = join(dir, `${basename(path)}.${label}.${safeStamp()}.sqlite`)
  db.prepare('VACUUM INTO ?').run(target)
  ownerOnly(target)
  return target
}

/** Journaled migrations: pre-snapshot + SQL transaction + durable status. */
export function runMigrations(
  db: Database.Database,
  path: string,
  component: string,
  migrations: Migration[],
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_journal (
      component     TEXT NOT NULL,
      version       INTEGER NOT NULL,
      name          TEXT NOT NULL,
      status        TEXT NOT NULL,
      snapshot_path TEXT,
      started_at    TEXT NOT NULL,
      completed_at  TEXT,
      error         TEXT,
      PRIMARY KEY (component, version)
    )
  `)
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    const row = db.prepare(
      'SELECT status FROM migration_journal WHERE component = ? AND version = ?',
    ).get(component, migration.version) as { status: string } | undefined
    if (row?.status === 'complete') continue
    const snapshot = snapshotDatabase(db, path, `${component}-v${migration.version}`)
    const started = new Date().toISOString()
    db.prepare(`
      INSERT INTO migration_journal
        (component, version, name, status, snapshot_path, started_at, completed_at, error)
      VALUES (?, ?, ?, 'pending', ?, ?, NULL, NULL)
      ON CONFLICT(component, version) DO UPDATE SET
        name = excluded.name, status = 'pending', snapshot_path = excluded.snapshot_path,
        started_at = excluded.started_at, completed_at = NULL, error = NULL
    `).run(component, migration.version, migration.name, snapshot ?? null, started)
    try {
      db.transaction(() => migration.up(db))()
      db.prepare(`
        UPDATE migration_journal SET status = 'complete', completed_at = ?, error = NULL
         WHERE component = ? AND version = ?
      `).run(new Date().toISOString(), component, migration.version)
    } catch (error) {
      db.prepare(`
        UPDATE migration_journal SET status = 'failed', completed_at = ?, error = ?
         WHERE component = ? AND version = ?
      `).run(
        new Date().toISOString(),
        (error instanceof Error ? error.message : String(error)).slice(0, 500),
        component,
        migration.version,
      )
      throw error
    }
  }
}

function quickCheck(db: Database.Database): boolean {
  const rows = db.pragma('quick_check') as Array<{ quick_check?: string }>
  return rows.length === 1 && rows[0]?.quick_check === 'ok'
}

/** Open, integrity-check, and recover only from a previously verified snapshot. */
export function openRecoveringDatabase(path: string): Database.Database {
  if (path === ':memory:') return new Database(path)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  ownerOnly(dirname(path), true)
  const lastGood = `${path}.last-good`
  const open = (): Database.Database => {
    const db = new Database(path)
    if (!quickCheck(db)) {
      db.close()
      throw new Error(`database ${path} failed quick_check`)
    }
    return db
  }
  try {
    const db = open()
    ownerOnlyDatabase(path)
    return db
  } catch (error) {
    if (!existsSync(lastGood)) throw error
    const corrupt = `${path}.corrupt-${safeStamp()}`
    if (existsSync(path)) {
      renameSync(path, corrupt)
      ownerOnly(corrupt)
    }
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`)) {
        renameSync(`${path}${suffix}`, `${corrupt}${suffix}`)
        ownerOnly(`${corrupt}${suffix}`)
      }
    }
    try {
      copyFileSync(lastGood, path)
      ownerOnly(path)
      return open()
    } catch (recoveryError) {
      rmSync(path, { force: true })
      rmSync(`${path}-wal`, { force: true })
      rmSync(`${path}-shm`, { force: true })
      // Preserve the failed database and SQLite-managed sidecars under their
      // quarantined names. SQLite may rewrite WAL/SHM merely by opening a file,
      // so do not reattach them to the active database. Restore only the main
      // file byte-for-byte and retain the evidence copy for diagnosis.
      if (existsSync(corrupt)) {
        copyFileSync(corrupt, path)
        ownerOnly(path)
        ownerOnly(corrupt)
      }
      for (const suffix of ['-wal', '-shm']) {
        ownerOnly(`${corrupt}${suffix}`)
      }
      throw recoveryError
    }
  }
}

/** Refresh the verified startup-recovery image using SQLite's consistent VACUUM snapshot. */
export function refreshLastGood(db: Database.Database, path: string): void {
  if (path === ':memory:' || !quickCheck(db)) return
  const tmp = `${path}.last-good.tmp-${process.pid}`
  rmSync(tmp, { force: true })
  db.prepare('VACUUM INTO ?').run(tmp)
  ownerOnly(tmp)
  renameSync(tmp, `${path}.last-good`)
  ownerOnlyDatabase(path)
}

export interface BackupManifest {
  version: 1
  createdAt: string
  files: Array<{ name: string; size: number; sha256: string }>
}

const FIXED_BACKUP_FILES = new Set(['boardroom.sqlite', 'mesh-outbox.sqlite', 'machine.json'])

function isBackupFileName(name: string): boolean {
  return FIXED_BACKUP_FILES.has(name) || /^mesh-outbox-[a-f0-9]{16}\.sqlite$/.test(name)
}

function regularFile(path: string, label: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new Error(`backup file missing: ${label}`)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`backup entry is not a regular file: ${label}`)
  }
}

function validateManifest(value: unknown): BackupManifest {
  if (typeof value !== 'object' || value === null) throw new Error('unsupported backup manifest')
  const manifest = value as Partial<BackupManifest>
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 102) {
    throw new Error('unsupported backup manifest')
  }
  const seen = new Set<string>()
  for (const candidate of manifest.files) {
    if (typeof candidate !== 'object' || candidate === null) throw new Error('invalid backup entry')
    const file = candidate as { name?: unknown; size?: unknown; sha256?: unknown }
    if (
      typeof file.name !== 'string'
      || !isBackupFileName(file.name)
      || file.name.includes('/')
      || file.name.includes('\\')
      || seen.has(file.name)
    ) {
      throw new Error(`unsafe or duplicate backup entry: ${String(file.name)}`)
    }
    if (
      typeof file.size !== 'number'
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || typeof file.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error(`invalid backup metadata: ${file.name}`)
    }
    seen.add(file.name)
  }
  return manifest as BackupManifest
}

function checksum(path: string): string {
  const hash = createHash('sha256')
  const handle = openSync(path, 'r')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const bytes = readSync(handle, chunk, 0, chunk.length, null)
      if (bytes === 0) break
      hash.update(chunk.subarray(0, bytes))
    }
  } finally {
    closeSync(handle)
  }
  return hash.digest('hex')
}

export function createBackup(sourceDir: string, outputDir: string): BackupManifest {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 })
  ownerOnly(outputDir, true)
  const names = readdirSync(sourceDir)
    .filter(name => isBackupFileName(name) && existsSync(join(sourceDir, name)))
    .sort()
  const files = names.map(name => {
    const source = join(sourceDir, name)
    const target = join(outputDir, name)
    regularFile(source, name)
    if (name.endsWith('.sqlite')) {
      const db = new Database(source, { readonly: true })
      try { db.prepare('VACUUM INTO ?').run(target) } finally { db.close() }
    } else {
      copyFileSync(source, target)
    }
    ownerOnly(target)
    return { name, size: statSync(target).size, sha256: checksum(target) }
  })
  const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), files }
  const manifestPath = join(outputDir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 })
  ownerOnly(manifestPath)
  return manifest
}

export function verifyBackup(inputDir: string): BackupManifest {
  const manifestPath = join(inputDir, 'manifest.json')
  regularFile(manifestPath, 'manifest.json')
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown)
  for (const file of manifest.files) {
    const path = join(inputDir, file.name)
    regularFile(path, file.name)
    if (statSync(path).size !== file.size || checksum(path) !== file.sha256) {
      throw new Error(`backup checksum mismatch: ${file.name}`)
    }
  }
  return manifest
}

/** Verify first, create a pre-restore backup, then atomically replace each file. */
export function restoreBackup(
  inputDir: string,
  targetDir: string,
  hooks: { afterPreviousMoved?: (name: string) => void } = {},
): string {
  const manifest = verifyBackup(inputDir)
  const preRestore = join(targetDir, `pre-restore-${safeStamp()}`)
  createBackup(targetDir, preRestore)
  const staged: Array<{ name: string; target: string; tmp: string; installed: boolean }> = []
  try {
    for (const file of manifest.files) {
      const target = join(targetDir, file.name)
      const tmp = `${target}.restore-${process.pid}`
      copyFileSync(join(inputDir, file.name), tmp)
      ownerOnly(tmp)
      staged.push({
        name: file.name,
        target,
        tmp,
        installed: false,
      })
    }
  } catch (error) {
    for (const item of staged) rmSync(item.tmp, { force: true })
    throw error
  }
  const manifestNames = new Set(manifest.files.map(file => file.name))
  const managedNames = new Set([
    ...manifestNames,
    ...readdirSync(targetDir).filter(isBackupFileName),
  ])
  const quarantined: Array<{ original: string; previous: string }> = []
  try {
    for (const name of managedNames) {
      const target = join(targetDir, name)
      const candidates = name.endsWith('.sqlite')
        ? [target, `${target}-wal`, `${target}-shm`, `${target}.last-good`]
        : [target]
      for (const [index, candidate] of candidates.entries()) {
        if (!existsSync(candidate)) continue
        const previous = `${candidate}.before-restore-${process.pid}-${index}`
        renameSync(candidate, previous)
        quarantined.push({ original: candidate, previous })
      }
      hooks.afterPreviousMoved?.(name)
    }
    for (const item of staged) {
      renameSync(item.tmp, item.target)
      item.installed = true
      ownerOnly(item.target)
    }
    // The replacement is committed once every staged file is installed. Cleanup
    // of quarantined originals is best-effort after that point: a cleanup error
    // must never trigger a partial rollback after earlier originals were removed.
    for (const item of quarantined) {
      try { rmSync(item.previous, { force: true }) } catch { /* retained for manual cleanup */ }
    }
    return preRestore
  } catch (error) {
    for (const item of [...staged].reverse()) {
      if (item.installed) rmSync(item.target, { force: true })
      rmSync(item.tmp, { force: true })
    }
    for (const item of quarantined.reverse()) {
      if (existsSync(item.previous)) renameSync(item.previous, item.original)
    }
    throw error
  }
}
