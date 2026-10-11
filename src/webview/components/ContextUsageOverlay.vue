<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { IconChartBar, IconChevronRight } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import OverlayShell from './OverlayShell.vue';
import { useContextUsageStore } from '@/stores/useContextUsageStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';

const { t, te, locale } = useI18n();
const store = useContextUsageStore();
const { postMessage } = usePlatformBridge();

// Section rows arrive in upstream discovery order (filesystem walk, MCP registration, Map insertion),
// which is neither stable nor meaningful to a reader scanning for a name. Sort by display label with a
// locale collator rather than the default comparator: default sort is UTF-16 code-unit order, which
// puts every uppercase name ahead of every lowercase one and misorders Greek entirely.
// `variant` (not `base`) because names differing only in case must still get a deterministic order —
// under `base` they compare equal and fall back to the very discovery order this sort exists to remove.
const collator = computed(() => new Intl.Collator(locale.value, { numeric: true, sensitivity: 'variant' }));

function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => collator.value.compare(a.name, b.name));
}

function openFile(filePath?: string): void {
  if (filePath) postMessage({ type: 'openFile', filePath });
}

/** Falls back to the raw key so a section added upstream still names itself rather than rendering blank. */
function promptSectionLabel(name: string): string {
  const key = `context.promptSection.${name}`;
  return te(key) ? t(key) : name;
}

defineEmits<{
  (e: 'close'): void;
}>();

function formatTokens(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

// The stacked bar is a picture of CONSUMED context, so its segments must sum to the headline total.
// A deferred category counts tokens that are NOT in the request — drawing it here would read as spend.
const visibleCategories = computed(() => {
  if (!store.data) return [];
  return store.data.categories.filter(c => c.tokens > 0 && !c.isDeferred);
});

const allCategories = computed(() => store.data?.categories ?? []);

const percentage = computed(() => store.data?.percentage ?? 0);

// `chip` is the tone's `.d-tone-*` class (style.css), for the percentage on its tint.
const usageColor = computed(() => {
  if (percentage.value >= 80) return { ring: 'text-(--d-danger)', chip: 'd-tone-danger' };
  if (percentage.value >= 50) return { ring: 'text-(--d-warning)', chip: 'd-tone-warning' };
  return { ring: 'text-(--d-success)', chip: 'd-tone-success' };
});

const ringStrokeDasharray = computed(() => {
  const circumference = 2 * Math.PI * 54;
  const filled = (percentage.value / 100) * circumference;
  return `${filled} ${circumference - filled}`;
});

interface DetailSection {
  key: string;
  label: string;
  badge?: string;
  items: { name: string; detail: string; tokens: number; badge?: string; filePath?: string; title?: string; onOpen?: () => void }[];
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
        onOpen: () => postMessage({ type: 'openMcpToolInfo', piName: i.name }),
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
      items: d.agents.map(i => ({ name: i.agentType, detail: i.source, tokens: i.tokens, ...(i.filePath ? { filePath: i.filePath } : {}) })),
    });
  }
  if (d.systemPromptSections && d.systemPromptSections.length > 0) {
    sections.push({
      key: 'systemPromptSections',
      label: t('context.systemPromptSections'),
      items: d.systemPromptSections.map(i => ({ name: promptSectionLabel(i.name), detail: '', tokens: i.tokens, title: i.name, onOpen: () => postMessage({ type: 'openSystemPrompt' }) })),
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
      items: d.skills.skillFrontmatter.map(i => ({ name: i.name, detail: i.source, tokens: i.tokens, ...(i.filePath ? { filePath: i.filePath } : {}) })),
    });
  }
  if (d.slashCommands) {
    sections.push({
      key: 'slashCommands',
      label: t('context.details.slashCommands'),
      badge: t('context.includedOf', { included: d.slashCommands.includedCommands, total: d.slashCommands.totalCommands }),
      items: d.slashCommands.commands?.length
        ? d.slashCommands.commands.map(i => ({ name: i.name, detail: i.source, tokens: i.tokens, filePath: i.filePath }))
        : [{ name: t('context.details.slashCommands'), detail: '', tokens: d.slashCommands.tokens }],
    });
  }

  // Sorted once here, not at each push above, so a section added later is ordered by construction.
  return sections.map(section => ({ ...section, items: sortByName(section.items) }));
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

// Both arrive in Map-insertion order (first use during the branch walk), so they shift as a session
// grows; the fixed rows above them are a deliberate semantic order and stay as authored.
const toolCallsByType = computed(() => sortByName(store.data?.messageBreakdown?.toolCallsByType ?? []));
const attachmentsByType = computed(() => sortByName(store.data?.messageBreakdown?.attachmentsByType ?? []));

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
    icon-class="text-(--d-info)"
    @close="$emit('close')"
  >
    <template #header-actions>
      <template v-if="store.data">
        <span
          class="flex-none rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_13%,transparent)] px-2 font-mono text-11/5 tabular-nums"
          :class="usageColor.chip"
        >{{ percentage }}%</span>
        <span
          v-if="store.data.autoCompactThreshold"
          class="hidden flex-none rounded-full border border-(--d-border2) px-2 font-mono text-11/5 text-(--d-muted) tabular-nums @min-[35rem]/app:inline"
        >
          {{ t('context.autoCompactAt', { threshold: store.data.autoCompactThreshold }) }}
          {{ store.data.isAutoCompactEnabled ? '✓' : '✗' }}
        </span>
      </template>
    </template>

    <!-- Loading -->
    <div
      v-if="store.isLoading"
      class="flex-1 flex items-center justify-center py-16"
    >
      <LoadingSpinner class="size-8" />
    </div>

    <!-- Error states -->
    <div
      v-else-if="!store.data"
      class="flex-1 flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground"
    >
      <IconChartBar class="size-8 opacity-40" />
      <template v-if="store.failReason === 'noQuery'">
        <p class="text-sm font-medium">
          {{ t('context.noQuery') }}
        </p>
        <p class="text-xs opacity-70">
          {{ t('context.noQueryHint') }}
        </p>
      </template>
      <template v-else>
        <p class="text-sm font-medium">
          {{ t('context.sessionBusy') }}
        </p>
        <p class="text-xs opacity-70">
          {{ t('context.sessionBusyHint') }}
        </p>
      </template>
    </div>

    <!-- Populated -->
    <div
      v-else
      class="space-y-4 px-4.5 pt-4 pb-5"
    >
      <div class="flex flex-wrap items-center gap-5.5">
        <div
          class="relative mx-auto size-32 flex-none"
          data-testid="context-ring"
        >
          <svg
            viewBox="0 0 128 128"
            class="size-full -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="64"
              cy="64"
              r="54"
              fill="none"
              stroke="var(--d-hover)"
              stroke-width="11"
            />
            <circle
              v-if="percentage > 0"
              cx="64"
              cy="64"
              r="54"
              fill="none"
              stroke="currentColor"
              stroke-width="11"
              stroke-linecap="round"
              :stroke-dasharray="ringStrokeDasharray"
              :class="usageColor.ring"
            />
          </svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-px">
            <span
              class="font-mono text-2xl font-bold tabular-nums"
              :class="usageColor.ring"
            >{{ percentage }}%</span>
            <span class="font-mono text-11 text-(--d-faint) tabular-nums">{{ formatTokens(store.data.totalTokens) }} / {{ formatTokens(store.data.maxTokens) }}</span>
          </div>
        </div>

        <div class="flex min-w-0 flex-[1_1_18.75rem] flex-col gap-1.75">
          <div
            v-if="visibleCategories.length > 0"
            class="flex h-2.5 overflow-hidden rounded-full bg-(--d-hover)"
            data-testid="context-bar"
          >
            <div
              v-for="cat in visibleCategories"
              :key="cat.name"
              class="d-bar min-w-0.5"
              :style="{ width: `${store.data!.maxTokens > 0 ? (cat.tokens / store.data!.maxTokens) * 100 : 0}%`, backgroundColor: cat.color }"
              :title="`${cat.name}: ${formatTokens(cat.tokens)}`"
            />
          </div>
          <div class="flex justify-between font-mono text-10.5 text-(--d-faint)">
            <span>0</span>
            <span v-if="store.data.autoCompactThreshold">{{ t('context.autoCompactAt', { threshold: store.data.autoCompactThreshold }) }}</span>
            <span>{{ formatTokens(store.data.maxTokens) }}</span>
          </div>

          <div class="mt-0.5 flex flex-col gap-1.25">
            <div
              v-for="cat in allCategories"
              :key="cat.name"
              class="flex items-center gap-2.25 text-xs"
              :class="cat.isDeferred ? 'opacity-60' : ''"
              data-testid="context-legend-row"
            >
              <span
                class="size-2.25 flex-none rounded-[0.1875rem]"
                :style="{ backgroundColor: cat.color }"
                aria-hidden="true"
              />
              <span
                class="min-w-0 flex-1 truncate text-(--d-muted)"
                data-testid="context-legend-name"
              >{{ cat.name }}</span>
              <span
                v-if="cat.isDeferred"
                class="flex-none rounded-full border border-(--d-border2) px-1.5 text-10.5/4 text-(--d-muted)"
              >{{ t('context.deferred') }}</span>
              <span class="w-12 flex-none text-right font-mono tabular-nums">{{ formatTokens(cat.tokens) }}</span>
              <span class="w-11 flex-none text-right font-mono text-(--d-faint) tabular-nums">
                {{ store.data!.maxTokens > 0 ? ((cat.tokens / store.data!.maxTokens) * 100).toFixed(1) : '0.0' }}%
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Message Breakdown -->
      <div
        v-if="store.data.messageBreakdown"
        class="space-y-1 pt-2 border-t border-border/30"
      >
        <Collapsible
          :open="openSections.has('messageBreakdown')"
          @update:open="toggleSection('messageBreakdown')"
        >
          <CollapsibleTrigger as-child>
            <button class="flex items-center gap-2 w-full py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
              <IconChevronRight
                class="size-3.5 shrink-0 transition-transform"
                :class="{ 'rotate-90': openSections.has('messageBreakdown') }"
              />
              <span class="font-medium">{{ t('context.messageBreakdown') }}</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="ml-5 space-y-1.5 pb-2">
              <div
                v-for="row in messageBreakdownRows"
                :key="row.label"
                class="flex items-center gap-2 text-xs"
                data-context-row
              >
                <span class="text-muted-foreground flex-1 truncate">{{ row.label }}</span>
                <div class="w-20 h-1.5 rounded-full bg-muted/30 overflow-hidden shrink-0">
                  <div
                    class="d-bar h-full rounded-full bg-(--d-info)"
                    :style="{ width: `${row.pct}%` }"
                  />
                </div>
                <span class="tabular-nums text-foreground w-12 text-right shrink-0">{{ formatTokens(row.tokens) }}</span>
              </div>
              <!-- Tool calls by type -->
              <template v-if="toolCallsByType.length > 0">
                <Collapsible
                  :open="openSections.has('toolCallsByType')"
                  @update:open="toggleSection('toolCallsByType')"
                >
                  <CollapsibleTrigger as-child>
                    <button class="flex items-center gap-2 w-full py-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                      <IconChevronRight
                        class="size-3 shrink-0 transition-transform"
                        :class="{ 'rotate-90': openSections.has('toolCallsByType') }"
                      />
                      <span>{{ t('context.toolCallsByType') }}</span>
                      <Badge
                        variant="secondary"
                        class="text-xs px-1.5 py-0"
                      >
                        {{ toolCallsByType.length }}
                      </Badge>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div class="ml-4 space-y-0.5 pb-1">
                      <div
                        v-for="tc in toolCallsByType"
                        :key="tc.name"
                        class="flex items-center gap-2 text-xs py-0.5"
                        data-context-row
                      >
                        <span class="text-foreground truncate flex-1">{{ tc.name }}</span>
                        <span class="tabular-nums text-muted-foreground shrink-0">↑{{ formatTokens(tc.callTokens) }}</span>
                        <span class="tabular-nums text-muted-foreground shrink-0">↓{{ formatTokens(tc.resultTokens) }}</span>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </template>
              <!-- Attachments by type -->
              <template v-if="attachmentsByType.length > 0">
                <Collapsible
                  :open="openSections.has('attachmentsByType')"
                  @update:open="toggleSection('attachmentsByType')"
                >
                  <CollapsibleTrigger as-child>
                    <button class="flex items-center gap-2 w-full py-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                      <IconChevronRight
                        class="size-3 shrink-0 transition-transform"
                        :class="{ 'rotate-90': openSections.has('attachmentsByType') }"
                      />
                      <span>{{ t('context.attachmentsByType') }}</span>
                      <Badge
                        variant="secondary"
                        class="text-xs px-1.5 py-0"
                      >
                        {{ attachmentsByType.length }}
                      </Badge>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div class="ml-4 space-y-0.5 pb-1">
                      <div
                        v-for="at in attachmentsByType"
                        :key="at.name"
                        class="flex items-center gap-2 text-xs py-0.5"
                        data-context-row
                      >
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
      <div
        v-if="detailSections.length > 0"
        class="divide-y divide-(--d-border) overflow-hidden rounded-xl border border-(--d-border) bg-(--d-card)"
      >
        <Collapsible
          v-for="section in detailSections"
          :key="section.key"
          :open="openSections.has(section.key)"
          @update:open="toggleSection(section.key)"
        >
          <CollapsibleTrigger as-child>
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2.5 text-13 font-semibold transition-colors hover:bg-(--d-hover)"
            >
              <IconChevronRight
                class="size-3.5 shrink-0 text-(--d-faint) transition-transform duration-200"
                :class="{ 'rotate-90': openSections.has(section.key) }"
              />
              <span>{{ section.label }}</span>
              <span class="rounded-full bg-(--d-hover) px-1.5 font-mono text-10.5/4 font-normal text-(--d-muted)">
                {{ section.badge ?? section.items.length }}
              </span>
              <span class="ml-auto font-mono text-xs font-normal text-(--d-muted) tabular-nums">{{ formatTokens(section.items.reduce((sum, item) => sum + item.tokens, 0)) }}</span>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="space-y-0.5 pr-3 pb-2.5 pl-9">
              <component
                :is="(item.onOpen || item.filePath) ? 'button' : 'div'"
                v-for="(item, idx) in section.items"
                :key="idx"
                :type="(item.onOpen || item.filePath) ? 'button' : undefined"
                class="flex w-full items-center gap-2 rounded py-0.5 text-left text-xs"
                :class="(item.onOpen || item.filePath) ? 'hover:text-(--d-accent) focus-visible:outline-2 focus-visible:outline-(--d-accent)' : ''"
                :title="item.title ?? item.filePath ?? item.name"
                :data-testid="(item.onOpen || item.filePath) ? 'context-row-open' : undefined"
                data-context-row
                @click="item.onOpen ? item.onOpen() : openFile(item.filePath)"
              >
                <span class="flex-1 truncate">{{ item.name }}</span>
                <Badge
                  v-if="item.badge"
                  variant="outline"
                  class="text-xs px-1 py-0 shrink-0"
                >
                  {{ item.badge }}
                </Badge>
                <span
                  v-if="item.detail"
                  class="shrink-0 text-xs text-(--d-muted)"
                >{{ item.detail }}</span>
                <span class="w-12 shrink-0 text-right text-(--d-muted) tabular-nums">{{ formatTokens(item.tokens) }}</span>
              </component>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      <!-- API Usage Footer -->
      <div
        v-if="store.data.apiUsage"
        class="pt-2 border-t border-border/30"
      >
        <p class="text-xs font-medium text-muted-foreground mb-1">
          {{ t('context.apiUsage') }}
        </p>
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
