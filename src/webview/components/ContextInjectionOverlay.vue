<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { IconDatabase } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import type { MemoryTierInjection, MemoryInjectionEntry } from '@shared/types/context-injection';
import type { RecallIteration } from '@shared/types/recall';

const { t } = useI18n();
const store = useContextInjectionStore();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

type TabId = 'recall' | 'memory';
const activeTab = ref<TabId>('recall');

function tierLabel(tier: MemoryTierInjection['tier']): string {
  return t(`contextInjection.tierLabel.${tier}`);
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const trajectory = computed(() => store.currentInjection);
const memoryInjection = computed(() => store.currentMemoryInjection);

const hasRecall = computed(() => trajectory.value !== null);
const hasMemory = computed(() => memoryInjection.value !== null);
const hasAnyData = computed(() => hasRecall.value || hasMemory.value);
const showTabs = computed(() => hasRecall.value && hasMemory.value);

let tabInitialized = false;
watch(() => store.isLoading, (loading) => {
  if (loading || tabInitialized) return;
  tabInitialized = true;
  if (hasRecall.value) activeTab.value = 'recall';
  else if (hasMemory.value) activeTab.value = 'memory';
});

const expandedIterations = ref<Set<number>>(new Set());

function toggleIteration(index: number): void {
  const next = new Set(expandedIterations.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  expandedIterations.value = next;
}

function iterationHasDetail(iter: RecallIteration): boolean {
  return !!(iter.codeBlock || iter.replOutput || iter.subcalls.length > 0);
}

const activeTiers = computed<MemoryTierInjection[]>(() => {
  if (!memoryInjection.value) return [];
  return memoryInjection.value.tiers.filter(tier => tier.entries.length > 0 || tier.totalAvailable > 0);
});

const pinnedEntries = computed(() => memoryInjection.value?.pinnedEntries ?? []);

function breakdownTooltip(entry: MemoryInjectionEntry): string {
  const b = entry.scoreBreakdown;
  const parts = [
    `${t('contextInjection.breakdownFts')}: ${b.ftsRelevance.toFixed(2)}`,
    `${t('contextInjection.breakdownRecency')}: ${b.recency.toFixed(2)}`,
    `${t('contextInjection.breakdownTier')}: ${b.tierWeight.toFixed(2)}`,
    `${t('contextInjection.breakdownFile')}: ${b.fileProximity.toFixed(2)}`,
    `${t('contextInjection.breakdownRetrieval')}: ${b.retrievalBoost.toFixed(2)}`,
  ];
  if (b.stalenessPenalty < 1.0) parts.push(`${t('contextInjection.breakdownStaleness')}: ${b.stalenessPenalty.toFixed(2)}`);
  return parts.join(' | ');
}
</script>

<template>
  <OverlayShell
    :title="t('contextInjection.title')"
    :subtitle="t('contextInjection.promptN', { n: store.activePromptIndex })"
    :icon="IconDatabase"
    icon-class="text-primary"
    @close="emit('close')"
  >
    <template #header-actions>
      <template v-if="activeTab === 'recall' && trajectory">
        <Badge variant="secondary" class="text-[10px]">
          {{ t('contextInjection.recallIterations', { count: trajectory.iterations.length }) }}
        </Badge>
        <Badge variant="secondary" class="text-[10px]">
          {{ t('contextInjection.recallDuration', { duration: formatDuration(trajectory.totalDurationMs) }) }}
        </Badge>
        <Badge variant="secondary" class="text-[10px]">
          {{ t('contextInjection.recallTurns', { count: trajectory.turnCount }) }}
        </Badge>
        <Badge
          v-if="trajectory.shortCircuited"
          variant="outline"
          class="text-[10px] border-emerald-500/50 text-emerald-400"
        >
          {{ t('contextInjection.recallShortCircuited') }}
        </Badge>
        <Badge
          v-if="trajectory.forcedAnswer"
          variant="outline"
          class="text-[10px] border-red-500/50 text-red-400"
        >
          {{ t('contextInjection.recallForcedAnswer') }}
        </Badge>
      </template>
      <template v-else-if="activeTab === 'memory' && memoryInjection">
        <Badge variant="secondary" class="text-[10px]">
          {{ t('contextInjection.memoryCatalogTokens', { tokens: memoryInjection.totalTokensUsed }) }}
        </Badge>
        <Badge
          v-if="memoryInjection.hasHandoffContext"
          variant="outline"
          class="text-[10px] border-primary/50 text-primary"
        >
          {{ t('contextInjection.memoryHandoff') }}
        </Badge>
        <Badge
          v-if="pinnedEntries.length > 0"
          variant="outline"
          class="text-[10px] border-amber-500/50 text-amber-400"
        >
          {{ t('contextInjection.memoryPinnedCount', { count: pinnedEntries.length }) }}
        </Badge>
      </template>
    </template>

    <div class="p-4 h-full flex flex-col overflow-hidden">
      <!-- Loading state -->
      <div v-if="store.isLoading" class="flex items-center justify-center py-12">
        <LoadingSpinner :size="24" />
      </div>

      <!-- Empty state -->
      <div v-else-if="!hasAnyData" class="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
        <IconDatabase :size="32" class="text-muted-foreground/40" />
        <div>
          <p class="text-sm text-muted-foreground">{{ t('contextInjection.noContext') }}</p>
          <p class="text-xs text-muted-foreground/60 mt-1">{{ t('contextInjection.noContextHint') }}</p>
        </div>
      </div>

      <!-- Content with tabs -->
      <div v-else class="flex flex-col flex-1 min-h-0">
        <!-- Tab bar (only if both sources have data) -->
        <div v-if="showTabs" class="flex gap-1 mb-3 border-b border-border pb-2">
          <button
            type="button"
            class="px-3 py-1 rounded-md text-[11px] font-medium transition-all duration-150 cursor-pointer border"
            :class="activeTab === 'recall'
              ? 'bg-primary/15 text-primary border-primary/30'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'"
            @click="activeTab = 'recall'"
          >
            {{ t('contextInjection.tabRecall') }}
          </button>
          <button
            type="button"
            class="px-3 py-1 rounded-md text-[11px] font-medium transition-all duration-150 cursor-pointer border"
            :class="activeTab === 'memory'
              ? 'bg-primary/15 text-primary border-primary/30'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'"
            @click="activeTab = 'memory'"
          >
            {{ t('contextInjection.tabMemory') }}
          </button>
        </div>

        <!-- Recall Tab -->
        <div v-if="activeTab === 'recall' && trajectory" class="flex flex-col flex-1 min-h-0">
          <!-- User prompt -->
          <div class="mb-3 rounded-lg bg-muted/80 border border-border px-3 py-2">
            <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mr-2">
              {{ t('contextInjection.recallUserPrompt') }}
            </span>
            <span class="text-[11px] text-foreground/80">{{ trajectory.userPrompt }}</span>
          </div>

          <!-- Metadata row -->
          <div class="mb-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{{ t('contextInjection.recallHistoryChars', { chars: trajectory.historyChars.toLocaleString() }) }}</span>
          </div>

          <!-- Short-circuit explanation -->
          <div v-if="trajectory.shortCircuited && trajectory.iterations.length === 0" class="mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
            <p class="text-[11px] text-emerald-400">{{ t('contextInjection.recallShortCircuitedHint') }}</p>
          </div>

          <!-- Scrollable iterations -->
          <div class="flex-1 min-h-0 overflow-y-auto space-y-3">
            <div
              v-for="iter in trajectory.iterations"
              :key="iter.index"
              class="rounded-xl border border-border bg-muted/80"
            >
              <!-- Iteration header (clickable if has detail) -->
              <button
                type="button"
                class="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
                :class="iterationHasDetail(iter) ? 'cursor-pointer hover:bg-muted' : 'cursor-default'"
                @click="iterationHasDetail(iter) && toggleIteration(iter.index)"
              >
                <div class="flex items-center gap-2 min-w-0">
                  <Badge variant="secondary" class="text-[9px] px-1.5 py-0 shrink-0">
                    #{{ iter.index + 1 }}
                  </Badge>
                  <span class="text-[11px] text-foreground truncate">{{ iter.modelResponse.slice(0, 120) }}{{ iter.modelResponse.length > 120 ? '...' : '' }}</span>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <Badge v-if="iter.subcalls.length > 0" variant="outline" class="text-[9px] px-1 py-0 border-primary/30 text-primary/70">
                    {{ t('contextInjection.recallSubcalls', { count: iter.subcalls.length }) }}
                  </Badge>
                  <span class="text-[10px] text-muted-foreground tabular-nums">{{ formatDuration(iter.durationMs) }}</span>
                </div>
              </button>

              <!-- Expanded detail -->
              <div v-if="expandedIterations.has(iter.index)" class="px-3 pb-3 space-y-2 border-t border-border/50">
                <!-- Full model response -->
                <div class="mt-2">
                  <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {{ t('contextInjection.recallModelResponse') }}
                  </span>
                  <pre class="mt-1 text-[11px] text-foreground/80 whitespace-pre-wrap break-words font-mono bg-background rounded-lg p-2 max-h-48 overflow-y-auto">{{ iter.modelResponse }}</pre>
                </div>

                <!-- Code block -->
                <div v-if="iter.codeBlock">
                  <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {{ t('contextInjection.recallCodeBlock') }}
                  </span>
                  <pre class="mt-1 text-[11px] text-foreground/80 whitespace-pre-wrap break-words font-mono bg-background rounded-lg p-2 max-h-48 overflow-y-auto border border-primary/20">{{ iter.codeBlock }}</pre>
                </div>

                <!-- REPL output -->
                <div v-if="iter.replOutput">
                  <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {{ t('contextInjection.recallReplOutput') }}
                  </span>
                  <pre class="mt-1 text-[11px] text-emerald-400/80 whitespace-pre-wrap break-words font-mono bg-background rounded-lg p-2 max-h-48 overflow-y-auto border border-emerald-500/20">{{ iter.replOutput }}</pre>
                </div>

                <!-- Subcalls -->
                <div v-if="iter.subcalls.length > 0" class="space-y-2">
                  <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {{ t('contextInjection.recallSubcallsHeader') }}
                  </span>
                  <div
                    v-for="(sub, si) in iter.subcalls"
                    :key="si"
                    class="rounded-lg border border-border/60 bg-background p-2 space-y-1"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-[10px] font-mono text-muted-foreground truncate">{{ sub.model }}</span>
                      <span class="text-[10px] text-muted-foreground tabular-nums shrink-0">{{ formatDuration(sub.durationMs) }}</span>
                    </div>
                    <pre class="text-[10px] text-foreground/70 whitespace-pre-wrap break-words font-mono max-h-32 overflow-y-auto">{{ sub.prompt.slice(0, 500) }}{{ sub.prompt.length > 500 ? '...' : '' }}</pre>
                    <pre class="text-[10px] text-primary/70 whitespace-pre-wrap break-words font-mono max-h-32 overflow-y-auto">{{ sub.response.slice(0, 500) }}{{ sub.response.length > 500 ? '...' : '' }}</pre>
                  </div>
                </div>
              </div>
            </div>

            <!-- Final context -->
            <div v-if="trajectory.finalContext" class="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-1.5">
              <div class="flex items-center gap-2">
                <div class="h-px flex-1 bg-primary/20" />
                <span class="text-[10px] font-medium text-primary uppercase tracking-widest">
                  {{ t('contextInjection.recallFinalContext') }}
                </span>
                <div class="h-px flex-1 bg-primary/20" />
              </div>
              <pre class="text-[11px] text-foreground/80 whitespace-pre-wrap break-words font-mono max-h-64 overflow-y-auto">{{ trajectory.finalContext }}</pre>
            </div>
          </div>
        </div>

        <!-- Recall tab empty (when only memory has data) -->
        <div v-else-if="activeTab === 'recall' && !trajectory" class="flex flex-col items-center justify-center flex-1 text-center gap-3 py-12">
          <IconDatabase :size="32" class="text-muted-foreground/40" />
          <p class="text-sm text-muted-foreground">{{ t('contextInjection.noContext') }}</p>
        </div>

        <!-- Memory Tab -->
        <div v-else-if="activeTab === 'memory' && memoryInjection" class="flex flex-col flex-1 min-h-0">
          <!-- FTS query -->
          <div v-if="memoryInjection.ftsQuery" class="mb-3">
            <div class="rounded-lg bg-muted/80 border border-border px-3 py-2">
              <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mr-2">
                {{ t('contextInjection.memoryFtsQuery') }}
              </span>
              <span class="text-[10px] font-mono text-foreground/80 break-all">{{ memoryInjection.ftsQuery }}</span>
            </div>
          </div>

          <!-- Scrollable content -->
          <div class="flex-1 min-h-0 overflow-y-auto space-y-4">
            <!-- Pinned section -->
            <div v-if="pinnedEntries.length > 0" class="space-y-2">
              <div class="flex items-center gap-2">
                <div class="h-px flex-1 bg-amber-500/30" />
                <span class="text-[10px] font-medium text-amber-400 uppercase tracking-widest">
                  {{ t('contextInjection.memoryPinned') }}
                </span>
                <Badge variant="secondary" class="text-[9px] px-1.5 py-0">
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
                  <span v-if="entry.title" class="text-[11px] font-medium text-foreground truncate">
                    {{ entry.title }}
                  </span>
                  <span v-else class="text-[11px] text-foreground truncate">
                    {{ entry.content.slice(0, 80) }}{{ entry.content.length > 80 ? '...' : '' }}
                  </span>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <Badge
                      v-if="entry.isStale"
                      variant="outline"
                      class="text-[9px] px-1 py-0 border-amber-500/50 text-amber-400"
                    >
                      {{ t('contextInjection.memoryStale') }}
                    </Badge>
                    <Badge variant="outline" class="text-[9px] px-1 py-0 border-amber-500/50 text-amber-400">
                      {{ t('contextInjection.memoryPinnedBadge') }}
                    </Badge>
                  </div>
                </div>
                <div class="flex items-center gap-2 text-[9px] text-muted-foreground/60">
                  <span>{{ t('contextInjection.memoryTokenCount', { count: entry.estimatedTokens }) }}</span>
                </div>
              </div>
            </div>

            <!-- Per-tier sections -->
            <div
              v-for="tier in activeTiers"
              :key="tier.tier"
              class="space-y-2"
            >
              <!-- Tier header -->
              <div class="flex items-center gap-2">
                <div class="h-px flex-1 bg-border" />
                <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">
                  {{ tierLabel(tier.tier) }}
                </span>
                <Badge variant="secondary" class="text-[9px] px-1.5 py-0">
                  {{ t('contextInjection.memoryTierEntries', { count: tier.entries.length, total: tier.totalAvailable }) }}
                </Badge>
                <div class="h-px flex-1 bg-border" />
              </div>

              <!-- Memory entry cards -->
              <div
                v-for="entry in tier.entries"
                :key="entry.id"
                class="rounded-xl p-3 space-y-1.5 border border-border bg-muted/80"
                :title="breakdownTooltip(entry)"
              >
                <div class="flex items-center justify-between gap-2">
                  <span v-if="entry.title" class="text-[11px] font-medium text-foreground truncate">
                    {{ entry.title }}
                  </span>
                  <span v-else class="text-[11px] text-foreground truncate">
                    {{ entry.content.slice(0, 80) }}{{ entry.content.length > 80 ? '...' : '' }}
                  </span>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <Badge
                      v-if="entry.isStale"
                      variant="outline"
                      class="text-[9px] px-1 py-0 border-amber-500/50 text-amber-400"
                    >
                      {{ t('contextInjection.memoryStale') }}
                    </Badge>
                    <span class="text-[10px] text-muted-foreground tabular-nums">
                      {{ t('contextInjection.memoryScore', { score: formatScore(entry.score) }) }}
                    </span>
                  </div>
                </div>

                <!-- Score breakdown bar -->
                <div class="flex gap-1 h-1 rounded-full overflow-hidden bg-background">
                  <div
                    v-if="entry.scoreBreakdown.ftsRelevance > 0"
                    class="bg-primary/80 rounded-full"
                    :style="{ flex: entry.scoreBreakdown.ftsRelevance }"
                    :title="`FTS: ${entry.scoreBreakdown.ftsRelevance.toFixed(2)}`"
                  />
                  <div
                    v-if="entry.scoreBreakdown.recency > 0"
                    class="bg-blue-400/80 rounded-full"
                    :style="{ flex: entry.scoreBreakdown.recency }"
                    :title="`Recency: ${entry.scoreBreakdown.recency.toFixed(2)}`"
                  />
                  <div
                    v-if="entry.scoreBreakdown.tierWeight > 0"
                    class="bg-emerald-400/80 rounded-full"
                    :style="{ flex: entry.scoreBreakdown.tierWeight }"
                    :title="`Tier: ${entry.scoreBreakdown.tierWeight.toFixed(2)}`"
                  />
                  <div
                    v-if="entry.scoreBreakdown.fileProximity > 0"
                    class="bg-purple-400/80 rounded-full"
                    :style="{ flex: entry.scoreBreakdown.fileProximity }"
                    :title="`File: ${entry.scoreBreakdown.fileProximity.toFixed(2)}`"
                  />
                  <div
                    v-if="entry.scoreBreakdown.retrievalBoost > 0"
                    class="bg-orange-400/80 rounded-full"
                    :style="{ flex: entry.scoreBreakdown.retrievalBoost }"
                    :title="`Retrieval: ${entry.scoreBreakdown.retrievalBoost.toFixed(2)}`"
                  />
                </div>

                <div class="flex items-center gap-2 text-[9px] text-muted-foreground/60">
                  <span>{{ t('contextInjection.memoryTokenCount', { count: entry.estimatedTokens }) }}</span>
                  <span v-if="entry.scoreBreakdown.stalenessPenalty < 1.0">
                    {{ t('contextInjection.memoryStalenessValue', { value: entry.scoreBreakdown.stalenessPenalty.toFixed(2) }) }}
                  </span>
                </div>
              </div>

              <!-- Empty tier -->
              <p v-if="tier.entries.length === 0" class="text-[11px] text-muted-foreground/50 pl-2">
                {{ t('contextInjection.memoryTierEntries', { count: 0, total: tier.totalAvailable }) }}
              </p>
            </div>
          </div>
        </div>

        <!-- Memory tab empty -->
        <div v-else-if="activeTab === 'memory' && !memoryInjection" class="flex flex-col items-center justify-center flex-1 text-center gap-3 py-12">
          <IconDatabase :size="32" class="text-muted-foreground/40" />
          <p class="text-sm text-muted-foreground">{{ t('contextInjection.memoryNoData') }}</p>
        </div>
      </div>
    </div>
  </OverlayShell>
</template>
