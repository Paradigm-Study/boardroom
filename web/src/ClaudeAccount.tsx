import { Check, LogIn } from 'lucide-react'
import { useState } from 'react'
import { cancelAuthConnect, connectAuth, disconnectAuth, postAuthToken, sendAuthConnectInput, type AuthStatusVM } from './api.js'

// The offline-delivery gate. Shown when the human submits a decision for an
// OFFLINE session with no Claude account connected: it blocks that submit with the
// choice — connect once (boardroom then delivers this and future decisions
// automatically; the pending submit fires the moment the login completes) or
// submit anyway and copy-paste by hand (onSubmitAnyway). A single dense row per
// state, per the compact-UI house style.
export function ClaudeAccount({
  status,
  onChanged,
  onSubmitAnyway,
  submitLabel = "Submit — I'll copy-paste",
  onDismiss,
}: {
  status: AuthStatusVM | null
  onChanged: () => void
  onSubmitAnyway?: () => void
  submitLabel?: string
  onDismiss?: () => void
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const [pasting, setPasting] = useState(false)
  const [token, setToken] = useState('')
  const [code, setCode] = useState('')

  if (!status) return null // status not loaded, or the daemon lacks the auth feature

  const login = status.login
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setErr(undefined)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const savePaste = async (): Promise<void> => {
    const value = token.trim()
    if (!value) return
    await run(() => postAuthToken('oauth', value))
    setToken('')
    setPasting(false)
  }

  const pasteBox = pasting ? (
    <div className="account-paste">
      <input
        className="account-paste-input"
        type="password"
        placeholder="Paste your token (from: claude setup-token)"
        value={token}
        onChange={e => setToken(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void savePaste() }}
        aria-label="Claude token"
      />
      <button className="account-btn" disabled={busy || !token.trim()} onClick={() => void savePaste()}>Save</button>
      <button className="account-btn ghost" disabled={busy} onClick={() => { setPasting(false); setToken('') }}>Cancel</button>
    </div>
  ) : null

  const submitCode = async (): Promise<void> => {
    const value = code.trim()
    if (!value) return
    await run(() => sendAuthConnectInput(value))
    setCode('')
  }

  // Mid-login: browser is (or should be) open; the poll drives us to connected/failed.
  if (login.state === 'running') {
    return (
      <div className="account account-connecting">
        <span className="account-msg">
          {login.awaitingCode
            ? 'Logged in? Paste the code from the browser page here to finish.'
            : 'Opening your browser — log in there to connect.'}
        </span>
        {login.url && <a className="account-link" href={login.url} target="_blank" rel="noreferrer">Open the login page</a>}
        {login.awaitingCode && (
          <div className="account-paste">
            <input
              className="account-paste-input"
              type="text"
              placeholder="Paste the code from the browser"
              value={code}
              onChange={e => setCode(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void submitCode() }}
              aria-label="Login code"
            />
            <button className="account-btn" disabled={busy || !code.trim()} onClick={() => void submitCode()}>Finish</button>
          </div>
        )}
        <button className="account-btn ghost" disabled={busy} onClick={() => void run(cancelAuthConnect)}>Cancel</button>
        {err && <span className="account-err">{err}</span>}
      </div>
    )
  }

  // Connected: the caller auto-fires the pending submit — brief confirmation only.
  if (status.connected) {
    return (
      <div className="account account-ok">
        <Check size={14} aria-hidden />
        <span className="account-msg">Claude connected — delivering automatically.</span>
        <button className="account-btn ghost" disabled={busy} onClick={() => void run(disconnectAuth)}>Disconnect</button>
        {err && <span className="account-err">{err}</span>}
      </div>
    )
  }

  // Disconnected (first-time, expired, or after a failed attempt): the delivery choice.
  return (
    <div className={`account${login.state === 'failed' ? ' account-failed' : ''}`}>
      <LogIn size={14} aria-hidden />
      <span className="account-msg">
        {login.state === 'failed'
          ? 'Login didn’t finish — no account connected.'
          : status.stale
            ? 'Your Claude login expired — reconnect to keep auto-delivery working.'
            : 'This session is offline. Connect once and boardroom delivers it for you — or copy-paste it yourself.'}
      </span>
      <button className="account-btn" disabled={busy} onClick={() => void run(connectAuth)}>
        {login.state === 'failed' ? 'Try again' : status.stale ? 'Reconnect & auto-deliver' : 'Connect & auto-deliver'}
      </button>
      {onSubmitAnyway && (
        <button className="account-btn ghost" disabled={busy} onClick={onSubmitAnyway}>{submitLabel}</button>
      )}
      {!pasting && (
        <button className="account-btn ghost" disabled={busy} onClick={() => setPasting(true)}>Paste a token instead</button>
      )}
      {onDismiss && (
        <button className="account-btn ghost" disabled={busy} onClick={onDismiss}>Back</button>
      )}
      {pasteBox}
      {login.state === 'failed' && login.detail && <span className="account-err">{login.detail}</span>}
      {err && <span className="account-err">{err}</span>}
    </div>
  )
}
