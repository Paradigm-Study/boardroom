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
    expect(cfg.port).toBe(4140)
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

  it('honors BOARDROOM_PORT — the convention seed.ts and every hook already use — over the default', () => {
    const prev = process.env.BOARDROOM_PORT
    process.env.BOARDROOM_PORT = '4041'
    try {
      expect(loadConfig(join(dir, 'cfgdir')).port).toBe(4041)
    } finally {
      if (prev === undefined) delete process.env.BOARDROOM_PORT
      else process.env.BOARDROOM_PORT = prev
    }
  })

  it('BOARDROOM_PORT wins over a config.json port (env is the explicit dev-daemon override)', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 9999 }))
    const prev = process.env.BOARDROOM_PORT
    process.env.BOARDROOM_PORT = '4041'
    try {
      expect(loadConfig(dir).port).toBe(4041)
    } finally {
      if (prev === undefined) delete process.env.BOARDROOM_PORT
      else process.env.BOARDROOM_PORT = prev
    }
  })

  it('ignores a non-numeric BOARDROOM_PORT, falling back to file/default', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 9999 }))
    const prev = process.env.BOARDROOM_PORT
    process.env.BOARDROOM_PORT = 'not-a-port'
    try {
      expect(loadConfig(dir).port).toBe(9999)
    } finally {
      if (prev === undefined) delete process.env.BOARDROOM_PORT
      else process.env.BOARDROOM_PORT = prev
    }
  })
})
