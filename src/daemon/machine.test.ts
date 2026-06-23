import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadMachineIdentity, setDeviceLabel } from './machine.js'

describe('machine identity', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'br-machine-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('mints once and is stable across calls', () => {
    const a = loadMachineIdentity(dir)
    const b = loadMachineIdentity(dir)
    expect(a.machineId).toBe(b.machineId)
    expect(a.machineId.length).toBeGreaterThan(0)
  })

  it('defaults deviceLabel to a non-empty hostname', () => {
    expect(loadMachineIdentity(dir).deviceLabel.length).toBeGreaterThan(0)
  })

  it('renames deviceLabel but keeps machineId', () => {
    const before = loadMachineIdentity(dir)
    const after = setDeviceLabel(dir, 'My Desktop')
    expect(after.deviceLabel).toBe('My Desktop')
    expect(after.machineId).toBe(before.machineId)
    expect(loadMachineIdentity(dir).deviceLabel).toBe('My Desktop')
  })

  it('persists to machine.json', () => {
    const id = loadMachineIdentity(dir)
    expect(JSON.parse(readFileSync(join(dir, 'machine.json'), 'utf8')).machineId).toBe(id.machineId)
  })

  it('re-mints on a corrupt machine.json instead of throwing', () => {
    writeFileSync(join(dir, 'machine.json'), '{not valid json', 'utf8')
    expect(() => loadMachineIdentity(dir)).not.toThrow()
    expect(loadMachineIdentity(dir).machineId.length).toBeGreaterThan(0)
  })

  it('writes machine.json locked to 0600 (it carries device identity)', () => {
    if (process.platform === 'win32') return // chmod semantics differ on Windows
    loadMachineIdentity(dir)
    expect(statSync(join(dir, 'machine.json')).mode & 0o777).toBe(0o600)
  })

  it('keeps machine.json locked to 0600 after a label change', () => {
    if (process.platform === 'win32') return
    loadMachineIdentity(dir)
    setDeviceLabel(dir, 'My Desktop')
    expect(statSync(join(dir, 'machine.json')).mode & 0o777).toBe(0o600)
  })
})
