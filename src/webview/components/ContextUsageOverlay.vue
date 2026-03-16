<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { IconChartBar, IconChevronRight } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import { useContextUsageStore } from '@/stores/useContextUsageStore';
import type { ContextUsageData } from '@shared/types/session';

const { t } = useI18n();
const store = useContextUsageStore();

defineEmits<{
  (e: 'close'): void;
}>();

function formatTokens(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

interface CategoryEntry {
  key: string;
  label: string;
  tokens: number;
  percentage: number;
  color: string;
}

const categoryMeta: Record<string, { label: string; color: string }> = {
  systemPrompt: { label: 'breakdown.systemPrompt', color: 'bg-blue-500' },
  systemTools: { label: 'breakdown.systemTools', color: 'bg-indigo-500' },
  mcpTools: { label: 'breakdown.mcpTools', color: 'bg-violet-500' },
  customAgents: { label: 'breakdown.customAgents', color: 'bg-purple-500' },
  memoryFiles: { label: 'breakdown.memoryFiles', color: 'bg-emerald-500' },
  skills: { label: 'breakdown.skills', color: 'bg-teal-500' },
  messages: { label: 'breakdown.messages', color: 'bg-sky-500' },
  compactBuffer: { label: 'breakdown.compactBuffer', color: 'bg-amber-500' },
  freeSpace: { label: 'breakdown.freeSpace', color: 'bg-muted-foreground/20' },
};

const categories = computed((): CategoryEntry[] => {
  if (!store.data) return [];
  const d = store.data;
  const keys = Object.keys(categoryMeta) as (keyof ContextUsageData['breakdown'])[];
  return keys.map(key => ({
    key,
    label: t(`context.${categoryMeta[key]!.label}`),
    tokens: d.breakdown[key],
    percentage: d.maxTokens > 0 ? (d.breakdown[key] / d.maxTokens) * 100 : 0,
    color: categoryMeta[key]!.color,
  }));
});

const usedCategories = computed(() => categories.value.filter(c => c.tokens > 0 && c.key !== 'freeSpace'));

const ringColor = computed(() => {
  if (!store.data) return 'text-emerald-500';
  const pct = store.data.usagePercentage;
  if (pct >= 80) return 'text-rose-500';
  if (pct >= 50) return 'text-amber-500';
  return 'text-emerald-500';
});

const ringStrokeDasharray = computed(() => {
  if (!store.data) return '0 283';
  const circumference = 2 * Math.PI * 45;
  const filled = (store.data.usagePercentage / 100) * circumference;
  return `${filled} ${circumference - filled}`;
});

const detailSections = computed(() => {
  if (!store.data) return [];
  const sections: { key: string; label: string; items: { name: string; detail: string; tokens: number }[] }[] = [];
  const d = store.data.details;

  if (d.mcpTools.length > 0) {
    sections.push({
      key: 'mcpTools',
      label: t('context.details.mcpTools'),
      items: d.mcpTools.map(i => ({ name: i.name, detail: i.server, tokens: i.tokens })),
    });
  }
  if (d.memoryFiles.length > 0) {
    sections.push({
      key: 'memoryFiles',
      label: t('context.details.memoryFiles'),
      items: d.memoryFiles.map(i => ({ name: i.path, detail: i.type, tokens: i.tokens })),
    });
  }
  if (d.skills.length > 0) {
    sections.push({
      key: 'skills',
      label: t('context.details.skills'),
      items: d.skills.map(i => ({ name: i.name, detail: i.source, tokens: i.tokens })),
    });
  }
  if (d.customAgents.length > 0) {
    sections.push({
      key: 'customAgents',
      label: t('context.details.customAgents'),
      items: d.customAgents.map(i => ({ name: i.type, detail: i.source, tokens: i.tokens })),
    });
  }

  return sections;
});

const openSections = ref<Set<string>>(new Set());

function toggleSection(key: string): void {
  if (openSections.value.has(key)) {
    openSections.value.delete(key);
  } else {
    openSections.value.add(key);
  }
}
</script>

<template>
  <OverlayShell
    :title="t('context.title')"
    :subtitle="store.data?.model"
    :icon="IconChartBar"
    icon-class="text-sky-400"
    @close="$emit('close')"
  >
    <template #header-actions>
      <template v-if="store.data">
        <Badge variant="secondary" class="gap-1 tabular-nums shrink-0">
          {{ formatTokens(store.data.totalTokens) }} / {{ formatTokens(store.data.maxTokens) }}
        </Badge>
        <Badge
          variant="secondary"
          class="tabular-nums shrink-0"
          :class="store.data.usagePercentage >= 80 ? 'bg-rose-500/15 text-rose-400' : store.data.usagePercentage >= 50 ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/15 text-emerald-400'"
        >
          {{ store.data.usagePercentage }}%
        </Badge>
      </template>
    </template>

    <!-- Loading -->
    <div v-if="store.isLoading" class="flex-1 flex items-center justify-center py-16">
      <LoadingSpinner :size="32" />
    </div>

    <!-- Session busy or parse failure -->
    <div v-else-if="!store.data" class="flex-1 flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
      <IconChartBar :size="32" class="opacity-40" />
      <template v-if="store.failReason === 'parseFailed'">
        <p class="text-sm font-medium">{{ t('context.parseFailed') }}</p>
        <p class="text-xs opacity-70">{{ t('context.parseFailedHint') }}</p>
      </template>
      <template v-else>
        <p class="text-sm font-medium">{{ t('context.sessionBusy') }}</p>
        <p class="text-xs opacity-70">{{ t('context.sessionBusyHint') }}</p>
      </template>
    </div>

    <!-- Populated -->
    <div v-else class="p-4 space-y-5">
      <!-- Ring Chart -->
      <div class="flex flex-col items-center gap-1">
        <div class="relative w-32 h-32">
          <svg viewBox="0 0 100 100" class="w-full h-full -rotate-90">
            <circle
              cx="50" cy="50" r="45"
              fill="none"
              stroke="currentColor"
              stroke-width="8"
              class="text-muted/40"
            />
            <circle
              cx="50" cy="50" r="45"
              fill="none"
              stroke="currentColor"
              stroke-width="8"
              stroke-linecap="round"
              :stroke-dasharray="ringStrokeDasharray"
              :class="ringColor"
            />
          </svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center">
            <span class="text-2xl font-bold tabular-nums" :class="ringColor">{{ store.data.usagePercentage }}%</span>
          </div>
        </div>
        <span class="text-xs text-muted-foreground tabular-nums">
          {{ formatTokens(store.data.totalTokens) }} / {{ formatTokens(store.data.maxTokens) }}
        </span>
      </div>

      <!-- Stacked Overview Bar -->
      <div v-if="usedCategories.length > 0" class="flex h-2.5 rounded-full overflow-hidden bg-muted/30">
        <div
          v-for="cat in usedCategories"
          :key="cat.key"
          :class="cat.color"
          class="min-w-[2px] transition-all"
          :style="{ width: `${cat.percentage}%` }"
          :title="`${cat.label}: ${formatTokens(cat.tokens)}`"
        />
      </div>

      <!-- Category Breakdown -->
      <div class="space-y-1.5">
        <div
          v-for="cat in categories"
          :key="cat.key"
          class="flex items-center gap-2 text-xs"
        >
          <div class="w-2.5 h-2.5 rounded-sm shrink-0" :class="cat.color" />
          <span class="text-muted-foreground flex-1 truncate">{{ cat.label }}</span>
          <div class="w-24 h-1.5 rounded-full bg-muted/30 overflow-hidden shrink-0">
            <div
              :class="cat.color"
              class="h-full rounded-full transition-all"
              :style="{ width: `${Math.min(cat.percentage, 100)}%` }"
            />
          </div>
          <span class="tabular-nums text-foreground w-12 text-right shrink-0">{{ formatTokens(cat.tokens) }}</span>
          <span class="tabular-nums text-muted-foreground w-10 text-right shrink-0">{{ cat.percentage.toFixed(1) }}%</span>
        </div>
      </div>

      <!-- Detail Sections -->
      <div v-if="detailSections.length > 0" class="space-y-1 pt-2 border-t border-border/30">
        <Collapsible
          v-for="section in detailSections"
          :key="section.key"
          :open="openSections.has(section.key)"
          @update:open="toggleSection(section.key)"
        >
          <CollapsibleTrigger as-child>
            <button
              class="flex items-center gap-2 w-full py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <IconChevronRight
                :size="14"
                class="shrink-0 transition-transform"
                :class="{ 'rotate-90': openSections.has(section.key) }"
              />
              <span class="font-medium">{{ section.label }}</span>
              <Badge variant="secondary" class="text-xs px-1.5 py-0">
                {{ section.items.length }}
              </Badge>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="ml-5 space-y-0.5 pb-1">
              <div
                v-for="(item, idx) in section.items"
                :key="idx"
                class="flex items-center gap-2 text-xs py-0.5"
              >
                <span class="text-foreground truncate flex-1" :title="item.name">{{ item.name }}</span>
                <span class="text-muted-foreground text-xs shrink-0">{{ item.detail }}</span>
                <span class="tabular-nums text-muted-foreground w-12 text-right shrink-0">{{ formatTokens(item.tokens) }}</span>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  </OverlayShell>
</template>
