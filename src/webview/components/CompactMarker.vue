<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CompactMarker as CompactMarkerType } from '@shared/types/session';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { IconChevronDown, IconChevronUp, IconRotateLeft } from '@/components/icons';
import MarkdownRenderer from './MarkdownRenderer.vue';

const { t } = useI18n();

const props = defineProps<{
  marker: CompactMarkerType;
}>();

const emit = defineEmits<{
  rewindToCompaction: [entryId: string];
}>();

const isExpanded = ref(true);

const hasSummary = computed(() => !!props.marker.summary);
const canRewind = computed(() => !!props.marker.entryId);

function requestRewind() {
  if (!props.marker.entryId) return;
  emit('rewindToCompaction', props.marker.entryId);
}

const tokenReduction = computed(() => {
  if (props.marker.postTokens) {
    return `${formatTokenCount(props.marker.preTokens)}→${formatTokenCount(props.marker.postTokens)}`;
  }
  return formatTokenCount(props.marker.preTokens);
});

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}k`;
  }
  return tokens.toString();
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}
</script>

<template>
  <Collapsible v-model:open="isExpanded" :disabled="!hasSummary">
    <!-- Compact boundary indicator line -->
    <div class="flex items-center gap-3 py-2 px-4">
      <div class="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>
      <span class="text-xs text-muted-foreground uppercase tracking-widest font-medium">{{ t('compactMarker.boundary') }}</span>
      <div class="flex-1 h-px bg-gradient-to-r from-transparent via-border to-transparent"></div>
    </div>

    <!-- Main compact card -->
    <div class="mx-4 mb-4 relative">
      <!-- Card container -->
      <div class="relative rounded-xl border border-border bg-muted overflow-hidden">
        <!-- Header with gradient border -->
        <CollapsibleTrigger
          :class="[
            'w-full px-4 py-3 flex items-center justify-between',
            'border-b border-border/50',
            'bg-card',
            hasSummary ? 'cursor-pointer hover:bg-muted transition-all duration-300' : 'cursor-default'
          ]"
        >
          <div class="flex items-center gap-3">
            <!-- Icon -->
            <div class="relative">
              <div class="w-8 h-8 rounded-lg bg-muted flex items-center justify-center border border-border">
                <span class="text-base">🗜️</span>
              </div>
            </div>

            <div class="flex flex-col items-start">
              <span class="text-sm font-semibold text-foreground">{{ t('compactMarker.title') }}</span>
              <div class="flex items-center gap-2 mt-0.5">
                <span
                  v-if="marker.trigger === 'auto'"
                  class="px-1.5 py-0.5 rounded text-xs font-medium bg-info/20 text-info border border-info/30"
                >
                  {{ t('compactMarker.auto') }}
                </span>
                <span
                  v-else
                  class="px-1.5 py-0.5 rounded text-xs font-medium bg-primary/20 text-primary border border-primary/30"
                >
                  {{ t('compactMarker.manual') }}
                </span>
                <span class="text-xs text-muted-foreground">{{ tokenReduction }} tokens</span>
                <span class="text-xs text-muted-foreground">•</span>
                <span class="text-xs text-muted-foreground">{{ formatTimestamp(marker.timestamp) }}</span>
              </div>
            </div>
          </div>

          <div v-if="hasSummary" class="flex items-center gap-2">
            <span class="text-xs text-muted-foreground">{{ isExpanded ? t('common.collapse') : t('common.expand') }} {{ t('compactMarker.summary') }}</span>
            <div class="w-6 h-6 rounded-full bg-muted flex items-center justify-center border border-border">
              <component
                :is="isExpanded ? IconChevronUp : IconChevronDown"
                :size="14"
                class="text-foreground"
              />
            </div>
          </div>
        </CollapsibleTrigger>

        <!-- Collapsible summary content -->
        <CollapsibleContent v-if="hasSummary">
          <div class="p-4">
            <!-- Summary header -->
            <div class="flex items-center gap-2 mb-3">
              <div class="w-1 h-4 rounded-full bg-primary"></div>
              <span class="text-xs font-semibold text-foreground uppercase tracking-wider">{{ t('compactMarker.summaryHeader') }}</span>
            </div>

            <!-- Summary content with styled scrollbar -->
            <div class="pl-3 border-l border-border/50">
              <div class="text-sm text-foreground/90 leading-relaxed prose prose-invert prose-sm max-w-none prose-p:my-2 prose-headings:text-foreground prose-strong:text-foreground prose-code:text-foreground prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded">
                <MarkdownRenderer :content="marker.summary ?? ''" />
              </div>
            </div>
          </div>
        </CollapsibleContent>

        <!-- No summary state -->
        <div v-if="!hasSummary" class="px-4 py-3 text-xs text-muted-foreground italic">
          {{ t('compactMarker.noSummary') }}
        </div>

        <!-- Rewind action: only when this boundary carries a resolvable tree anchor -->
        <div v-if="canRewind" class="px-4 py-3 border-t border-border/50 flex justify-end">
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            @click="requestRewind"
          >
            <IconRotateLeft :size="13" />
            {{ t('compactMarker.rewindBefore') }}
          </button>
        </div>
      </div>
    </div>
  </Collapsible>
</template>
