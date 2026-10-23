import { ref } from 'vue'
import type { AudiobookshelfLibraryExposure } from '@bookorbit/types'
import { api } from '@/lib/api'

const ENDPOINT = '/api/v1/abs/settings/libraries'

/** Which libraries the Audiobookshelf-compatible API exposes. */
export function useAudiobookshelfLibraries() {
  const libraries = ref<AudiobookshelfLibraryExposure[]>([])
  const loaded = ref(false)
  const pendingIds = ref(new Set<number>())

  async function load(): Promise<boolean> {
    const res = await api(ENDPOINT)
    if (!res.ok) return false
    libraries.value = await res.json()
    loaded.value = true
    return true
  }

  async function setExposed(library: AudiobookshelfLibraryExposure, exposed: boolean): Promise<boolean> {
    pendingIds.value = new Set(pendingIds.value).add(library.id)
    try {
      const res = await api(`${ENDPOINT}/${library.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exposed }),
      })
      if (!res.ok) return false
      const updated: AudiobookshelfLibraryExposure = await res.json()
      libraries.value = libraries.value.map((entry) => (entry.id === updated.id ? updated : entry))
      return true
    } catch {
      return false
    } finally {
      const next = new Set(pendingIds.value)
      next.delete(library.id)
      pendingIds.value = next
    }
  }

  return { libraries, loaded, pendingIds, load, setExposed }
}
