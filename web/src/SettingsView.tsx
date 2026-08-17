import { AlertTriangle, ArrowLeft, CheckCircle2, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchHooksStatus, setHooksInstalled, type HooksStatus } from './api.js'

// Enforcement-hooks toggle (README "Enforcement hooks"): lets a human wire/unwire
// the boardroom PreToolUse/Stop/SessionStart hooks from the dashboard itself,
// instead of hand-editing ~/.claude/settings.json. Global (all projects on this
// machine) — the copy below says so plainly before anyone flips it.
export function SettingsView({ onClose }: { onClose(): void }) {
  const [status, setStatus] = useState<HooksStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchHooksStatus().then(setStatus).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (): void => {
    if (!status || busy) return
    setBusy(true)
    setError(null)
    setHooksInstalled(!status.installed)
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="folders">
      <header className="folders-bar">
        <button className="viewer-back" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden /> Back
        </button>
        <span className="folders-title">
          <SettingsIcon size={14} aria-hidden /> Settings
        </span>
      </header>

      <div className="settings-body">
        <section className="settings-card">
          <div className="settings-card-head">
            <h3>Enforcement hooks</h3>
            <button
              type="button"
              role="switch"
              aria-checked={status?.installed ?? false}
              aria-label="Wire boardroom enforcement hooks into Claude Code"
              className={`hook-switch${status?.installed ? ' on' : ''}`}
              disabled={!status || busy}
              onClick={toggle}
            >
              <span className="hook-switch-knob" />
            </button>
          </div>
          <p className="settings-card-desc">
            Wires 4 hooks plus the MCP timeout env into your global{' '}
            <code>~/.claude/settings.json</code> so Claude Code can't silently skip the
            boardroom gate — asking in chat, exiting plan mode, or stopping without a review —
            and so gate calls wait for your verdict instead of aborting at the default MCP
            timeout. Deny-once and fail-open: each nudge fires at most once per session, and a
            downed daemon disables them automatically. This affects{' '}
            <strong>every project on this machine</strong>, not just this one.
          </p>

          {error && <p className="error-text" role="alert">{error}</p>}

          {status && !status.installed && status.entries.some(e => e.wired) && (
            <p className="settings-card-desc">
              <strong>Partially installed</strong> — the checked pieces below are active right
              now. Flip the switch to install what's missing; flip it twice to remove
              everything.
            </p>
          )}

          {status && (
            <ul className="hook-list">
              {status.entries.map(entry => (
                <li key={entry.id} className={entry.wired ? 'wired' : ''}>
                  {entry.wired
                    ? <CheckCircle2 size={13} aria-hidden />
                    : <AlertTriangle size={13} aria-hidden />}
                  <span className="hook-list-name">
                    {entry.event}{entry.matcher ? `: ${entry.matcher}` : ''}
                  </span>
                  <span className="hook-list-desc">{entry.description}</span>
                </li>
              ))}
              {status.env.map(entry => (
                <li key={entry.key} className={entry.configured ? 'wired' : ''}>
                  {entry.configured
                    ? <CheckCircle2 size={13} aria-hidden />
                    : <AlertTriangle size={13} aria-hidden />}
                  <span className="hook-list-name">env: {entry.key}</span>
                  <span className="hook-list-desc">
                    {entry.configured && entry.current !== entry.recommended
                      ? `${entry.description} (custom: ${entry.current})`
                      : entry.description}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
