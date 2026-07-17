import { spawn as nodeSpawn } from 'node:child_process'
import type { AuthStore } from './authStore.js'

// `claude setup-token` prints its result token to the terminal; boardroom drives
// that flow on the user's behalf (browser opens, they log in) and captures the
// token from the process output. These parsers are the fragile seam — the CLI's
// exact output isn't contractual — so they're isolated and unit-tested, and the
// capture fails LOUDLY (never stores a wrong/blank token) if the shape drifts.

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g
export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

// Claude Code subscription OAuth tokens (from `claude setup-token`) look like
// sk-ant-oat01-… — take the LAST one in the stream (setup-token prints it at the
// very end, after the browser login completes).
export function extractOauthToken(output: string): string | undefined {
  const matches = stripAnsi(output).match(/sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]+/g)
  return matches?.[matches.length - 1]
}

// The Claude login URL the flow prints for the user to open. Scoped to the Claude/
// Anthropic hosts ON PURPOSE: when setup-token errors without a TTY it prints an ink
// docs URL (github.com/vadimdemedes/ink), which a naive "first URL" match surfaced as
// a bogus "login link". setup-token's real OAuth URL is on claude.com (observed) —
// claude.ai / anthropic.com are accepted too for older/other flows.
export function extractLoginUrl(output: string): string | undefined {
  return stripAnsi(output).match(/https?:\/\/(?:[a-z0-9-]+\.)*(?:claude\.com|claude\.ai|anthropic\.com)\/[^\s'"]*/i)?.[0]
}

// setup-token, after opening the browser, prints "Paste code here if prompted >" and
// waits for the OAuth code (there is no localhost auto-callback — the redirect is a
// hosted page that shows the code). Detecting this prompt is how boardroom knows to
// ask the user for the code and relay it into the PTY.
function outputAwaitsCode(output: string): boolean {
  return /paste code here/i.test(stripAnsi(output))
}

export type ConnectState = 'idle' | 'running' | 'connected' | 'failed'
export interface ConnectStatus {
  state: ConnectState
  url?: string
  detail?: string
  // True once setup-token is waiting for the OAuth code — the UI shows a paste field.
  awaitingCode?: boolean
}

export interface ConnectChild {
  kill(): void
  write(data: string): void
}
export type ConnectSpawnFn = (
  bin: string,
  args: string[],
  hooks: { onData(chunk: string): void; onExit(code: number | null): void; onError(err: Error): void },
) => ConnectChild

// Drives ONE login at a time. The dashboard starts a connect and polls getStatus()
// until it lands on connected/failed. On success the captured token is written to
// the AuthStore, which the waker reads lazily — so the very next wake authenticates.
const DEFAULT_CONNECT_TIMEOUT_MS = 5 * 60_000 // a real login is minutes; bound it so a stuck flow can't hang forever

export class AuthConnector {
  private status: ConnectStatus = { state: 'idle' }
  private child?: ConnectChild
  private buf = ''
  // True once the user has pasted their OAuth code: keeps the paste field hidden
  // through the code→token exchange (the "Paste code here" prompt lingers in buf and
  // would otherwise re-arm awaitingCode and invite a corrupting duplicate paste). A
  // genuine RE-prompt in a fresh chunk clears it again (see onData).
  private codeSubmitted = false
  private timer?: ReturnType<typeof setTimeout>
  private readonly spawnFn: ConnectSpawnFn
  private readonly claudeBin: string
  private readonly timeoutMs: number

  constructor(private authStore: AuthStore, opts: { spawn?: ConnectSpawnFn; claudeBin?: string; timeoutMs?: number } = {}) {
    this.spawnFn = opts.spawn ?? defaultConnectSpawn
    this.claudeBin = opts.claudeBin ?? process.env.BOARDROOM_CLAUDE_BIN ?? '/opt/homebrew/bin/claude'
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  }

  getStatus(): ConnectStatus {
    return this.status
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
  }

  start(): ConnectStatus {
    if (this.status.state === 'running') return this.status // one login at a time
    this.buf = ''
    this.codeSubmitted = false
    this.status = { state: 'running' }
    // Bound the whole flow: setup-token with no TTY (or an abandoned browser login)
    // would otherwise leave the process — and this status — running forever.
    this.timer = setTimeout(() => {
      this.child?.kill()
      this.child = undefined
      this.buf = ''
      this.status = { state: 'failed', detail: 'login timed out — please try again, or paste a token instead' }
    }, this.timeoutMs)
    this.timer.unref?.()
    this.child = this.spawnFn(this.claudeBin, ['setup-token'], {
      onData: chunk => {
        this.buf += chunk
        if (this.status.state !== 'running') return
        // Re-scan the whole (growing) buffer each chunk and PREFER a fresh match: a PTY
        // read can split the ~300-char OAuth URL mid-line, and locking in the first
        // (truncated) match would leave the user with a broken login link. buf only
        // grows and the match is monotonic, so the complete URL replaces the prefix.
        const url = extractLoginUrl(this.buf) ?? this.status.url
        // A code prompt in THIS chunk (re)arms the paste field; stale prompt text already
        // in buf must not. After a paste (codeSubmitted) the field stays hidden until a
        // genuine re-prompt arrives — otherwise it reappears mid-exchange and a second
        // paste corrupts setup-token's stdin.
        if (outputAwaitsCode(chunk)) this.codeSubmitted = false
        const awaitingCode = this.codeSubmitted
          ? undefined
          : (this.status.awaitingCode || outputAwaitsCode(this.buf) || undefined)
        if (url !== this.status.url || awaitingCode !== this.status.awaitingCode) {
          this.status = { state: 'running', ...(url ? { url } : {}), ...(awaitingCode ? { awaitingCode } : {}) }
        }
      },
      onExit: code => {
        // A cancel() already reset the status and killed the child; its late exit
        // must not resurrect a 'failed' state over the deliberate idle.
        if (this.status.state !== 'running') return
        this.clearTimer()
        const token = extractOauthToken(this.buf)
        if (code === 0 && token) {
          this.authStore.set({ type: 'oauth', value: token })
          this.status = { state: 'connected' }
        } else {
          this.status = {
            state: 'failed',
            detail: token ? `login exited ${code}` : 'no token captured — the login may have been cancelled or timed out',
          }
        }
        this.buf = '' // don't retain the secret in memory past capture
        this.child = undefined
      },
      onError: err => {
        if (this.status.state !== 'running') return // late error after cancel — already idle
        this.clearTimer()
        this.status = { state: 'failed', detail: `could not start login: ${err.message}` }
        this.buf = ''
        this.child = undefined
      },
    })
    return this.status
  }

  // Relay the OAuth code the user pasted from the browser into setup-token's prompt
  // (with a carriage return to submit it). No-op if no login is running.
  sendInput(text: string): void {
    if (this.status.state !== 'running' || !this.child) return
    this.child.write(`${text}\r`)
    // The code is in setup-token's stdin now; hold the paste field hidden (onData won't
    // re-derive it from the lingering prompt in buf) until a real re-prompt reopens it.
    this.codeSubmitted = true
    if (this.status.awaitingCode) this.status = { ...this.status, awaitingCode: undefined }
  }

  cancel(): void {
    this.clearTimer()
    this.child?.kill()
    this.child = undefined
    this.buf = ''
    if (this.status.state === 'running') this.status = { state: 'idle' }
  }
}

// Run `claude setup-token` inside an INVISIBLE background terminal. setup-token's UI
// (ink) REQUIRES a real TTY — piped stdio makes it error "Raw mode is not supported"
// and hang, and macOS `script` needs its own controlling terminal a launchd daemon
// lacks. Rather than a native PTY dependency, this uses the stock macOS
// /usr/bin/python3 and its stdlib `pty` module (forkpty): the relay below gives the
// child a real terminal — never shown to anyone — while piping its output to us and
// our writes (the pasted OAuth code) back in. Details that matter:
//   - TIOCSWINSZ 512 cols: the OAuth URL is ~300 chars; a narrow PTY would WRAP it
//     mid-URL and break capture.
//   - SIGTERM/stdin-EOF → SIGKILL the child: setup-token sits in an interactive
//     prompt that ignores soft signals (observed: a cancelled login kept running),
//     and pty.fork's child is its own session leader, so killing only the relay
//     would orphan it. The relay owns its child's lifetime.
//   - exit code propagates, so the connector's exit-0 gating still holds.
const PTY_RELAY = `
import os, pty, sys, fcntl, struct, termios, select, signal
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 512, 0, 0))
def bail(*_):
    try: os.kill(pid, signal.SIGKILL)
    except OSError: pass
    sys.exit(1)
signal.signal(signal.SIGTERM, bail)
stdin_open = True
while True:
    rl = [fd] + ([0] if stdin_open else [])
    r, _, _ = select.select(rl, [], [])
    if fd in r:
        try: data = os.read(fd, 4096)
        except OSError: data = b''
        if not data: break
        os.write(1, data)
    if 0 in r:
        d = os.read(0, 4096)
        if d: os.write(fd, d)
        else: bail()
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`

function defaultConnectSpawn(
  bin: string,
  args: string[],
  hooks: { onData(chunk: string): void; onExit(code: number | null): void; onError(err: Error): void },
): ConnectChild {
  const child = nodeSpawn('/usr/bin/python3', ['-c', PTY_RELAY, bin, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' },
  })
  child.stdout?.on('data', d => hooks.onData(d.toString()))
  child.stderr?.on('data', d => hooks.onData(d.toString()))
  child.on('error', hooks.onError)
  // 'close' (not 'exit') so ALL stdout/stderr data has drained into buf before we
  // extract the token: the sk-ant-oat token is the LAST thing printed, so on 'exit'
  // its trailing chunk can still be in the pipe — capturing then would miss it and
  // report a successful login as "no token captured". 'close' always fires (even on a
  // failed spawn, where onError already settled and the state guard makes it a no-op).
  child.on('close', code => hooks.onExit(code))
  return {
    write: (data: string) => { try { child.stdin?.write(data) } catch { /* exited */ } },
    // SIGTERM the relay; its handler SIGKILLs setup-token (its own session leader,
    // unreachable by a plain group kill) before exiting.
    kill: () => { try { child.kill('SIGTERM') } catch { /* already gone */ } },
  }
}
