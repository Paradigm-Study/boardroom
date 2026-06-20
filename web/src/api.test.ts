import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentRef, Card } from '../../src/shared/card.js'
import { decideCard, fetchCards, subscribeCards, uploadAttachment } from './api.js'

function jsonResponse(body: unknown, status = 200): globalThis.Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as globalThis.Response
}

function rawResponse(text: string, status: number): globalThis.Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as unknown as globalThis.Response
}

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchCards', () => {
  it('returns the parsed JSON body on a 200', async () => {
    const cards = [{ id: 'c1', headline: 'One' }]
    fetchMock.mockResolvedValue(jsonResponse(cards))

    await expect(fetchCards()).resolves.toEqual(cards)
    expect(fetchMock).toHaveBeenCalledWith('/api/cards')
  })

  it('throws the error message from a non-ok JSON response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 400))

    await expect(fetchCards()).rejects.toThrow('boom')
  })

  it('falls back to the HTTP status when a non-ok JSON body has no error field', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500))

    await expect(fetchCards()).rejects.toThrow('HTTP 500')
  })

  it('throws the out-of-date error on a non-JSON (HTML 404) body', async () => {
    fetchMock.mockResolvedValue(rawResponse('<!doctype html><title>Not found</title>', 404))

    await expect(fetchCards()).rejects.toThrow(
      'Boardroom returned a non-JSON response (HTTP 404). The dashboard may be out of date — reload the page.',
    )
  })
})

describe('decideCard', () => {
  it('encodes the id, posts { answers }, and returns the parsed body on a 200', async () => {
    const result = { card: { id: 'a/b', status: 'decided' }, summary: 'ok', delivered: true }
    fetchMock.mockResolvedValue(jsonResponse(result))

    await expect(
      decideCard('a/b', { scope: { chosen: ['approve'] } }),
    ).resolves.toEqual(result)

    expect(fetchMock).toHaveBeenCalledWith('/api/cards/a%2Fb/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers: { scope: { chosen: ['approve'] } } }),
    })
  })

  it('throws the error message from a non-ok JSON response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid answers' }, 400))

    await expect(decideCard('c1', {})).rejects.toThrow('invalid answers')
  })

  it('throws the out-of-date error on a non-JSON body', async () => {
    fetchMock.mockResolvedValue(rawResponse('<html>404</html>', 404))

    await expect(decideCard('c1', {})).rejects.toThrow('The dashboard may be out of date')
  })
})

describe('uploadAttachment', () => {
  it('posts the file with x-answer-id / x-file-name / x-field headers and returns the parsed body', async () => {
    const ref: AttachmentRef = {
      id: 'att-1',
      name: 'shot.png',
      size: 4,
      path: '/tmp/shot.png',
      uploadedAt: '2026-06-18T00:00:00.000Z',
    }
    fetchMock.mockResolvedValue(jsonResponse(ref))
    const file = new File(['data'], 'shot.png', { type: 'image/png' })

    await expect(uploadAttachment('c1', 'ans-1', 'note', file)).resolves.toEqual(ref)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/cards/c1/attachments')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(file)
    expect(init.headers).toMatchObject({
      'content-type': 'image/png',
      'x-answer-id': 'ans-1',
      'x-field': 'note',
      'x-file-name': 'shot.png',
    })
  })

  it('throws the error message from a non-ok JSON response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'too big' }, 413))
    const file = new File(['data'], 'shot.png', { type: 'image/png' })

    await expect(uploadAttachment('c1', 'ans-1', 'note', file)).rejects.toThrow('too big')
  })

  it('percent-encodes a non-ASCII file name (survives the latin1 header)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'a', name: 'x', size: 1, path: '/x', uploadedAt: 'now' }))
    const file = new File(['data'], 'café 文档.png', { type: 'image/png' })

    await uploadAttachment('c1', 'ans-1', 'note', file)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-file-name']).toBe(encodeURIComponent('café 文档.png'))
  })
})

class MockEventSource {
  static instances: MockEventSource[] = []
  listeners: Record<string, ((e: unknown) => void)[]> = {}
  closed = false
  constructor(public url: string) { MockEventSource.instances.push(this) }
  addEventListener(type: string, cb: (e: unknown) => void): void { (this.listeners[type] ??= []).push(cb) }
  close(): void { this.closed = true }
  emit(type: string, e: unknown = {}): void { (this.listeners[type] ?? []).forEach(cb => cb(e)) }
}

describe('subscribeCards', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    vi.stubGlobal('EventSource', MockEventSource)
  })

  it('reports connection status: offline on stream error, online on (re)open', () => {
    const statuses: boolean[] = []
    subscribeCards(() => {}, online => statuses.push(online))
    const es = MockEventSource.instances[0]
    es.emit('error')
    es.emit('open')
    expect(statuses).toEqual([false, true])
  })

  it('delivers parsed cards and skips a malformed frame without throwing', () => {
    const got: Card[] = []
    subscribeCards(c => got.push(c))
    const es = MockEventSource.instances[0]
    es.emit('card', { data: JSON.stringify({ id: 'c1' }) })
    expect(() => es.emit('card', { data: 'not-json{' })).not.toThrow()
    expect(got.map(c => c.id)).toEqual(['c1'])
  })

  it('closes the stream on unsubscribe', () => {
    const stop = subscribeCards(() => {})
    stop()
    expect(MockEventSource.instances[0].closed).toBe(true)
  })
})
