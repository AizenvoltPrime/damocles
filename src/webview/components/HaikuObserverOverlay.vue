<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { IconArrowLeft, IconSparkles, IconExternalLink, IconChevronLeft, IconChevronRight, IconChevronDown } from '@/components/icons';
import ThinkingIndicator from './ThinkingIndicator.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { useOverlayEscape } from '@/composables/useOverlayEscape';
import { useVSCode } from '@/composables/useVSCode';
import { useHaikuObserverStore } from '@/stores/useHaikuObserverStore';

const { t } = useI18n();
const { postMessage } = useVSCode();
const store = useHaikuObserverStore();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

useOverlayEscape(() => emit('close'));

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

const iterationLabel = computed(() => {
  if (isLiveStreaming.value && store.streamingIteration) {
    return t('haikuObserver.processing', { n: store.streamingIteration });
  }
  if (store.totalIterations > 1) {
    return t('haikuObserver.completedIterations', { n: store.totalIterations });
  }
  return t('haikuObserver.complete');
});

const earlierIterations = computed(() => store.currentIterationHistory);
const earlierIterationsReversed = computed(() => [...earlierIterations.value].reverse());
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
        <h2 class="text-sm font-medium text-foreground">{{ t('haikuObserver.title') }}</h2>
        <p class="text-xs text-muted-foreground">{{ t('haikuObserver.subtitle') }}</p>
      </div>

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
    </header>

    <!-- Content -->
    <div class="flex-1 overflow-y-auto p-4">
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
        <!-- Iteration badge (only shown alongside content) -->
        <div v-if="(isLiveStreaming || store.totalIterations > 1) && (store.displayThinking || store.displayText)" class="flex items-center gap-2">
          <Badge variant="secondary" class="text-xs">
            {{ iterationLabel }}
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
          {{ iterationLabel }}
        </div>

        <!-- Earlier iterations (collapsible) -->
        <Collapsible v-if="earlierIterations.length > 0" class="mt-4">
          <CollapsibleTrigger class="group flex items-center gap-2 py-1.5 px-2 -mx-2 rounded-md cursor-pointer hover:bg-muted/50 transition-colors">
            <IconChevronDown
              :size="14"
              class="text-muted-foreground transition-transform group-data-[state=open]:-rotate-180"
            />
            <span class="text-xs text-muted-foreground">
              {{ t('haikuObserver.earlierIterations', earlierIterations.length) }}
            </span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div class="mt-2 space-y-3">
              <div
                v-for="iter in earlierIterationsReversed"
                :key="iter.iteration"
                class="border-l-2 border-border pl-3 py-2"
              >
                <Badge variant="outline" class="text-[10px] mb-2">
                  {{ t('haikuObserver.iterationLabel', { n: iter.iteration }) }}
                </Badge>
                <ThinkingIndicator
                  v-if="iter.thinking"
                  :thinking="iter.thinking"
                  :is-streaming="false"
                />
                <div v-if="iter.text" class="mt-1">
                  <MarkdownRenderer :content="iter.text" />
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  </div>
</template>
