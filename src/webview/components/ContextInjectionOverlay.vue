<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { IconChevronDown, IconDatabase } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import CodeBlock from './CodeBlock.vue';
import GraphView from './GraphView.vue';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { formatDuration } from '@/utils/stringUtils';
import type { MemoryTierInjection, MemoryInjectionEntry } from '@shared/types/context-injection';
import type { RecallIteration } from '@shared/types/recall';
import { ref } from 'vue';

const { t } = useI18n();
const store = useContextInjectionStore();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function l(key: string, params?: Record<string, unknown>): string {
  if (store.technicalView) return t(`contextInjection.${key}`, params ?? {});
  const friendlyKey = `contextInjection.friendly.${key}`;
  const friendly = t(friendlyKey, params ?? {});
  return friendly === friendlyKey ? t(`contextInjection.${key}`, params ?? {}) : friendly;
}

function onTabClick(tab: 'graph' | 'recall' | 'memory'): void {
  store.setActiveTab(tab);
}

function tierLabel(tier: MemoryTierInjection['tier']): string {
  return t(`contextInjection.tierLabel.${tier}`);
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

function relevanceLabel(score: number): string {
  if (score >= 0.7) return l('relevanceHigh');
  if (score >= 0.4) return l('relevanceMedium');
  return l('relevanceLow');
}

const overlayTitle = computed(() => l('title'));

const isExecuting = computed(() =>
  store.executionPhase !== 'idle' && store.executionPhase !== 'complete',
);

const trajectory = computed(() => store.currentInjection);
const memoryInjection = computed(() => store.currentMemoryInjection);

const graphSnapshot = computed(() => store.liveGraphState ?? store.currentGraphSnapshot);
const hasGraph = computed(() => graphSnapshot.value !== null || (isExecuting.value && store.executionPhase === 'graph'));
const isGraphLive = computed(() => store.isGraphLive);
const graphNodeCount = computed(() =>
  graphSnapshot.value?.topology.nodes.filter(n => n.type === 'node').length ?? 0,
);

const displayIterations = computed<RecallIteration[]>(() => {
  if (trajectory.value) return trajectory.value.iterations;
  if (store.liveIterations.length > 0) return store.liveIterations;
  return [];
});

const hasRecall = computed(() =>
  trajectory.value !== null || store.liveIterations.length > 0 || (isExecuting.value && store.executionPhase === 'recall'),
);
const hasMemory = computed(() => memoryInjection.value !== null || (isExecuting.value && store.executionPhase === 'memory'));
const hasAnyData = computed(() => hasRecall.value || hasMemory.value || hasGraph.value || isExecuting.value);
const showTabs = computed(() => isExecuting.value || [hasGraph.value, hasRecall.value, hasMemory.value].filter(Boolean).length > 1);

const isRecallStreaming = computed(() =>
  !trajectory.value && store.liveIterations.length > 0 && store.executionPhase === 'recall',
);

const expandedIterations = ref<Set<number>>(new Set());

function toggleIteration(index: number): void {
  const next = new Set(expandedIterations.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  expandedIterations.value = next;
}

function iterationHasDetail(iter: RecallIteration): boolean {
  if (!store.technicalView) return true;
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
    `${l('breakdownFts')}: ${b.ftsRelevance.toFixed(2)}`,
    `${l('breakdownRecency')}: ${b.recency.toFixed(2)}`,
    `${l('breakdownTier')}: ${b.tierWeight.toFixed(2)}`,
    `${l('breakdownFile')}: ${b.fileProximity.toFixed(2)}`,
    `${l('breakdownRetrieval')}: ${b.retrievalBoost.toFixed(2)}`,
  ];
  if (b.stalenessPenalty < 1.0) parts.push(`${l('breakdownStaleness')}: ${b.stalenessPenalty.toFixed(2)}`);
  return parts.join(' | ');
}

const tabDescription = computed(() => {
  const tab = store.activeTab;
  if (tab === 'graph') return l('tabDescriptionGraph');
  if (tab === 'recall') return l('tabDescriptionRecall');
  if (tab === 'memory') return l('tabDescriptionMemory');
  return '';
});
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
      <template v-if="store.activeTab === 'graph' && graphSnapshot">
        <Badge variant="secondary" class="text-[10px]">
          {{ l('graphNodeCount', { count: graphNodeCount }) }}
        </Badge>
        <Badge variant="secondary" class="text-[10px]">
          {{ formatDuration(graphSnapshot.totalDurationMs) }}
        </Badge>
        <Badge
          v-if="isGraphLive"
          variant="outline"
          class="text-[10px] border-primary/50 text-primary"
        >
          {{ t('contextInjection.graphLive') }}
        </Badge>
      </template>
      <template v-else-if="store.activeTab === 'recall' && trajectory">
        <Badge variant="secondary" class="text-[10px]">
          {{ l('recallIterations', { count: trajectory.iterations.length }) }}
        </Badge>
        <Badge variant="secondary" class="text-[10px]">
          {{ t('contextInjection.recallDuration', { duration: formatDuration(trajectory.totalDurationMs) }) }}
        </Badge>
        <Badge variant="secondary" class="text-[10px]">
          {{ l('recallTurns', { count: trajectory.turnCount }) }}
        </Badge>
        <Badge
          v-if="trajectory.shortCircuited"
          variant="outline"
          class="text-[10px] border-emerald-500/50 text-emerald-400"
        >
          {{ l('recallShortCircuited') }}
        </Badge>
        <Badge
          v-if="trajectory.forcedAnswer"
          variant="outline"
          class="text-[10px] border-red-500/50 text-red-400"
        >
          {{ l('recallForcedAnswer') }}
        </Badge>
        <Badge
          v-if="trajectory.timedOut"
          variant="outline"
          class="text-[10px] border-amber-500/50 text-amber-400"
        >
          {{ t('contextInjection.recallTimedOut') }}
        </Badge>
      </template>
      <template v-else-if="store.activeTab === 'recall' && isRecallStreaming">
        <Badge variant="secondary" class="text-[10px]">
          {{ l('recallIterations', { count: store.liveIterations.length }) }}
        </Badge>
        <Badge
          variant="outline"
          class="text-[10px] border-primary/50 text-primary"
        >
          {{ l('recallRunning', { n: store.liveIterations.length + 1 }) }}
        </Badge>
      </template>
      <template v-else-if="store.activeTab === 'memory' && memoryInjection">
        <Badge v-if="store.technicalView" variant="secondary" class="text-[10px]">
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

      <div class="flex items-center gap-1.5 ml-1 pl-1.5 border-l border-border/50">
        <span class="text-[10px] text-muted-foreground">{{ t('contextInjection.technicalToggle') }}</span>
        <Switch
          :checked="store.technicalView"
          class="!h-4 !w-7 [&>span]:!h-3 [&>span]:!w-3 data-[state=checked]:[&>span]:!translate-x-3"
          @update:checked="store.toggleTechnicalView()"
        />
      </div>
    </template>

    <div class="p-4 space-y-4">
      <!-- Loading state (pull-based only) -->
      <div v-if="store.isLoading && !isExecuting" class="flex items-center justify-center py-12">
        <LoadingSpinner :size="24" />
      </div>

      <!-- Empty state -->
      <div v-else-if="!hasAnyData && !store.isLoading" class="flex flex-col items-center justify-center text-center gap-3 py-12">
        <IconDatabase :size="32" class="text-muted-foreground/40" />
        <div>
          <p class="text-sm text-muted-foreground">{{ l('noContext') }}</p>
          <p class="text-xs text-muted-foreground/60 mt-1">{{ l('noContextHint') }}</p>
        </div>
      </div>

      <!-- Content with tabs -->
      <div v-else class="space-y-3">
        <!-- Tab bar -->
        <div v-if="showTabs" class="flex gap-1 mb-3 border-b border-border pb-2">
          <button
            v-if="hasGraph || isExecuting"
            type="button"
            class="px-3 py-1 rounded-md text-[11px] font-medium transition-all duration-150 cursor-pointer border"
            :class="store.activeTab === 'graph'
              ? 'bg-primary/15 text-primary border-primary/30'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'"
            @click="onTabClick('graph')"
          >
            {{ l('tabGraph') }}
          </button>
          <button
            v-if="hasRecall || isExecuting"
            type="button"
            class="px-3 py-1 rounded-md text-[11px] font-medium transition-all duration-150 cursor-pointer border"
            :class="store.activeTab === 'recall'
              ? 'bg-primary/15 text-primary border-primary/30'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'"
            @click="onTabClick('recall')"
          >
            {{ l('tabRecall') }}
          </button>
          <button
            v-if="hasMemory || isExecuting"
            type="button"
            class="px-3 py-1 rounded-md text-[11px] font-medium transition-all duration-150 cursor-pointer border"
            :class="store.activeTab === 'memory'
              ? 'bg-primary/15 text-primary border-primary/30'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'"
            @click="onTabClick('memory')"
          >
            {{ t('contextInjection.tabMemory') }}
          </button>
        </div>

        <!-- Tab description -->
        <p v-if="tabDescription && hasAnyData" class="text-[11px] text-muted-foreground/70 leading-relaxed -mt-1 mb-2">
          {{ tabDescription }}
        </p>

        <!-- Graph Tab -->
        <div v-if="store.activeTab === 'graph'" class="space-y-3">
          <div v-if="graphSnapshot">
            <GraphView :snapshot="graphSnapshot" :is-live="isGraphLive" />
          </div>
          <div v-else-if="isExecuting" class="flex items-center justify-center gap-2 py-12">
            <LoadingSpinner :size="16" />
            <span class="text-xs text-muted-foreground">{{ l('graphRunning') }}</span>
          </div>
        </div>

        <!-- Recall Tab -->
        <div v-else-if="store.activeTab === 'recall'" class="space-y-3">
          <!-- User prompt (from trajectory or live) -->
          <div v-if="trajectory" class="mb-3 rounded-lg bg-muted/80 border border-border px-3 py-2">
            <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mr-2">
              {{ l('recallUserPrompt') }}
            </span>
            <span class="text-[11px] text-foreground/80">{{ trajectory.userPrompt }}</span>
          </div>

          <!-- Metadata row -->
          <div v-if="trajectory" class="mb-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{{ l('recallHistoryChars', { chars: trajectory.historyChars.toLocaleString() }) }}</span>
          </div>

          <!-- Short-circuit explanation -->
          <div v-if="trajectory?.shortCircuited && trajectory.iterations.length === 0" class="mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
            <p class="text-[11px] text-emerald-400">{{ l('recallShortCircuitedHint') }}</p>
          </div>

          <!-- Waiting for first iteration -->
          <div v-if="!trajectory && store.liveIterations.length === 0 && isExecuting" class="flex items-center justify-center gap-2 py-12">
            <LoadingSpinner :size="16" />
            <span class="text-xs text-muted-foreground">{{ l('recallRunning', { n: 1 }) }}</span>
          </div>

          <!-- Scrollable iterations (live or final) -->
          <div v-if="displayIterations.length > 0" class="space-y-3">
            <div
              v-for="iter in displayIterations"
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
                  <span class="text-[11px] text-foreground truncate">{{ iter.modelResponse.slice(0, store.technicalView ? 120 : 200) }}{{ iter.modelResponse.length > (store.technicalView ? 120 : 200) ? '...' : '' }}</span>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  <Badge v-if="iter.subcalls.length > 0" variant="outline" class="text-[9px] px-1 py-0 border-primary/30 text-primary/70">
                    {{ l('recallSubcalls', { count: iter.subcalls.length }) }}
                  </Badge>
                  <span class="text-[10px] text-muted-foreground tabular-nums">{{ formatDuration(iter.durationMs) }}</span>
                </div>
              </button>

              <!-- Expanded detail -->
              <div v-if="expandedIterations.has(iter.index)" class="px-3 pb-3 space-y-2 border-t border-border/50">
                <!-- Full model response -->
                <Collapsible :default-open="true" class="mt-2">
                  <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                    <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                    <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{{ l('recallModelResponse') }}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div class="mt-1 text-[11px] text-foreground/80 bg-background rounded-lg p-2">
                      <MarkdownRenderer :content="iter.modelResponse" />
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                <!-- Code block -->
                <Collapsible v-if="iter.codeBlock && store.technicalView" :default-open="true">
                  <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                    <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                    <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{{ l('recallCodeBlock') }}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div class="mt-1">
                      <CodeBlock :code="iter.codeBlock" language="javascript" />
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                <!-- REPL output -->
                <Collapsible v-if="iter.replOutput && store.technicalView" :default-open="true">
                  <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                    <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                    <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{{ l('recallReplOutput') }}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div class="mt-1">
                      <CodeBlock :code="iter.replOutput" />
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                <!-- Subcalls -->
                <div v-if="iter.subcalls.length > 0" class="space-y-2">
                  <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {{ l('recallSubcallsHeader') }}
                  </span>
                  <div
                    v-for="(sub, si) in iter.subcalls"
                    :key="si"
                    class="rounded-lg border border-border/60 bg-background p-2 space-y-1"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span v-if="store.technicalView" class="text-[10px] font-mono text-muted-foreground truncate">{{ sub.model }}</span>
                      <span class="text-[10px] text-muted-foreground tabular-nums shrink-0">{{ formatDuration(sub.durationMs) }}</span>
                    </div>

                    <Collapsible>
                      <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                        <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                        <span class="text-[9px] font-medium text-muted-foreground uppercase tracking-wider">{{ l('recallSubcallPrompt') }}</span>
                        <span class="text-[9px] text-muted-foreground/50 truncate">{{ sub.prompt.slice(0, 80) }}</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div class="mt-1 text-[10px] text-foreground/70">
                          <MarkdownRenderer :content="sub.prompt" />
                        </div>
                      </CollapsibleContent>
                    </Collapsible>

                    <Collapsible :default-open="true">
                      <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                        <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                        <span class="text-[9px] font-medium text-primary/70 uppercase tracking-wider">{{ l('recallSubcallResponse') }}</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div class="mt-1 text-[10px] text-primary/70">
                          <MarkdownRenderer :content="sub.response" />
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                </div>
              </div>
            </div>

            <!-- Streaming indicator -->
            <div v-if="isRecallStreaming" class="flex items-center justify-center gap-2 py-3">
              <LoadingSpinner :size="14" />
              <span class="text-[10px] text-muted-foreground">{{ l('recallRunning', { n: store.liveIterations.length + 1 }) }}</span>
            </div>

            <!-- Final context -->
            <Collapsible v-if="trajectory?.finalContext" :default-open="true">
              <div class="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-1.5">
                <CollapsibleTrigger class="group flex items-center gap-2 w-full cursor-pointer">
                  <div class="h-px flex-1 bg-primary/20" />
                  <IconChevronDown :size="12" class="shrink-0 text-primary transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                  <span class="text-[10px] font-medium text-primary uppercase tracking-widest">
                    {{ l('recallFinalContext') }}
                  </span>
                  <div class="h-px flex-1 bg-primary/20" />
                </CollapsibleTrigger>
                <p v-if="!store.technicalView" class="text-[11px] text-muted-foreground/70 leading-relaxed">
                  {{ t('contextInjection.friendly.recallFinalContextHint') }}
                </p>
                <CollapsibleContent>
                  <MarkdownRenderer :content="trajectory.finalContext" />
                </CollapsibleContent>
              </div>
            </Collapsible>
          </div>

          <!-- Recall tab empty (when only memory has data, no live data) -->
          <div v-if="!trajectory && store.liveIterations.length === 0 && !isExecuting" class="flex flex-col items-center justify-center text-center gap-3 py-12">
            <IconDatabase :size="32" class="text-muted-foreground/40" />
            <p class="text-sm text-muted-foreground">{{ l('noContext') }}</p>
          </div>
        </div>

        <!-- Memory Tab -->
        <div v-else-if="store.activeTab === 'memory'" class="space-y-3">
          <!-- Memory building indicator -->
          <div v-if="!memoryInjection && isExecuting" class="flex items-center justify-center gap-2 py-12">
            <LoadingSpinner :size="16" />
            <span class="text-xs text-muted-foreground">{{ l('memoryBuilding') }}</span>
          </div>

          <template v-else-if="memoryInjection">
            <!-- FTS query -->
            <div v-if="memoryInjection.ftsQuery" class="mb-3">
              <div class="rounded-lg bg-muted/80 border border-border px-3 py-2">
                <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mr-2">
                  {{ l('memoryFtsQuery') }}
                </span>
                <span class="text-[10px] font-mono text-foreground/80 break-all">{{ memoryInjection.ftsQuery }}</span>
              </div>
            </div>

            <!-- Scrollable content -->
            <div class="space-y-4">
              <!-- Pinned section -->
              <div v-if="pinnedEntries.length > 0" class="space-y-2">
                <div class="flex items-center gap-2">
                  <div class="h-px flex-1 bg-amber-500/30" />
                  <span class="text-[10px] font-medium text-amber-400 uppercase tracking-widest">
                    {{ t('contextInjection.memoryPinned') }}
                  </span>
                  <Badge v-if="store.technicalView" variant="secondary" class="text-[9px] px-1.5 py-0">
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
                  <div v-if="store.technicalView" class="flex items-center gap-2 text-[9px] text-muted-foreground/60">
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
                    {{ store.technicalView ? tierLabel(tier.tier) : t(`contextInjection.friendly.memoryTierExplain.${tier.tier}`) }}
                  </span>
                  <Badge variant="secondary" class="text-[9px] px-1.5 py-0">
                    {{ l('memoryTierEntries', { count: tier.entries.length, total: tier.totalAvailable }) }}
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
                      <span v-if="store.technicalView" class="text-[10px] text-muted-foreground tabular-nums">
                        {{ l('memoryScore', { score: formatScore(entry.score) }) }}
                      </span>
                      <Badge
                        v-else
                        variant="outline"
                        class="text-[9px] px-1.5 py-0"
                        :class="entry.score >= 0.7 ? 'border-emerald-500/50 text-emerald-400' : entry.score >= 0.4 ? 'border-primary/50 text-primary' : 'border-muted-foreground/30 text-muted-foreground'"
                      >
                        {{ relevanceLabel(entry.score) }}
                      </Badge>
                    </div>
                  </div>

                  <!-- Score breakdown bar -->
                  <div v-if="store.technicalView" class="flex gap-1 h-1 rounded-full overflow-hidden bg-background">
                    <div
                      v-if="entry.scoreBreakdown.ftsRelevance > 0"
                      class="bg-primary/80 rounded-full"
                      :style="{ flex: entry.scoreBreakdown.ftsRelevance }"
                      :title="`${l('breakdownFts')}: ${entry.scoreBreakdown.ftsRelevance.toFixed(2)}`"
                    />
                    <div
                      v-if="entry.scoreBreakdown.recency > 0"
                      class="bg-blue-400/80 rounded-full"
                      :style="{ flex: entry.scoreBreakdown.recency }"
                      :title="`${l('breakdownRecency')}: ${entry.scoreBreakdown.recency.toFixed(2)}`"
                    />
                    <div
                      v-if="entry.scoreBreakdown.tierWeight > 0"
                      class="bg-emerald-400/80 rounded-full"
                      :style="{ flex: entry.scoreBreakdown.tierWeight }"
                      :title="`${l('breakdownTier')}: ${entry.scoreBreakdown.tierWeight.toFixed(2)}`"
                    />
                    <div
                      v-if="entry.scoreBreakdown.fileProximity > 0"
                      class="bg-purple-400/80 rounded-full"
                      :style="{ flex: entry.scoreBreakdown.fileProximity }"
                      :title="`${l('breakdownFile')}: ${entry.scoreBreakdown.fileProximity.toFixed(2)}`"
                    />
                    <div
                      v-if="entry.scoreBreakdown.retrievalBoost > 0"
                      class="bg-orange-400/80 rounded-full"
                      :style="{ flex: entry.scoreBreakdown.retrievalBoost }"
                      :title="`${l('breakdownRetrieval')}: ${entry.scoreBreakdown.retrievalBoost.toFixed(2)}`"
                    />
                  </div>

                  <div v-if="store.technicalView" class="flex items-center gap-2 text-[9px] text-muted-foreground/60">
                    <span>{{ t('contextInjection.memoryTokenCount', { count: entry.estimatedTokens }) }}</span>
                    <span v-if="entry.scoreBreakdown.stalenessPenalty < 1.0">
                      {{ l('memoryStalenessValue', { value: entry.scoreBreakdown.stalenessPenalty.toFixed(2) }) }}
                    </span>
                  </div>
                </div>

                <!-- Empty tier -->
                <p v-if="tier.entries.length === 0" class="text-[11px] text-muted-foreground/50 pl-2">
                  {{ l('memoryTierEntries', { count: 0, total: tier.totalAvailable }) }}
                </p>
              </div>
            </div>
          </template>

          <!-- Memory tab empty -->
          <div v-else class="flex flex-col items-center justify-center text-center gap-3 py-12">
            <IconDatabase :size="32" class="text-muted-foreground/40" />
            <div>
              <p class="text-sm text-muted-foreground">{{ l('memoryNoData') }}</p>
              <p v-if="!store.technicalView" class="text-xs text-muted-foreground/60 mt-1">{{ t('contextInjection.friendly.memoryNoDataHint') }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </OverlayShell>
</template>
