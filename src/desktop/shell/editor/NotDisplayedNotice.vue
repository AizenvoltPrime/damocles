<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { FileX2 } from 'lucide-vue-next';
import { EDITOR_HARD_MAX_DOCUMENT_BYTES } from '@shared/types/messages';
import type { NotDisplayedReason } from '../../preload/shell-channels';
import { fileSize } from './file-size';

// VS Code's binary and large file placeholder: why a file or a diff side is not shown, with the slot's actions under it.
const props = defineProps<{ reason: NotDisplayedReason; bytes?: number | undefined }>();
const { t, locale } = useI18n();
const overLimit = computed(() => props.reason === 'tooLarge' && props.bytes !== undefined && props.bytes > EDITOR_HARD_MAX_DOCUMENT_BYTES);
</script>

<template>
  <div class="pane-empty d-fade-in absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-6 text-center">
    <span class="flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-panel) text-(--d-faint)">
      <FileX2
        aria-hidden="true"
        class="size-5"
      />
    </span>
    <p class="text-12.5 font-medium text-(--d-text)">
      {{ t('editor.notDisplayed.title') }}
    </p>
    <p class="max-w-80 text-11.5 text-(--d-muted)">
      {{ overLimit ? t('editor.notDisplayed.overLimit', { limit: fileSize(EDITOR_HARD_MAX_DOCUMENT_BYTES, locale) }) : t(`editor.notDisplayed.${reason}`) }}
      <template v-if="bytes !== undefined">
        {{ fileSize(bytes, locale) }}
      </template>
    </p>
    <slot />
  </div>
</template>
