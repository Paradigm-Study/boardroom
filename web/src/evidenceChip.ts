import type { Block } from '../../src/shared/blocks.js'

// Collapse a claim's evidence blocks into one short, glanceable chip label for
// the results checklist. Full evidence lives behind the row's expand toggle.
export function evidenceChip(blocks: Block[]): string {
  if (blocks.length === 0) return ''
  const first = label(blocks[0])
  return blocks.length > 1 ? `${first} +${blocks.length - 1}` : first
}

function label(b: Block): string {
  switch (b.type) {
    case 'evidence':
      return `${b.command ?? 'output'}${b.exitCode !== undefined ? ` · exit ${b.exitCode}` : ''}`
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
    case 'markdown':
      return 'notes'
  }
}
