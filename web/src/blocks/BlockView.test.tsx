// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Block } from '../../../src/shared/blocks.js'
import { parseHash } from '../fileView.js'
import { BlockView, blockAnchorId, labelLines } from './BlockView.js'

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

describe('BlockView acceptance block', () => {
  it('renders each criterion with its good/bad outcomes, trace, and the goal', () => {
    const block: Block = {
      id: 'ac', type: 'acceptance', title: 'Contract', goal: 'ship securely',
      criteria: [
        { id: 'cr1', behavior: 'tokens are secure', good: 'httpOnly cookie only', bad: 'token in localStorage', tracesTo: 'token_storage' },
      ],
    }
    render(<BlockView block={block} />)

    expect(screen.getByText('tokens are secure')).toBeTruthy()
    expect(screen.getByText(/httpOnly cookie only/)).toBeTruthy()
    expect(screen.getByText(/token in localStorage/)).toBeTruthy()
    expect(screen.getByText(/token_storage/)).toBeTruthy()
    expect(screen.getByText(/ship securely/)).toBeTruthy()
  })

  it('shows a met/unmet status pill when a criterion carries status', () => {
    const block: Block = {
      id: 'ac', type: 'acceptance',
      criteria: [
        { id: 'cr1', behavior: 'b1', good: 'g1', bad: 'x1', tracesTo: 't1', status: 'met' },
        { id: 'cr2', behavior: 'b2', good: 'g2', bad: 'x2', tracesTo: 't2', status: 'unmet' },
      ],
    }
    render(<BlockView block={block} />)

    expect(screen.getByText('met')).toBeTruthy()
    expect(screen.getByText('unmet')).toBeTruthy()
  })
})

describe('BlockView renders each data-bearing block type', () => {
  it('table: renders every row across all columns', () => {
    const block: Block = {
      id: 'tbl',
      type: 'table',
      title: 'Capacity',
      columns: ['Region', 'Quota'],
      rows: [
        ['us-east', '40'],
        ['eu-west', '25'],
        ['ap-south', '10'],
      ],
    }
    render(<BlockView block={block} />)

    const table = screen.getByRole('table')
    expect(within(table).getByText('Region')).toBeTruthy()
    expect(within(table).getByText('Quota')).toBeTruthy()
    // 1 header row + 3 body rows
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    expect(within(table).getByText('us-east')).toBeTruthy()
    expect(within(table).getByText('eu-west')).toBeTruthy()
    expect(within(table).getByText('ap-south')).toBeTruthy()
    expect(within(table).getByText('40')).toBeTruthy()
    expect(within(table).getByText('25')).toBeTruthy()
    expect(within(table).getByText('10')).toBeTruthy()
  })

  it('graph: renders the node labels', () => {
    const block: Block = {
      id: 'g',
      type: 'graph',
      nodes: [
        { id: 'a', label: 'Ingest' },
        { id: 'b', label: 'Transform' },
        { id: 'c', label: 'Publish' },
      ],
      edges: [
        { from: 'a', to: 'b', label: 'stream' },
        { from: 'b', to: 'c' },
      ],
    }
    render(<BlockView block={block} />)

    expect(screen.getByText('Ingest')).toBeTruthy()
    expect(screen.getByText('Transform')).toBeTruthy()
    expect(screen.getByText('Publish')).toBeTruthy()
    // edge label is rendered too
    expect(screen.getByText('stream')).toBeTruthy()
  })

  it('phases: renders each phase title', () => {
    const block: Block = {
      id: 'ph',
      type: 'phases',
      phases: [
        { title: 'Scaffold', summary: 'wire the daemon' },
        { title: 'Render', summary: 'build the dashboard' },
        { title: 'Ship' },
      ],
    }
    render(<BlockView block={block} />)

    expect(screen.getByText('Scaffold')).toBeTruthy()
    expect(screen.getByText('Render')).toBeTruthy()
    expect(screen.getByText('Ship')).toBeTruthy()
    // summaries render when present
    expect(screen.getByText('wire the daemon')).toBeTruthy()
    expect(screen.getByText('build the dashboard')).toBeTruthy()
  })

  it('diff_stat: renders per-file additions and deletions', () => {
    const block: Block = {
      id: 'd',
      type: 'diff_stat',
      files: [
        { path: 'src/store.ts', additions: 12, deletions: 3 },
        { path: 'web/src/App.tsx', additions: 5, deletions: 0 },
      ],
    }
    render(<BlockView block={block} />)

    expect(screen.getByText('src/store.ts')).toBeTruthy()
    expect(screen.getByText('web/src/App.tsx')).toBeTruthy()
    expect(screen.getByText('+12')).toBeTruthy()
    expect(screen.getByText('−3')).toBeTruthy()
    expect(screen.getByText('+5')).toBeTruthy()
    expect(screen.getByText('−0')).toBeTruthy()
  })

  it('options_compare: renders option labels with pros and cons', () => {
    const block: Block = {
      id: 'oc',
      type: 'options_compare',
      options: [
        { label: 'SQLite store', pros: ['Zero-config', 'Embedded'], cons: ['Single writer'], recommended: true },
        { label: 'Postgres store', pros: ['Concurrent writers'], cons: ['Ops overhead'] },
      ],
    }
    render(<BlockView block={block} />)

    expect(screen.getByText('SQLite store')).toBeTruthy()
    expect(screen.getByText('Postgres store')).toBeTruthy()
    expect(screen.getByText('Zero-config')).toBeTruthy()
    expect(screen.getByText('Embedded')).toBeTruthy()
    expect(screen.getByText('Single writer')).toBeTruthy()
    expect(screen.getByText('Concurrent writers')).toBeTruthy()
    expect(screen.getByText('Ops overhead')).toBeTruthy()
    // the recommended option carries a rec badge
    expect(screen.getByText('rec')).toBeTruthy()
  })

  it('evidence: shows the output when forceOpen', () => {
    const block: Block = {
      id: 'ev',
      type: 'evidence',
      command: 'npm test',
      output: 'PASS suite green-output-line',
      exitCode: 0,
    }
    const { container } = render(<BlockView block={block} forceOpen />)

    expect(screen.getByText('PASS suite green-output-line')).toBeTruthy()
    expect(screen.getByText('npm test')).toBeTruthy()
    expect(screen.getByText('exit 0')).toBeTruthy()
    const details = container.querySelector('details.evidence') as HTMLDetailsElement
    expect(details.open).toBe(true)
  })

  it('evidence: stays collapsed without forceOpen', () => {
    const block: Block = {
      id: 'ev2',
      type: 'evidence',
      command: 'npm test',
      output: 'hidden-output-line',
      exitCode: 1,
    }
    const { container } = render(<BlockView block={block} />)

    const details = container.querySelector('details.evidence') as HTMLDetailsElement
    expect(details.open).toBe(false)
    // a non-zero exit code is flagged
    expect(screen.getByText('exit 1')).toBeTruthy()
  })

  it('markdown: renders the prose text', () => {
    const block: Block = {
      id: 'md',
      type: 'markdown',
      text: 'A plain context paragraph.',
    }
    render(<BlockView block={block} />)

    expect(screen.getByText('A plain context paragraph.')).toBeTruthy()
  })

  it('mermaid: mounts with its block header (async diagram render is not run in jsdom)', () => {
    // mermaid renders asynchronously via a dynamic import jsdom can't run, so
    // assert the block mounts (its header + anchor) rather than coupling to the
    // transient "rendering…" placeholder copy, which a wording tweak would break.
    const block: Block = {
      id: 'mer',
      type: 'mermaid',
      source: 'graph TD; A-->B;',
    }
    const { container } = render(<BlockView block={block} />)

    expect(screen.getByText('Diagram')).toBeTruthy()
    expect(container.querySelector('#block-mer')).toBeTruthy()
  })

  it('markdown: routes a file link into the in-app viewer instead of navigating away', () => {
    const block: Block = { id: 'mlink', type: 'markdown', text: 'See [the report](./out/report.html).' }
    render(<BlockView block={block} />)

    fireEvent.click(screen.getByRole('link', { name: 'the report' }))

    expect(parseHash(window.location.hash)).toEqual({ kind: 'file', url: './out/report.html', name: 'report.html' })
  })

  it('markdown: opens an external link in a new tab and does not hijack it', () => {
    const block: Block = { id: 'mext', type: 'markdown', text: 'Visit [the site](https://example.com/page).' }
    render(<BlockView block={block} />)

    const link = screen.getByRole('link', { name: 'the site' }) as HTMLAnchorElement
    expect(link.target).toBe('_blank')
    expect(link.getAttribute('href')).toBe('https://example.com/page')
    expect(window.location.hash).toBe('')
  })

  it('renders the kind label and block title in the header', () => {
    const block: Block = {
      id: 'md2',
      type: 'markdown',
      title: 'Constraints',
      text: 'body text',
    }
    render(<BlockView block={block} />)

    expect(screen.getByText('Context')).toBeTruthy()
    expect(screen.getByText('· Constraints')).toBeTruthy()
  })
})

describe('blockAnchorId / anchorScope (duplicate-anchor scoping)', () => {
  it('namespaces the id to a decision when a scope is given', () => {
    expect(blockAnchorId('ev')).toBe('block-ev')
    expect(blockAnchorId('ev', 'decision-1')).toBe('block-decision-1-ev')
  })

  it('stamps the scoped id on the rendered block, not the bare one', () => {
    const block: Block = { id: 'ev', type: 'markdown', text: 'body' }
    const { container } = render(<BlockView block={block} anchorScope="d1" />)

    expect(container.querySelector('#block-d1-ev')).toBeTruthy()
    expect(container.querySelector('#block-ev')).toBeNull()
  })
})

describe('labelLines (graph node word-wrap/truncate)', () => {
  it('keeps a short label on a single line', () => {
    expect(labelLines('Build')).toEqual(['Build'])
  })

  it('wraps a long label onto two lines', () => {
    expect(labelLines('Database migration layer')).toEqual(['Database migration', 'layer'])
  })

  it('truncates with a trailing ellipsis when content overflows two lines', () => {
    const lines = labelLines('one two three four five six seven eight nine ten')
    expect(lines).toHaveLength(2)
    expect(lines[lines.length - 1].endsWith('...')).toBe(true)
  })

  it('keeps an over-18-char single word intact on one line', () => {
    const word = 'supercalifragilisticexpialidocious'
    expect(word.length).toBeGreaterThan(18)
    expect(labelLines(word)).toEqual([word])
  })
})

describe('BlockView new widgets', () => {
  it('callout: renders the summary and an Explain more disclosure for the detail', () => {
    const block: Block = {
      id: 'c', type: 'callout', tone: 'warn',
      summary: 'Touches auth — slower rollout',
      detail: 'The token-storage path changes, so we stage it behind a flag.',
    }
    render(<BlockView block={block} />)

    expect(screen.getByText('Touches auth — slower rollout')).toBeTruthy()
    expect(screen.getByText('Explain more')).toBeTruthy()
  })

  it('callout: omits the disclosure when there is no detail', () => {
    const block: Block = { id: 'c2', type: 'callout', tone: 'info', summary: 'Just an FYI' }
    render(<BlockView block={block} />)

    expect(screen.getByText('Just an FYI')).toBeTruthy()
    expect(screen.queryByText('Explain more')).toBeNull()
  })

  it('key_facts: renders every fact label, value, delta, and its tone class', () => {
    const block: Block = {
      id: 'k', type: 'key_facts',
      facts: [
        { label: 'Tests', value: '142', delta: '+12', tone: 'good' },
        { label: 'Bundle', value: '211kb', delta: '−4', tone: 'bad' },
      ],
    }
    const { container } = render(<BlockView block={block} />)

    expect(screen.getByText('Tests')).toBeTruthy()
    expect(screen.getByText('142')).toBeTruthy()
    expect(screen.getByText('+12')).toBeTruthy()
    expect(screen.getByText('Bundle')).toBeTruthy()
    expect(screen.getByText('211kb')).toBeTruthy()
    // both deltas render (not just the first) and tone is the styling signal
    expect(screen.getByText('−4')).toBeTruthy()
    expect(container.querySelector('.kf-delta.kf-good')).toBeTruthy()
    expect(container.querySelector('.kf-delta.kf-bad')).toBeTruthy()
  })

  it('bar_list: renders each item label and its display value', () => {
    const block: Block = {
      id: 'b', type: 'bar_list',
      items: [
        { label: 'auth.ts', value: 320, display: '320 ms' },
        { label: 'db.ts', value: 120, display: '120 ms' },
      ],
    }
    render(<BlockView block={block} />)

    expect(screen.getByText('auth.ts')).toBeTruthy()
    expect(screen.getByText('320 ms')).toBeTruthy()
    expect(screen.getByText('db.ts')).toBeTruthy()
    expect(screen.getByText('120 ms')).toBeTruthy()
  })

  it('progress: renders the label and a value-over-total readout', () => {
    const block: Block = { id: 'p', type: 'progress', label: 'Migration', value: 18, total: 24 }
    render(<BlockView block={block} />)

    expect(screen.getByText('Migration')).toBeTruthy()
    expect(screen.getByText('18/24')).toBeTruthy()
  })
})

describe('BlockView visual widget (sandboxed)', () => {
  const svgVisual: Block = {
    id: 'vz', type: 'visual', format: 'svg', aspectRatio: 16 / 9,
    source: '<svg viewBox="0 0 16 9"><rect width="16" height="9"></rect></svg>',
  }

  it('renders the visual inside an iframe with sandbox="" exactly — the sole security boundary', () => {
    const { container } = render(<BlockView block={svgVisual} />)
    const iframe = container.querySelector('iframe.visual-frame') as HTMLIFrameElement
    expect(iframe).toBeTruthy()
    // The whole boundary rests on this exact value. If anyone ever adds allow-scripts
    // or allow-same-origin, this test fails — by design.
    expect(iframe.getAttribute('sandbox')).toBe('')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts')
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe.getAttribute('loading')).toBe('lazy')
  })

  it('builds a srcdoc whose CSP meta is first in <head>, before the token style and the author source', () => {
    const { container } = render(<BlockView block={svgVisual} />)
    const doc = (container.querySelector('iframe.visual-frame') as HTMLIFrameElement).getAttribute('srcdoc') ?? ''
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain("object-src 'none'")
    const cspIdx = doc.indexOf('Content-Security-Policy')
    const styleIdx = doc.indexOf('<style')
    const sourceIdx = doc.indexOf('<rect')
    expect(cspIdx).toBeGreaterThanOrEqual(0)
    expect(cspIdx).toBeLessThan(styleIdx)
    expect(cspIdx).toBeLessThan(sourceIdx)
  })

  it('assembles the srcdoc with the CSP meta before the body, so a stray </head> lands as inert body text', () => {
    const sneaky: Block = { id: 'vs', type: 'visual', format: 'html', height: 120, source: '<div>a</div></head>' }
    const { container } = render(<BlockView block={sneaky} />)
    const doc = (container.querySelector('iframe.visual-frame') as HTMLIFrameElement).getAttribute('srcdoc') ?? ''
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<div>a</div></head>'))
  })

  it('sizes an explicit aspectRatio as an uncropped ratio box — no max-height, no pixel height', () => {
    const af = render(<BlockView block={svgVisual} />).container.querySelector('iframe.visual-frame') as HTMLIFrameElement
    expect(af.style.aspectRatio).toBeTruthy()
    expect(af.style.height).toBe('') // ratio mode sets no pixel height
    expect(af.style.maxHeight).toBe('') // the old 720px crop forced inner scrolling on tall visuals
  })

  it('derives the ratio from the svg viewBox when no aspectRatio is given, so the whole figure is always visible', () => {
    const block: Block = { id: 'vd', type: 'visual', format: 'svg', source: '<svg viewBox="0 0 100 300"><rect/></svg>' }
    const f = render(<BlockView block={block} />).container.querySelector('iframe.visual-frame') as HTMLIFrameElement
    expect(parseFloat(f.style.aspectRatio)).toBeCloseTo(100 / 300)
    expect(f.style.height).toBe('')
  })

  it('clamps hostile ratios (derived or explicit) so a visual cannot bury the card', () => {
    const derived: Block = { id: 'vt', type: 'visual', format: 'svg', source: '<svg viewBox="0 0 10 1000"><rect/></svg>' }
    const df = render(<BlockView block={derived} />).container.querySelector('iframe.visual-frame') as HTMLIFrameElement
    expect(parseFloat(df.style.aspectRatio)).toBeCloseTo(0.1)

    const explicit: Block = { id: 'vx', type: 'visual', format: 'svg', aspectRatio: 0.01, source: '<svg viewBox="0 0 16 9"></svg>' }
    const xf = render(<BlockView block={explicit} />).container.querySelector('iframe.visual-frame') as HTMLIFrameElement
    expect(parseFloat(xf.style.aspectRatio)).toBeCloseTo(0.1)
  })

  it('html visuals keep explicit-height mode inside a drag-resizable wrapper (240px fallback)', () => {
    const hr = render(<BlockView block={{ id: 'vh', type: 'visual', format: 'html', height: 300, source: '<div>x</div>' }} />).container
    const wrap = hr.querySelector('.visual-resize') as HTMLDivElement
    const hf = wrap.querySelector('iframe.visual-frame') as HTMLIFrameElement
    expect(wrap.style.height).toBe('300px')
    expect(hf.style.height).toBe('100%') // the wrapper owns the height so the human can drag it taller
    expect(hf.style.aspectRatio).toBe('')

    const br = render(<BlockView block={{ id: 'vb', type: 'visual', format: 'html', source: '<div>x</div>' }} />).container
    expect((br.querySelector('.visual-resize') as HTMLDivElement).style.height).toBe('240px')
  })

  it('never derives a ratio for html visuals, even when the markup embeds an svg', () => {
    const block: Block = { id: 'vm', type: 'visual', format: 'html', source: '<p>legend</p><svg viewBox="0 0 10 10"></svg>' }
    const { container } = render(<BlockView block={block} />)
    const f = container.querySelector('iframe.visual-frame') as HTMLIFrameElement
    expect(f.style.aspectRatio).toBe('')
    expect((container.querySelector('.visual-resize') as HTMLDivElement).style.height).toBe('240px')
  })

  it('aspect-ratio mode is not wrapped for resize — the frame already fits its content exactly', () => {
    const { container } = render(<BlockView block={svgVisual} />)
    expect(container.querySelector('.visual-resize')).toBeNull()
  })
})
