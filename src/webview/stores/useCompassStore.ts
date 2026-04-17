import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type {
	CompassIndexStatus,
	CompassGraphData,
	CompassSearchResult,
	CompassBlastRadiusResult,
	CompassNodeKind,
	CompassValidationResult,
} from '@shared/types/compass';
import { useVSCode } from '@/composables/useVSCode';

export type CompassPanel = 'search' | 'graph' | 'validate' | null;

export interface CompassBuildProgress {
	current: number;
	total: number;
	phase: string;
	label?: string;
}

export const useCompassStore = defineStore('compass', () => {
	const { postMessage } = useVSCode();
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

	const validationResult = ref<CompassValidationResult | null>(null);
	const validationLoading = ref(false);

	const buildProgress = ref<CompassBuildProgress | null>(null);

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

	function requestValidation(): void {
		validationLoading.value = true;
		postMessage({ type: 'compassRequestValidation' });
	}

	function requestGraph(): void {
		graphLoading.value = true;
		postMessage({
			type: 'compassRequestGraph',
			communityId: graphCommunityFilter.value ?? undefined,
			maxNodes: 500,
		});
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

	function setValidationResult(data: CompassValidationResult): void {
		validationResult.value = data;
		validationLoading.value = false;
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
		validationResult.value = null;
		validationLoading.value = false;
		buildProgress.value = null;
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
		validationResult,
		validationLoading,
		buildProgress,
		isVisible,
		isIndexing,
		isReady,
		isError,
		hasBlastRadius,
		updateStatus,
		setSearchResults,
		requestValidation,
		requestGraph,
		setGraphData,
		setBlastRadius,
		dismissBlastRadius,
		setValidationResult,
		setActivePanel,
		$reset,
	};
});
