import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../shared/card.js'
import { loadConfig } from './config.js'
import { MeshOutbox } from './meshOutbox.js'
import { doctor } from './ops.js'
import {
  createBackup,
  openRecoveringDatabase,
  restoreBackup,
  runMigrations,
  verifyBackup,
} from './reliability.js'
import { Store } from './store.js'

const card = (id: string): Card => ({
  id,
  stage: 'clarify',
  session: { agent: 'test', project: 'demo' },
  headline: 'recover me',
  blocks: [],
  decisions: [{ id: 'd', prompt: 'p', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }],
  status: 'pending',
  createdAt: new Date().toISOString(),
})

describe('reliability operations', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boardroom-reliability-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('journals versioned migrations, snapshots first, and rolls a failed migration back atomically', () => {
    const path = join(dir, 'migration.sqlite')
    const db = openRecoveringDatabase(path)
    runMigrations(db, path, 'test', [{
      version: 1, name: 'base', up: value => value.exec("CREATE TABLE stable (id TEXT PRIMARY KEY); INSERT INTO stable VALUES ('seed')"),
    }])
    expect(() => runMigrations(db, path, 'test', [{
      version: 2,
      name: 'injected failure',
      up: value => {
        value.exec("INSERT INTO stable VALUES ('must-rollback')")
        value.exec('CREATE TABLE must_rollback (id TEXT)')
        throw new Error('failure injection')
      },
    }])).toThrow(/failure injection/)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'must_rollback'").get()).toBeUndefined()
    expect(db.prepare('SELECT id FROM stable ORDER BY id').all()).toEqual([{ id: 'seed' }])
    expect(db.prepare(
      "SELECT status FROM migration_journal WHERE component = 'test' AND version = 2",
    ).get()).toEqual({ status: 'failed' })
    expect(readdirSync(join(dir, 'migration-snapshots')).some(name => name.includes('test-v2'))).toBe(true)
    runMigrations(db, path, 'test', [{
      version: 2, name: 'retry succeeds', up: value => value.exec('CREATE TABLE retry_succeeded (id TEXT)'),
    }])
    expect(db.prepare(
      "SELECT status FROM migration_journal WHERE component = 'test' AND version = 2",
    ).get()).toEqual({ status: 'complete' })
    db.close()
  })

  it('recovers a corrupt database from the last verified close snapshot', () => {
    const path = join(dir, 'boardroom.sqlite')
    const first = new Store(path)
    first.insert(card('preserved'))
    first.close()
    expect(existsSync(`${path}.last-good`)).toBe(true)
    writeFileSync(path, 'not a sqlite database')
    const recovered = new Store(path)
    expect(recovered.get('preserved')?.headline).toBe('recover me')
    expect(readdirSync(dir).some(name => name.includes('.corrupt-'))).toBe(true)
    recovered.close()
  })

  it('restores the main database and quarantines sidecars when last-good recovery also fails', () => {
    const path = join(dir, 'boardroom.sqlite')
    writeFileSync(path, 'original-corrupt-database')
    writeFileSync(`${path}-wal`, 'original-wal')
    writeFileSync(`${path}-shm`, 'original-shm')
    writeFileSync(`${path}.last-good`, 'also-not-sqlite')
    expect(() => openRecoveringDatabase(path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('original-corrupt-database')
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)
    const evidence = readdirSync(dir).find(name => name.startsWith('boardroom.sqlite.corrupt-'))
    expect(evidence).toBeDefined()
    const evidencePath = join(dir, evidence!)
    expect(readFileSync(evidencePath, 'utf8')).toBe('original-corrupt-database')
    expect(existsSync(`${evidencePath}-wal`)).toBe(true)
    expect(existsSync(`${evidencePath}-shm`)).toBe(true)
    for (const candidate of [path, evidencePath, `${evidencePath}-wal`, `${evidencePath}-shm`]) {
      expect(statSync(candidate).mode & 0o777).toBe(0o600)
    }
  })

  it('recovers a partial config write from its last-good image', () => {
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ notifications: false }))
    expect(loadConfig(dir).notifications).toBe(false)
    writeFileSync(path, '{"notifications":')
    expect(loadConfig(dir).notifications).toBe(false)
    expect(readdirSync(dir).some(name => name.startsWith('config.json.corrupt-'))).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('backs up with checksums, creates a pre-restore backup, and rejects tampering before mutation', () => {
    const dbPath = join(dir, 'boardroom.sqlite')
    const store = new Store(dbPath)
    store.insert(card('from-backup'))
    store.close()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ notifications: false, mesh: { token: 'never-back-up' } }), { mode: 0o600 })
    writeFileSync(join(dir, 'local-token'), 'machine-local-secret', { mode: 0o600 })
    writeFileSync(join(dir, 'mesh-credential.json'), JSON.stringify({ token: 'hosted-secret' }), { mode: 0o600 })
    const backupDir = join(dir, 'backup')
    createBackup(dir, backupDir)
    expect(verifyBackup(backupDir).files.map(file => file.name)).toContain('boardroom.sqlite')
    const backupNames = verifyBackup(backupDir).files.map(file => file.name)
    for (const secret of ['config.json', 'local-token', 'mesh-credential.json']) {
      expect(backupNames).not.toContain(secret)
    }

    let changed = new Store(dbPath)
    changed.insert(card('after-backup'))
    changed.close()
    const preRestore = restoreBackup(backupDir, dir)
    let restored = new Store(dbPath)
    expect(restored.list().map(item => item.id)).toEqual(['from-backup'])
    restored.close()
    const preDb = new Store(join(preRestore, 'boardroom.sqlite'))
    expect(preDb.list().map(item => item.id).sort()).toEqual(['after-backup', 'from-backup'])
    preDb.close()
    expect(readFileSync(join(dir, 'local-token'), 'utf8')).toBe('machine-local-secret')
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).mesh.token).toBe('never-back-up')

    writeFileSync(join(backupDir, 'boardroom.sqlite'), 'tampered')
    expect(() => restoreBackup(backupDir, dir)).toThrow(/checksum mismatch/)
    restored = new Store(dbPath)
    expect(restored.list().map(item => item.id)).toEqual(['from-backup'])
    restored.close()

    createBackup(dir, backupDir + '-fresh')
    expect(() => restoreBackup(backupDir + '-fresh', dir, {
      afterPreviousMoved: () => { throw new Error('mid-swap injection') },
    })).toThrow(/mid-swap injection/)
    restored = new Store(dbPath)
    expect(restored.list().map(item => item.id)).toEqual(['from-backup'])
    restored.close()
  })

  it('rejects traversal, duplicate names, and symlink entries before restore mutation', () => {
    const dbPath = join(dir, 'boardroom.sqlite')
    const store = new Store(dbPath)
    store.insert(card('untouched'))
    store.close()
    const backupDir = join(dir, 'malicious-backup')
    createBackup(dir, backupDir)
    const manifestPath = join(backupDir, 'manifest.json')
    const original = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Array<{ name: string; size: number; sha256: string }>
    }

    writeFileSync(manifestPath, JSON.stringify({ ...original, version: 1, files: [{ ...original.files[0]!, name: '../boardroom.sqlite' }] }))
    expect(() => restoreBackup(backupDir, dir)).toThrow(/unsafe or duplicate/)
    writeFileSync(manifestPath, JSON.stringify({ ...original, version: 1, files: [original.files[0]!, original.files[0]!] }))
    expect(() => restoreBackup(backupDir, dir)).toThrow(/unsafe or duplicate/)

    writeFileSync(manifestPath, JSON.stringify({ ...original, version: 1 }))
    rmSync(join(backupDir, 'boardroom.sqlite'))
    symlinkSync(dbPath, join(backupDir, 'boardroom.sqlite'))
    expect(() => restoreBackup(backupDir, dir)).toThrow(/not a regular file/)

    const untouched = new Store(dbPath)
    expect(untouched.list().map(item => item.id)).toEqual(['untouched'])
    untouched.close()
  })

  it('prunes only old delivered outbox receipts and preserves queued/terminal replay state', () => {
    const path = join(dir, 'mesh-outbox.sqlite')
    let outbox = new MeshOutbox(path)
    for (const [key, state] of [['old-delivered', 'delivered'], ['queued', 'queued'], ['terminal', 'terminal']] as const) {
      outbox.enqueue({
        idempotencyKey: key, cardId: key, event: 'raised', record: { key },
        createdAt: '2020-01-01T00:00:00.000Z',
      })
      if (state === 'delivered') outbox.markDelivered(key, 1)
      if (state === 'terminal') outbox.markTerminal(key, 'terminal')
    }
    outbox.close()
    const db = new Database(path)
    db.prepare("UPDATE mesh_outbox SET updated_at = '2020-01-01T00:00:00.000Z'").run()
    db.close()
    outbox = new MeshOutbox(path)
    expect(outbox.list().map(entry => [entry.idempotencyKey, entry.state]).sort()).toEqual([
      ['queued', 'queued'], ['terminal', 'terminal'],
    ])
    outbox.close()
  })

  it('doctor emits machine-readable checks and only repairs owner permissions', () => {
    const store = new Store(join(dir, 'boardroom.sqlite'))
    store.close()
    writeFileSync(join(dir, 'local-token'), 'secret', { mode: 0o644 })
    const before = doctor(dir)
    expect(before.ok).toBe(false)
    const repaired = doctor(dir, true)
    expect(repaired.ok).toBe(true)
    expect(repaired.checks.some(check => check.repaired)).toBe(true)
    expect(statSync(join(dir, 'local-token')).mode & 0o777).toBe(0o600)
    expect(() => JSON.stringify(repaired)).not.toThrow()
  })
})
