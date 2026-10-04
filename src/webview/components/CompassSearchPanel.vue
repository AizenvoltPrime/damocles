<script setup lang="ts">
import { computed, onUnmounted, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { Box, Dot, FileCode, FlaskConical, SquareFunction, Search, Shapes } from 'lucide-vue-next';
import OverlayShell from './OverlayShell.vue';
import SegmentedToggle, { type SegmentedOption } from './SegmentedToggle.vue';
import { useFolderRelativePath } from '@/composables/useFolderRelativePath';
import { useCompassStore } from '@/stores/useCompassStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { ownEntry } from '@/utils/ownEntry';
import type { CompassNodeKind } from '@shared/types/compass';

const { t } = useI18n();
const store = useCompassStore();
const { postMessage } = usePlatformBridge();

const KIND_FILTERS: Array<{ labelKey: string; value: CompassNodeKind | null }> = [
	{ labelKey: 'compass.search.all', value: null },
	{ labelKey: 'compass.nodeKind.File', value: 'File' },
	{ labelKey: 'compass.nodeKind.Class', value: 'Class' },
	{ labelKey: 'compass.nodeKind.Function', value: 'Function' },
	{ labelKey: 'compass.nodeKind.Type', value: 'Type' },
	{ labelKey: 'compass.nodeKind.Test', value: 'Test' },
];

const KIND_ICON: Record<string, Component> = {
	File: FileCode,
	Class: Box,
	Function: SquareFunction,
	Type: Shapes,
	Test: FlaskConical,
};

const displayPath = useFolderRelativePath();
const kindKey = computed(() => store.searchKind ?? 'all');
const kindOptions = computed<SegmentedOption<string>[]>(() => KIND_FILTERS.map((f) => ({ value: f.value ?? 'all', label: t(f.labelKey) })));

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function onInput(value: string): void {
	store.searchQuery = value;
	if (debounceTimer) clearTimeout(debounceTimer);

	if (!value.trim()) {
		store.searchResults = [];
		return;
	}

	store.searchLoading = true;
	debounceTimer = setTimeout(() => {
		postMessage({
			type: 'compassSearch',
			query: value.trim(),
			...(store.searchKind !== null && { kind: store.searchKind }),
			limit: 30,
		});
	}, 300);
}

function selectKind(kind: CompassNodeKind | null): void {
	store.searchKind = kind;
	if (store.searchQuery.trim()) {
		store.searchLoading = true;
		postMessage({
			type: 'compassSearch',
			query: store.searchQuery.trim(),
			...(kind !== null && { kind }),
			limit: 30,
		});
	}
}

function navigateToResult(filePath: string, line: number): void {
	postMessage({ type: 'compassNavigateToNode', filePath, line });
}

onUnmounted(() => {
	if (debounceTimer) clearTimeout(debounceTimer);
	store.searchLoading = false;
});

</script>

<template>
  <OverlayShell
    fill
    :title="t('compass.search.title')"
    :icon="Search"
    icon-class="text-(--d-success)"
    data-testid="compass-search"
    @close="store.setActivePanel(null)"
  >
    <div class="sticky top-0 z-3 flex flex-col gap-2 border-b border-(--d-border) bg-(--d-bg) px-4 pt-3 pb-2.5">
      <label class="flex h-8.5 items-center gap-2 rounded-10 border border-(--d-border2) bg-(--d-input) px-2.75 focus-within:border-(--d-accent)">
        <Search
          class="size-3.25 flex-none text-(--d-faint)"
          aria-hidden="true"
        />
        <input
          :value="store.searchQuery"
          type="search"
          class="min-w-0 flex-1 bg-transparent text-12.5 text-(--d-text) outline-none placeholder:text-(--d-faint)"
          :placeholder="t('compass.search.placeholder')"
          :aria-label="t('compass.search.placeholder')"
          data-overlay-initial-focus
          @input="onInput(($event.target as HTMLInputElement).value)"
        >
      </label>
      <SegmentedToggle
        :model-value="kindKey"
        :options="kindOptions"
        indicator-class="text-(--d-card)"
        class="self-start bg-(--d-hover)"
        :aria-label="t('compass.search.kindFilter')"
        @update:model-value="(key: string) => selectKind(key === 'all' ? null : (key as CompassNodeKind))"
      />
    </div>

    <p
      v-if="store.searchLoading"
      class="p-5 text-center text-12.5 text-(--d-muted)"
      role="status"
    >
      {{ t('compass.search.searching') }}
    </p>
    <p
      v-else-if="store.searchResults.length === 0 && store.searchQuery.trim()"
      class="p-5 text-center text-12.5 text-(--d-faint)"
    >
      {{ t('compass.search.noResults') }}
    </p>
    <p
      v-else-if="!store.searchQuery.trim()"
      class="p-5 text-center text-12.5 text-(--d-faint)"
    >
      {{ t('compass.search.hint') }}
    </p>
    <div
      v-else
      class="flex flex-col gap-1.5 px-4 pt-3 pb-4"
    >
      <button
        v-for="result in store.searchResults"
        :key="result.node.qualified_name"
        type="button"
        class="flex items-center gap-2.5 rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2 text-left transition-colors hover:border-(--d-border2) hover:bg-(--d-hover)"
        :title="result.node.file_path"
        data-testid="compass-search-result"
        @click="navigateToResult(result.node.file_path, result.node.line_start)"
      >
        <span class="flex size-5.5 flex-none items-center justify-center rounded-md bg-(--d-accent-soft) text-(--d-accent)">
          <component
            :is="ownEntry(KIND_ICON, result.node.kind) ?? Dot"
            class="size-3"
            aria-hidden="true"
          />
        </span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5">
            <span class="truncate font-mono text-12.5 font-semibold">{{ result.node.name }}</span>
            <span class="flex-none rounded-5 bg-(--d-hover) px-1.5 text-10.5 text-(--d-muted)">{{ t(`compass.nodeKind.${result.node.kind}`) }}</span>
          </span>
          <span class="block truncate font-mono text-11 text-(--d-faint)">{{ displayPath(result.node.file_path) }}:{{ result.node.line_start }}</span>
        </span>
      </button>
    </div>
  </OverlayShell>
</template>
