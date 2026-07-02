// Pure, dependency-free logic for the menu-bar tray: SSE frame parsing and the
// render derivation (title / tooltip / status line / notifications) from the daemon's
// tray view-model. Kept free of any electron/menubar import so it is unit-testable
// (tests/trayRender.test.ts) and shipped raw by electron-builder alongside main.js.

// Long labels for notifications; short ones for the tooltip + menu per-stage rows.
const STAGE_LABEL = { clarify: 'Needs scoping', plan: 'Plan to approve', spec: 'Spec to lock', results: 'Results to review' }
const STAGE_SHORT = { clarify: 'scoping', plan: 'plan', spec: 'spec', results: 'results' }
const STAGE_ORDER = ['clarify', 'plan', 'spec', 'results']

// Split a buffer into complete SSE frames (separated by a blank line) plus the
// trailing incomplete remainder to carry into the next chunk.
function splitFrames(buffer) {
  const frames = []
  let rest = buffer
  let idx
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    frames.push(rest.slice(0, idx))
    rest = rest.slice(idx + 2)
  }
  return { frames, rest }
}

// Parse one SSE frame into { event, data }. Comment lines (':...') are skipped, so a
// frame with no data field (':connected', ':hb' heartbeats) returns null.
function parseFrame(frameText) {
  let event = 'message'
  const data = []
  for (const line of frameText.split('\n')) {
    if (line === '' || line[0] === ':') continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value[0] === ' ') value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  return data.length ? { event, data: data.join('\n') } : null
}

// Known stages first in canonical order, then any unknown stage keys — the single
// ordering policy for every per-stage surface (tooltip summary AND the right-click
// menu rows), forward-compatible with a daemon that adds a stage.
function orderedStages(byStage) {
  const tally = byStage || {}
  const known = STAGE_ORDER.filter(s => s in tally)
  const extra = Object.keys(tally).filter(s => !STAGE_ORDER.includes(s))
  return [...known, ...extra]
}

// "2 scoping · 1 results" from a byStage tally, zero counts omitted.
function stageSummary(byStage) {
  const tally = byStage || {}
  return orderedStages(tally)
    .filter(s => tally[s] > 0)
    .map(s => `${tally[s]} ${STAGE_SHORT[s] || s}`)
    .join(' · ')
}

// Derive the always-visible title, the tooltip, and a menu status-line from the
// connection state + the latest view-model. A number in the title therefore ALWAYS
// means a real pending count; connecting/offline use distinct non-numeric glyphs.
function trayView({ connState, vm }) {
  if (connState === 'connecting') {
    return { title: ' …', tooltip: 'boardroom — connecting…', statusLine: 'Connecting…' }
  }
  if (connState !== 'connected') {
    return {
      title: ' •',
      tooltip: 'boardroom — daemon offline (start it and this clears)',
      statusLine: 'Daemon offline — retrying',
    }
  }
  const total = (vm && vm.total) || 0
  if (total === 0) {
    return { title: '', tooltip: 'boardroom — nothing pending', statusLine: 'Connected — nothing pending' }
  }
  const summary = stageSummary(vm.byStage)
  return {
    title: ` ${total}`,
    tooltip: `boardroom — ${total} waiting on you (${summary})`,
    statusLine: `Connected — ${total} waiting (${summary})`,
  }
}

// Decide which tray items deserve a notification. On the first frame (priorSeen ===
// null) seed silently so a reconnect doesn't replay the whole backlog. Thereafter,
// notify on ids not previously seen. The returned `seen` mirrors the current items, so
// an id that left (decided) drops out — keeping the set bounded.
function reconcileNotifications(priorSeen, items) {
  const list = items || []
  if (priorSeen === null || priorSeen === undefined) {
    return { seen: list.map(i => i.id), toNotify: [] }
  }
  const prev = new Set(priorSeen)
  return { seen: list.map(i => i.id), toNotify: list.filter(i => !prev.has(i.id)) }
}

module.exports = {
  STAGE_LABEL,
  STAGE_SHORT,
  STAGE_ORDER,
  orderedStages,
  splitFrames,
  parseFrame,
  stageSummary,
  trayView,
  reconcileNotifications,
}
