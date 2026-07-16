// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import type { AuthStatusVM } from './api.js'
import { CardView } from './CardView.js'

vi.mock('./api.js', () => ({
  decideCard: vi.fn(() => Promise.resolve({ delivered: false, summary: 'the summary' })),
  uploadAttachment: vi.fn(),
  connectAuth: vi.fn(() => Promise.resolve({ connected: false, login: { state: 'running' } })),
  cancelAuthConnect: vi.fn(() => Promise.resolve({ connected: false, login: { state: 'idle' } })),
  disconnectAuth: vi.fn(() => Promise.resolve({ connected: false, login: { state: 'idle' } })),
  postAuthToken: vi.fn(() => Promise.resolve({ connected: true, login: { state: 'idle' } })),
  sendAuthConnectInput: vi.fn(() => Promise.resolve({ connected: true, login: { state: 'idle' } })),
}))
import { connectAuth, decideCard } from './api.js'

afterEach(() => { cleanup(); vi.clearAllMocks() })

function orphanedCard(): Card {
  return {
    id: 'c1', stage: 'clarify',
    session: { agent: 'claude-code', project: 'demo' },
    headline: 'Pick one', blocks: [],
    decisions: [{ id: 'd1', prompt: 'p', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'orphaned', orphanedReason: 'boot', orphanedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), fingerprint: 'fp',
  }
}

const disconnected: AuthStatusVM = { connected: false, login: { state: 'idle' } }
const connected: AuthStatusVM = { connected: true, type: 'oauth', login: { state: 'idle' } }

function answerAndSubmit(): void {
  fireEvent.click(screen.getByRole('button', { name: /^A$/ })) // answer d1
  fireEvent.click(screen.getByRole('button', { name: /submit \(agent offline\)/i }))
}

describe('offline submit gate', () => {
  it('BLOCKS submit on an offline card when no account is connected: shows the delivery choice, does not decide yet', () => {
    render(<CardView card={orphanedCard()} authStatus={disconnected} onAuthChanged={() => {}} />)
    answerAndSubmit()
    expect(decideCard).not.toHaveBeenCalled() // blocked — the choice is up instead
    expect(screen.getByRole('button', { name: /connect .* auto-deliver/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /i'll copy-paste/i })).toBeTruthy()
  })

  it('choice: "Submit — I\'ll copy-paste" performs the original submit', async () => {
    render(<CardView card={orphanedCard()} authStatus={disconnected} onAuthChanged={() => {}} />)
    answerAndSubmit()
    fireEvent.click(screen.getByRole('button', { name: /i'll copy-paste/i }))
    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('c1', expect.anything()))
  })

  it('choice: Connect starts the login', async () => {
    render(<CardView card={orphanedCard()} authStatus={disconnected} onAuthChanged={() => {}} />)
    answerAndSubmit()
    fireEvent.click(screen.getByRole('button', { name: /connect .* auto-deliver/i }))
    await waitFor(() => expect(connectAuth).toHaveBeenCalledOnce())
    expect(decideCard).not.toHaveBeenCalled() // still waiting on the login
  })

  it('once connected mid-gate, the pending submit fires automatically (login → message sent right away)', async () => {
    const { rerender } = render(<CardView card={orphanedCard()} authStatus={disconnected} onAuthChanged={() => {}} />)
    answerAndSubmit()
    expect(decideCard).not.toHaveBeenCalled()
    // The app's auth poll flips the status to connected (the login completed).
    rerender(<CardView card={orphanedCard()} authStatus={connected} onAuthChanged={() => {}} />)
    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('c1', expect.anything()))
  })

  it('already connected: submit goes straight through, no gate', async () => {
    render(<CardView card={orphanedCard()} authStatus={connected} onAuthChanged={() => {}} />)
    answerAndSubmit()
    await waitFor(() => expect(decideCard).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: /i'll copy-paste/i })).toBeNull()
  })

  it('no auth feature (authStatus null): submit behaves as before — no gate', async () => {
    render(<CardView card={orphanedCard()} onAuthChanged={() => {}} />)
    answerAndSubmit()
    await waitFor(() => expect(decideCard).toHaveBeenCalledOnce())
  })

  it('Back dismisses the gate without submitting', () => {
    render(<CardView card={orphanedCard()} authStatus={disconnected} onAuthChanged={() => {}} />)
    answerAndSubmit()
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(decideCard).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /i'll copy-paste/i })).toBeNull()
  })
})
