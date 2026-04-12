<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconCompass } from '@/components/icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCompassStore } from '@/stores/useCompassStore';
import { useVSCode } from '@/composables/useVSCode';
import type { CompassPanel } from '@/stores/useCompassStore';

const { t } = useI18n();
const store = useCompassStore();
const { postMessage } = useVSCode();
const popoverOpen = ref(false);

function openPanel(panel: CompassPanel): void {
	store.setActivePanel(panel);
	popoverOpen.value = false;
}

const pillClass = computed(() => {
	if (store.isError) return 'bg-red-500/15 text-red-400 hover:bg-red-500/25';
	if (store.isIndexing) return 'bg-primary/15 text-primary hover:bg-primary/25';
	return 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25';
});

const pillText = computed(() => {
	if (!store.status) return '';
	if (store.isError) return 'Graph error';
	if (store.isIndexing) {
		return store.status.fileCount > 0 ? `Indexing ${store.status.fileCount.toLocaleString()}…` : 'Indexing…';
	}
	return `${store.status.nodeCount.toLocaleString()} nodes`;
});

const lastIndexedLabel = computed(() => {
	if (!store.status?.lastIndexedAt) return 'Never';
	const diff = Date.now() - store.status.lastIndexedAt;
	if (diff < 60_000) return 'Just now';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hr ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
});

function handleReindex(): void {
	postMessage({ type: 'requestCompassReindex' });
}
</script>

<template>
	<Popover v-if="store.isVisible" v-model:open="popoverOpen">
		<PopoverTrigger as-child>
			<button
				class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium transition-colors cursor-pointer border-0"
				:class="pillClass"
			>
				<IconCompass
					:size="12"
					class="shrink-0"
					:class="{ 'animate-spin': store.isIndexing }"
					:style="store.isIndexing ? 'animation-duration: 2s' : ''"
				/>
				<span class="tabular-nums leading-none">{{ pillText }}</span>
			</button>
		</PopoverTrigger>
		<PopoverContent class="w-56 p-3" align="start" :side-offset="8" side="top">
			<div class="space-y-2">
				<p class="text-xs font-semibold text-foreground">{{ t('compassIndicator.title') }}</p>
				<div v-if="store.isError && store.status?.error" class="text-xs text-red-400">
					{{ store.status.error }}
				</div>
				<div v-else-if="store.status" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
					<span class="text-muted-foreground">State</span>
					<span
						:class="{
							'text-emerald-400': store.isReady,
							'text-primary': store.isIndexing,
							'text-red-400': store.isError,
						}"
					>
						{{ store.status.state === 'ready' ? 'Ready' : store.status.state === 'indexing' || store.status.state === 'building' ? 'Indexing' : store.status.state === 'idle' ? 'Idle' : 'Error' }}
					</span>
					<span class="text-muted-foreground">Files</span>
					<span>{{ store.status.fileCount.toLocaleString() }}</span>
					<span class="text-muted-foreground">Nodes</span>
					<span>{{ store.status.nodeCount.toLocaleString() }}</span>
					<span class="text-muted-foreground">Edges</span>
					<span>{{ store.status.edgeCount.toLocaleString() }}</span>
					<span class="text-muted-foreground">Communities</span>
					<span>{{ store.status.communityCount.toLocaleString() }}</span>
					<span class="text-muted-foreground">Indexed</span>
					<span>{{ lastIndexedLabel }}</span>
				</div>
				<div v-if="store.isReady" class="flex gap-1.5 mt-1">
					<button
						class="flex-1 px-2 py-1 rounded text-xs font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer border-0"
						@click="openPanel('graph')"
					>
						{{ t('compassIndicator.graph') }}
					</button>
					<button
						class="flex-1 px-2 py-1 rounded text-xs font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer border-0"
						@click="openPanel('search')"
					>
						{{ t('compassIndicator.search') }}
					</button>
					<button
						class="flex-1 px-2 py-1 rounded text-xs font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer border-0"
						@click="openPanel('validate')"
					>
						{{ t('compassValidation.validate') }}
					</button>
				</div>
				<button
					class="w-full mt-1 px-2 py-1 rounded text-xs font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
					:disabled="store.isIndexing"
					@click="handleReindex"
				>
					{{ store.isIndexing ? 'Indexing…' : store.isError ? 'Retry' : 'Reindex' }}
				</button>
			</div>
		</PopoverContent>
	</Popover>
</template>
