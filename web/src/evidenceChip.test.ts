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
})
