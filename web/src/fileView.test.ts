import { describe, expect, it } from 'vitest'
import { extensionOf, fileHash, fileKind, parseHash, viewableHref } from './fileView.js'

describe('fileKind', () => {
  it('classifies by mime first', () => {
    expect(fileKind({ mime: 'image/png' })).toBe('image')
    expect(fileKind({ mime: 'image/svg+xml' })).toBe('image')
    expect(fileKind({ mime: 'application/pdf' })).toBe('pdf')
    expect(fileKind({ mime: 'text/html' })).toBe('html')
    expect(fileKind({ mime: 'application/xhtml+xml' })).toBe('html')
    expect(fileKind({ mime: 'text/markdown' })).toBe('markdown')
    expect(fileKind({ mime: 'text/plain' })).toBe('text')
    expect(fileKind({ mime: 'application/json' })).toBe('text')
    expect(fileKind({ mime: 'application/zip' })).toBe('other')
  })

  it('ignores mime params and case', () => {
    expect(fileKind({ mime: 'TEXT/HTML; charset=utf-8' })).toBe('html')
  })

  it('falls back to the file extension when mime is missing or generic', () => {
    expect(fileKind({ name: 'photo.JPG' })).toBe('image')
    expect(fileKind({ name: 'report.pdf' })).toBe('pdf')
    expect(fileKind({ name: 'index.html' })).toBe('html')
    expect(fileKind({ name: 'notes.md' })).toBe('markdown')
    expect(fileKind({ name: 'data.csv' })).toBe('text')
    expect(fileKind({ name: 'main.ts' })).toBe('text')
    // generic octet-stream → trust the extension
    expect(fileKind({ mime: 'application/octet-stream', name: 'a.png' })).toBe('image')
  })

  it('is "other" when nothing identifies it', () => {
    expect(fileKind({})).toBe('other')
    expect(fileKind({ name: 'archive.bin' })).toBe('other')
    expect(fileKind({ name: 'Makefile' })).toBe('other')
  })
})

describe('extensionOf', () => {
  it('extracts a lowercase extension', () => {
    expect(extensionOf('a/b/Photo.PNG')).toBe('png')
    expect(extensionOf('report.final.pdf')).toBe('pdf')
  })
  it('strips url query/hash', () => {
    expect(extensionOf('/api/x/file.html?v=2#top')).toBe('html')
  })
  it('returns undefined for no extension or dotfiles', () => {
    expect(extensionOf('Makefile')).toBeUndefined()
    expect(extensionOf('.gitignore')).toBeUndefined()
    expect(extensionOf(undefined)).toBeUndefined()
  })
  it('returns undefined for a trailing dot with no extension', () => {
    expect(extensionOf('file.')).toBeUndefined()
    expect(fileKind({ name: 'file.' })).toBe('other')
  })
})

describe('viewableHref', () => {
  it('treats attachment urls as viewable regardless of extension', () => {
    expect(viewableHref('/api/cards/c1/attachments/a1')).toBe(true)
  })
  it('is viewable for known file extensions', () => {
    expect(viewableHref('./out/report.html')).toBe(true)
    expect(viewableHref('shot.png')).toBe(true)
  })
  it('is not viewable for plain external links', () => {
    expect(viewableHref('https://example.com/page')).toBe(false)
    expect(viewableHref('https://example.com')).toBe(false)
  })

  it('never treats an absolute cross-origin URL as in-app viewable — not by extension, not by an attachment-shaped path', () => {
    // Agent prose is untrusted: an absolute/external link must open in a new tab,
    // never be fetched or embedded inside the dashboard chrome (SSRF/beacon).
    expect(viewableHref('https://evil.com/report.html')).toBe(false)
    expect(viewableHref('https://evil.com/shot.png')).toBe(false)
    expect(viewableHref('https://evil.com/api/cards/c1/attachments/a1')).toBe(false)
    expect(viewableHref('//evil.com/notes.md')).toBe(false)
    expect(viewableHref('data:text/html,<b>x</b>')).toBe(false)
    // …but legitimate relative/same-origin links stay viewable.
    expect(viewableHref('/api/cards/c1/attachments/a1')).toBe(true)
    expect(viewableHref('./out/report.html')).toBe(true)
  })
})

describe('parseHash / fileHash', () => {
  it('round-trips a file route', () => {
    const h = fileHash({ url: '/api/cards/c1/attachments/a1', name: 'r e p.pdf', mime: 'application/pdf' })
    expect(parseHash(h)).toEqual({ kind: 'file', url: '/api/cards/c1/attachments/a1', name: 'r e p.pdf', mime: 'application/pdf' })
  })
  it('parses with and without a leading #', () => {
    expect(parseHash('#/card/abc')).toEqual({ kind: 'card', id: 'abc' })
    expect(parseHash('/card/abc')).toEqual({ kind: 'card', id: 'abc' })
  })
  it('parses root for empty or unknown hashes', () => {
    expect(parseHash('')).toEqual({ kind: 'root' })
    expect(parseHash('#/')).toEqual({ kind: 'root' })
  })
  it('omits absent optional params', () => {
    expect(parseHash(fileHash({ url: 'x.png' }))).toEqual({ kind: 'file', url: 'x.png' })
  })
  it('parses the folders route, with or without a leading # or trailing /', () => {
    expect(parseHash('#/folders')).toEqual({ kind: 'folders' })
    expect(parseHash('/folders')).toEqual({ kind: 'folders' })
    expect(parseHash('#/folders/')).toEqual({ kind: 'folders' })
  })
})
