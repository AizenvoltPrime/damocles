<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { IconCompass } from '@/components/icons';
import OverlayShell from './OverlayShell.vue';
import LoadingSpinner from './LoadingSpinner.vue';
import { useCompassStore } from '@/stores/useCompassStore';
const { t } = useI18n();

const store = useCompassStore();

const expandedCategories = ref<Set<string>>(new Set());

const sortedIssues = computed(() => {
	if (!store.validationResult) return [];
	const order: Record<string, number> = { error: 0, warning: 1, info: 2 };
	return [...store.validationResult.issues].sort(
		(a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
	);
});

const isHealthy = computed(() =>
	store.validationResult !== null && store.validationResult.issues.every(i => i.severity === 'info')
);

function toggleCategory(category: string): void {
	if (expandedCategories.value.has(category)) {
		expandedCategories.value.delete(category);
	} else {
		expandedCategories.value.add(category);
	}
}

function severityColor(severity: string): string {
	if (severity === 'error') return 'text-red-400';
	if (severity === 'warning') return 'text-yellow-400';
	return 'text-blue-400';
}

function severityBg(severity: string): string {
	if (severity === 'error') return 'bg-red-500/15 text-red-400';
	if (severity === 'warning') return 'bg-yellow-500/15 text-yellow-400';
	return 'bg-blue-500/15 text-blue-400';
}

function severityIcon(severity: string): string {
	if (severity === 'error') return '✕';
	if (severity === 'warning') return '⚠';
	return 'ℹ';
}

function ratioClass(ratio: number): string {
	return ratio < 1.0 ? 'text-yellow-400' : 'text-foreground';
}

onMounted(() => {
	if (!store.validationResult && !store.validationLoading) {
		store.requestValidation();
	}
});
</script>

<template>
	<OverlayShell
		:title="t('compassValidation.title')"
		:icon="IconCompass"
		icon-class="text-emerald-400"
		@close="store.setActivePanel(null)"
	>
		<template #header-actions>
			<button
				class="px-2 py-1 rounded text-xs font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors cursor-pointer border-0 disabled:cursor-not-allowed disabled:opacity-50"
				:disabled="store.validationLoading"
				@click="store.requestValidation()"
			>
				{{ t('compassValidation.revalidate') }}
			</button>
		</template>

		<div v-if="store.validationLoading" class="flex flex-col items-center justify-center gap-2 py-12">
			<LoadingSpinner :size="24" />
			<span v-if="store.buildProgress" class="text-xs text-muted-foreground">
				{{ t('compassValidation.buildingProgress', { current: store.buildProgress.current, total: store.buildProgress.total }) }}
			</span>
			<span v-else class="text-xs text-muted-foreground">{{ t('compassValidation.running') }}</span>
		</div>

		<div v-else-if="store.validationResult" class="flex flex-col">
			<div class="px-3 py-2.5 border-b border-border bg-muted/30">
				<div class="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-0.5 text-xs">
					<span class="text-muted-foreground">{{ t('compassValidation.nodes') }}</span>
					<span>{{ store.validationResult.summary.nodeCount.toLocaleString() }}</span>
					<span class="text-muted-foreground">{{ t('compassValidation.edges') }}</span>
					<span>{{ store.validationResult.summary.edgeCount.toLocaleString() }}</span>
					<span class="text-muted-foreground">{{ t('compassValidation.ratio') }}</span>
					<span :class="ratioClass(store.validationResult.summary.edgeToNodeRatio)">
						{{ store.validationResult.summary.edgeToNodeRatio.toFixed(2) }}
					</span>
					<span class="text-muted-foreground">{{ t('compassValidation.coverage') }}</span>
					<span>{{ store.validationResult.summary.coveragePercent }}%</span>
				</div>
				<div class="text-[10px] text-muted-foreground mt-1">
					{{ t('compassValidation.checkedIn', { ms: store.validationResult.durationMs }) }}
				</div>
				<p v-if="store.buildProgress" class="text-xs text-muted-foreground mt-1">{{ t('compassValidation.reindexing') }}</p>
			</div>

			<div v-if="isHealthy" class="px-3 py-6 text-center">
				<div class="text-sm text-emerald-400 font-medium">{{ t('compassValidation.healthy') }}</div>
			</div>

			<ScrollArea v-else class="flex-1">
				<div class="divide-y divide-border">
					<div v-for="issue in sortedIssues" :key="issue.category">
						<button
							class="w-full px-3 py-2 text-left hover:bg-accent transition-colors cursor-pointer border-0 bg-transparent flex items-center gap-2"
							:aria-expanded="expandedCategories.has(issue.category)"
							@click="toggleCategory(issue.category)"
						>
							<span class="text-xs font-medium w-4 text-center" :class="severityColor(issue.severity)">
								{{ severityIcon(issue.severity) }}
							</span>
							<span class="text-xs text-foreground flex-1 truncate">{{ issue.category }}</span>
							<Badge v-if="issue.count > 0" variant="secondary" :class="severityBg(issue.severity)" class="text-[9px] px-1.5 py-0 shrink-0">
								{{ issue.count }}
							</Badge>
							<span class="text-[10px] text-muted-foreground shrink-0">
								{{ expandedCategories.has(issue.category) ? '▾' : '▸' }}
							</span>
						</button>
						<div v-if="expandedCategories.has(issue.category)" class="px-3 pb-2">
							<p class="text-[10px] text-muted-foreground mb-1.5">{{ issue.description }}</p>
							<div v-if="issue.entities.length > 0" class="max-h-48 overflow-y-auto rounded bg-muted/40 p-1.5">
								<div
									v-for="(entity, idx) in issue.entities"
									:key="idx"
									class="text-[10px] text-foreground/80 font-mono py-0.5 px-1 truncate"
								>
									{{ entity }}
								</div>
								<div v-if="issue.truncated" class="text-[10px] text-muted-foreground italic px-1 pt-0.5">
									{{ t('compassValidation.andMore') }}
								</div>
							</div>
						</div>
					</div>
				</div>
			</ScrollArea>
		</div>
	</OverlayShell>
</template>
