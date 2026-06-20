// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileViewer } from './FileViewer.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FileViewer', () => {
  it('renders an image with its name as alt text', () => {
    render(<FileViewer url="/api/x/a1" name="shot.png" mime="image/png" onClose={vi.fn()} />)
    const img = screen.getByAltText('shot.png') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('/api/x/a1')
  })

  it('renders a PDF in a frame pointed at the file url', () => {
    render(<FileViewer url="/api/x/a1" name="report.pdf" mime="application/pdf" onClose={vi.fn()} />)
    const frame = document.querySelector('iframe.viewer-pdf') as HTMLIFrameElement
    expect(frame).toBeTruthy()
    expect(frame.getAttribute('src')).toBe('/api/x/a1')
  })

  it('renders HTML sandboxed with scripts disabled and a static-preview badge', () => {
    render(<FileViewer url="/api/x/a1" name="page.html" mime="text/html" onClose={vi.fn()} />)
    const frame = document.querySelector('iframe.viewer-html') as HTMLIFrameElement
    expect(frame).toBeTruthy()
    // empty sandbox = most restrictive; must NOT allow scripts
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts')
    expect(screen.getByText(/static preview/i)).toBeTruthy()
    expect(screen.getByText(/interactive content is disabled/i)).toBeTruthy()
  })

  it('fetches and shows text content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('line one\nline two') }))
    render(<FileViewer url="/api/x/a1" name="notes.txt" mime="text/plain" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/line one/)).toBeTruthy())
    // fetched with a timeout signal so a hung URL can't spin forever
    expect(fetch).toHaveBeenCalledWith('/api/x/a1', expect.objectContaining({ signal: expect.anything() }))
  })

  it('shows an error pane when the fetch is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    render(<FileViewer url="/api/x/a1" name="notes.txt" mime="text/plain" onClose={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('.viewer-error')).toBeTruthy())
    expect(document.querySelector('.viewer-error')?.textContent).toContain('404')
  })

  it('shows an error pane when the fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    render(<FileViewer url="/api/x/a1" name="notes.txt" mime="text/plain" onClose={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('.viewer-error')?.textContent).toContain('network down'))
  })

  it('offers a download link for unviewable files', () => {
    render(<FileViewer url="/api/x/a1" name="archive.zip" mime="application/zip" onClose={vi.fn()} />)
    const link = screen.getByRole('link', { name: /download/i }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/api/x/a1')
  })

  it('calls onClose when Back is clicked', () => {
    const onClose = vi.fn()
    render(<FileViewer url="/api/x/a1" name="shot.png" mime="image/png" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<FileViewer url="/api/x/a1" name="shot.png" mime="image/png" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })
})
