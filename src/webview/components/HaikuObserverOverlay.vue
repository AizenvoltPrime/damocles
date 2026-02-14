<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { IconSparkles, IconExternalLink, IconChevronLeft, IconChevronRight, IconCheck, IconChevronDown } from '@/components/icons';
import ThinkingIndicator from './ThinkingIndicator.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';
import { useVSCode } from '@/composables/useVSCode';
import { useHaikuObserverStore } from '@/stores/useHaikuObserverStore';
import type { AnnotationLinkDisplay } from '@shared/types/haiku-observer';

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

function shortenPath(filePath: string | null): string {
  if (!filePath) return '(no file)';
  const segments = filePath.replace(/\\/g, '/').split('/');
  return segments.length > 2
    ? '.../' + segments.slice(-2).join('/')
    : filePath;
}

function confidenceColor(confidence: number): string {
  if (confidence >= 0.8) return 'text-success';
  if (confidence >= 0.5) return 'text-warning';
  return 'text-muted-foreground';
}

const LINK_TYPE_CLASSES: Record<string, string> = {
  extends: 'border-green-500/40 text-green-400',
  depends_on: 'border-blue-500/40 text-blue-400',
  reverts: 'border-red-500/40 text-red-400',
  related: 'border-yellow-500/40 text-yellow-400',
};

function linkBadgeClass(linkType: AnnotationLinkDisplay['linkType']): string {
  return LINK_TYPE_CLASSES[linkType] ?? 'border-muted-foreground text-muted-foreground';
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

          <!-- Text block (progressive JSON during streaming) -->
          <div v-else-if="block.type === 'text'">
            <MarkdownRenderer :content="block.content" />
          </div>

          <!-- Annotation summary card -->
          <Card v-else-if="block.type === 'annotation_summary'" class="border-primary/30 rounded-xl">
            <CardContent class="p-3 space-y-2">
              <div class="flex items-center gap-2">
                <IconCheck :size="16" class="shrink-0 text-success" />
                <span class="text-xs font-medium text-foreground">
                  {{ block.annotationCount }} {{ t('haikuObserver.entriesAnnotated') }}
                </span>
                <span v-if="block.lowRelevanceCount" class="text-xs text-muted-foreground">
                  · {{ block.lowRelevanceCount }} {{ t('haikuObserver.lowRelevance') }}
                </span>
                <span v-if="block.linkCount" class="text-xs text-muted-foreground">
                  · {{ block.linkCount }} {{ t('haikuObserver.links') }}
                </span>
              </div>
              <p v-if="block.summary" class="text-xs text-muted-foreground">{{ block.summary }}</p>
              <div v-if="block.groups && block.groups.length > 0" class="flex flex-wrap gap-1">
                <Badge
                  v-for="group in block.groups"
                  :key="group"
                  variant="outline"
                  class="text-[10px] px-1.5 py-0"
                >
                  {{ group }}
                </Badge>
              </div>

              <!-- Collapsible Entries -->
              <Collapsible v-if="block.entries && block.entries.length > 0">
                <CollapsibleTrigger class="flex items-center gap-1.5 w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1 cursor-pointer group">
                  <IconChevronDown :size="12" class="shrink-0 transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                  <span>{{ t('haikuObserver.entriesSection', { count: block.entries.length }) }}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div class="space-y-1.5 pt-1">
                    <div
                      v-for="entry in block.entries"
                      :key="entry.entryId"
                      class="rounded-lg border border-border/50 p-2 space-y-0.5"
                      :class="{ 'opacity-50': entry.lowRelevance }"
                    >
                      <div class="text-[11px] font-mono text-foreground truncate">
                        {{ shortenPath(entry.filePath) }}
                      </div>
                      <div class="flex items-center justify-between gap-2">
                        <Badge variant="outline" class="text-[10px] px-1.5 py-0">
                          {{ entry.entryType }}
                        </Badge>
                        <span class="text-[10px] tabular-nums" :class="confidenceColor(entry.confidence)">
                          {{ entry.confidence.toFixed(2) }}
                        </span>
                      </div>
                      <p class="text-[11px] text-muted-foreground leading-snug">
                        {{ entry.description }}
                      </p>
                      <div v-if="entry.tags.length > 0" class="flex flex-wrap gap-0.5 pt-0.5">
                        <Badge
                          v-for="tag in entry.tags"
                          :key="tag"
                          variant="secondary"
                          class="text-[9px] px-1 py-0 font-normal"
                        >
                          {{ tag }}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>

              <!-- Collapsible Links -->
              <Collapsible v-if="block.links && block.links.length > 0">
                <CollapsibleTrigger class="flex items-center gap-1.5 w-full text-xs text-muted-foreground hover:text-foreground transition-colors py-1 cursor-pointer group">
                  <IconChevronDown :size="12" class="shrink-0 transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                  <span>{{ t('haikuObserver.linksSection', { count: block.links.length }) }}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div class="space-y-1.5 pt-1">
                    <div
                      v-for="(link, linkIdx) in block.links"
                      :key="linkIdx"
                      class="rounded-lg border p-2 space-y-0.5"
                      :class="linkBadgeClass(link.linkType)"
                    >
                      <div class="flex items-center justify-between gap-2">
                        <Badge variant="outline" class="text-[10px] px-1.5 py-0" :class="linkBadgeClass(link.linkType)">
                          {{ t(`haikuObserver.linkType.${link.linkType}`) }}
                        </Badge>
                        <span v-if="link.targetPromptIndex >= 0" class="text-[10px] text-muted-foreground tabular-nums">
                          P#{{ link.targetPromptIndex }}
                        </span>
                      </div>
                      <div class="text-[11px] font-mono text-foreground/80 truncate">
                        {{ shortenPath(link.sourceFilePath) }} → {{ shortenPath(link.targetFilePath) }}
                      </div>
                      <p v-if="link.targetDescription" class="text-[11px] text-muted-foreground leading-snug">
                        {{ link.targetDescription }}
                      </p>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
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
