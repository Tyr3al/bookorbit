<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { onMounted, ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, Headphones } from '@lucide/vue'
import { toast } from 'vue-sonner'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { api } from '@/lib/api'
import { copyToClipboard } from '@/lib/clipboard'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import type { AudiobookshelfLibraryExposure } from '@bookorbit/types'
import { useAudiobookshelfLibraries } from './composables/useAudiobookshelfLibraries'

const { t } = useI18n()
const { hasPermission } = usePermissions()
const canManageSettings = computed(() => hasPermission('manage_app_settings'))
const canManageLibraries = computed(() => hasPermission('manage_libraries'))
const { libraries, pendingIds, load: loadLibraries, setExposed } = useAudiobookshelfLibraries()

const audiobookshelfEnabled = ref(false)
const loading = ref(true)
const error = ref<string | null>(null)

const audiobookshelfUrl = computed(() => `${window.location.origin}/abs`)

onMounted(async () => {
  try {
    const res = await api('/api/v1/app-settings')
    if (res.ok) {
      const settings = await res.json()
      const row = settings.find((s: { key: string; value: string }) => s.key === 'audiobookshelf_enabled')
      audiobookshelfEnabled.value = row?.value === 'true'
    }
    if (canManageLibraries.value && !(await loadLibraries())) {
      error.value = t('settings.reader.audiobookshelf.loadFailed')
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('settings.reader.audiobookshelf.loadFailed')
  } finally {
    loading.value = false
  }
})

async function toggleAudiobookshelf() {
  const newVal = !audiobookshelfEnabled.value
  try {
    const res = await api('/api/v1/app-settings/audiobookshelf_enabled', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: String(newVal) }),
    })
    if (res.ok) {
      audiobookshelfEnabled.value = newVal
      toast.success(newVal ? t('settings.reader.audiobookshelf.serverEnabled') : t('settings.reader.audiobookshelf.serverDisabled'))
    } else {
      toast.error(t('settings.reader.audiobookshelf.updateSettingsFailed'))
    }
  } catch {
    toast.error(t('settings.reader.audiobookshelf.updateSettingsFailed'))
  }
}

async function toggleLibrary(library: AudiobookshelfLibraryExposure, exposed: boolean) {
  const saved = await setExposed(library, exposed)
  if (!saved) {
    toast.error(t('settings.reader.audiobookshelf.updateLibraryFailed', { name: library.name }))
    return
  }
  toast.success(
    exposed
      ? t('settings.reader.audiobookshelf.libraryEnabled', { name: library.name })
      : t('settings.reader.audiobookshelf.libraryDisabled', { name: library.name }),
  )
}

async function copyUrl() {
  const copied = await copyToClipboard(audiobookshelfUrl.value)
  if (copied) {
    toast.success(t('settings.reader.audiobookshelf.urlCopied'))
  } else {
    toast.error(t('settings.reader.audiobookshelf.urlCopyFailed'))
  }
}
</script>

<template>
  <div v-if="loading" class="settings-loading-state">
    {{ t('common.loading') }}
  </div>
  <div v-else-if="error" class="settings-error-state">{{ error }}</div>
  <template v-else>
    <!-- Server Toggle -->
    <div v-if="canManageSettings" class="mb-6">
      <p class="settings-group-label">{{ t('settings.reader.audiobookshelf.server') }}</p>
      <div class="settings-card">
        <div class="flex flex-col gap-3 px-4 py-3.5 bg-card md:flex-row md:items-center md:justify-between md:px-5 md:py-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <p class="settings-label">
                {{ t('settings.reader.audiobookshelf.apiServer') }}
              </p>
              <Badge variant="outline">{{ t('settings.reader.audiobookshelf.experimental') }}</Badge>
            </div>
            <p class="settings-hint">
              {{ t('settings.reader.audiobookshelf.apiServerHint') }}
            </p>
          </div>
          <ToggleSwitch :model-value="audiobookshelfEnabled" class="self-start md:self-auto" @update:model-value="toggleAudiobookshelf" />
        </div>
      </div>
    </div>

    <div v-if="canManageLibraries" class="mb-6">
      <p class="settings-group-label">{{ t('settings.reader.audiobookshelf.libraries') }}</p>
      <div class="settings-card divide-y divide-border">
        <p v-if="libraries.length === 0" class="px-4 py-3.5 bg-card settings-hint md:px-5 md:py-4">
          {{ t('settings.reader.audiobookshelf.librariesEmpty') }}
        </p>
        <div v-for="library in libraries" :key="library.id" class="flex items-center justify-between gap-3 px-4 py-3.5 bg-card md:px-5 md:py-4">
          <p class="settings-label min-w-0 truncate">{{ library.name }}</p>
          <ToggleSwitch
            :model-value="library.exposed"
            :disabled="pendingIds.has(library.id)"
            :aria-label="library.name"
            @update:model-value="(value: boolean) => toggleLibrary(library, value)"
          />
        </div>
      </div>
      <p class="settings-hint mt-2">{{ t('settings.reader.audiobookshelf.librariesHint') }}</p>
    </div>

    <!-- Endpoint URL -->
    <div v-if="audiobookshelfEnabled" class="mb-6">
      <p class="settings-group-label">
        {{ t('settings.reader.audiobookshelf.endpoint') }}
      </p>
      <div class="settings-card">
        <div class="flex flex-col md:flex-row md:items-center gap-2 px-4 py-3.5 md:px-5 md:py-4 bg-card">
          <Headphones :size="14" class="text-muted-foreground shrink-0" />
          <input :value="audiobookshelfUrl" readonly class="flex-1 text-sm bg-transparent text-foreground outline-none select-all min-w-0 truncate" />
          <Button variant="outline" size="sm" class="w-full md:w-auto shrink-0" @click="copyUrl">
            <Copy :size="12" />
            {{ t('settings.reader.audiobookshelf.copy') }}
          </Button>
        </div>
      </div>
      <p class="settings-hint mt-2">
        {{ t('settings.reader.audiobookshelf.endpointHint') }}
      </p>
    </div>

    <div v-if="audiobookshelfEnabled" class="border border-border rounded-lg bg-card/50 shadow-xs">
      <p class="px-4 pt-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {{ t('settings.reader.audiobookshelf.notes') }}
      </p>
      <p class="px-4 pb-4 pt-2 text-xs text-muted-foreground">
        {{ t('settings.reader.audiobookshelf.notesBody') }}
      </p>
    </div>
  </template>
</template>
