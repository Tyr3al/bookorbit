<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Headphones } from '@lucide/vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'

const { t } = useI18n()

defineProps<{
  enableAudiobookshelfApi: boolean
}>()

const emit = defineEmits<{
  'update:enableAudiobookshelfApi': [value: boolean]
}>()

function handleToggle(value: boolean) {
  emit('update:enableAudiobookshelfApi', value)
}
</script>

<template>
  <div class="px-6 py-6 flex flex-col gap-7 h-full min-h-0">
    <div class="flex items-start justify-between gap-4">
      <div class="flex gap-3">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/20">
          <Headphones :size="20" class="text-primary" />
        </div>
        <div>
          <p class="text-sm font-medium text-foreground">{{ t('library.creator.integration.audiobookshelf.title') }}</p>
          <p class="text-xs text-muted-foreground mt-0.5 max-w-md">{{ t('library.creator.integration.audiobookshelf.hint') }}</p>
        </div>
      </div>
      <ToggleSwitch
        :model-value="enableAudiobookshelfApi"
        :aria-label="t('library.creator.integration.audiobookshelf.title')"
        @update:model-value="handleToggle"
      />
    </div>
  </div>
</template>
