import { describe, expect, it } from 'vitest'
import { CapturedSession } from './session.js'

describe('CapturedSession', () => {
  const valid = {
    sessionId: 'abc-123', machineId: 'm-1', pid: 4242, cwd: '/Users/x/proj',
    project: 'proj', status: 'alive' as const, capturedAt: '2026-06-21T00:00:00.000Z',
    lastSeenAt: '2026-06-21T00:00:00.000Z',
  }

  it('parses a minimal valid record', () => {
    expect(CapturedSession.parse(valid)).toMatchObject({ sessionId: 'abc-123', status: 'alive' })
  })

  it('rejects a missing sessionId', () => {
    expect(CapturedSession.safeParse({ ...valid, sessionId: '' }).success).toBe(false)
  })

  it('rejects an unknown status', () => {
    expect(CapturedSession.safeParse({ ...valid, status: 'paused' }).success).toBe(false)
  })

  it('keeps optional pointers when present', () => {
    const r = CapturedSession.parse({ ...valid, transcriptPath: '/t.jsonl', tasksDir: '/td' })
    expect(r.transcriptPath).toBe('/t.jsonl')
  })
})
