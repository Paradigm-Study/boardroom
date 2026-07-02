// Sizing for sandboxed visuals WITHOUT scripts: sandbox="" gives the frame no script
// capability to report its own height, and the parent cannot reach an opaque-origin
// document to measure it — so the frame's shape must come from the author bytes
// themselves. Pure string parsing; block.source must never enter the parent DOM.

// Ratio band: RATIO_MIN bounds attention-hijack (a hostile 1000×-tall visual would bury
// the card's decisions under one block) while allowing ~10×-width diagrams that real
// content occasionally needs; RATIO_MAX mirrors the schema's aspectRatio cap.
export const RATIO_MIN = 0.1
export const RATIO_MAX = 20

export function clampVisualRatio(ratio: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio))
}

const SVG_TAG = /<svg\b[^>]*>/i
// (?<![\w-]) keeps stroke-width / data-viewbox from matching; HTML parsers normalize
// attribute-name case, so the match is case-insensitive. The third alternative accepts
// UNQUOTED attribute values (viewbox=0 0 16 9 is not valid unquoted — but width=16 is),
// which HTML/SVG-in-HTML parsing permits and real generators emit.
const VIEWBOX = /(?<![\w-])viewbox\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i
const PX = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i

function pxDimension(tag: string, name: string): number | null {
  const m = tag.match(new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'))
  const px = (m?.[1] ?? m?.[2] ?? m?.[3])?.match(PX)
  return px ? Number(px[1]) : null
}

// The intrinsic width/height ratio of the ROOT <svg> tag: viewBox first (the intrinsic
// truth), else unitless/px width+height attributes. Anything unparseable (%, em,
// missing, non-positive) → null, and the caller falls back to fixed-height mode.
export function intrinsicSvgRatio(source: string): number | null {
  const tag = source.match(SVG_TAG)?.[0]
  if (!tag) return null
  const vb = tag.match(VIEWBOX)
  const rawViewBox = vb?.[1] ?? vb?.[2]
  if (rawViewBox !== undefined) {
    const parts = rawViewBox.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return parts[2] / parts[3]
    }
  }
  const width = pxDimension(tag, 'width')
  const height = pxDimension(tag, 'height')
  return width !== null && height !== null && width > 0 && height > 0 ? width / height : null
}
