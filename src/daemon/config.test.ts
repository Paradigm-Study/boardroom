import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boardroom-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig(join(dir, 'cfgdir'))
    expect(cfg.port).toBe(4040)
    expect(cfg.remindEveryMinutes).toBe(10)
    expect(cfg.notifications).toBe(true)
    expect(cfg.openOnPending).toBe(false)
    expect(cfg.dbPath).toBe(join(dir, 'cfgdir', 'boardroom.sqlite'))
    expect(cfg.configDir).toBe(join(dir, 'cfgdir'))
  })

  it('lets file overrides win over defaults', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ port: 9999, notifications: false, openOnPending: true, remindEveryMinutes: 3 }),
    )
    const cfg = loadConfig(dir)
    expect(cfg.port).toBe(9999)
    expect(cfg.notifications).toBe(false)
    expect(cfg.openOnPending).toBe(true)
    expect(cfg.remindEveryMinutes).toBe(3)
  })

  it('derives dbPath and configDir from the dir, ignoring any file overrides', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ port: 9999, dbPath: '/evil/path.sqlite', configDir: '/evil/dir' }),
    )
    const cfg = loadConfig(dir)
    // The explicit dir always wins for the derived paths — they are not overridable.
    expect(cfg.dbPath).toBe(join(dir, 'boardroom.sqlite'))
    expect(cfg.configDir).toBe(dir)
    // ...while a real override (port) still takes effect.
    expect(cfg.port).toBe(9999)
  })

  it('creates the config dir locked to 0700', () => {
    const cfgDir = join(dir, 'cfgdir')
    loadConfig(cfgDir)
    expect(statSync(cfgDir).mode & 0o777).toBe(0o700)
  })

  it('mints a per-machine auth token and persists it locked to 0600', () => {
    const first = loadConfig(dir)
    expect(typeof first.authToken).toBe('string')
    expect(first.authToken!.length).toBeGreaterThanOrEqual(32)
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600)
    // Stable across reloads (the daemon must not rotate the token every boot).
    expect(loadConfig(dir).authToken).toBe(first.authToken)
  })

  it('does not crash on an unparseable config.json — falls back to defaults', () => {
    writeFileSync(join(dir, 'config.json'), '{ this is not valid json ')
    const cfg = loadConfig(dir)
    expect(cfg.port).toBe(4040)
    expect(cfg.notifications).toBe(true)
  })

  it('ignores config values of the wrong type (a string port never reaches listen)', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ port: '9999', remindEveryMinutes: 'soon', notifications: 'yes' }),
    )
    const cfg = loadConfig(dir)
    expect(cfg.port).toBe(4040)
    expect(cfg.remindEveryMinutes).toBe(10)
    expect(cfg.notifications).toBe(true)
  })

  it('rejects an out-of-range port', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 70000 }))
    expect(loadConfig(dir).port).toBe(4040)
  })
})
