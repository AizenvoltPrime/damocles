import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { CompassIndexStatus } from '@shared/types/compass';

export const useCompassStore = defineStore('compass', () => {
	const status = ref<CompassIndexStatus | null>(null);

	const isVisible = computed(() => {
		if (!status.value) return false;
		return status.value.state !== 'idle';
	});

	const isIndexing = computed(() => status.value?.state === 'indexing');
	const isReady = computed(() => status.value?.state === 'ready');
	const isError = computed(() => status.value?.state === 'error');

	function updateStatus(newStatus: CompassIndexStatus): void {
		status.value = newStatus;
	}

	function $reset(): void {
		status.value = null;
	}

	return {
		status,
		isVisible,
		isIndexing,
		isReady,
		isError,
		updateStatus,
		$reset,
	};
});
