<script setup lang="ts">
import { ref, computed, useId, type Component } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { AppWindow, Bot, Brain, ChevronRight, Compass, Globe, ImagePlus, Search, ShieldAlert, Users, Wrench } from 'lucide-vue-next';
import { enabledToolCount, type ToolsSnapshot, type ToolGroup, type ToolStatusInfo, type ToolGroupStatus } from '@shared/types/tools';
import OverlayShell from './OverlayShell.vue';
import ToggleSwitch from './ToggleSwitch.vue';
import LoadingSpinner from './LoadingSpinner.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';

const { t } = useI18n();

const { projectTrusted } = storeToRefs(useSettingsStore());

const props = defineProps<{
  snapshot: ToolsSnapshot;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'toggle', toolName: string, enabled: boolean): void;
  (e: 'toggleGroup', group: ToolGroup, enabled: boolean): void;
  (e: 'trustProject'): void;
}>();

const GROUP_ORDER: ToolGroup[] = ['memory', 'compass', 'browser', 'web', 'image', 'subagents', 'team', 'core'];

const GROUP_ICONS: Record<ToolGroup, Component> = {
  memory: Brain,
  compass: Compass,
  browser: AppWindow,
  web: Globe,
  image: ImagePlus,
  subagents: Bot,
  team: Users,
  core: Wrench,
};

/** Groups with no master switch — gated per-tool only (core is locked on; subagents toggle individually). */
const NO_MASTER_GROUPS: ReadonlySet<ToolGroup> = new Set<ToolGroup>(['core', 'subagents']);

// Core starts open, as the reference shows it, and Subagents while its untrusted-project notice applies; the others open on demand.
const expanded = ref<Partial<Record<ToolGroup, boolean>>>({ core: true });
const query = ref('');
const ids = useId();

function groupExpanded(group: ToolGroup): boolean {
  return expanded.value[group] ?? (group === 'subagents' && !projectTrusted.value);
}

function toggleExpanded(group: ToolGroup): void {
  expanded.value = { ...expanded.value, [group]: !groupExpanded(group) };
}

interface GroupView {
  group: ToolGroup;
  status: ToolGroupStatus | undefined;
  tools: ToolStatusInfo[];
  /** The group's tools that match the filter. */
  shown: ToolStatusInfo[];
}

const groups = computed<GroupView[]>(() => {
  const needle = query.value.trim().toLowerCase();
  const matches = (tool: ToolStatusInfo): boolean =>
    !needle || tool.name.toLowerCase().includes(needle) || tool.label.toLowerCase().includes(needle) || (tool.description ?? '').toLowerCase().includes(needle);
  return GROUP_ORDER.map((group) => {
    const tools = props.snapshot.tools.filter((tool) => tool.group === group);
    return { group, status: props.snapshot.groups.find((g) => g.group === group), tools, shown: tools.filter(matches) };
  }).filter((view) => view.shown.length > 0);
});

/** While filtering, every matching group opens so its matches show. */
function isOpen(view: GroupView): boolean {
  return query.value.trim() !== '' || groupExpanded(view.group);
}

/** Core tools are always present, so an empty list means the first toolStatus has not arrived. */
const loading = computed(() => props.snapshot.tools.length === 0);

const statusBadge = computed(() => loading.value ? undefined : {
  label: t('overlays.tools.enabledCount', { n: enabledToolCount(props.snapshot), total: props.snapshot.tools.length }),
  class: 'd-tone-muted',
});

function groupOff(view: GroupView): boolean {
  return view.status !== undefined && !NO_MASTER_GROUPS.has(view.group) && !view.status.enabled;
}

function unavailable(view: GroupView): boolean {
  return Boolean(view.status && !view.status.available && view.status.unavailableReason);
}

function groupStatus(view: GroupView): { label: string; class: string } {
  if (unavailable(view) && view.status?.unavailableReason) {
    return { label: t(`tools.unavailable.${view.status.unavailableReason}`), class: 'text-(--d-warning)' };
  }
  if (groupOff(view)) return { label: t('overlays.tools.disabled'), class: 'text-(--d-faint)' };
  return { label: t('overlays.tools.enabled'), class: 'text-(--d-success)' };
}

function toolLocked(view: GroupView, tool: ToolStatusInfo): boolean {
  return !tool.toggleable || groupOff(view);
}

function setAll(view: GroupView, enabled: boolean): void {
  for (const tool of view.tools) {
    if (!toolLocked(view, tool) && tool.enabled !== enabled) emit('toggle', tool.name, enabled);
  }
}

function canSetAll(view: GroupView, enabled: boolean): boolean {
  return view.tools.some((tool) => !toolLocked(view, tool) && tool.enabled !== enabled);
}
</script>

<template>
  <OverlayShell
    :title="t('tools.title')"
    :subtitle="t('tools.description')"
    :icon="Wrench"
    :status-badge="statusBadge"
    data-testid="tools-panel"
    @close="emit('close')"
  >
    <div class="flex flex-col gap-2.5 px-4 pt-3 pb-4.5 text-13">
      <label class="flex h-8.5 items-center gap-2 rounded-10 border border-(--d-border2) bg-(--d-input) px-2.75 focus-within:border-(--d-accent)">
        <Search
          class="size-3.25 flex-none text-(--d-faint)"
          aria-hidden="true"
        />
        <input
          v-model="query"
          type="search"
          class="min-w-0 flex-1 bg-transparent text-12.5 text-(--d-text) outline-none placeholder:text-(--d-faint)"
          :placeholder="t('overlays.tools.filter')"
          :aria-label="t('overlays.tools.filter')"
          data-overlay-initial-focus
          data-testid="tools-filter"
        >
      </label>

      <div
        v-if="loading"
        class="flex items-center justify-center gap-2 p-5 text-12.5 text-(--d-faint)"
        role="status"
        data-testid="tools-loading"
      >
        <LoadingSpinner class="size-3.25" />{{ t('overlays.tools.loading') }}
      </div>
      <p
        v-else-if="groups.length === 0"
        class="p-5 text-center text-(--d-faint)"
      >
        {{ t('overlays.tools.noMatch', { query: query.trim() }) }}
      </p>

      <div
        v-for="view in groups"
        :key="view.group"
        class="overflow-hidden rounded-xl border border-(--d-border) bg-(--d-card) transition-opacity duration-200"
        :class="groupOff(view) && 'opacity-60'"
        data-testid="tools-group"
      >
        <div class="flex items-center gap-2.5 px-3 py-2.5">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2.5 text-left"
            :aria-expanded="isOpen(view)"
            :aria-controls="isOpen(view) ? `${ids}-group-${view.group}` : undefined"
            @click="toggleExpanded(view.group)"
          >
            <ChevronRight
              class="size-3.25 flex-none text-(--d-faint) transition-transform duration-200"
              :class="isOpen(view) && 'rotate-90'"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.75">
                <component
                  :is="GROUP_ICONS[view.group]"
                  class="size-3.25 flex-none text-(--d-accent)"
                  aria-hidden="true"
                />
                <span class="text-12.5 font-semibold">{{ t(`tools.group.${view.group}`) }}</span>
              </span>
              <span
                class="flex items-center gap-1.5 text-11.5"
                :class="groupStatus(view).class"
              >
                <span
                  class="size-1.5 flex-none rounded-full bg-current"
                  aria-hidden="true"
                />
                <span
                  :id="unavailable(view) ? `${ids}-unavailable-${view.group}` : undefined"
                  class="min-w-0 truncate"
                  :title="groupStatus(view).label"
                >{{ groupStatus(view).label }}</span>
                <span class="flex-none text-(--d-faint)">· {{ t('overlays.tools.onCount', { n: view.tools.filter((tool) => tool.enabled).length, total: view.tools.length }) }}</span>
              </span>
            </span>
          </button>
          <ToggleSwitch
            v-if="!NO_MASTER_GROUPS.has(view.group) && view.status"
            :checked="view.status.enabled"
            :disabled="!view.status.available && !view.status.enabled"
            :aria-label="t('tools.groupSwitch', { group: t(`tools.group.${view.group}`) })"
            :aria-describedby="unavailable(view) ? `${ids}-unavailable-${view.group}` : undefined"
            @update:checked="(checked: boolean) => emit('toggleGroup', view.group, checked)"
          />
        </div>

        <Transition name="t-fade">
          <div
            v-if="isOpen(view)"
            :id="`${ids}-group-${view.group}`"
            class="mx-3 mb-3 overflow-hidden rounded-lg border border-(--d-border) @min-[35rem]/overlay:ml-9"
          >
            <div class="flex h-7.5 items-center gap-2 bg-(--d-panel) px-2.5 text-11 text-(--d-faint)">
              <span class="min-w-0 flex-1 truncate">{{ t('overlays.tools.enabledOf', { n: view.tools.filter((tool) => tool.enabled).length, total: view.tools.length }) }}</span>
              <button
                type="button"
                class="flex-none whitespace-nowrap text-(--d-accent) enabled:hover:underline disabled:opacity-45"
                :disabled="!canSetAll(view, true)"
                @click="setAll(view, true)"
              >
                {{ t('overlays.tools.enableAll') }}
              </button>
              <span
                class="text-(--d-border2)"
                aria-hidden="true"
              >·</span>
              <button
                type="button"
                class="flex-none whitespace-nowrap text-(--d-accent) enabled:hover:underline disabled:opacity-45"
                :disabled="!canSetAll(view, false)"
                @click="setAll(view, false)"
              >
                {{ t('overlays.tools.disableAll') }}
              </button>
            </div>
            <div
              v-if="view.group === 'subagents' && !projectTrusted"
              class="flex items-center gap-2.5 border-t border-(--d-border) bg-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] px-2.5 py-2 text-11.5 text-(--d-warning-text)"
            >
              <ShieldAlert
                class="size-3.25 flex-none"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1">{{ t('tools.projectAgentsUntrusted') }}</span>
              <button
                type="button"
                class="flex-none font-semibold underline"
                @click="emit('trustProject')"
              >
                {{ t('tools.trustWorkspace') }}
              </button>
            </div>
            <div
              v-for="tool in view.shown"
              :key="tool.name"
              class="flex min-h-8.5 items-center gap-2.25 border-t border-(--d-border) px-2.5 py-1.25"
              data-testid="tools-row"
            >
              <div
                class="min-w-0 flex-1 transition-opacity duration-200"
                :class="!tool.enabled && 'opacity-55'"
              >
                <div
                  :id="`${ids}-tool-${tool.name}`"
                  class="truncate font-mono text-11.5"
                  :class="!tool.enabled && 'line-through'"
                >
                  {{ tool.label }}
                </div>
                <div
                  v-if="tool.description"
                  class="truncate text-11 text-(--d-faint)"
                  :title="tool.description"
                >
                  {{ tool.description }}
                </div>
              </div>
              <ToggleSwitch
                :checked="tool.enabled"
                :disabled="toolLocked(view, tool)"
                :aria-labelledby="`${ids}-tool-${tool.name}`"
                @update:checked="(checked: boolean) => emit('toggle', tool.name, checked)"
              />
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </OverlayShell>
</template>
