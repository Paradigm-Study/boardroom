import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

let dir: string
let ambientBoardroomPort: string | undefined

beforeEach(() => {
  ambientBoardroomPort = process.env.BOARDROOM_PORT
  delete process.env.BOARDROOM_PORT
  dir = mkdtempSync(join(tmpdir(), 'boardroom-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (ambientBoardroomPort === undefined) delete process.env.BOARDROOM_PORT
  else process.env.BOARDROOM_PORT = ambientBoardroomPort
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

  it('lets a validated BOARDROOM_PORT override the file for desktop-managed launches', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 9999 }))
    process.env.BOARDROOM_PORT = '51234'
    expect(loadConfig(dir).port).toBe(51234)
  })

  it.each(['0', '65536', 'not-a-port', '', ' 51234', '51234 '])(
    'rejects non-canonical BOARDROOM_PORT value %j',
    value => {
      process.env.BOARDROOM_PORT = value
      expect(() => loadConfig(dir)).toThrow(/between 1 and 65535/)
    }
  )

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
})

describe('loadConfig local bearer', () => {
  const keys = ['BOARDROOM_LOCAL_TOKEN', 'BOARDROOM_LOCAL_TOKEN_FILE'] as const
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const key of keys) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('prefers BOARDROOM_LOCAL_TOKEN without writing or logging it', () => {
    process.env.BOARDROOM_LOCAL_TOKEN = ' env-secret '
    expect(loadConfig(dir).localToken).toBe('env-secret')
  })

  it('loads a protected token file and locks it to 0600', () => {
    const path = join(dir, 'install-token')
    writeFileSync(path, 'file-secret\n', { mode: 0o644 })
    process.env.BOARDROOM_LOCAL_TOKEN_FILE = path
    expect(loadConfig(dir).localToken).toBe('file-secret')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('fails closed when an explicitly configured token file is missing or empty', () => {
    process.env.BOARDROOM_LOCAL_TOKEN_FILE = join(dir, 'missing-token')
    expect(() => loadConfig(dir)).toThrow(/does not exist/)
    const empty = join(dir, 'empty-token')
    writeFileSync(empty, '\n')
    process.env.BOARDROOM_LOCAL_TOKEN_FILE = empty
    expect(() => loadConfig(dir)).toThrow(/empty/)
  })

  it('is disabled when neither env nor token file exists (legacy dev)', () => {
    expect(loadConfig(dir).localToken).toBeUndefined()
  })
})

describe('loadConfig mesh resolution (mesh-v0, default-off)', () => {
  const MESH_ENV = [
    'BOARDROOM_MESH_URL', 'BOARDROOM_MESH_TOKEN', 'BOARDROOM_MESH_PERSON',
    'BOARDROOM_MESH_TEAM_ID', 'BOARDROOM_MESH_DEVICE_ID', 'BOARDROOM_MESH_EXPIRES_AT',
    'BOARDROOM_MESH_PROJECTS_JSON',
  ] as const
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = {}
    for (const key of MESH_ENV) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of MESH_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it('resolves no mesh at all by default (nothing configured → nothing leaves the machine)', () => {
    const cfg = loadConfig(dir)
    expect(cfg.mesh).toBeUndefined()
  })

  it('resolves mesh from a complete file block', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ mesh: { url: 'http://127.0.0.1:4600', token: 'tok-file', person: 'alice' } }),
    )
    const cfg = loadConfig(dir)
    expect(cfg.mesh).toEqual({ url: 'http://127.0.0.1:4600', token: 'tok-file', person: 'alice' })
  })

  it('resolves mesh from env alone (no file)', () => {
    process.env.BOARDROOM_MESH_URL = 'http://127.0.0.1:4601'
    process.env.BOARDROOM_MESH_TOKEN = 'tok-env'
    process.env.BOARDROOM_MESH_PERSON = 'bob'
    const cfg = loadConfig(dir)
    expect(cfg.mesh).toEqual({ url: 'http://127.0.0.1:4601', token: 'tok-env', person: 'bob' })
  })

  it('lets env override the file field-by-field', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ mesh: { url: 'http://127.0.0.1:4600', token: 'tok-file', person: 'alice' } }),
    )
    process.env.BOARDROOM_MESH_TOKEN = 'tok-env'
    const cfg = loadConfig(dir)
    // Only the env-set field changes; the other two still come from the file.
    expect(cfg.mesh).toEqual({ url: 'http://127.0.0.1:4600', token: 'tok-env', person: 'alice' })
  })

  it('carries an optional team id while legacy configs remain unchanged', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ mesh: { url: 'http://127.0.0.1:4600', token: 'tok-file', person: 'alice', teamId: 'team-file' } }),
    )
    process.env.BOARDROOM_MESH_TEAM_ID = 'team-env'
    expect(loadConfig(dir).mesh).toEqual({
      url: 'http://127.0.0.1:4600', token: 'tok-file', person: 'alice', teamId: 'team-env',
    })
  })

  it('requires rotating hosted credentials to come completely from process environment', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        mesh: {
          url: 'https://mesh.example.test', token: 'persisted-token', person: 'alice',
          teamId: 'team-a', deviceId: 'device-a', expiresAt: '2099-01-01T00:00:00.000Z',
        },
      }),
    )
    expect(() => loadConfig(dir)).toThrow(/supplied completely through process environment/)

    process.env.BOARDROOM_MESH_URL = 'https://mesh.example.test'
    process.env.BOARDROOM_MESH_TOKEN = 'runtime-only-token'
    process.env.BOARDROOM_MESH_PERSON = 'alice'
    process.env.BOARDROOM_MESH_TEAM_ID = 'team-a'
    process.env.BOARDROOM_MESH_DEVICE_ID = 'device-a'
    process.env.BOARDROOM_MESH_EXPIRES_AT = '2099-01-01T00:00:00.000Z'
    expect(loadConfig(dir).mesh).toEqual({
      url: 'https://mesh.example.test', token: 'runtime-only-token', person: 'alice',
      teamId: 'team-a', deviceId: 'device-a', expiresAt: '2099-01-01T00:00:00.000Z',
      projects: [],
    })
  })

  it('parses hosted workspace consent only from the process environment', () => {
    process.env.BOARDROOM_MESH_URL = 'https://mesh.example.test'
    process.env.BOARDROOM_MESH_TOKEN = 'runtime-only-token'
    process.env.BOARDROOM_MESH_PERSON = 'alice'
    process.env.BOARDROOM_MESH_TEAM_ID = 'team-a'
    process.env.BOARDROOM_MESH_DEVICE_ID = 'device-a'
    process.env.BOARDROOM_MESH_EXPIRES_AT = '2099-01-01T00:00:00.000Z'
    process.env.BOARDROOM_MESH_PROJECTS_JSON = JSON.stringify([
      { workspaceRoot: '/Users/Alice/work/repo/', project: 'Acme/Repo' },
      { workspaceRoot: '/Users/Alice/work/repo', project: 'acme/repo' },
    ])
    expect(loadConfig(dir).mesh?.projects).toEqual([
      { workspaceRoot: '/Users/Alice/work/repo', project: 'acme/repo' },
    ])
  })

  it('fails closed on malformed or ambiguous hosted workspace consent', () => {
    process.env.BOARDROOM_MESH_URL = 'https://mesh.example.test'
    process.env.BOARDROOM_MESH_TOKEN = 'runtime-only-token'
    process.env.BOARDROOM_MESH_PERSON = 'alice'
    process.env.BOARDROOM_MESH_TEAM_ID = 'team-a'
    process.env.BOARDROOM_MESH_DEVICE_ID = 'device-a'
    process.env.BOARDROOM_MESH_EXPIRES_AT = '2099-01-01T00:00:00.000Z'

    process.env.BOARDROOM_MESH_PROJECTS_JSON = 'not-json'
    expect(() => loadConfig(dir)).toThrow(/valid JSON/)
    process.env.BOARDROOM_MESH_PROJECTS_JSON = JSON.stringify([
      { workspaceRoot: 'relative/path', project: 'acme/repo' },
    ])
    expect(() => loadConfig(dir)).toThrow(/invalid workspace mapping/)
    process.env.BOARDROOM_MESH_PROJECTS_JSON = JSON.stringify([
      { workspaceRoot: '/Users/Alice/work/repo', project: 'acme/repo' },
      { workspaceRoot: '/Users/Alice/work/repo/', project: 'other/repo' },
    ])
    expect(() => loadConfig(dir)).toThrow(/multiple projects/)
  })

  it('treats a partial mesh (file) as not configured — never a half-armed forwarder', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ mesh: { url: 'http://127.0.0.1:4600', token: 'tok-file' } }), // person missing
    )
    const cfg = loadConfig(dir)
    expect(cfg.mesh).toBeUndefined()
  })

  it('treats a partial mesh (env) as not configured', () => {
    process.env.BOARDROOM_MESH_URL = 'http://127.0.0.1:4601'
    process.env.BOARDROOM_MESH_PERSON = 'bob' // token missing
    const cfg = loadConfig(dir)
    expect(cfg.mesh).toBeUndefined()
  })

  it('a partial file block cannot leak through the spread (mesh is computed after ...file)', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ port: 4099, mesh: { url: 'http://127.0.0.1:4600' } }),
    )
    const cfg = loadConfig(dir)
    expect(cfg.mesh).toBeUndefined() // NOT the partial object from the file
    expect(cfg.port).toBe(4099) // ordinary file overrides still work
  })

  it('empty-string fields count as unset (env "" does not arm the forwarder)', () => {
    process.env.BOARDROOM_MESH_URL = ''
    process.env.BOARDROOM_MESH_TOKEN = 'tok-env'
    process.env.BOARDROOM_MESH_PERSON = 'bob'
    const cfg = loadConfig(dir)
    expect(cfg.mesh).toBeUndefined()
  })
})
