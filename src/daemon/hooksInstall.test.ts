import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let fakeHome: string
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => fakeHome }
})

// Imported after the mock so every call inside sees the mocked homedir().
const { claudeSettingsPath, hooksStatus, installHooks, uninstallHooks, HOOK_SPECS, ENV_SPECS } =
  await import('./hooksInstall.js')

function settingsPath(): string {
  return join(fakeHome, '.claude', 'settings.json')
}

function writeSettings(obj: unknown): void {
  const p = settingsPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2))
}

function readSettingsRaw(): unknown {
  return JSON.parse(readFileSync(settingsPath(), 'utf8'))
}

describe('hooksInstall', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'br-hooks-'))
    fakeHome = dir
    // node:fs mkdirSync isn't called by hooksInstall for the .claude dir itself,
    // so tests that pre-seed a file must create the parent directory.
    writeFileSync(join(dir, '.gitkeep'), '')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('resolves the path under the (mocked) home directory', () => {
    expect(claudeSettingsPath()).toBe(join(fakeHome, '.claude', 'settings.json'))
  })

  it('reports nothing wired when settings.json does not exist', () => {
    const status = hooksStatus()
    expect(status.installed).toBe(false)
    expect(status.entries).toHaveLength(HOOK_SPECS.length)
    expect(status.entries.every(e => !e.wired)).toBe(true)
  })

  it('installs all 4 hooks and reports fully installed', () => {
    const status = installHooks()
    expect(status.installed).toBe(true)
    expect(status.entries.every(e => e.wired)).toBe(true)
  })

  it('is idempotent: installing twice does not duplicate entries', () => {
    installHooks()
    installHooks()
    const raw = readSettingsRaw() as { hooks: { PreToolUse: { matcher: string; hooks: unknown[] }[] } }
    const askGroup = raw.hooks.PreToolUse.find(g => g.matcher === 'AskUserQuestion')
    expect(askGroup?.hooks).toHaveLength(1)
  })

  it('uninstall restores byte-for-byte the pre-install shape (no leftover empty hooks key)', () => {
    writeSettings({ enabledPlugins: { foo: true }, skipWorkflowUsageWarning: true })
    const before = readSettingsRaw()
    installHooks()
    const after = uninstallHooks()
    expect(after.installed).toBe(false)
    expect(readSettingsRaw()).toEqual(before)
  })

  it('preserves unrelated hooks the user already had configured', () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/some/other/tool/precheck.sh' }] },
          { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/some/other/tool/unrelated-ask.sh' }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: '/some/other/tool/on-stop.sh' }] }],
      },
    })

    installHooks()
    let raw = readSettingsRaw() as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[]; Stop: { hooks: { command: string }[] }[] }
    }
    const bashGroup = raw.hooks.PreToolUse.find(g => g.matcher === 'Bash')
    expect(bashGroup?.hooks.map(h => h.command)).toEqual(['/some/other/tool/precheck.sh'])
    const askGroup = raw.hooks.PreToolUse.find(g => g.matcher === 'AskUserQuestion')
    expect(askGroup?.hooks.map(h => h.command)).toContain('/some/other/tool/unrelated-ask.sh')
    expect(askGroup?.hooks).toHaveLength(2) // unrelated + ours, same matcher group
    expect(raw.hooks.Stop[0]?.hooks.map(h => h.command)).toContain('/some/other/tool/on-stop.sh')

    uninstallHooks()
    raw = readSettingsRaw() as typeof raw
    // Unrelated entries must survive uninstall untouched.
    expect(raw.hooks.PreToolUse.find(g => g.matcher === 'Bash')?.hooks.map(h => h.command))
      .toEqual(['/some/other/tool/precheck.sh'])
    const askAfter = raw.hooks.PreToolUse.find(g => g.matcher === 'AskUserQuestion')
    expect(askAfter?.hooks.map(h => h.command)).toEqual(['/some/other/tool/unrelated-ask.sh'])
    expect(raw.hooks.Stop[0]?.hooks.map(h => h.command)).toEqual(['/some/other/tool/on-stop.sh'])
  })

  it('writes a .bak snapshot of the pre-mutation file on every write', () => {
    writeSettings({ marker: 'pristine' })
    installHooks()
    expect(existsSync(`${settingsPath()}.bak`)).toBe(true)
    expect(JSON.parse(readFileSync(`${settingsPath()}.bak`, 'utf8'))).toEqual({ marker: 'pristine' })
  })

  it('uninstall on an already-clean file is a safe no-op', () => {
    writeSettings({ enabledPlugins: {} })
    const before = readSettingsRaw()
    const status = uninstallHooks()
    expect(status.installed).toBe(false)
    expect(readSettingsRaw()).toEqual(before)
  })

  // The env block is the client half of the timeout fix — the piece that
  // regressed by living only in the README. The installer now owns it.
  describe('env block (client half of the timeout fix)', () => {
    it('install writes the recommended env defaults and reports them configured', () => {
      const status = installHooks()
      expect(status.installed).toBe(true)
      expect(status.env.every(e => e.configured)).toBe(true)
      const raw = readSettingsRaw() as { env: Record<string, string> }
      for (const spec of ENV_SPECS) expect(raw.env[spec.key]).toBe(spec.value)
    })

    it('preserves a user-tuned value: install fills only the missing keys', () => {
      writeSettings({ env: { MCP_TOOL_TIMEOUT: '3600000' } })
      installHooks()
      const raw = readSettingsRaw() as { env: Record<string, string> }
      expect(raw.env.MCP_TOOL_TIMEOUT).toBe('3600000') // theirs, untouched
      expect(raw.env.MCP_TIMEOUT).toBe('30000') // ours, filled in
      const entry = hooksStatus().env.find(e => e.key === 'MCP_TOOL_TIMEOUT')
      expect(entry).toMatchObject({ configured: true, current: '3600000' })
    })

    it('drift detection: hooks wired but env missing → installed is false', () => {
      installHooks()
      const raw = readSettingsRaw() as Record<string, unknown>
      delete raw.env
      writeSettings(raw)
      const status = hooksStatus()
      expect(status.entries.every(e => e.wired)).toBe(true)
      expect(status.env.every(e => !e.configured)).toBe(true)
      expect(status.installed).toBe(false)
    })

    it('uninstall removes only the exact installed defaults — custom values survive', () => {
      writeSettings({ env: { MCP_TOOL_TIMEOUT: '3600000', OTHER: 'x' } })
      installHooks()
      uninstallHooks()
      const raw = readSettingsRaw() as { env: Record<string, string> }
      expect(raw.env).toEqual({ MCP_TOOL_TIMEOUT: '3600000', OTHER: 'x' }) // our MCP_TIMEOUT default removed
    })

    it('a malformed (non-object) env is reported unconfigured, then repaired by install', () => {
      writeSettings({ env: 'not-an-object' })
      expect(hooksStatus().env.every(e => !e.configured)).toBe(true)
      installHooks()
      const raw = readSettingsRaw() as { env: Record<string, string> }
      for (const spec of ENV_SPECS) expect(raw.env[spec.key]).toBe(spec.value)
    })

    it('empty-string values count as unconfigured and are refilled on install', () => {
      writeSettings({ env: { MCP_TOOL_TIMEOUT: '  ' } })
      expect(hooksStatus().env.find(e => e.key === 'MCP_TOOL_TIMEOUT')?.configured).toBe(false)
      installHooks()
      const raw = readSettingsRaw() as { env: Record<string, string> }
      expect(raw.env.MCP_TOOL_TIMEOUT).toBe('86400000')
    })

    it('a numeric user value is configured, repaired to its string form, and survives uninstall', () => {
      writeSettings({ env: { MCP_TOOL_TIMEOUT: 3600000 } })
      const entry = hooksStatus().env.find(e => e.key === 'MCP_TOOL_TIMEOUT')
      expect(entry).toMatchObject({ configured: true, current: '3600000' })
      installHooks()
      let raw = readSettingsRaw() as { env: Record<string, unknown> }
      expect(raw.env.MCP_TOOL_TIMEOUT).toBe('3600000') // type repaired, value preserved
      uninstallHooks()
      raw = readSettingsRaw() as { env: Record<string, unknown> }
      expect(raw.env.MCP_TOOL_TIMEOUT).toBe('3600000') // not our default → not ours to delete
    })
  })

  describe('defensive handling of a broken settings file', () => {
    it('an array-rooted settings.json is surfaced as an error, never a silent no-op', () => {
      const p = settingsPath()
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, '[]')
      expect(() => hooksStatus()).toThrow(/not a JSON object/)
      expect(() => installHooks()).toThrow(/not a JSON object/)
      expect(readFileSync(p, 'utf8')).toBe('[]') // untouched
    })
  })

  describe('stale entries from a moved repo', () => {
    const stale = (script: string): string => `/old/location/boardroom/hooks/${script}`

    it('install replaces a stale-path entry instead of stacking a duplicate', () => {
      writeSettings({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: stale('session-start.sh') }] }] },
      })
      installHooks()
      const raw = readSettingsRaw() as { hooks: { SessionStart: { hooks: { command: string }[] }[] } }
      const cmds = raw.hooks.SessionStart.flatMap(g => g.hooks.map(h => h.command))
      expect(cmds).toHaveLength(1)
      expect(cmds[0]).not.toBe(stale('session-start.sh'))
      expect(cmds[0].endsWith('/hooks/session-start.sh')).toBe(true)
    })

    it('uninstall purges stale-path entries too, not just the current path', () => {
      writeSettings({
        hooks: {
          Stop: [{ hooks: [
            { type: 'command', command: stale('require-review.sh') },
            { type: 'command', command: '/some/other/tool/on-stop.sh' },
          ] }],
        },
      })
      uninstallHooks()
      const raw = readSettingsRaw() as { hooks: { Stop: { hooks: { command: string }[] }[] } }
      expect(raw.hooks.Stop[0].hooks.map(h => h.command)).toEqual(['/some/other/tool/on-stop.sh'])
    })
  })
})
