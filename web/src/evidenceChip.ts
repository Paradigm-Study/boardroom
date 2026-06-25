import type { Block } from '../../src/shared/blocks.js'

// Collapse a claim's evidence blocks into one short, glanceable chip label for
// the results checklist. Full evidence lives behind the row's expand toggle.
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function evidenceChip(blocks: Block[]): string {
  if (blocks.length === 0) return ''
  const first = label(blocks[0])
  return blocks.length > 1 ? `${first} +${blocks.length - 1}` : first
}

function label(b: Block): string {
  switch (b.type) {
    case 'evidence': {
      // Commands can be long (a multi-pattern grep); keep the chip short so it
      // never crushes the claim text. Full command shows on expand.
      const cmd = clip((b.command ?? 'output').split(/\s+/).slice(0, 2).join(' '), 18)
      return `${cmd}${b.exitCode !== undefined ? ` · exit ${b.exitCode}` : ''}`
    }
    case 'diff_stat': {
      const add = b.files.reduce((s, f) => s + f.additions, 0)
      const del = b.files.reduce((s, f) => s + f.deletions, 0)
      return `${b.files.length} file${b.files.length === 1 ? '' : 's'} +${add} −${del}`
    }
    case 'mermaid':
    case 'graph':
      return 'diagram'
    case 'table':
      return `${b.rows.length}-row table`
    case 'phases':
      return `${b.phases.length} phases`
    case 'options_compare':
      return `${b.options.length} options`
    case 'acceptance':
      return `${b.criteria.length} criteri${b.criteria.length === 1 ? 'on' : 'a'}`
    case 'markdown':
      return 'notes'
  }
}
