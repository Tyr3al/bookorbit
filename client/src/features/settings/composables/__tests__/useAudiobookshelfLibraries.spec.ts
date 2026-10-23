import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()
vi.mock('@/lib/api', () => ({ api: (input: string, init?: RequestInit) => apiMock(input, init) }))

import { useAudiobookshelfLibraries } from '../useAudiobookshelfLibraries'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('useAudiobookshelfLibraries', () => {
  beforeEach(() => {
    apiMock.mockReset()
  })

  it('loads the libraries and their exposure', async () => {
    apiMock.mockResolvedValue(json([{ id: 1, name: 'Audiobooks', exposed: true }]))
    const state = useAudiobookshelfLibraries()

    await expect(state.load()).resolves.toBe(true)

    expect(apiMock).toHaveBeenCalledWith('/api/v1/abs/settings/libraries', undefined)
    expect(state.libraries.value).toEqual([{ id: 1, name: 'Audiobooks', exposed: true }])
  })

  it('reports a failed load without replacing the list', async () => {
    apiMock.mockResolvedValue(json({ message: 'Forbidden' }, 403))
    const state = useAudiobookshelfLibraries()

    await expect(state.load()).resolves.toBe(false)
    expect(state.libraries.value).toEqual([])
  })

  it('sends the new exposure and applies the server response', async () => {
    apiMock.mockResolvedValueOnce(json([{ id: 1, name: 'Audiobooks', exposed: false }]))
    const state = useAudiobookshelfLibraries()
    await state.load()
    apiMock.mockResolvedValueOnce(json({ id: 1, name: 'Audiobooks', exposed: true }))

    await expect(state.setExposed(state.libraries.value[0]!, true)).resolves.toBe(true)

    expect(apiMock).toHaveBeenLastCalledWith('/api/v1/abs/settings/libraries/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exposed: true }),
    })
    expect(state.libraries.value[0]!.exposed).toBe(true)
    expect(state.pendingIds.value.size).toBe(0)
  })

  it('keeps the previous state when the update fails', async () => {
    apiMock.mockResolvedValueOnce(json([{ id: 1, name: 'Audiobooks', exposed: false }]))
    const state = useAudiobookshelfLibraries()
    await state.load()
    apiMock.mockRejectedValueOnce(new Error('offline'))

    await expect(state.setExposed(state.libraries.value[0]!, true)).resolves.toBe(false)

    expect(state.libraries.value[0]!.exposed).toBe(false)
    expect(state.pendingIds.value.size).toBe(0)
  })
})
