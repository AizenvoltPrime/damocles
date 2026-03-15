<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { IconChevronDown, IconDatabase } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import CodeBlock from './CodeBlock.vue';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { useNodeStore } from '@/stores/useNodeStore';
import { formatDuration } from '@/utils/stringUtils';
import type { MemoryTierInjection, MemoryInjectionEntry } from '@shared/types/context-injection';
import type { RecallIteration } from '@shared/types/recall';
import { ref, watch } from 'vue';

const { t } = useI18n();
const store = useContextInjectionStore();
const nodeStore = useNodeStore();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function onTabClick(tab: 'recall' | 'memory' | 'nodeContext'): void {
  store.setActiveTab(tab);
}

function toolCallSummary(tc: { name: string; input: Record<string, unknown> }): string {
  if (tc.input.file_path) return String(tc.input.file_path);
  if (tc.input.command) return String(tc.input.command).slice(0, 80);
  if (tc.input.pattern) return String(tc.input.pattern);
  if (tc.input.query) return String(tc.input.query).slice(0, 80);
  return '';
}

const hasNodeContext = computed(() => {
  const traj = trajectory.value;
  return traj !== null && ((traj.contextTurns?.length ?? 0) > 0 || traj.nodeId !== null);
});

function tierLabel(tier: MemoryTierInjection['tier']): string {
  return t(`contextInjection.tierLabel.${tier}`);
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

const overlayTitle = computed(() => t('contextInjection.title'));

const isExecuting = computed(() =>
  store.executionPhase !== 'idle' && store.executionPhase !== 'complete',
);

const trajectory = computed(() => store.currentInjection);
const memoryInjection = computed(() => store.currentMemoryInjection);

const displayIterations = computed<RecallIteration[]>(() => {
  if (trajectory.value) return trajectory.value.iterations;
  if (store.liveIterations.length > 0) return store.liveIterations;
  return [];
});

const hasRecall = computed(() =>
  trajectory.value !== null || store.liveIterations.length > 0 || (isExecuting.value && store.executionPhase === 'recall'),
);
const hasMemory = computed(() => memoryInjection.value !== null || (isExecuting.value && store.executionPhase === 'memory'));
const hasAnyData = computed(() => hasRecall.value || hasMemory.value || hasNodeContext.value || isExecuting.value);
const showTabs = computed(() => isExecuting.value || [hasRecall.value, hasMemory.value, hasNodeContext.value].filter(Boolean).length > 1);

const isRecallStreaming = computed(() =>
  !trajectory.value && store.liveIterations.length > 0 && store.executionPhase === 'recall',
);

const expandedIterations = ref<Set<number>>(new Set());

watch(() => store.activePromptIndex, () => {
  expandedIterations.value = new Set();
});

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

const trajectoryNode = computed(() => {
  const traj = trajectory.value;
  if (!traj?.nodeId) return null;
  return nodeStore.nodes.find(n => n.nodeId === traj.nodeId) ?? null;
});

function outcomeBadgeClass(outcome: string): string {
  switch (outcome) {
    case 'resolved': return 'border-emerald-500/50 text-emerald-400';
    case 'partial': return 'border-amber-500/50 text-amber-400';
    case 'abandoned': return 'border-red-500/50 text-red-400';
    default: return 'border-muted-foreground/30 text-muted-foreground';
  }
}

const tabDescription = computed(() => {
  const tab = store.activeTab;
  if (tab === 'recall') return t('contextInjection.tabDescriptionRecall');
  if (tab === 'memory') return t('contextInjection.tabDescriptionMemory');
  if (tab === 'nodeContext') return t('contextInjection.tabDescriptionNode');
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
      <template v-if="store.activeTab === 'recall' && trajectory">
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
          {{ t('contextInjection.recallIterations', { count: store.liveIterations.length }) }}
        </Badge>
        <Badge
          variant="outline"
          class="text-[10px] border-primary/50 text-primary"
        >
          {{ t('contextInjection.recallRunning', { n: store.liveIterations.length + 1 }) }}
        </Badge>
      </template>
      <template v-else-if="store.activeTab === 'memory' && memoryInjection">
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

      <template v-if="store.activeTab === 'nodeContext' && trajectory">
        <Badge
          v-if="trajectory.nodeTitle"
          variant="outline"
          class="text-[10px] border-primary/50 text-primary"
        >
          {{ trajectory.nodeTitle }}
        </Badge>
        <div class="flex rounded-md overflow-hidden border border-border/50">
          <button
            type="button"
            class="px-2 py-0.5 text-[9px] font-medium transition-colors cursor-pointer"
            :class="store.contextViewMode === 'cards' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'"
            @click="store.setContextViewMode('cards')"
          >
            {{ t('contextInjection.viewCards') }}
          </button>
          <button
            type="button"
            class="px-2 py-0.5 text-[9px] font-medium transition-colors cursor-pointer"
            :class="store.contextViewMode === 'raw' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'"
            @click="store.setContextViewMode('raw')"
          >
            {{ t('contextInjection.viewRaw') }}
          </button>
        </div>
      </template>
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
          <p class="text-sm text-muted-foreground">{{ t('contextInjection.noContext') }}</p>
          <p class="text-xs text-muted-foreground/60 mt-1">{{ t('contextInjection.noContextHint') }}</p>
        </div>
      </div>

      <!-- Content with tabs -->
      <div v-else class="space-y-3">
        <!-- Tab bar -->
        <div v-if="showTabs" class="flex gap-1 mb-3 border-b border-border pb-2">
          <button
            v-if="hasRecall || isExecuting"
            type="button"
            class="px-3 py-1 rounded-md text-[11px] font-medium transition-all duration-150 cursor-pointer border"
            :class="store.activeTab === 'recall'
              ? 'bg-primary/15 text-primary border-primary/30'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'"
            @click="onTabClick('recall')"
          >
            {{ t('contextInjection.tabRecall') }}
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
          <button
            v-if="hasNodeContext"
            type="button"
            class="px-3 py-1 rounded-md text-[11px] font-medium transition-all duration-150 cursor-pointer border"
            :class="store.activeTab === 'nodeContext'
              ? 'bg-primary/15 text-primary border-primary/30'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'"
            @click="onTabClick('nodeContext')"
          >
            {{ t('contextInjection.tabNodeContext') }}
          </button>
        </div>

        <!-- Tab description -->
        <p v-if="tabDescription && hasAnyData" class="text-[11px] text-muted-foreground/70 leading-relaxed -mt-1 mb-2">
          {{ tabDescription }}
        </p>

        <!-- Recall Tab -->
        <div v-if="store.activeTab === 'recall'" class="space-y-3">
          <!-- User prompt (from trajectory or live) -->
          <div v-if="trajectory" class="mb-3 rounded-lg bg-muted/80 border border-border px-3 py-2">
            <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mr-2">
              {{ t('contextInjection.recallUserPrompt') }}
            </span>
            <span class="text-[11px] text-foreground/80">{{ trajectory.userPrompt }}</span>
          </div>

          <!-- Metadata row -->
          <div v-if="trajectory" class="mb-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{{ t('contextInjection.recallHistoryChars', { chars: trajectory.historyChars.toLocaleString() }) }}</span>
          </div>

          <!-- Short-circuit explanation -->
          <div v-if="trajectory?.shortCircuited && trajectory.iterations.length === 0" class="mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
            <p class="text-[11px] text-emerald-400">{{ t('contextInjection.recallShortCircuitedHint') }}</p>
          </div>

          <!-- Waiting for first iteration -->
          <div v-if="!trajectory && store.liveIterations.length === 0 && isExecuting" class="flex items-center justify-center gap-2 py-12">
            <LoadingSpinner :size="16" />
            <span class="text-xs text-muted-foreground">{{ t('contextInjection.recallRunning', { n: 1 }) }}</span>
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
                <Collapsible :default-open="true" class="mt-2">
                  <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                    <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                    <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{{ t('contextInjection.recallModelResponse') }}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div class="mt-1 text-[11px] text-foreground/80 bg-background rounded-lg p-2">
                      <MarkdownRenderer :content="iter.modelResponse" />
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                <!-- Code block -->
                <Collapsible v-if="iter.codeBlock" :default-open="true">
                  <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                    <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                    <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{{ t('contextInjection.recallCodeBlock') }}</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div class="mt-1">
                      <CodeBlock :code="iter.codeBlock" language="javascript" />
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                <!-- REPL output -->
                <Collapsible v-if="iter.replOutput" :default-open="true">
                  <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                    <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                    <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">{{ t('contextInjection.recallReplOutput') }}</span>
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

                    <Collapsible>
                      <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                        <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                        <span class="text-[9px] font-medium text-muted-foreground uppercase tracking-wider">{{ t('contextInjection.recallSubcallPrompt') }}</span>
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
                        <span class="text-[9px] font-medium text-primary/70 uppercase tracking-wider">{{ t('contextInjection.recallSubcallResponse') }}</span>
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
              <span class="text-[10px] text-muted-foreground">{{ t('contextInjection.recallRunning', { n: store.liveIterations.length + 1 }) }}</span>
            </div>

            <!-- Final context -->
            <Collapsible v-if="trajectory?.finalContext" :default-open="true">
              <div class="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-1.5">
                <CollapsibleTrigger class="group flex items-center gap-2 w-full cursor-pointer">
                  <div class="h-px flex-1 bg-primary/20" />
                  <IconChevronDown :size="12" class="shrink-0 text-primary transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                  <span class="text-[10px] font-medium text-primary uppercase tracking-widest">
                    {{ t('contextInjection.recallFinalContext') }}
                  </span>
                  <div class="h-px flex-1 bg-primary/20" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <MarkdownRenderer :content="trajectory.finalContext" />
                </CollapsibleContent>
              </div>
            </Collapsible>
          </div>

          <!-- Recall tab empty (when only memory has data, no live data) -->
          <div v-if="!trajectory && store.liveIterations.length === 0 && !isExecuting" class="flex flex-col items-center justify-center text-center gap-3 py-12">
            <IconDatabase :size="32" class="text-muted-foreground/40" />
            <p class="text-sm text-muted-foreground">{{ t('contextInjection.noContext') }}</p>
          </div>
        </div>

        <!-- Memory Tab -->
        <div v-else-if="store.activeTab === 'memory'" class="space-y-3">
          <!-- Memory building indicator -->
          <div v-if="!memoryInjection && isExecuting" class="flex items-center justify-center gap-2 py-12">
            <LoadingSpinner :size="16" />
            <span class="text-xs text-muted-foreground">{{ t('contextInjection.memoryBuilding') }}</span>
          </div>

          <template v-else-if="memoryInjection">
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
            <div class="space-y-4">
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
                      :title="`${t('contextInjection.breakdownFts')}: ${entry.scoreBreakdown.ftsRelevance.toFixed(2)}`"
                    />
                    <div
                      v-if="entry.scoreBreakdown.recency > 0"
                      class="bg-blue-400/80 rounded-full"
                      :style="{ flex: entry.scoreBreakdown.recency }"
                      :title="`${t('contextInjection.breakdownRecency')}: ${entry.scoreBreakdown.recency.toFixed(2)}`"
                    />
                    <div
                      v-if="entry.scoreBreakdown.tierWeight > 0"
                      class="bg-emerald-400/80 rounded-full"
                      :style="{ flex: entry.scoreBreakdown.tierWeight }"
                      :title="`${t('contextInjection.breakdownTier')}: ${entry.scoreBreakdown.tierWeight.toFixed(2)}`"
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
          </template>

          <!-- Memory tab empty -->
          <div v-else class="flex flex-col items-center justify-center text-center gap-3 py-12">
            <IconDatabase :size="32" class="text-muted-foreground/40" />
            <div>
              <p class="text-sm text-muted-foreground">{{ t('contextInjection.memoryNoData') }}</p>
            </div>
          </div>
        </div>

        <!-- Node Context Tab -->
        <div v-else-if="store.activeTab === 'nodeContext' && trajectory" class="space-y-3">
          <!-- Node badge header -->
          <div class="flex items-center gap-2 mb-3">
            <Badge
              v-if="trajectory.nodeTitle"
              variant="outline"
              class="text-[10px] border-primary/30 text-primary"
            >
              {{ trajectory.nodeTitle }}
            </Badge>
            <span v-if="!trajectory.nodeTitle" class="text-[10px] text-muted-foreground">{{ t('contextInjection.noNodeAssigned') }}</span>
            <span class="text-[10px] text-muted-foreground">
              {{ t('contextInjection.nodeContextStats', { turns: trajectory.contextTurns.length, chars: (trajectory.finalContext?.length ?? 0).toLocaleString() }) }}
            </span>
          </div>

          <!-- Cards View -->
          <template v-if="store.contextViewMode === 'cards'">
            <!-- Node metadata header -->
            <div v-if="trajectoryNode" class="space-y-3 mb-4">
              <!-- Key entities -->
              <div v-if="trajectoryNode.keyEntities.length > 0" class="flex flex-wrap gap-1">
                <Badge
                  v-for="tag in trajectoryNode.keyEntities"
                  :key="tag"
                  variant="secondary"
                  class="text-[9px] px-1.5 py-0"
                >
                  {{ tag }}
                </Badge>
              </div>

              <!-- Summary card (closed nodes) -->
              <div v-if="trajectoryNode.summary" class="rounded-lg border border-border bg-muted/60 p-3 space-y-2">
                <p class="text-[11px] text-foreground/80">{{ trajectoryNode.summary.taskDescription }}</p>
                <div v-if="trajectoryNode.summary.filesChanged.length > 0" class="text-[10px] text-muted-foreground">
                  <span class="font-medium">{{ t('nodeOverlay.files') }}</span> {{ trajectoryNode.summary.filesChanged.join(', ') }}
                </div>
                <div v-if="trajectoryNode.summary.keyDecisions.length > 0" class="space-y-0.5">
                  <span class="text-[10px] font-medium text-muted-foreground">{{ t('nodeOverlay.keyDecisions') }}</span>
                  <ul class="list-disc list-inside text-[10px] text-foreground/70 space-y-0.5 pl-1">
                    <li v-for="(decision, i) in trajectoryNode.summary.keyDecisions" :key="i">{{ decision }}</li>
                  </ul>
                </div>
              </div>

              <!-- Files touched -->
              <Collapsible v-if="trajectoryNode.filesTouched.length > 0">
                <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer">
                  <IconChevronDown :size="12" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                  <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {{ t('nodeOverlay.filesTouchedCount', { count: trajectoryNode.filesTouched.length }) }}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <span
                      v-for="file in trajectoryNode.filesTouched"
                      :key="file"
                      class="text-[10px] font-mono text-primary/80 bg-primary/5 px-1.5 py-0.5 rounded"
                    >
                      {{ file }}
                    </span>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>

            <!-- Seed context (from orphan turns) -->
            <Collapsible v-if="trajectory.seedContext">
              <div class="rounded-lg border border-amber-500/20 bg-amber-500/5 mb-3">
                <CollapsibleTrigger class="group flex items-center gap-2 w-full px-3 py-2 cursor-pointer">
                  <IconChevronDown :size="12" class="shrink-0 text-amber-400 transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                  <span class="text-[10px] font-medium text-amber-400 uppercase tracking-wider">{{ t('nodeOverlay.seedContext') }}</span>
                  <span class="text-[9px] text-muted-foreground/50">{{ trajectory.seedContext.length.toLocaleString() }} chars</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div class="px-3 pb-3 text-[12px] text-foreground/80">
                    <MarkdownRenderer :content="trajectory.seedContext" />
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <!-- Related task summaries -->
            <Collapsible v-if="trajectory.relatedSummaries.length > 0">
              <div class="rounded-lg border border-primary/20 bg-primary/5 mb-3">
                <CollapsibleTrigger class="group flex items-center gap-2 w-full px-3 py-2 cursor-pointer">
                  <IconChevronDown :size="12" class="shrink-0 text-primary transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                  <span class="text-[10px] font-medium text-primary uppercase tracking-wider">{{ t('nodeOverlay.relatedTasks') }}</span>
                  <Badge variant="secondary" class="text-[9px] px-1.5 py-0">{{ trajectory.relatedSummaries.length }}</Badge>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div class="px-3 pb-3 space-y-1.5">
                    <div
                      v-for="rs in trajectory.relatedSummaries"
                      :key="rs.nodeId"
                      class="rounded-lg border border-border/50 bg-muted/40 p-3 space-y-1.5"
                    >
                      <div class="flex items-center gap-2">
                        <span class="text-[10px] font-medium text-foreground/80">{{ rs.title }}</span>
                        <Badge
                          variant="outline"
                          class="text-[8px] px-1 py-0 shrink-0"
                          :class="outcomeBadgeClass(rs.outcome)"
                        >
                          {{ rs.outcome }}
                        </Badge>
                      </div>
                      <p class="text-[11px] text-foreground/70">{{ rs.taskDescription }}</p>
                      <div v-if="rs.filesChanged.length > 0" class="text-[9px] text-muted-foreground/60">
                        {{ t('nodeOverlay.files') }} {{ rs.filesChanged.join(', ') }}
                      </div>
                      <div v-if="rs.keyDecisions.length > 0" class="space-y-0.5">
                        <span class="text-[9px] font-medium text-muted-foreground/60">{{ t('nodeOverlay.keyDecisions') }}</span>
                        <ul class="list-disc list-inside text-[9px] text-foreground/60 space-y-0.5 pl-1">
                          <li v-for="(decision, i) in rs.keyDecisions" :key="i">{{ decision }}</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <!-- Conversation turns -->
            <div v-if="trajectory.contextTurns.length > 0" class="space-y-3">
              <div class="flex items-center gap-2 mb-2">
                <div class="h-px flex-1 bg-border" />
                <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">{{ t('nodeOverlay.conversation') }}</span>
                <Badge variant="secondary" class="text-[9px] px-1.5 py-0">{{ t('nodeOverlay.turnsBadge', { count: trajectory.contextTurns.length }) }}</Badge>
                <div class="h-px flex-1 bg-border" />
              </div>

              <div v-for="(turn, idx) in trajectory.contextTurns" :key="turn.promptIndex" class="space-y-1.5">
                <!-- User message -->
                <div class="border-l-2 border-blue-500 pl-3 py-2 bg-blue-500/5 rounded-r-lg">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-[10px] font-medium text-blue-400">{{ t('nodeOverlay.turnN', { n: idx + 1 }) }}</span>
                    <span class="text-[10px] text-muted-foreground">{{ t('nodeOverlay.you') }}</span>
                  </div>
                  <div class="text-[12px] text-foreground/90">
                    <MarkdownRenderer :content="turn.userMessage" />
                  </div>
                </div>

                <!-- Interleaved content blocks -->
                <template v-for="(block, bi) in turn.contentBlocks" :key="bi">
                  <div v-if="block.type === 'text'" class="border-l-2 border-violet-500 pl-3 py-2 bg-violet-500/5 rounded-r-lg">
                    <div v-if="bi === 0" class="flex items-center gap-2 mb-1">
                      <span class="text-[10px] font-medium text-violet-400">{{ t('nodeOverlay.turnN', { n: idx + 1 }) }}</span>
                      <span class="text-[10px] text-muted-foreground">{{ t('nodeOverlay.claude') }}</span>
                    </div>
                    <div class="text-[12px] text-foreground/80">
                      <MarkdownRenderer :content="block.content" />
                    </div>
                  </div>
                  <Collapsible v-else-if="block.type === 'tool_call'">
                    <CollapsibleTrigger class="group flex items-center gap-1.5 w-full text-left cursor-pointer border-l-2 border-amber-500/60 pl-3 py-1.5 bg-amber-500/5 rounded-r-lg">
                      <IconChevronDown :size="10" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                      <span class="text-[10px] font-mono text-amber-400">{{ block.name }}</span>
                      <span class="text-[10px] font-mono text-foreground/50 truncate">{{ toolCallSummary(block) }}</span>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div v-if="block.result" class="border-l-2 border-amber-500/30 pl-3 py-1.5">
                        <pre class="text-[10px] font-mono text-foreground/70 whitespace-pre-wrap break-all overflow-hidden">{{ block.result }}</pre>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </template>

                <!-- Fallback: if no contentBlocks -->
                <template v-if="!turn.contentBlocks || turn.contentBlocks.length === 0">
                  <div class="border-l-2 border-violet-500 pl-3 py-2 bg-violet-500/5 rounded-r-lg">
                    <div class="flex items-center gap-2 mb-1">
                      <span class="text-[10px] font-medium text-violet-400">{{ t('nodeOverlay.turnN', { n: idx + 1 }) }}</span>
                      <span class="text-[10px] text-muted-foreground">{{ t('nodeOverlay.claude') }}</span>
                    </div>
                    <div class="text-[12px] text-foreground/80">
                      <MarkdownRenderer :content="turn.assistantResponse" />
                    </div>
                  </div>
                </template>

                <!-- Files touched -->
                <Collapsible v-if="turn.filesTouched.length > 0">
                  <CollapsibleTrigger class="group flex items-center gap-1.5 cursor-pointer">
                    <IconChevronDown :size="10" class="shrink-0 text-muted-foreground transition-transform -rotate-90 group-data-[state=open]:rotate-0" />
                    <span class="text-[9px] font-medium text-primary/60">{{ t('nodePicker.filesTouched') }}</span>
                    <span class="text-[9px] font-mono text-muted-foreground">({{ turn.filesTouched.length }})</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div class="flex flex-col gap-0.5 pl-4 pt-1">
                      <span
                        v-for="file in turn.filesTouched"
                        :key="file"
                        class="text-[9px] font-mono text-primary/60 bg-primary/5 px-1 py-0.5 rounded w-fit"
                      >
                        {{ file }}
                      </span>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            </div>

            <div v-else-if="trajectory.finalContext" class="text-[11px] text-muted-foreground">
              <p class="mb-2">{{ t('contextInjection.replFallbackHint') }}</p>
            </div>

            <div v-else-if="!trajectory.seedContext && trajectory.relatedSummaries.length === 0" class="flex flex-col items-center justify-center text-center gap-3 py-12">
              <IconDatabase :size="32" class="text-muted-foreground/40" />
              <p class="text-sm text-muted-foreground">{{ t('contextInjection.noContext') }}</p>
            </div>
          </template>

          <!-- Raw View -->
          <template v-else-if="store.contextViewMode === 'raw'">
            <div v-if="trajectory.finalContext" class="rounded-lg bg-background border border-border p-3">
              <MarkdownRenderer :content="trajectory.finalContext" />
            </div>
            <div v-else class="flex flex-col items-center justify-center text-center gap-3 py-12">
              <IconDatabase :size="32" class="text-muted-foreground/40" />
              <p class="text-sm text-muted-foreground">{{ t('contextInjection.noContext') }}</p>
            </div>
          </template>
        </div>
      </div>
    </div>
  </OverlayShell>
</template>
