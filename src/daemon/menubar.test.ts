import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { menubarAppCandidates, planMenubarLaunch, startMenubar } from './menubar.js'
import type { MenubarSpawn } from './menubar.js'

describe('menubarAppCandidates', () => {
  it('lists the packaged app under the repo, both arches', () => {
    const c = menubarAppCandidates({}, '/repo')
    expect(c).toEqual([
      '/repo/menubar/release/mac-arm64/boardroom.app',
      '/repo/menubar/release/mac/boardroom.app',
    ])
  })

  it('puts an explicit BOARDROOM_MENUBAR_APP override first', () => {
    const c = menubarAppCandidates({ BOARDROOM_MENUBAR_APP: '/custom/boardroom.app' }, '/repo')
    expect(c[0]).toBe('/custom/boardroom.app')
    expect(c).toContain('/repo/menubar/release/mac-arm64/boardroom.app')
  })
})

describe('planMenubarLaunch', () => {
  const darwin = { platform: 'darwin' as const, exists: () => true }

  it('launches the first existing candidate on macOS by default', () => {
    const plan = planMenubarLaunch(['/a/boardroom.app', '/b/boardroom.app'], {
      ...darwin,
      exists: p => p === '/b/boardroom.app',
    })
    expect(plan.appPath).toBe('/b/boardroom.app')
  })

  it('does not launch when BOARDROOM_NO_MENUBAR is set (the dev opt-out)', () => {
    const plan = planMenubarLaunch(['/a/boardroom.app'], { ...darwin, env: { BOARDROOM_NO_MENUBAR: '1' } })
    expect(plan.appPath).toBeNull()
    expect(plan.reason).toMatch(/BOARDROOM_NO_MENUBAR/)
  })

  it('does not launch off macOS (open -g is macOS-only)', () => {
    const plan = planMenubarLaunch(['/a/boardroom.app'], { ...darwin, platform: 'linux' })
    expect(plan.appPath).toBeNull()
    expect(plan.reason).toMatch(/macOS/)
  })

  it('does not launch when no app bundle is built, and hints how to build it', () => {
    const plan = planMenubarLaunch(['/a/boardroom.app'], { ...darwin, exists: () => false })
    expect(plan.appPath).toBeNull()
    expect(plan.reason).toMatch(/pack/)
  })
})

describe('startMenubar', () => {
  // A fake child_process.spawn: records the command/args and hands back an emitter
  // the test drives to simulate `open` failing or exiting non-zero.
  function fakeSpawn() {
    const calls: { command: string; args: string[] }[] = []
    const child = new EventEmitter()
    const spawn: MenubarSpawn = (command, args) => {
      calls.push({ command, args: [...args] })
      return child
    }
    return { spawn, child, calls }
  }

  it('boots the resolved app with `open -g <path>` in the background', () => {
    const { spawn, calls } = fakeSpawn()
    startMenubar({
      plan: () => ({ appPath: '/x/boardroom.app', reason: '/x/boardroom.app' }),
      spawn, log: () => {}, error: () => {},
    })
    expect(calls).toEqual([{ command: 'open', args: ['-g', '/x/boardroom.app'] }])
  })

  it('loudly reports a non-zero `open` exit (bundle exists but will not launch)', () => {
    const { spawn, child } = fakeSpawn()
    const error = vi.fn()
    startMenubar({ plan: () => ({ appPath: '/x/app', reason: 'x' }), spawn, log: () => {}, error })
    child.emit('exit', 1)
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/exited 1/))
  })

  it('loudly reports a spawn failure (no `open` binary)', () => {
    const { spawn, child } = fakeSpawn()
    const error = vi.fn()
    startMenubar({ plan: () => ({ appPath: '/x/app', reason: 'x' }), spawn, log: () => {}, error })
    child.emit('error', new Error('ENOENT'))
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/open|ENOENT/))
  })

  it('stays quiet on a clean exit (code 0)', () => {
    const { spawn, child } = fakeSpawn()
    const error = vi.fn()
    startMenubar({ plan: () => ({ appPath: '/x/app', reason: 'x' }), spawn, log: () => {}, error })
    child.emit('exit', 0)
    expect(error).not.toHaveBeenCalled()
  })

  it('logs the reason and spawns nothing when the plan declines', () => {
    const { spawn, calls } = fakeSpawn()
    const log = vi.fn()
    startMenubar({ plan: () => ({ appPath: null, reason: 'disabled by BOARDROOM_NO_MENUBAR' }), spawn, log, error: () => {} })
    expect(calls).toHaveLength(0)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/BOARDROOM_NO_MENUBAR/))
  })
})
