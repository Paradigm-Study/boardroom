import { describe, expect, it } from 'vitest'
import { isBenignNotifierNoise } from './notify.js'

// node-notifier shells out to terminal-notifier and JSON.parses its stdout
// (node-notifier/lib/utils.js fileCommandJson). On modern macOS the daemon's
// notification is suppressed and terminal-notifier emits output that isn't a
// clean JSON value, so JSON.parse throws a SyntaxError that node-notifier hands
// back as the callback's error. That surface is best-effort — the menu-bar app
// is the dependable notifier — so the parse failure is expected noise.
describe('isBenignNotifierNoise', () => {
  it('treats the terminal-notifier JSON.parse SyntaxError as benign', () => {
    const err = new SyntaxError(
      'Unexpected non-whitespace character after JSON at position 154 (line 6 column 2)',
    )
    expect(isBenignNotifierNoise(err)).toBe(true)
  })

  it('keeps real spawn failures loud (e.g. notifier missing)', () => {
    const err = new Error('Notifier (terminal-notifier) not found on system.')
    expect(isBenignNotifierNoise(err)).toBe(false)
  })

  it('does not swallow stderr strings or empty errors', () => {
    expect(isBenignNotifierNoise('some terminal-notifier stderr warning')).toBe(false)
    expect(isBenignNotifierNoise(null)).toBe(false)
    expect(isBenignNotifierNoise(undefined)).toBe(false)
  })
})
