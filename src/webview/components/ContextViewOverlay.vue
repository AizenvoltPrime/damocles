<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { IconArrowLeft, IconSparkles, IconExternalLink } from '@/components/icons';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { useOverlayEscape } from '@/composables/useOverlayEscape';
import { useVSCode } from '@/composables/useVSCode';
import { useContextViewStore } from '@/stores/useContextViewStore';

const { t } = useI18n();
const { postMessage } = useVSCode();
const contextViewStore = useContextViewStore();

defineProps<{
  contextContent: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

useOverlayEscape(() => emit('close'));

function handleOpenInEditor() {
  if (contextViewStore.viewingContextPath) {
    postMessage({ type: 'openFile', filePath: contextViewStore.viewingContextPath });
  }
}
</script>

<template>
  <div class="absolute inset-0 z-50 flex flex-col bg-background overflow-hidden">
    <!-- Header -->
    <header class="flex items-center gap-3 px-4 py-3 bg-muted border-b border-border/30 shrink-0">
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        @click="emit('close')"
      >
        <IconArrowLeft :size="18" />
      </Button>

      <IconSparkles :size="20" class="text-primary shrink-0" />

      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-medium text-foreground">{{ t('contextView.title') }}</h2>
        <p class="text-xs text-muted-foreground">{{ t('contextView.subtitle') }}</p>
      </div>

      <Button
        v-if="contextViewStore.viewingContextPath"
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        :title="t('contextView.openInEditor')"
        @click="handleOpenInEditor"
      >
        <IconExternalLink :size="16" />
      </Button>
    </header>

    <!-- Scrollable content -->
    <div class="flex-1 overflow-y-auto p-4">
      <MarkdownRenderer :content="contextContent" />
    </div>
  </div>
</template>
