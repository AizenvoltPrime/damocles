<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconSparkles, IconExternalLink, IconChevronLeft, IconChevronRight } from '@/components/icons';
import ThinkingIndicator from './ThinkingIndicator.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';
import { useVSCode } from '@/composables/useVSCode';
import { useHaikuObserverStore } from '@/stores/useHaikuObserverStore';

const { t } = useI18n();
const { postMessage } = useVSCode();
const store = useHaikuObserverStore();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const hasContent = computed(() =>
  store.totalPrompts > 0 || store.isObservationStreaming
);

const isLiveStreaming = computed(() =>
  store.isViewingLivePrompt && store.isObservationStreaming
);

function handleOpenLog() {
  const promptIndex = store.isViewingLivePrompt && store.streamingPromptIndex !== null
    ? store.streamingPromptIndex
    : store.currentActivity?.promptIndex ?? store.activePromptIndex;
  postMessage({ type: 'openHaikuLog', promptIndex });
}

function handleOpenContextFile() {
  const promptIndex = store.isViewingLivePrompt && store.streamingPromptIndex !== null
    ? store.streamingPromptIndex
    : store.currentActivity?.promptIndex ?? store.activePromptIndex;
  postMessage({ type: 'openContextFile', promptIndex });
}

const statusLabel = computed(() => {
  if (isLiveStreaming.value) {
    return t('haikuObserver.processing');
  }
  return t('haikuObserver.complete');
});
</script>

<template>
  <OverlayShell
    :title="t('haikuObserver.title')"
    :subtitle="t('haikuObserver.subtitle')"
    :icon="IconSparkles"
    icon-class="text-primary"
    @close="emit('close')"
  >
    <template #header-actions>
      <!-- Prompt navigation -->
      <div v-if="store.totalPrompts > 1" class="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="store.activePromptIndex <= 0"
          @click="store.navigatePrompt(store.activePromptIndex - 1)"
        >
          <IconChevronLeft :size="14" />
        </Button>
        <span class="text-xs text-muted-foreground tabular-nums px-1">
          {{ t('haikuObserver.promptOf', { n: store.activePromptIndex + 1, total: store.totalPrompts }) }}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          :disabled="store.activePromptIndex >= store.totalPrompts - 1"
          @click="store.navigatePrompt(store.activePromptIndex + 1)"
        >
          <IconChevronRight :size="14" />
        </Button>
      </div>

      <!-- Open log file -->
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        :title="t('haikuObserver.openLog')"
        @click="handleOpenLog"
      >
        <IconExternalLink :size="16" />
      </Button>

      <!-- Open Context File -->
      <Button
        variant="ghost"
        size="sm"
        class="text-xs text-muted-foreground hover:text-foreground shrink-0"
        @click="handleOpenContextFile"
      >
        {{ t('haikuObserver.openContextFile') }}
      </Button>
    </template>

    <div class="p-4">
      <!-- Empty state -->
      <div v-if="!hasContent" class="flex flex-col items-center justify-center h-full text-center gap-3">
        <IconSparkles :size="32" class="text-muted-foreground/40" />
        <div>
          <p class="text-sm text-muted-foreground">{{ t('haikuObserver.noActivity') }}</p>
          <p class="text-xs text-muted-foreground/60 mt-1">{{ t('haikuObserver.noActivityHint') }}</p>
        </div>
      </div>

      <!-- Activity content -->
      <div v-else class="space-y-4">
        <!-- Status badge -->
        <div v-if="isLiveStreaming && (store.displayThinking || store.displayText)" class="flex items-center gap-2">
          <Badge variant="secondary" class="text-xs">
            {{ statusLabel }}
          </Badge>
        </div>

        <!-- Thinking -->
        <ThinkingIndicator
          v-if="store.displayThinking"
          :thinking="store.displayThinking"
          :is-streaming="isLiveStreaming"
        />

        <!-- Text output -->
        <div v-if="store.displayText">
          <MarkdownRenderer :content="store.displayText" />
        </div>

        <!-- Streaming cursor -->
        <div v-if="isLiveStreaming && !store.displayText && !store.displayThinking" class="text-xs text-muted-foreground animate-pulse">
          {{ statusLabel }}
        </div>
      </div>
    </div>
  </OverlayShell>
</template>
