import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type {
	CompassIndexStatus,
	CompassGraphData,
	CompassSearchResult,
	CompassBlastRadiusResult,
	CompassNodeKind,
} from '@shared/types/compass';

export type CompassPanel = 'search' | 'graph' | null;

export const useCompassStore = defineStore('compass', () => {
	const status = ref<CompassIndexStatus | null>(null);
	const activePanel = ref<CompassPanel>(null);

	const searchQuery = ref('');
	const searchKind = ref<CompassNodeKind | null>(null);
	const searchResults = ref<CompassSearchResult[]>([]);
	const searchLoading = ref(false);

	const graphData = ref<CompassGraphData | null>(null);
	const graphCommunityFilter = ref<number | null>(null);
	const graphLoading = ref(false);

	const blastRadius = ref<CompassBlastRadiusResult | null>(null);

	const isVisible = computed(() => status.value !== null);

	const isIndexing = computed(() => status.value?.state === 'indexing');
	const isReady = computed(() => status.value?.state === 'ready');
	const isError = computed(() => status.value?.state === 'error');
	const hasBlastRadius = computed(() => blastRadius.value !== null);

	function updateStatus(newStatus: CompassIndexStatus): void {
		status.value = newStatus;
	}

	function setSearchResults(results: CompassSearchResult[]): void {
		searchResults.value = results;
		searchLoading.value = false;
	}

	function setGraphData(data: CompassGraphData): void {
		graphData.value = data;
		graphLoading.value = false;
	}

	function setBlastRadius(data: CompassBlastRadiusResult): void {
		blastRadius.value = data;
	}

	function dismissBlastRadius(): void {
		blastRadius.value = null;
	}

	function setActivePanel(panel: CompassPanel): void {
		activePanel.value = panel;
	}

	function $reset(): void {
		status.value = null;
		activePanel.value = null;
		searchQuery.value = '';
		searchKind.value = null;
		searchResults.value = [];
		searchLoading.value = false;
		graphData.value = null;
		graphCommunityFilter.value = null;
		graphLoading.value = false;
		blastRadius.value = null;
	}

	return {
		status,
		activePanel,
		searchQuery,
		searchKind,
		searchResults,
		searchLoading,
		graphData,
		graphCommunityFilter,
		graphLoading,
		blastRadius,
		isVisible,
		isIndexing,
		isReady,
		isError,
		hasBlastRadius,
		updateStatus,
		setSearchResults,
		setGraphData,
		setBlastRadius,
		dismissBlastRadius,
		setActivePanel,
		$reset,
	};
});
