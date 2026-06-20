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
