// Fragility guards for the daemon-core / product-harness split.
// These are written to FAIL if the harness restructure ever regresses:
//   - the core re-couples to a product adapter,
//   - a stale pre-move import path creeps back,
//   - the wiring seam (app.ts) stops loading the moved modules,
//   - or the modules are not where the split says they are.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDaemon, type Daemon } from '../src/daemon/app.js'
import { loadConfig } from '../src/daemon/config.js'
import { SessionCapturer } from '../src/harness/claude-code/sessionCapturer.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(p)
  }
  return out
}

// Every module specifier a file references, across ALL import/export forms:
//   import … from '…' · export … from '…' · bare side-effect `import '…'` ·
//   dynamic `import('…')`. The bare side-effect form is easy to forget and is
//   precisely the one a naive `… from …`-only matcher misses, so it is covered
//   explicitly. The negated class also spans newlines → multi-line imports match.
function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const specs: string[] = []
  const patterns = [
    /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g, // import/export … from '…'
    /import\s+['"]([^'"]+)['"]/g,                        // bare side-effect import '…'
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,              // dynamic import('…')
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) specs.push(m[1])
  }
  return specs
}

const DAEMON_DIR = join(ROOT, 'src/daemon')
const SHARED_DIR = join(ROOT, 'src/shared')
const WEB_DIR = join(ROOT, 'web/src')

describe('harness boundary (one-way: harness → core, never core → harness)', () => {
  it('no core, shared, or web file imports the harness — except app.ts, the single wiring seam', () => {
    const offenders: string[] = []
    for (const file of [...tsFiles(DAEMON_DIR), ...tsFiles(SHARED_DIR), ...tsFiles(WEB_DIR)]) {
      if (file.endsWith(join('daemon', 'app.ts'))) continue // the one permitted wiring point
      const bad = importSpecifiers(file).filter(s => s.includes('harness/'))
      if (bad.length) offenders.push(`${file} → ${bad.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('app.ts wires the moved modules from their new harness location', () => {
    const app = readFileSync(join(DAEMON_DIR, 'app.ts'), 'utf8')
    expect(app).toContain("from '../harness/claude-code/waker.js'")
    expect(app).toContain("from '../harness/claude-code/sessionCapturer.js'")
  })

  it('nothing imports the pre-move daemon/{waker,sessionCapturer} paths', () => {
    const offenders: string[] = []
    for (const file of [...tsFiles(join(ROOT, 'src')), ...tsFiles(join(ROOT, 'tests')), ...tsFiles(WEB_DIR)]) {
      const bad = importSpecifiers(file).filter(s => /daemon\/(waker|sessionCapturer)(\.js)?$/.test(s))
      if (bad.length) offenders.push(`${file} → ${bad.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('the two product modules live under src/harness/claude-code, not src/daemon', () => {
    for (const f of ['waker.ts', 'sessionCapturer.ts']) {
      expect(existsSync(join(ROOT, 'src/harness/claude-code', f))).toBe(true)
      expect(existsSync(join(DAEMON_DIR, f))).toBe(false)
    }
  })
})

describe('harness wiring resolves at runtime through the new paths', () => {
  let dir: string
  let daemon: Daemon

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boardroom-boundary-'))
    daemon = createDaemon(loadConfig(dir))
  })
  afterEach(() => {
    daemon.capturer.stop()
    daemon.store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('createDaemon loads the moved SessionCapturer and wires the moved Waker to the queue', () => {
    // If app.ts could not resolve ../harness/claude-code/* at runtime, createDaemon
    // would have thrown before we got here.
    expect(daemon.capturer).toBeInstanceOf(SessionCapturer)
    // Waker subscribes to queue 'card' events; a broken import would leave it unwired.
    expect(daemon.queue.listenerCount('card')).toBeGreaterThanOrEqual(1)
  })
})
