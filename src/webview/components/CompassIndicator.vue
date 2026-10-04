<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconCompass, IconLock } from '@/components/icons';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCompassStore } from '@/stores/useCompassStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import type { CompassPanel } from '@/stores/useCompassStore';
import { remPx } from '@/composables/useRemPx';

const { t } = useI18n();
const store = useCompassStore();
const { postMessage } = usePlatformBridge();
const popoverOpen = ref(false);

function openPanel(panel: CompassPanel): void {
	store.setActivePanel(panel);
	popoverOpen.value = false;
}

const pillClass = computed(() => {
	if (store.isError) return 'text-(--d-danger)';
	if (store.isIndexing) return 'text-(--d-accent)';
	return '';
});

const pillText = computed(() => {
	if (!store.status) return '';
	if (store.isError) return t('compass.indicator.error');
	if (store.isIndexing) {
		return store.status.fileCount > 0 ? t('compass.indicator.indexingFiles', { count: store.status.fileCount.toLocaleString() }) : t('compass.indicator.indexing');
	}
	return t('compass.indicator.nodes', { count: store.status.nodeCount.toLocaleString() });
});

const lastIndexedLabel = computed(() => {
	if (!store.status?.lastIndexedAt) return t('compass.indicator.never');
	const diff = Date.now() - store.status.lastIndexedAt;
	if (diff < 60_000) return t('compass.indicator.justNow');
	if (diff < 3_600_000) return t('compass.indicator.minutesAgo', { n: Math.floor(diff / 60_000) });
	if (diff < 86_400_000) return t('compass.indicator.hoursAgo', { n: Math.floor(diff / 3_600_000) });
	return t('compass.indicator.daysAgo', { n: Math.floor(diff / 86_400_000) });
});

const readOnly = computed(() => store.status?.readOnly === true);
const reindexLabel = computed(() => {
	if (store.isIndexing) return t('compass.indicator.indexing');
	return store.isError ? t('compass.indicator.retry') : t('compass.indicator.reindex');
});

function handleReindex(): void {
	postMessage({ type: 'requestCompassReindex' });
}
</script>

<template>
	<Popover v-if="store.isVisible" v-model:open="popoverOpen">
    <PopoverTrigger
      class="flex shrink-0 items-center gap-1.25 rounded-full bg-(--d-hover) px-2 py-0.5 transition-colors hover:bg-(--d-border2) hover:text-(--d-text) data-[state=open]:bg-(--d-border2)"
      :class="pillClass"
      data-testid="composer-compass"
    >
      <IconCompass
        class="size-2.75 shrink-0"
        :class="store.isIndexing ? 'animate-[d-spin_2s_linear_infinite]' : ''"
      />
      <span class="tabular-nums leading-none @max-[43rem]:sr-only">{{ pillText }}</span>
      <span
        v-if="readOnly"
        class="inline-flex shrink-0"
        data-testid="compass-read-only-pill"
			>
        <IconLock class="size-2.5" />
        <span class="sr-only">{{ t('compass.indicator.readOnly') }}</span>
      </span>
		</PopoverTrigger>
    <PopoverContent
      class="w-max min-w-56 max-w-80 rounded-xl border-(--d-border2) bg-(--d-card) p-3 text-(--d-text) shadow-(--d-shadow)"
      align="start"
      :side-offset="remPx(0.5)"
      side="top"
    >
			<div class="space-y-2">
        <p class="text-xs font-semibold">
          {{ t('compassIndicator.title') }}
        </p>
        <div
          v-if="store.isError && store.status?.error"
          class="text-xs text-(--d-danger)"
        >
					{{ store.status.error }}
				</div>
				<div v-else-if="store.status" class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <span class="text-(--d-muted)">{{ t('compass.indicator.state') }}</span>
					<span
						:class="{
              'text-(--d-success)': store.isReady,
              'text-(--d-accent)': store.isIndexing,
              'text-(--d-danger)': store.isError,
						}"
					>
						{{ store.status.state === 'ready' ? t('compass.indicator.ready') : store.status.state === 'indexing' || store.status.state === 'building' ? t('compass.indicator.indexingState') : store.status.state === 'idle' ? t('compass.indicator.idle') : t('common.error') }}
					</span>
					<template v-if="readOnly">
            <span class="text-(--d-muted)">{{ t('compass.indicator.access') }}</span>
						<span data-testid="compass-read-only-state">{{ t('compass.indicator.readOnly') }}</span>
					</template>
          <span class="text-(--d-muted)">{{ t('compass.indicator.files') }}</span>
					<span>{{ store.status.fileCount.toLocaleString() }}</span>
          <span class="text-(--d-muted)">{{ t('compassValidation.nodes') }}</span>
					<span>{{ store.status.nodeCount.toLocaleString() }}</span>
          <span class="text-(--d-muted)">{{ t('compassValidation.edges') }}</span>
					<span>{{ store.status.edgeCount.toLocaleString() }}</span>
          <span class="text-(--d-muted)">{{ t('compass.indicator.communities') }}</span>
					<span>{{ store.status.communityCount.toLocaleString() }}</span>
          <span class="text-(--d-muted)">{{ t('compass.indicator.indexed') }}</span>
					<span>{{ lastIndexedLabel }}</span>
				</div>
        <div
          v-if="store.isReady"
          class="mt-1 flex gap-1.5"
        >
					<button
            v-for="panel in (['graph', 'search', 'validate'] as const)"
            :key="panel"
            type="button"
            class="d-press flex-1 rounded-7 bg-(--d-hover) px-2 py-1 text-xs font-medium transition-colors hover:bg-(--d-border2)"
            @click="openPanel(panel)"
					>
            {{ panel === 'graph' ? t('compassIndicator.graph') : panel === 'search' ? t('compassIndicator.search') : t('compassValidation.validate') }}
					</button>
				</div>
				<p
					v-if="readOnly"
					id="compass-read-only-notice"
					data-testid="compass-read-only-notice"
          class="text-xs text-(--d-muted)"
				>
					{{ t('compass.indicator.readOnlyNotice') }}
				</p>
				<button
          type="button"
          class="d-press mt-1 w-full rounded-7 bg-(--d-hover) px-2 py-1 text-xs font-medium transition-colors hover:bg-(--d-border2) disabled:opacity-50"
					data-testid="compass-reindex"
					:disabled="store.isIndexing || readOnly"
					:aria-describedby="readOnly ? 'compass-read-only-notice' : undefined"
					@click="handleReindex"
				>
					{{ reindexLabel }}
				</button>
			</div>
		</PopoverContent>
	</Popover>
</template>
