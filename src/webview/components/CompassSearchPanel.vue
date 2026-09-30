<script setup lang="ts">
import { onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { IconSearch } from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import { useCompassStore } from '@/stores/useCompassStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
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

const KIND_ICON: Record<string, string> = {
	File: '📄',
	Class: '🔷',
	Function: '⚡',
	Type: '🔶',
	Test: '🧪',
};

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

function formatPath(filePath: string): string {
	const parts = filePath.replace(/\\/g, '/').split('/');
	return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : filePath;
}
</script>

<template>
	<OverlayShell
		:title="t('compass.search.title')"
		:icon="IconSearch"
		icon-class="text-emerald-400"
		@close="store.setActivePanel(null)"
	>
		<div class="px-3 pt-3 pb-2 space-y-2 border-b border-border">
			<Input
				:model-value="store.searchQuery"
				:placeholder="t('compass.search.placeholder')"
				class="h-8 text-xs"
				@update:model-value="onInput($event as string)"
			/>
			<div class="flex flex-wrap gap-1">
				<button
					v-for="f in KIND_FILTERS"
					:key="f.labelKey"
					type="button"
					class="px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors cursor-pointer border-0"
					:class="store.searchKind === f.value
						? 'bg-primary text-primary-foreground'
						: 'bg-secondary text-secondary-foreground hover:bg-secondary/80'"
					@click="selectKind(f.value)"
				>
					{{ t(f.labelKey) }}
				</button>
			</div>
		</div>

		<ScrollArea class="flex-1">
			<div v-if="store.searchLoading" class="p-4 text-center text-xs text-muted-foreground">
				{{ t('compass.search.searching') }}
			</div>
			<div v-else-if="store.searchResults.length === 0 && store.searchQuery.trim()" class="p-4 text-center text-xs text-muted-foreground">
				{{ t('compass.search.noResults') }}
			</div>
			<div v-else-if="!store.searchQuery.trim()" class="p-4 text-center text-xs text-muted-foreground">
				{{ t('compass.search.hint') }}
			</div>
			<div v-else class="divide-y divide-border">
				<button
					v-for="result in store.searchResults"
					:key="result.node.qualified_name"
					type="button"
					class="w-full px-3 py-2 text-left hover:bg-accent transition-colors cursor-pointer border-0 bg-transparent"
					@click="navigateToResult(result.node.file_path, result.node.line_start)"
				>
					<div class="flex items-center gap-1.5">
						<span class="text-xs">{{ KIND_ICON[result.node.kind] ?? '•' }}</span>
						<span class="text-xs font-medium text-foreground truncate">{{ result.node.name }}</span>
						<Badge variant="secondary" class="text-[9px] px-1 py-0 shrink-0">
							{{ result.node.kind }}
						</Badge>
					</div>
					<div class="text-[10px] text-muted-foreground mt-0.5 truncate">
						{{ formatPath(result.node.file_path) }}:{{ result.node.line_start }}
					</div>
				</button>
			</div>
		</ScrollArea>
	</OverlayShell>
</template>
