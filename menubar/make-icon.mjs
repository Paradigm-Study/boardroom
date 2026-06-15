// Generates macOS menu-bar template icons (a rounded "card" outline with a
// center dot) with no image-library dependency — raw RGBA → PNG via zlib.
// Template images must be black + alpha; macOS recolors them for light/dark.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

// rounded-rect membership test in pixel space
function inRR(x, y, size, margin, radius) {
  const lo = margin, hi = size - 1 - margin
  if (x < lo || x > hi || y < lo || y > hi) return false
  const cx = Math.min(Math.max(x, lo + radius), hi - radius)
  const cy = Math.min(Math.max(y, lo + radius), hi - radius)
  const dx = x - cx, dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function render(size) {
  const stroke = Math.max(1, Math.round(size / 16))
  const margin = Math.round(size * 0.16)
  const radius = Math.round(size * 0.2)
  const dotR = size * 0.1
  const c = (size - 1) / 2
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const ring = inRR(x, y, size, margin, radius) && !inRR(x, y, size, margin + stroke, Math.max(0, radius - stroke))
      const dot = (x - c) ** 2 + (y - c) ** 2 <= dotR * dotR
      const on = ring || dot
      const o = rowStart + 1 + x * 4
      raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 0; raw[o + 3] = on ? 255 : 0
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

writeFileSync(join(dir, 'iconTemplate.png'), render(16))
writeFileSync(join(dir, 'iconTemplate@2x.png'), render(32))
console.log('wrote iconTemplate.png (16) + @2x (32)')
