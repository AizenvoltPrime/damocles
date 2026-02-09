<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { IconSparkles, IconExternalLink, IconChevronLeft, IconChevronRight, IconMcp, IconCheck } from '@/components/icons';
import ThinkingIndicator from './ThinkingIndicator.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import LoadingSpinner from './LoadingSpinner.vue';
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

function formatInput(input: string | undefined): string {
  if (!input) return '';
  try {
    const parsed = JSON.parse(input);
    if ('entry_id' in parsed) return `Entry ${parsed.entry_id}`;
    if ('summary' in parsed) {
      const s = parsed.summary as string;
      return s.length > 80 ? s.slice(0, 80) + '...' : s;
    }
    if ('description' in parsed) {
      const s = parsed.description as string;
      return s.length > 80 ? s.slice(0, 80) + '...' : s;
    }
    const json = JSON.stringify(parsed);
    return json.length > 100 ? json.slice(0, 100) + '...' : json;
  } catch {
    return input.slice(0, 100) + (input.length > 100 ? '...' : '');
  }
}

function truncateResult(result: string | undefined): string {
  if (!result) return '';
  const text = result.length > 200 ? result.slice(0, 200) + '...' : result;
  return text;
}
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
      <div v-else class="space-y-3">
        <!-- Status badge -->
        <div v-if="isLiveStreaming && store.displayBlocks.length > 0" class="flex items-center gap-2">
          <Badge variant="secondary" class="text-xs">
            {{ statusLabel }}
          </Badge>
        </div>

        <!-- Block-based rendering -->
        <template v-for="(block, idx) in store.displayBlocks" :key="`${block.type}-${idx}`">
          <!-- Thinking block -->
          <ThinkingIndicator
            v-if="block.type === 'thinking'"
            :thinking="block.content"
            :is-streaming="isLiveStreaming"
          />

          <!-- Text block -->
          <div v-else-if="block.type === 'text'">
            <MarkdownRenderer :content="block.content" />
          </div>

          <!-- Tool call card (matching main chat ToolCallCard style) -->
          <Card v-else-if="block.type === 'tool'" class="border-primary/30 rounded-xl cursor-pointer hover:border-primary/50 transition-colors" @click="store.expandBlock(idx)">
            <CardHeader class="flex flex-row items-center gap-2 px-3 py-1.5 border-b border-border/50 space-y-0 bg-gradient-to-r from-primary/10 to-transparent">
              <IconMcp :size="18" class="shrink-0 text-primary" />
              <span class="text-foreground font-medium text-xs">{{ block.toolName }}</span>
              <LoadingSpinner v-if="!block.toolResult && isLiveStreaming" :size="16" class="ml-auto shrink-0 text-primary" />
              <IconCheck v-else-if="block.toolResult" :size="16" class="ml-auto shrink-0 text-success" />
            </CardHeader>
            <CardContent class="p-3 space-y-2">
              <div v-if="block.toolInput" class="flex items-start gap-2 text-xs">
                <span class="text-muted-foreground font-medium shrink-0">IN</span>
                <span class="font-mono text-foreground/70 truncate">{{ formatInput(block.toolInput) }}</span>
              </div>
              <div v-if="block.toolResult" class="flex items-start gap-2 text-xs border-t border-border/30 pt-2">
                <span class="text-muted-foreground font-medium shrink-0">OUT</span>
                <span class="font-mono text-foreground overflow-x-auto">{{ truncateResult(block.toolResult) }}</span>
              </div>
            </CardContent>
          </Card>
        </template>

        <!-- Streaming cursor -->
        <div v-if="isLiveStreaming && store.displayBlocks.length === 0" class="text-xs text-muted-foreground animate-pulse">
          {{ statusLabel }}
        </div>
      </div>
    </div>
  </OverlayShell>
</template>
