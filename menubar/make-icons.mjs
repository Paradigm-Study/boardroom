// Generates every boardroom icon from one source — the lucide "armchair" mark
// (matching the wordmark + favicon) — via SVG rasterization:
//   - iconTemplate.png / @2x  : menu-bar tray template (black glyph, transparent)
//   - build/boardroom.iconset : colored app icon sizes → icon.icns (via iconutil)
//   - ../web/public/notif-icon.png : browser/notification icon
import { Resvg } from '@resvg/resvg-js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))

const ARMCHAIR =
  '<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/>' +
  '<path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H7v-2a2 2 0 0 0-4 0Z"/>' +
  '<path d="M5 18v2"/><path d="M19 18v2"/>'

const templateSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000000" ` +
  `stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ARMCHAIR}</svg>`

const coloredSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
  `<rect x="6" y="6" width="88" height="88" rx="20" fill="#b45309"/>` +
  `<g transform="translate(22 27) scale(2.33)" fill="none" stroke="#ffffff" stroke-width="2" ` +
  `stroke-linecap="round" stroke-linejoin="round">${ARMCHAIR}</g></svg>`

const png = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng()

writeFileSync(join(dir, 'iconTemplate.png'), png(templateSvg, 16))
writeFileSync(join(dir, 'iconTemplate@2x.png'), png(templateSvg, 32))

const iconset = join(dir, 'build', 'boardroom.iconset')
mkdirSync(iconset, { recursive: true })
for (const [name, size] of [
  ['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64],
  ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512],
  ['icon_512x512', 512], ['icon_512x512@2x', 1024],
]) writeFileSync(join(iconset, `${name}.png`), png(coloredSvg, size))

const pub = join(dir, '..', 'web', 'public')
mkdirSync(pub, { recursive: true })
writeFileSync(join(pub, 'notif-icon.png'), png(coloredSvg, 96))

console.log('icons generated from the armchair mark')
