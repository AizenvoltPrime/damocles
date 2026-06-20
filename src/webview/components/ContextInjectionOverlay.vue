<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { IconDatabase } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import type { MemoryInjectionGroup, MemoryInjectionEntry } from '@shared/types/context-injection';

const { t } = useI18n();
const store = useContextInjectionStore();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function groupLabel(label: MemoryInjectionGroup['label']): string {
  const key = label === 'observations' ? 'observation' : label;
  return t(`contextInjection.tierLabel.${key}`);
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

const overlayTitle = computed(() => t('contextInjection.title'));

const isExecuting = computed(() =>
  store.executionPhase !== 'idle' && store.executionPhase !== 'complete',
);

const memoryInjection = computed(() => store.currentMemoryInjection);

const hasMemory = computed(() => memoryInjection.value !== null || isExecuting.value);

const activeGroups = computed<MemoryInjectionGroup[]>(() => {
  if (!memoryInjection.value) return [];
  return memoryInjection.value.groups.filter(group => group.entries.length > 0 || group.totalAvailable > 0);
});

const pinnedEntries = computed(() => memoryInjection.value?.pinnedEntries ?? []);

function breakdownTooltip(entry: MemoryInjectionEntry): string {
  const b = entry.scoreBreakdown;
  const parts = [
    `${t('contextInjection.breakdownFts')}: ${b.ftsRelevance.toFixed(2)}`,
    `${t('contextInjection.breakdownRecency')}: ${b.recency.toFixed(2)}`,
    `${t('contextInjection.breakdownScope')}: ${b.scopeWeight.toFixed(2)}`,
    `${t('contextInjection.breakdownFile')}: ${b.fileProximity.toFixed(2)}`,
    `${t('contextInjection.breakdownRetrieval')}: ${b.retrievalBoost.toFixed(2)}`,
    `${t('contextInjection.breakdownSourceCount')}: ${b.sourceCountBoost.toFixed(2)}`,
  ];
  if (b.stalenessPenalty < 1.0) parts.push(`${t('contextInjection.breakdownStaleness')}: ${b.stalenessPenalty.toFixed(2)}`);
  if (entry.reason) parts.push(entry.reason);
  return parts.join(' | ');
}

function relevanceBadgeClass(relevance: 'high' | 'medium' | 'low'): string {
  switch (relevance) {
    case 'high': return 'border-emerald-500/50 text-emerald-400';
    case 'medium': return 'border-amber-500/50 text-amber-400';
    default: return 'border-muted-foreground/30 text-muted-foreground';
  }
}
</script>

<template>
  <OverlayShell
    :title="overlayTitle"
    :subtitle="t('contextInjection.promptN', { n: store.activePromptIndex })"
    :icon="IconDatabase"
    icon-class="text-primary"
    @close="emit('close')"
  >
    <template #header-actions>
      <template v-if="memoryInjection">
        <Badge variant="secondary" class="text-xs">
          {{ t('contextInjection.memoryCatalogTokens', { tokens: memoryInjection.totalTokensUsed }) }}
        </Badge>
        <Badge
          v-if="memoryInjection.hasProfile"
          variant="outline"
          class="text-xs border-cyan-500/50 text-cyan-400"
        >
          {{ t('contextInjection.memoryProfile') }}
        </Badge>
        <Badge
          v-if="memoryInjection.hasHandoffContext"
          variant="outline"
          class="text-xs border-primary/50 text-primary"
        >
          {{ t('contextInjection.memoryHandoff') }}
        </Badge>
        <Badge
          v-if="memoryInjection.rerankApplied"
          variant="outline"
          class="text-xs border-violet-500/50 text-violet-400"
        >
          {{ t('contextInjection.memoryReranked') }}
        </Badge>
        <Badge
          v-if="pinnedEntries.length > 0"
          variant="outline"
          class="text-xs border-amber-500/50 text-amber-400"
        >
          {{ t('contextInjection.memoryPinnedCount', { count: pinnedEntries.length }) }}
        </Badge>
      </template>
    </template>

    <div class="p-4 space-y-4">
      <!-- Loading state (pull-based only) -->
      <div v-if="store.isLoading && !isExecuting" class="flex items-center justify-center py-12">
        <LoadingSpinner :size="24" />
      </div>

      <!-- Empty state -->
      <div v-else-if="!hasMemory && !store.isLoading" class="flex flex-col items-center justify-center text-center gap-3 py-12">
        <IconDatabase :size="32" class="text-muted-foreground/40" />
        <div>
          <p class="text-sm text-muted-foreground">{{ t('contextInjection.noContext') }}</p>
          <p class="text-xs text-muted-foreground/60 mt-1">{{ t('contextInjection.noContextHint') }}</p>
        </div>
      </div>

      <!-- Memory content -->
      <div v-else class="space-y-3">
        <p class="text-xs text-muted-foreground/70 leading-relaxed -mt-1 mb-2">
          {{ t('contextInjection.tabDescriptionMemory') }}
        </p>

        <!-- Memory building indicator -->
        <div v-if="!memoryInjection && isExecuting" class="flex items-center justify-center gap-2 py-12">
          <LoadingSpinner :size="16" />
          <span class="text-xs text-muted-foreground">{{ t('contextInjection.memoryBuilding') }}</span>
        </div>

        <template v-else-if="memoryInjection">
          <!-- FTS query -->
          <div v-if="memoryInjection.ftsQuery" class="mb-3">
            <div class="rounded-lg bg-muted/80 border border-border px-3 py-2">
              <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider mr-2">
                {{ t('contextInjection.memoryFtsQuery') }}
              </span>
              <span class="text-xs font-mono text-foreground/80 break-all">{{ memoryInjection.ftsQuery }}</span>
            </div>
          </div>

          <!-- Scrollable content -->
          <div class="space-y-4">
            <!-- Pinned section -->
            <div v-if="pinnedEntries.length > 0" class="space-y-2">
              <div class="flex items-center gap-2">
                <div class="h-px flex-1 bg-amber-500/30" />
                <span class="text-xs font-medium text-amber-400 uppercase tracking-widest">
                  {{ t('contextInjection.memoryPinned') }}
                </span>
                <Badge variant="secondary" class="text-xs px-1.5 py-0">
                  {{ t('contextInjection.memoryPinnedBudget', { used: memoryInjection.pinnedTokensUsed, budget: memoryInjection.pinnedBudget }) }}
                </Badge>
                <div class="h-px flex-1 bg-amber-500/30" />
              </div>

              <div
                v-for="entry in pinnedEntries"
                :key="entry.id"
                class="rounded-xl p-3 space-y-1.5 border border-amber-500/30 bg-amber-500/5"
                :title="breakdownTooltip(entry)"
              >
                <div class="flex items-center justify-between gap-2">
                  <span v-if="entry.title" class="text-xs font-medium text-foreground truncate">
                    {{ entry.title }}
                  </span>
                  <span v-else class="text-xs text-foreground truncate">
                    {{ entry.content.slice(0, 80) }}{{ entry.content.length > 80 ? '...' : '' }}
                  </span>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <Badge
                      v-if="entry.isStale"
                      variant="outline"
                      class="text-xs px-1 py-0 border-amber-500/50 text-amber-400"
                    >
                      {{ t('contextInjection.memoryStale') }}
                    </Badge>
                    <Badge variant="outline" class="text-xs px-1 py-0 border-amber-500/50 text-amber-400">
                      {{ t('contextInjection.memoryPinnedBadge') }}
                    </Badge>
                  </div>
                </div>
                <div class="flex items-center gap-2 text-xs text-muted-foreground/60">
                  <span>{{ t('contextInjection.memoryTokenCount', { count: entry.estimatedTokens }) }}</span>
                </div>
              </div>
            </div>

            <!-- Per-group sections -->
            <div
              v-for="group in activeGroups"
              :key="group.label"
              class="space-y-2"
            >
              <!-- Group header -->
              <div class="flex items-center gap-2">
                <div class="h-px flex-1 bg-border" />
                <span class="text-xs font-medium text-muted-foreground uppercase tracking-widest">
                  {{ groupLabel(group.label) }}
                </span>
                <Badge variant="secondary" class="text-xs px-1.5 py-0">
                  {{ t('contextInjection.memoryTierEntries', { count: group.entries.length, total: group.totalAvailable }) }}
                </Badge>
                <div class="h-px flex-1 bg-border" />
              </div>

              <!-- Memory entry cards -->
              <div
                v-for="entry in group.entries"
                :key="entry.id"
                class="rounded-xl p-3 space-y-1.5 border border-border bg-muted/80"
                :title="breakdownTooltip(entry)"
              >
                <div class="flex items-center justify-between gap-2">
                  <span v-if="entry.title" class="text-xs font-medium text-foreground truncate">
                    {{ entry.title }}
                  </span>
                  <span v-else class="text-xs text-foreground truncate">
                    {{ entry.content.slice(0, 80) }}{{ entry.content.length > 80 ? '...' : '' }}
                  </span>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <Badge
                      v-if="entry.rerankRelevance"
                      variant="outline"
                      class="text-xs px-1 py-0"
                      :class="relevanceBadgeClass(entry.rerankRelevance)"
                    >
                      {{ t(`contextInjection.relevance.${entry.rerankRelevance}`) }}
                    </Badge>
                    <Badge
                      v-if="entry.isStale"
                      variant="outline"
                      class="text-xs px-1 py-0 border-amber-500/50 text-amber-400"
                    >
                      {{ t('contextInjection.memoryStale') }}
                    </Badge>
                    <span class="text-xs text-muted-foreground tabular-nums">
                      {{ t('contextInjection.memoryScore', { score: formatScore(entry.score) }) }}
                    </span>
                  </div>
                </div>

                <!-- Rerank reason -->
                <p v-if="entry.reason" class="text-xs text-violet-400/80 italic">
                  {{ entry.reason }}
                </p>

                <!-- Score breakdown bar -->
                <div class="flex gap-1 h-1 rounded-full overflow-hidden bg-background">
                  <div
                    v-if="entry.scoreBreakdown.ftsRelevance > 0"
                    class="bg-primary/80 rounded-full"
                    :style="{ flex: entry.scoreBreakdown.ftsRelevance }"
                    :title="`${t('contextInjection.breakdownFts')}: ${entry.scoreBreakdown.ftsRelevance.toFixed(2)}`"
                  />
                  <div
                    v-if="entry.scoreBreakdown.recency > 0"
                    class="bg-blue-400/80 rounded-full"
                    :style="{ flex: entry.scoreBreakdown.recency }"
                    :title="`${t('contextInjection.breakdownRecency')}: ${entry.scoreBreakdown.recency.toFixed(2)}`"
                  />
                  <div
                    v-if="entry.scoreBreakdown.scopeWeight > 0"
                    class="bg-emerald-400/80 rounded-full"
                    :style="{ flex: entry.scoreBreakdown.scopeWeight }"
                    :title="`${t('contextInjection.breakdownScope')}: ${entry.scoreBreakdown.scopeWeight.toFixed(2)}`"
                  />
                  <div
                    v-if="entry.scoreBreakdown.fileProximity > 0"
                    class="bg-purple-400/80 rounded-full"
                    :style="{ flex: entry.scoreBreakdown.fileProximity }"
                    :title="`${t('contextInjection.breakdownFile')}: ${entry.scoreBreakdown.fileProximity.toFixed(2)}`"
                  />
                  <div
                    v-if="entry.scoreBreakdown.retrievalBoost > 0"
                    class="bg-orange-400/80 rounded-full"
                    :style="{ flex: entry.scoreBreakdown.retrievalBoost }"
                    :title="`${t('contextInjection.breakdownRetrieval')}: ${entry.scoreBreakdown.retrievalBoost.toFixed(2)}`"
                  />
                  <div
                    v-if="entry.scoreBreakdown.sourceCountBoost > 0"
                    class="bg-pink-400/80 rounded-full"
                    :style="{ flex: entry.scoreBreakdown.sourceCountBoost }"
                    :title="`${t('contextInjection.breakdownSourceCount')}: ${entry.scoreBreakdown.sourceCountBoost.toFixed(2)}`"
                  />
                </div>

                <div class="flex items-center gap-2 text-xs text-muted-foreground/60">
                  <span>{{ t('contextInjection.memoryTokenCount', { count: entry.estimatedTokens }) }}</span>
                  <span v-if="entry.sourceCount && entry.sourceCount > 1">
                    {{ t('contextInjection.memorySourceCount', { count: entry.sourceCount }) }}
                  </span>
                  <span v-if="entry.scoreBreakdown.stalenessPenalty < 1.0">
                    {{ t('contextInjection.memoryStalenessValue', { value: entry.scoreBreakdown.stalenessPenalty.toFixed(2) }) }}
                  </span>
                </div>
              </div>

              <!-- Empty group -->
              <p v-if="group.entries.length === 0" class="text-xs text-muted-foreground/50 pl-2">
                {{ t('contextInjection.memoryTierEntries', { count: 0, total: group.totalAvailable }) }}
              </p>
            </div>
          </div>
        </template>
      </div>
    </div>
  </OverlayShell>
</template>
