<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { CircleAlert } from 'lucide-vue-next';
import type { ShellEditorTab } from '../../preload/shell-channels';
import { tabFileName } from './editor-place';

defineProps<{ tab: Pick<ShellEditorTab, 'displayPath' | 'title'> }>();
const { t } = useI18n();
</script>

<template>
  <div
    role="alert"
    data-testid="editor-load-failed"
    class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-13 text-(--d-danger-text)"
  >
    <CircleAlert
      aria-hidden="true"
      class="size-6"
    />
    <p>{{ t('editor.loadFailed', { name: tabFileName(tab) }) }}</p>
  </div>
</template>
