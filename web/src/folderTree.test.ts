import { describe, expect, it } from 'vitest'
import type { CapturedSession } from '../../src/shared/session.js'
import { abbreviateHome, buildTree, columnsFor, commonAncestor, deriveHome, type FolderNode } from './folderTree.js'

// Minimal valid-ish CapturedSession factory — only the fields the tree reads
// (cwd, status, sessionId) ever matter to these tests; the rest satisfy the type.
function ses(cwd: string, status: 'alive' | 'ended' = 'alive', id = cwd + ':' + status): CapturedSession {
  return {
    sessionId: id,
    machineId: 'm1',
    pid: 1,
    cwd,
    project: cwd.split('/').pop() || cwd,
    status,
    capturedAt: '2026-06-23T00:00:00.000Z',
    lastSeenAt: '2026-06-23T00:00:00.000Z',
  }
}

// A node's child by segment name — convenience for assertions.
function child(node: FolderNode, name: string): FolderNode {
  const c = node.children.find(n => n.name === name)
  if (!c) throw new Error(`no child "${name}" under ${node.path} (have: ${node.children.map(n => n.name).join(', ')})`)
  return c
}

describe('commonAncestor', () => {
  it('returns the deepest shared prefix', () => {
    expect(commonAncestor([
      '/Users/me/Desktop/Playground/boardroom',
      '/Users/me/Desktop/Paradigm/web/app',
      '/Users/me/Desktop/clawbench',
    ])).toBe('/Users/me/Desktop')
  })
  it('is the path itself for a single input', () => {
    expect(commonAncestor(['/a/b/c'])).toBe('/a/b/c')
  })
  it('falls back to root when inputs diverge at the top', () => {
    expect(commonAncestor(['/Users/me/x', '/tmp/y'])).toBe('/')
  })
  it('is empty-safe', () => {
    expect(commonAncestor([])).toBe('/')
  })
  it('does not treat a partial segment as shared', () => {
    // "/a/bb" must NOT share "/a/b" — comparison is per segment, not per char.
    expect(commonAncestor(['/a/bb', '/a/bc'])).toBe('/a')
  })
})

describe('buildTree', () => {
  it('roots at the common ancestor and aggregates counts up the tree', () => {
    const sessions = [
      ses('/Users/me/Desktop/Playground/boardroom', 'alive', 's1'),
      ses('/Users/me/Desktop/Playground/boardroom', 'ended', 's2'),
      ses('/Users/me/Desktop/Paradigm/web/app', 'alive', 's3'),
      ses('/Users/me/Desktop/clawbench', 'ended', 's4'),
    ]
    const root = buildTree(sessions)
    expect(root.path).toBe('/Users/me/Desktop')
    expect(root.total).toBe(4)
    expect(root.running).toBe(2)

    const play = child(root, 'Playground')
    expect(play.total).toBe(2)
    expect(play.running).toBe(1)
    // The two sessions live in boardroom, not in Playground directly.
    expect(play.sessions).toHaveLength(0)
    expect(child(play, 'boardroom').sessions).toHaveLength(2)

    const claw = child(root, 'clawbench')
    expect(claw.total).toBe(1)
    expect(claw.running).toBe(0)
    expect(claw.sessions).toHaveLength(1)
  })

  it('keeps two sessions in the same folder as one node with count 2', () => {
    const root = buildTree([ses('/p/repo', 'alive', 'a'), ses('/p/repo', 'alive', 'b')])
    // Common ancestor IS the shared cwd, so the tree backs off one level so the
    // folder itself is a clickable entry rather than bare loose sessions at root.
    expect(root.path).toBe('/p')
    const repo = child(root, 'repo')
    expect(repo.total).toBe(2)
    expect(repo.sessions).toHaveLength(2)
  })

  it('backs off one level for a single session so its folder shows as a node', () => {
    const root = buildTree([ses('/a/b/c', 'alive', 'only')])
    expect(root.path).toBe('/a/b')
    expect(child(root, 'c').total).toBe(1)
  })

  it('handles a folder that holds both a session and a subfolder', () => {
    const root = buildTree([ses('/a/b', 'alive', 'p'), ses('/a/b/c', 'ended', 'q')])
    expect(root.path).toBe('/a')
    const b = child(root, 'b')
    expect(b.total).toBe(2)        // its own session + the one under c
    expect(b.sessions).toHaveLength(1)
    expect(child(b, 'c').sessions).toHaveLength(1)
  })

  it('is empty-safe', () => {
    const root = buildTree([])
    expect(root.total).toBe(0)
    expect(root.children).toHaveLength(0)
  })

  it('sorts children alphabetically (case-insensitive)', () => {
    const root = buildTree([
      ses('/r/Zeta', 'alive', '1'),
      ses('/r/alpha', 'alive', '2'),
      ses('/r/Beta', 'alive', '3'),
    ])
    expect(root.children.map(c => c.name)).toEqual(['alpha', 'Beta', 'Zeta'])
  })
})

describe('columnsFor', () => {
  const root = buildTree([
    ses('/Users/me/Desktop/Playground/boardroom', 'alive', 's1'),
    ses('/Users/me/Desktop/clawbench', 'alive', 's2'),
  ])

  it('returns just the root for an empty selection', () => {
    const cols = columnsFor(root, [])
    expect(cols).toHaveLength(1)
    expect(cols[0]).toBe(root)
  })

  it('returns root + each selected folder node, in order', () => {
    const cols = columnsFor(root, ['/Users/me/Desktop/Playground'])
    expect(cols.map(c => c.path)).toEqual(['/Users/me/Desktop', '/Users/me/Desktop/Playground'])
    expect(cols.map(c => c.name)).toEqual(['Desktop', 'Playground'])
  })

  it('stops at the first selection that does not resolve', () => {
    const cols = columnsFor(root, ['/Users/me/Desktop/Playground', '/Users/me/Desktop/Playground/ghost'])
    // boardroom is the real child, "ghost" does not exist → walk stops after Playground.
    expect(cols).toHaveLength(2)
  })
})

describe('deriveHome', () => {
  it('extracts a macOS home prefix', () => {
    expect(deriveHome(['/Users/paradigm.study/Desktop/x'])).toBe('/Users/paradigm.study')
  })
  it('extracts a Linux home prefix', () => {
    expect(deriveHome(['/home/geo/code/y'])).toBe('/home/geo')
  })
  it('returns empty when no home-shaped path is present', () => {
    expect(deriveHome(['/var/tmp/z', '/opt/app'])).toBe('')
  })
})

describe('abbreviateHome', () => {
  it('replaces the home prefix with ~', () => {
    expect(abbreviateHome('/Users/me/Desktop/x', '/Users/me')).toBe('~/Desktop/x')
  })
  it('abbreviates the home dir itself', () => {
    expect(abbreviateHome('/Users/me', '/Users/me')).toBe('~')
  })
  it('leaves unrelated paths and an empty home untouched', () => {
    expect(abbreviateHome('/var/tmp', '/Users/me')).toBe('/var/tmp')
    expect(abbreviateHome('/Users/me/x', '')).toBe('/Users/me/x')
    // A sibling that merely shares a prefix string must not be abbreviated.
    expect(abbreviateHome('/Users/mentor/x', '/Users/me')).toBe('/Users/mentor/x')
  })
})
