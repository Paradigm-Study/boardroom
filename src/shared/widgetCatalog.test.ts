import { describe, expect, it } from 'vitest'
import { Block } from './blocks.js'
import { WIDGET_CATALOG, widgetCatalogList } from './widgetCatalog.js'

describe('widget catalog (dialbook)', () => {
  it('lists exactly one entry per block-union member', () => {
    expect(widgetCatalogList()).toHaveLength(Block.options.length)
  })

  it('keys every entry by its own block type and carries a valid example of that type', () => {
    for (const [key, entry] of Object.entries(WIDGET_CATALOG)) {
      expect(entry.type).toBe(key)
      const parsed = Block.safeParse(entry.example)
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(parsed.data.type).toBe(key)
    }
  })

  it('gives every entry non-empty name / conveys / whenToUse guidance', () => {
    for (const entry of widgetCatalogList()) {
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.conveys.length).toBeGreaterThan(0)
      expect(entry.whenToUse.length).toBeGreaterThan(0)
    }
  })
})
