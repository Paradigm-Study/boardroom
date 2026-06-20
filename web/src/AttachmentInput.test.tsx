// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentRef } from '../../src/shared/card.js'
import { AttachmentInput } from './AttachmentInput.js'
import { fileHash } from './fileView.js'

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

function ref(overrides: Partial<AttachmentRef> & Pick<AttachmentRef, 'id' | 'name'>): AttachmentRef {
  return {
    size: 4,
    path: `/tmp/${overrides.name}`,
    uploadedAt: '2026-06-18T00:00:00.000Z',
    ...overrides,
  }
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input.attach-input') as HTMLInputElement
}

describe('AttachmentInput', () => {
  it('uploads the chosen file and clears the input when onUpload resolves', async () => {
    const uploaded = ref({ id: 'att-1', name: 'notes.txt' })
    const onUpload = vi.fn<(file: File) => Promise<AttachmentRef>>().mockResolvedValue(uploaded)

    const { rerender } = render(
      <AttachmentInput label="Attach file" attachments={[]} readonly={false} onUpload={onUpload} onRemove={vi.fn()} />,
    )

    const input = fileInput()
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(file))
    expect(input.value).toBe('')

    // The component does not own the attachments list; the parent feeds the
    // resolved ref back in. Re-render with it to assert the chip appears.
    rerender(
      <AttachmentInput
        label="Attach file"
        attachments={[uploaded]}
        readonly={false}
        onUpload={onUpload}
        onRemove={vi.fn()}
      />,
    )

    expect(screen.getByText('notes.txt')).toBeTruthy()
  })

  it('shows the error text and clears busy when onUpload rejects', async () => {
    const onUpload = vi.fn<(file: File) => Promise<AttachmentRef>>().mockRejectedValue(new Error('upload failed'))

    render(
      <AttachmentInput label="Attach file" attachments={[]} readonly={false} onUpload={onUpload} onRemove={vi.fn()} />,
    )

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(fileInput(), { target: { files: [file] } })

    await waitFor(() => expect(screen.getByText('upload failed')).toBeTruthy())

    const attach = screen.getByRole('button', { name: 'Attach file' }) as HTMLButtonElement
    await waitFor(() => expect(attach.disabled).toBe(false))
    expect(attach.textContent).toContain('Attach')
  })

  it('hides the attach button and per-chip remove button when readonly', () => {
    render(
      <AttachmentInput
        label="Attach file"
        attachments={[ref({ id: 'att-1', name: 'notes.txt' })]}
        readonly
        onUpload={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Attach file' })).toBeNull()
    expect(fileInput()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).toBeNull()
    expect(screen.getByText('notes.txt')).toBeTruthy()
  })

  it('opens the in-app viewer when a chip with a url is clicked', () => {
    const a = ref({ id: 'att-1', name: 'r.pdf', url: '/api/cards/c1/attachments/att-1', mime: 'application/pdf' })

    render(
      <AttachmentInput label="x" attachments={[a]} readonly onUpload={vi.fn()} onRemove={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /view r\.pdf/i }))

    expect(window.location.hash).toBe(fileHash({ url: a.url!, name: a.name, mime: a.mime }))
  })

  it('leaves a chip without a url as plain, non-clickable text', () => {
    render(
      <AttachmentInput
        label="x"
        attachments={[ref({ id: 'att-1', name: 'notes.txt' })]}
        readonly
        onUpload={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: /view notes\.txt/i })).toBeNull()
    expect(screen.getByText('notes.txt')).toBeTruthy()
  })

  it('calls onRemove with the attachment id when the remove button is clicked', () => {
    const onRemove = vi.fn()

    render(
      <AttachmentInput
        label="Attach file"
        attachments={[ref({ id: 'att-1', name: 'notes.txt' })]}
        readonly={false}
        onUpload={vi.fn()}
        onRemove={onRemove}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }))

    expect(onRemove).toHaveBeenCalledWith('att-1')
  })
})
