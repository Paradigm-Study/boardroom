import { describe, expect, it } from 'vitest'
import type { Block } from '../../src/shared/blocks.js'
import { evidenceChip } from './evidenceChip.js'

describe('evidenceChip', () => {
  it('summarizes a test-run evidence block', () => {
    const b: Block = { id: 'e', type: 'evidence', command: 'npm test', exitCode: 0, output: '...' }
    expect(evidenceChip([b])).toBe('npm test · exit 0')
  })

  it('totals a diff_stat across files', () => {
    const b: Block = { id: 'd', type: 'diff_stat', files: [
      { path: 'a.ts', additions: 142, deletions: 0 },
      { path: 'b.ts', additions: 18, deletions: 2 },
    ] }
    expect(evidenceChip([b])).toBe('2 files +160 −2')
  })

  it('names diagrams and adds a count suffix for extra blocks', () => {
    const m: Block = { id: 'm', type: 'mermaid', source: 'graph TD; a-->b' }
    const n: Block = { id: 'n', type: 'markdown', text: 'see notes' }
    expect(evidenceChip([m])).toBe('diagram')
    expect(evidenceChip([m, n])).toBe('diagram +1')
  })

  it('is empty when there is no evidence', () => {
    expect(evidenceChip([])).toBe('')
  })

  it('keeps a long command chip short (no row-crushing)', () => {
    const b: Block = { id: 'e', type: 'evidence', command: "grep -rln 'unstackAll|SquaresFourIcon|computeBatchGridPositions' src/", exitCode: 0, output: '...' }
    const chip = evidenceChip([b])
    expect(chip.length).toBeLessThanOrEqual(30)
    expect(chip).toContain('grep')
    expect(chip).toContain('exit 0')
  })

  it('counts a table by rows', () => {
    const b: Block = { id: 't', type: 'table', columns: ['file', 'lines'], rows: [
      ['a.ts', '10'],
      ['b.ts', '20'],
      ['c.ts', '30'],
    ] }
    expect(evidenceChip([b])).toBe('3-row table')
  })

  it('counts phases', () => {
    const b: Block = { id: 'p', type: 'phases', phases: [
      { title: 'scaffold' },
      { title: 'wire up' },
    ] }
    expect(evidenceChip([b])).toBe('2 phases')
  })

  it('counts compared options', () => {
    const b: Block = { id: 'o', type: 'options_compare', options: [
      { label: 'sqlite', pros: ['simple'], cons: [] },
      { label: 'postgres', pros: ['scales'], cons: ['heavier'] },
    ] }
    expect(evidenceChip([b])).toBe('2 options')
  })

  it('falls back to output when an evidence block has no command', () => {
    const b: Block = { id: 'e', type: 'evidence', output: 'all green' }
    expect(evidenceChip([b]).startsWith('output')).toBe(true)
  })

  it('uses the singular for a single-file diff_stat', () => {
    const b: Block = { id: 'd', type: 'diff_stat', files: [
      { path: 'a.ts', additions: 5, deletions: 1 },
    ] }
    expect(evidenceChip([b])).toBe('1 file +5 −1')
  })
})
