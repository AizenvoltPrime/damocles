<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { IconDatabase } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import type { MemoryTierInjection, MemoryInjectionEntry } from '@shared/types/context-injection';

const { t } = useI18n();
const store = useContextInjectionStore();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

type TabId = 'distill' | 'memory';
const activeTab = ref<TabId>('distill');

interface ParsedEntry {
  promptIndex: number;
  filePath: string | null;
  semanticGroup: string | null;
  description: string;
  isSummary: boolean;
}

interface ParsedContext {
  lastActivity: ParsedEntry[];
  relevantContext: ParsedEntry[];
}

interface ContextSection {
  id: string;
  label: string;
  entries: ParsedEntry[];
}

interface ContextColumn {
  id: string;
  label: string;
  accent: boolean;
  sections: ContextSection[];
}

function parseContextString(raw: string): ParsedContext {
  const result: ParsedContext = { lastActivity: [], relevantContext: [] };

  const lastActivityMatch = raw.match(/<last_activity>([\s\S]*?)<\/last_activity>/);
  const relevantContextMatch = raw.match(/<relevant_context>([\s\S]*?)<\/relevant_context>/);

  if (lastActivityMatch) result.lastActivity = parseEntries(lastActivityMatch[1]);
  if (relevantContextMatch) result.relevantContext = parseEntries(relevantContextMatch[1]);

  return result;
}

function parseEntries(block: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    const summaryMatch = line.match(/^\[Prompt (\d+) summary\]: (.+)$/);
    if (summaryMatch) {
      entries.push({
        promptIndex: parseInt(summaryMatch[1], 10),
        filePath: null,
        semanticGroup: null,
        description: summaryMatch[2],
        isSummary: true,
      });
      continue;
    }

    const entryMatch = line.match(/^\[Prompt (\d+)\]: (.+?)(?:\s*\(([^)]+)\))?\s*—\s*(.+)$/);
    if (entryMatch) {
      entries.push({
        promptIndex: parseInt(entryMatch[1], 10),
        filePath: entryMatch[2],
        semanticGroup: entryMatch[3] ?? null,
        description: entryMatch[4],
        isSummary: false,
      });
    }
  }

  return entries;
}

function shortenPath(filePath: string | null): string {
  if (!filePath) return '(no file)';
  const segments = filePath.replace(/\\/g, '/').split('/');
  return segments.length > 2
    ? '.../' + segments.slice(-2).join('/')
    : filePath;
}

function tierLabel(tier: MemoryTierInjection['tier']): string {
  return t(`contextInjection.tierLabel.${tier}`);
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

const injection = computed(() => store.currentInjection);
const memoryInjection = computed(() => store.currentMemoryInjection);

const hasDistill = computed(() => injection.value !== null);
const hasMemory = computed(() => memoryInjection.value !== null);
const hasAnyData = computed(() => hasDistill.value || hasMemory.value);
const showTabs = computed(() => hasDistill.value && hasMemory.value);

let tabInitialized = false;
watch(() => store.isLoading, (loading) => {
  if (loading || tabInitialized) return;
  tabInitialized = true;
  if (hasDistill.value) activeTab.value = 'distill';
  else if (hasMemory.value) activeTab.value = 'memory';
});

const bm25Parsed = computed(() =>
  injection.value?.bm25Context ? parseContextString(injection.value.bm25Context) : null
);

const rerankedParsed = computed(() =>
  injection.value?.rerankedContext ? parseContextString(injection.value.rerankedContext) : null
);

const showDualColumns = computed(() =>
  injection.value?.rerankingEnabled && injection.value?.rerankedContext !== null
);

const planFileName = computed(() => {
  const p = injection.value?.planFilePath;
  if (!p) return null;
  const segments = p.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1] ?? p;
});

const columns = computed<ContextColumn[]>(() => {
  function buildSections(parsed: ParsedContext | null): ContextSection[] {
    if (!parsed) return [];
    const sections: ContextSection[] = [];
    if (parsed.lastActivity.length > 0)
      sections.push({ id: 'la', label: t('contextInjection.lastActivity'), entries: parsed.lastActivity });
    if (parsed.relevantContext.length > 0)
      sections.push({ id: 'rc', label: t('contextInjection.relevantContext'), entries: parsed.relevantContext });
    return sections;
  }

  if (showDualColumns.value) {
    return [
      { id: 'bm25', label: t('contextInjection.bm25Column'), accent: false, sections: buildSections(bm25Parsed.value) },
      { id: 'reranked', label: t('contextInjection.rerankedColumn'), accent: true, sections: buildSections(rerankedParsed.value) },
    ];
  }
  return [
    { id: 'single', label: '', accent: false, sections: buildSections(bm25Parsed.value) },
  ];
});

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
      <template v-if="activeTab === 'distill' && injection">
        <Badge variant="secondary" class="text-[10px]">
          {{ t('contextInjection.entries', { count: injection.entryCount }) }}
        </Badge>
        <Badge variant="secondary" class="text-[10px]">
          {{ t('contextInjection.tokenBudget', { budget: injection.tokenBudget }) }}
        </Badge>
        <Badge
          variant="outline"
          class="text-[10px]"
          :class="injection.rerankingEnabled ? 'border-primary/50 text-primary' : 'border-muted-foreground/50 text-muted-foreground'"
        >
          {{ injection.rerankingEnabled ? t('contextInjection.rerankingEnabled') : t('contextInjection.bm25Only') }}
        </Badge>
        <Badge
          v-if="injection.decompositionFacets && injection.decompositionFacets.length > 0"
          variant="outline"
          class="text-[10px] border-primary/50 text-primary"
        >
          {{ t('contextInjection.decompositionEnabled') }}
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
            :class="activeTab === 'distill'
              ? 'bg-primary/15 text-primary border-primary/30'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'"
            @click="activeTab = 'distill'"
          >
            {{ t('contextInjection.tabDistill') }}
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

        <!-- ═══════ Distill Tab ═══════ -->
        <div v-if="activeTab === 'distill' && injection" class="flex flex-col flex-1 min-h-0">
          <!-- Plan file reference -->
          <div v-if="planFileName" class="mb-3 flex items-center gap-2 rounded-lg bg-primary/10 border border-primary/30 px-3 py-2">
            <span class="text-[11px] font-medium text-primary">{{ t('contextInjection.planFile') }}</span>
            <span class="text-[11px] font-mono text-muted-foreground truncate">{{ planFileName }}</span>
          </div>

          <!-- Decomposition facets -->
          <div
            v-if="injection.decompositionFacets && injection.decompositionFacets.length > 0"
            class="mb-3 flex flex-wrap items-center gap-1.5"
          >
            <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mr-1">
              {{ t('contextInjection.facets') }}
            </span>
            <Badge
              v-for="(facet, i) in injection.decompositionFacets"
              :key="i"
              variant="secondary"
              class="text-[10px] font-normal"
            >
              {{ facet }}
            </Badge>
          </div>

          <!-- Fixed column headers (dual mode only) -->
          <div v-if="showDualColumns" class="grid grid-cols-2 mb-3">
            <div
              v-for="(col, colIdx) in columns"
              :key="`header-${col.id}`"
              class="text-[11px] font-semibold uppercase tracking-wider"
              :class="[
                col.accent ? 'text-primary' : 'text-muted-foreground',
                colIdx === 0 ? 'pr-4' : 'pl-4'
              ]"
            >
              {{ col.label }}
            </div>
          </div>

          <!-- Scrollable columns -->
          <div :class="[showDualColumns ? 'grid grid-cols-2' : '', 'flex-1 min-h-0 overflow-hidden']">
            <div
              v-for="(col, colIdx) in columns"
              :key="col.id"
              class="space-y-4 overflow-y-auto h-full"
              :class="[
                showDualColumns && colIdx === 0 ? 'pr-4 border-r border-border/60' : '',
                showDualColumns && colIdx === 1 ? 'pl-4' : ''
              ]"
            >
              <div
                v-for="section in col.sections"
                :key="`${col.id}-${section.id}`"
                class="space-y-2"
              >
                <div class="flex items-center gap-2">
                  <div class="h-px flex-1 bg-border" />
                  <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">
                    {{ section.label }}
                  </span>
                  <div class="h-px flex-1 bg-border" />
                </div>

                <template v-for="(entry, idx) in section.entries" :key="`${col.id}-${section.id}-${idx}`">
                  <div v-if="entry.isSummary" class="rounded-xl bg-muted p-3 space-y-1">
                    <div class="flex items-center justify-between">
                      <span class="text-[11px] font-medium text-foreground">{{ t('contextInjection.summary') }}</span>
                      <span class="text-[10px] text-muted-foreground tabular-nums">P#{{ entry.promptIndex }}</span>
                    </div>
                    <p class="text-[11px] text-muted-foreground leading-relaxed">{{ entry.description }}</p>
                  </div>

                  <div
                    v-else
                    class="rounded-xl p-3 space-y-1.5 border"
                    :class="col.accent ? 'border-primary/50 bg-primary/10' : 'border-border bg-muted/80'"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-[11px] font-mono text-foreground truncate">
                        {{ shortenPath(entry.filePath) }}
                      </span>
                      <span class="text-[10px] text-muted-foreground tabular-nums shrink-0">
                        P#{{ entry.promptIndex }}
                      </span>
                    </div>
                    <Badge v-if="entry.semanticGroup" variant="secondary" class="text-[9px] px-1.5 py-0 font-normal">
                      {{ entry.semanticGroup }}
                    </Badge>
                    <p class="text-[11px] text-muted-foreground leading-relaxed">{{ entry.description }}</p>
                  </div>
                </template>
              </div>

              <p v-if="col.sections.length === 0" class="text-xs text-muted-foreground/60">
                {{ t('contextInjection.noContext') }}
              </p>
            </div>
          </div>
        </div>

        <!-- Distill tab empty (when only memory has data) -->
        <div v-else-if="activeTab === 'distill' && !injection" class="flex flex-col items-center justify-center flex-1 text-center gap-3 py-12">
          <IconDatabase :size="32" class="text-muted-foreground/40" />
          <p class="text-sm text-muted-foreground">{{ t('contextInjection.noContext') }}</p>
        </div>

        <!-- ═══════ Memory Tab ═══════ -->
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
