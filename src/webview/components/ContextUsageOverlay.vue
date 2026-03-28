<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { IconChartBar, IconChevronRight } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import { useContextUsageStore } from '@/stores/useContextUsageStore';

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

const visibleCategories = computed(() => {
  if (!store.data) return [];
  return store.data.categories.filter(c => c.tokens > 0);
});

const allCategories = computed(() => store.data?.categories ?? []);

const percentage = computed(() => store.data?.percentage ?? 0);

const ringColor = computed(() => {
  if (percentage.value >= 80) return 'text-rose-500';
  if (percentage.value >= 50) return 'text-amber-500';
  return 'text-emerald-500';
});

const ringStrokeDasharray = computed(() => {
  const circumference = 2 * Math.PI * 45;
  const filled = (percentage.value / 100) * circumference;
  return `${filled} ${circumference - filled}`;
});

interface DetailSection {
  key: string;
  label: string;
  badge?: string;
  items: { name: string; detail: string; tokens: number; badge?: string }[];
}

const detailSections = computed((): DetailSection[] => {
  if (!store.data) return [];
  const sections: DetailSection[] = [];
  const d = store.data;

  if (d.mcpTools.length > 0) {
    sections.push({
      key: 'mcpTools',
      label: t('context.details.mcpTools'),
      items: d.mcpTools.map(i => ({
        name: i.name,
        detail: i.serverName,
        tokens: i.tokens,
        ...(i.isLoaded !== undefined ? { badge: i.isLoaded ? t('context.loaded') : t('context.deferred') } : {}),
      })),
    });
  }
  if (d.memoryFiles.length > 0) {
    sections.push({
      key: 'memoryFiles',
      label: t('context.details.memoryFiles'),
      items: d.memoryFiles.map(i => ({ name: i.path, detail: i.type, tokens: i.tokens })),
    });
  }
  if (d.agents.length > 0) {
    sections.push({
      key: 'agents',
      label: t('context.details.customAgents'),
      items: d.agents.map(i => ({ name: i.agentType, detail: i.source, tokens: i.tokens })),
    });
  }
  if (d.systemPromptSections && d.systemPromptSections.length > 0) {
    sections.push({
      key: 'systemPromptSections',
      label: t('context.systemPromptSections'),
      items: d.systemPromptSections.map(i => ({ name: i.name, detail: '', tokens: i.tokens })),
    });
  }
  if (d.systemTools && d.systemTools.length > 0) {
    sections.push({
      key: 'systemTools',
      label: t('context.details.systemTools'),
      items: d.systemTools.map(i => ({ name: i.name, detail: '', tokens: i.tokens })),
    });
  }
  if (d.deferredBuiltinTools && d.deferredBuiltinTools.length > 0) {
    sections.push({
      key: 'deferredTools',
      label: t('context.deferredTools'),
      items: d.deferredBuiltinTools.map(i => ({
        name: i.name,
        detail: '',
        tokens: i.tokens,
        badge: i.isLoaded ? t('context.loaded') : t('context.deferred'),
      })),
    });
  }
  if (d.skills?.skillFrontmatter?.length) {
    sections.push({
      key: 'skills',
      label: t('context.details.skills'),
      badge: t('context.includedOf', { included: d.skills.includedSkills, total: d.skills.totalSkills }),
      items: d.skills.skillFrontmatter.map(i => ({ name: i.name, detail: i.source, tokens: i.tokens })),
    });
  }
  if (d.slashCommands) {
    sections.push({
      key: 'slashCommands',
      label: t('context.details.slashCommands'),
      badge: t('context.includedOf', { included: d.slashCommands.includedCommands, total: d.slashCommands.totalCommands }),
      items: [{ name: t('context.details.slashCommands'), detail: '', tokens: d.slashCommands.tokens }],
    });
  }

  return sections;
});

const messageBreakdownRows = computed(() => {
  if (!store.data?.messageBreakdown) return [];
  const mb = store.data.messageBreakdown;
  const total = mb.userMessageTokens + mb.assistantMessageTokens + mb.toolCallTokens + mb.toolResultTokens + mb.attachmentTokens;
  return [
    { label: t('context.userMessages'), tokens: mb.userMessageTokens, pct: total > 0 ? (mb.userMessageTokens / total) * 100 : 0 },
    { label: t('context.assistantMessages'), tokens: mb.assistantMessageTokens, pct: total > 0 ? (mb.assistantMessageTokens / total) * 100 : 0 },
    { label: t('context.toolCalls'), tokens: mb.toolCallTokens, pct: total > 0 ? (mb.toolCallTokens / total) * 100 : 0 },
    { label: t('context.toolResults'), tokens: mb.toolResultTokens, pct: total > 0 ? (mb.toolResultTokens / total) * 100 : 0 },
    { label: t('context.attachments'), tokens: mb.attachmentTokens, pct: total > 0 ? (mb.attachmentTokens / total) * 100 : 0 },
  ];
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
          :class="percentage >= 80 ? 'bg-rose-500/15 text-rose-400' : percentage >= 50 ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/15 text-emerald-400'"
        >
          {{ percentage }}%
        </Badge>
        <Badge
          v-if="store.data.autoCompactThreshold"
          variant="outline"
          class="tabular-nums shrink-0 text-xs"
        >
          {{ t('context.autoCompactAt', { threshold: store.data.autoCompactThreshold }) }}
          {{ store.data.isAutoCompactEnabled ? '✓' : '✗' }}
        </Badge>
      </template>
    </template>

    <!-- Loading -->
    <div v-if="store.isLoading" class="flex-1 flex items-center justify-center py-16">
      <LoadingSpinner :size="32" />
    </div>

    <!-- Error states -->
    <div v-else-if="!store.data" class="flex-1 flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
      <IconChartBar :size="32" class="opacity-40" />
      <template v-if="store.failReason === 'noQuery'">
        <p class="text-sm font-medium">{{ t('context.noQuery') }}</p>
        <p class="text-xs opacity-70">{{ t('context.noQueryHint') }}</p>
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
            <span class="text-2xl font-bold tabular-nums" :class="ringColor">{{ percentage }}%</span>
          </div>
        </div>
        <span class="text-xs text-muted-foreground tabular-nums">
          {{ formatTokens(store.data.totalTokens) }} / {{ formatTokens(store.data.maxTokens) }}
        </span>
      </div>

      <!-- Stacked Overview Bar -->
      <div v-if="visibleCategories.length > 0" class="flex h-2.5 rounded-full overflow-hidden bg-muted/30">
        <div
          v-for="cat in visibleCategories"
          :key="cat.name"
          class="min-w-[2px] transition-all"
          :style="{ width: `${store.data!.maxTokens > 0 ? (cat.tokens / store.data!.maxTokens) * 100 : 0}%`, backgroundColor: cat.color }"
          :title="`${cat.name}: ${formatTokens(cat.tokens)}`"
        />
      </div>

      <!-- Category Breakdown -->
      <div class="space-y-1.5">
        <div
          v-for="cat in allCategories"
          :key="cat.name"
          class="flex items-center gap-2 text-xs"
        >
          <div class="w-2.5 h-2.5 rounded-sm shrink-0" :style="{ backgroundColor: cat.color }" />
          <span class="text-muted-foreground flex-1 truncate">{{ cat.name }}</span>
          <div class="w-24 h-1.5 rounded-full bg-muted/30 overflow-hidden shrink-0">
            <div
              class="h-full rounded-full transition-all"
              :style="{ width: `${store.data!.maxTokens > 0 ? Math.min((cat.tokens / store.data!.maxTokens) * 100, 100) : 0}%`, backgroundColor: cat.color }"
            />
          </div>
          <span class="tabular-nums text-foreground w-12 text-right shrink-0">{{ formatTokens(cat.tokens) }}</span>
          <span class="tabular-nums text-muted-foreground w-10 text-right shrink-0">
            {{ store.data!.maxTokens > 0 ? ((cat.tokens / store.data!.maxTokens) * 100).toFixed(1) : '0.0' }}%
          </span>
        </div>
      </div>

      <!-- Message Breakdown -->
      <div v-if="store.data.messageBreakdown" class="space-y-1 pt-2 border-t border-border/30">
        <Collapsible :open="openSections.has('messageBreakdown')" @update:open="toggleSection('messageBreakdown')">
          <CollapsibleTrigger as-child>
            <button class="flex items-center gap-2 w-full py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
              <IconChevronRight :size="14" class="shrink-0 transition-transform" :class="{ 'rotate-90': openSections.has('messageBreakdown') }" />
              <span class="font-medium">{{ t('context.messageBreakdown') }}</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="ml-5 space-y-1.5 pb-2">
              <div v-for="row in messageBreakdownRows" :key="row.label" class="flex items-center gap-2 text-xs">
                <span class="text-muted-foreground flex-1 truncate">{{ row.label }}</span>
                <div class="w-20 h-1.5 rounded-full bg-muted/30 overflow-hidden shrink-0">
                  <div class="h-full rounded-full bg-sky-500 transition-all" :style="{ width: `${row.pct}%` }" />
                </div>
                <span class="tabular-nums text-foreground w-12 text-right shrink-0">{{ formatTokens(row.tokens) }}</span>
              </div>
              <!-- Tool calls by type -->
              <template v-if="store.data.messageBreakdown!.toolCallsByType.length > 0">
                <Collapsible :open="openSections.has('toolCallsByType')" @update:open="toggleSection('toolCallsByType')">
                  <CollapsibleTrigger as-child>
                    <button class="flex items-center gap-2 w-full py-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                      <IconChevronRight :size="12" class="shrink-0 transition-transform" :class="{ 'rotate-90': openSections.has('toolCallsByType') }" />
                      <span>{{ t('context.toolCallsByType') }}</span>
                      <Badge variant="secondary" class="text-xs px-1.5 py-0">{{ store.data.messageBreakdown!.toolCallsByType.length }}</Badge>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div class="ml-4 space-y-0.5 pb-1">
                      <div v-for="tc in store.data.messageBreakdown!.toolCallsByType" :key="tc.name" class="flex items-center gap-2 text-xs py-0.5">
                        <span class="text-foreground truncate flex-1">{{ tc.name }}</span>
                        <span class="tabular-nums text-muted-foreground shrink-0">↑{{ formatTokens(tc.callTokens) }}</span>
                        <span class="tabular-nums text-muted-foreground shrink-0">↓{{ formatTokens(tc.resultTokens) }}</span>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </template>
              <!-- Attachments by type -->
              <template v-if="store.data.messageBreakdown!.attachmentsByType.length > 0">
                <Collapsible :open="openSections.has('attachmentsByType')" @update:open="toggleSection('attachmentsByType')">
                  <CollapsibleTrigger as-child>
                    <button class="flex items-center gap-2 w-full py-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                      <IconChevronRight :size="12" class="shrink-0 transition-transform" :class="{ 'rotate-90': openSections.has('attachmentsByType') }" />
                      <span>{{ t('context.attachmentsByType') }}</span>
                      <Badge variant="secondary" class="text-xs px-1.5 py-0">{{ store.data.messageBreakdown!.attachmentsByType.length }}</Badge>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div class="ml-4 space-y-0.5 pb-1">
                      <div v-for="at in store.data.messageBreakdown!.attachmentsByType" :key="at.name" class="flex items-center gap-2 text-xs py-0.5">
                        <span class="text-foreground truncate flex-1">{{ at.name }}</span>
                        <span class="tabular-nums text-muted-foreground w-12 text-right shrink-0">{{ formatTokens(at.tokens) }}</span>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </template>
            </div>
          </CollapsibleContent>
        </Collapsible>
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
                {{ section.badge ?? section.items.length }}
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
                <Badge
                  v-if="item.badge"
                  variant="outline"
                  class="text-xs px-1 py-0 shrink-0"
                >
                  {{ item.badge }}
                </Badge>
                <span v-if="item.detail" class="text-muted-foreground text-xs shrink-0">{{ item.detail }}</span>
                <span class="tabular-nums text-muted-foreground w-12 text-right shrink-0">{{ formatTokens(item.tokens) }}</span>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      <!-- API Usage Footer -->
      <div v-if="store.data.apiUsage" class="pt-2 border-t border-border/30">
        <p class="text-xs font-medium text-muted-foreground mb-1">{{ t('context.apiUsage') }}</p>
        <div class="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
          <span>↓ {{ formatTokens(store.data.apiUsage.input_tokens) }}</span>
          <span>↑ {{ formatTokens(store.data.apiUsage.output_tokens) }}</span>
          <span>cache↑ {{ formatTokens(store.data.apiUsage.cache_creation_input_tokens) }}</span>
          <span>cache↓ {{ formatTokens(store.data.apiUsage.cache_read_input_tokens) }}</span>
        </div>
      </div>
    </div>
  </OverlayShell>
</template>
