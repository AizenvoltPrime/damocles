<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { IconDatabase } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';

const { t } = useI18n();
const store = useContextInjectionStore();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

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

const injection = computed(() => store.currentInjection);

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
      <template v-if="injection">
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
      </template>
    </template>

    <div class="p-4">
      <!-- Loading state -->
      <div v-if="store.isLoading" class="flex items-center justify-center py-12">
        <LoadingSpinner :size="24" />
      </div>

      <!-- Empty state -->
      <div v-else-if="!injection" class="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
        <IconDatabase :size="32" class="text-muted-foreground/40" />
        <div>
          <p class="text-sm text-muted-foreground">{{ t('contextInjection.noContext') }}</p>
          <p class="text-xs text-muted-foreground/60 mt-1">{{ t('contextInjection.noContextHint') }}</p>
        </div>
      </div>

      <!-- Content -->
      <div v-else>
        <!-- Plan file reference -->
        <div v-if="planFileName" class="mb-3 flex items-center gap-2 rounded-lg bg-primary/10 border border-primary/30 px-3 py-2">
          <span class="text-[11px] font-medium text-primary">{{ t('contextInjection.planFile') }}</span>
          <span class="text-[11px] font-mono text-muted-foreground truncate">{{ planFileName }}</span>
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
        <div :class="showDualColumns ? 'grid grid-cols-2' : ''">
        <div
          v-for="(col, colIdx) in columns"
          :key="col.id"
          class="space-y-4 overflow-y-auto max-h-[calc(100vh-12rem)]"
          :class="[
            showDualColumns && colIdx === 0 ? 'pr-4 border-r border-border/60' : '',
            showDualColumns && colIdx === 1 ? 'pl-4' : ''
          ]"
        >
          <!-- Sections -->
          <div
            v-for="section in col.sections"
            :key="`${col.id}-${section.id}`"
            class="space-y-2"
          >
            <!-- Section divider header -->
            <div class="flex items-center gap-2">
              <div class="h-px flex-1 bg-border" />
              <span class="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">
                {{ section.label }}
              </span>
              <div class="h-px flex-1 bg-border" />
            </div>

            <!-- Entry cards -->
            <template v-for="(entry, idx) in section.entries" :key="`${col.id}-${section.id}-${idx}`">
              <!-- Summary entry -->
              <div v-if="entry.isSummary" class="rounded-xl bg-muted p-3 space-y-1">
                <div class="flex items-center justify-between">
                  <span class="text-[11px] font-medium text-foreground">{{ t('contextInjection.summary') }}</span>
                  <span class="text-[10px] text-muted-foreground tabular-nums">P#{{ entry.promptIndex }}</span>
                </div>
                <p class="text-[11px] text-muted-foreground leading-relaxed">{{ entry.description }}</p>
              </div>

              <!-- File entry -->
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

          <!-- Empty column -->
          <p v-if="col.sections.length === 0" class="text-xs text-muted-foreground/60">
            {{ t('contextInjection.noContext') }}
          </p>
        </div>
        </div>
      </div>
    </div>
  </OverlayShell>
</template>
