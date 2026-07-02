import { describe, expect, it } from 'vitest'
import { clampVisualRatio, intrinsicSvgRatio, RATIO_MAX, RATIO_MIN } from './visualSize.js'

// The whole point of intrinsic sizing: an SVG visual carries its true shape in its own
// viewBox, so the frame can always show the WHOLE figure without the agent hand-tuning
// aspectRatio — and without any script inside the sandbox reporting a height.
describe('intrinsicSvgRatio', () => {
  it('derives width/height from a viewBox', () => {
    expect(intrinsicSvgRatio('<svg viewBox="0 0 160 90"><rect/></svg>')).toBeCloseTo(160 / 90)
  })

  it('accepts comma-separated and negative-origin viewBox values', () => {
    expect(intrinsicSvgRatio('<svg viewBox="0,0,300,150"></svg>')).toBeCloseTo(2)
    expect(intrinsicSvgRatio('<svg viewBox="-10 -5 200 100"></svg>')).toBeCloseTo(2)
    expect(intrinsicSvgRatio("<svg viewBox='0 0 400 100'></svg>")).toBeCloseTo(4)
  })

  it('is case-insensitive on the attribute name (HTML parsers normalize viewbox)', () => {
    expect(intrinsicSvgRatio('<svg VIEWBOX="0 0 100 50"></svg>')).toBeCloseTo(2)
  })

  it('falls back to unitless / px width+height attributes when there is no viewBox', () => {
    expect(intrinsicSvgRatio('<svg width="400" height="300"></svg>')).toBeCloseTo(4 / 3)
    expect(intrinsicSvgRatio('<svg width="400px" height="200px"></svg>')).toBeCloseTo(2)
  })

  it('does not mistake stroke-width for width', () => {
    expect(intrinsicSvgRatio('<svg stroke-width="3" width="200" height="100"></svg>')).toBeCloseTo(2)
    expect(intrinsicSvgRatio('<svg stroke-width="3" height="100"></svg>')).toBeNull()
  })

  it('ignores percentage or otherwise non-pixel dimensions', () => {
    expect(intrinsicSvgRatio('<svg width="100%" height="300"></svg>')).toBeNull()
    expect(intrinsicSvgRatio('<svg width="10em" height="300"></svg>')).toBeNull()
  })

  it('returns null for malformed, zero, or missing dimensions', () => {
    expect(intrinsicSvgRatio('<div>no svg here</div>')).toBeNull()
    expect(intrinsicSvgRatio('<svg viewBox="0 0 100"></svg>')).toBeNull()
    expect(intrinsicSvgRatio('<svg viewBox="0 0 100 0"></svg>')).toBeNull()
    expect(intrinsicSvgRatio('<svg viewBox="0 0 -100 50"></svg>')).toBeNull()
    expect(intrinsicSvgRatio('<svg viewBox="a b c d"></svg>')).toBeNull()
    expect(intrinsicSvgRatio('<svg></svg>')).toBeNull()
  })

  it('reads only the first (root) svg tag', () => {
    expect(intrinsicSvgRatio('<svg viewBox="0 0 100 50"><svg viewBox="0 0 10 100"/></svg>')).toBeCloseTo(2)
  })

  it('handles attributes spread across lines', () => {
    expect(intrinsicSvgRatio('<svg\n  xmlns="http://www.w3.org/2000/svg"\n  viewBox="0 0 640 480">\n</svg>')).toBeCloseTo(640 / 480)
  })
})

// The clamp bounds attention-hijack (a hostile 1000×-tall ratio would bury the card's
// decisions) while staying generous enough that no real diagram ever hits it.
describe('clampVisualRatio', () => {
  it('passes ordinary ratios through untouched', () => {
    expect(clampVisualRatio(16 / 9)).toBeCloseTo(16 / 9)
    expect(clampVisualRatio(1 / 3)).toBeCloseTo(1 / 3)
  })

  it('clamps pathological ratios to the [RATIO_MIN, RATIO_MAX] band', () => {
    expect(clampVisualRatio(0.01)).toBe(RATIO_MIN)
    expect(clampVisualRatio(1000)).toBe(RATIO_MAX)
  })
})
