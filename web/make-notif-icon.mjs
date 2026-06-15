// Generates web/public/notif-icon.png — a colored boardroom mark for browser
// notification banners (amber rounded square + white card-with-dot glyph).
// No image-lib dependency: raw RGBA → PNG via zlib.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = buf => {
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
function inRR(x, y, lo, hi, radius) {
  if (x < lo || x > hi || y < lo || y > hi) return false
  const cx = Math.min(Math.max(x, lo + radius), hi - radius)
  const cy = Math.min(Math.max(y, lo + radius), hi - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
}

const S = 96
const amber = [180, 83, 9]      // #b45309
const white = [255, 255, 255]
const raw = Buffer.alloc(S * (S * 4 + 1))
const c = (S - 1) / 2
for (let y = 0; y < S; y++) {
  const row = y * (S * 4 + 1)
  raw[row] = 0
  for (let x = 0; x < S; x++) {
    const bg = inRR(x, y, 6, S - 7, 22)
    const cardRing = inRR(x, y, 26, S - 27, 10) && !inRR(x, y, 30, S - 31, 7)
    const dot = (x - c) ** 2 + (y - c) ** 2 <= 7 * 7
    const o = row + 1 + x * 4
    if (cardRing || dot) { raw[o] = white[0]; raw[o + 1] = white[1]; raw[o + 2] = white[2]; raw[o + 3] = 255 }
    else if (bg) { raw[o] = amber[0]; raw[o + 1] = amber[1]; raw[o + 2] = amber[2]; raw[o + 3] = 255 }
    else { raw[o + 3] = 0 }
  }
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
])
mkdirSync(join(dir, 'public'), { recursive: true })
writeFileSync(join(dir, 'public', 'notif-icon.png'), png)
console.log('wrote web/public/notif-icon.png (96x96)')
