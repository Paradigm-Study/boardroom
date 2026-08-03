// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAccount } from './ClaudeAccount.js'
import type { AuthStatusVM } from './api.js'

vi.mock('./api.js', () => ({
  connectAuth: vi.fn(() => Promise.resolve({ connected: false, login: { state: 'running' } })),
  cancelAuthConnect: vi.fn(() => Promise.resolve({ connected: false, login: { state: 'idle' } })),
  disconnectAuth: vi.fn(() => Promise.resolve({ connected: false, login: { state: 'idle' } })),
  postAuthToken: vi.fn(() => Promise.resolve({ connected: true, login: { state: 'idle' } })),
  sendAuthConnectInput: vi.fn(() => Promise.resolve({ connected: true, login: { state: 'idle' } })),
}))
import { connectAuth, disconnectAuth, postAuthToken, sendAuthConnectInput } from './api.js'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const disconnected: AuthStatusVM = { connected: false, login: { state: 'idle' } }

describe('ClaudeAccount', () => {
  it('renders nothing until status is known (or the feature is unavailable)', () => {
    const { container } = render(<ClaudeAccount status={null} onChanged={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('disconnected: shows the connect CTA and triggers the browser login', async () => {
    const onChanged = vi.fn()
    render(<ClaudeAccount status={disconnected} onChanged={onChanged} />)
    const btn = screen.getByRole('button', { name: /connect & auto-deliver/i })
    fireEvent.click(btn)
    await waitFor(() => expect(connectAuth).toHaveBeenCalledOnce())
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('gate mode: offers "submit anyway" and dismiss, wired to the callbacks', () => {
    const onSubmitAnyway = vi.fn()
    const onDismiss = vi.fn()
    render(<ClaudeAccount status={disconnected} onChanged={() => {}} onSubmitAnyway={onSubmitAnyway} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: /i'll copy-paste/i }))
    expect(onSubmitAnyway).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('mid-login: shows the browser prompt and the login URL', () => {
    render(<ClaudeAccount status={{ connected: false, login: { state: 'running', url: 'https://claude.ai/oauth' } }} onChanged={() => {}} />)
    expect(screen.getByText(/opening your browser/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /open the login page/i }).getAttribute('href')).toBe('https://claude.ai/oauth')
  })

  it('connected: confirms auto-delivery and offers disconnect', async () => {
    const onChanged = vi.fn()
    render(<ClaudeAccount status={{ connected: true, type: 'oauth', login: { state: 'idle' } }} onChanged={onChanged} />)
    expect(screen.getByText(/connected/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }))
    await waitFor(() => expect(disconnectAuth).toHaveBeenCalledOnce())
  })

  it('awaiting code: shows a paste-code field and relays the pasted code', async () => {
    const onChanged = vi.fn()
    render(<ClaudeAccount status={{ connected: false, login: { state: 'running', awaitingCode: true } }} onChanged={onChanged} />)
    const input = screen.getByLabelText(/login code/i)
    fireEvent.change(input, { target: { value: 'oauth-code-123' } })
    fireEvent.click(screen.getByRole('button', { name: /finish/i }))
    await waitFor(() => expect(sendAuthConnectInput).toHaveBeenCalledWith('oauth-code-123'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('stale (login went bad after connect): says the login expired and offers reconnect', () => {
    render(<ClaudeAccount status={{ connected: false, stale: true, type: 'oauth', login: { state: 'idle' } }} onChanged={() => {}} />)
    expect(screen.getByText(/login expired/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /reconnect/i })).toBeTruthy()
  })

  it('failed: shows a retry and the failure detail', () => {
    render(<ClaudeAccount status={{ connected: false, login: { state: 'failed', detail: 'no token captured' } }} onChanged={() => {}} />)
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
    expect(screen.getByText(/no token captured/i)).toBeTruthy()
  })

  it('paste path: reveals the input and saves the pasted token', async () => {
    const onChanged = vi.fn()
    render(<ClaudeAccount status={disconnected} onChanged={onChanged} />)
    fireEvent.click(screen.getByRole('button', { name: /paste a token instead/i }))
    const input = screen.getByLabelText(/claude token/i)
    fireEvent.change(input, { target: { value: 'sk-ant-oat01-pasted' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(postAuthToken).toHaveBeenCalledWith('oauth', 'sk-ant-oat01-pasted'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})
