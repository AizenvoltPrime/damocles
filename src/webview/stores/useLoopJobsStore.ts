import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { LoopJob } from '@shared/types/loop-jobs';

export const useLoopJobsStore = defineStore('loopJobs', () => {
  const isOverlayOpen = ref(false);
  const jobs = ref<LoopJob[]>([]);

  const hasActiveJobs = computed(() => jobs.value.some(j => j.status === 'active'));
  const activeJobCount = computed(() => jobs.value.filter(j => j.status === 'active' || j.status === 'cancelling').length);

  function openOverlay(): void {
    isOverlayOpen.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
  }

  function handleJobsLoaded(loaded: LoopJob[]): void {
    jobs.value = loaded;
  }

  function handleJobCreated(job: LoopJob): void {
    const idx = jobs.value.findIndex(j => j.taskId === job.taskId);
    if (idx >= 0) {
      jobs.value[idx] = job;
    } else {
      jobs.value.push(job);
    }
  }

  function handleJobUpdated(taskId: string, updates: Partial<LoopJob>): void {
    const job = jobs.value.find(j => j.taskId === taskId);
    if (job) {
      Object.assign(job, updates);
    }
  }

  function handleJobRemoved(taskId: string): void {
    jobs.value = jobs.value.filter(j => j.taskId !== taskId);
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    jobs.value = [];
  }

  return {
    isOverlayOpen,
    jobs,
    hasActiveJobs,
    activeJobCount,
    openOverlay,
    closeOverlay,
    handleJobsLoaded,
    handleJobCreated,
    handleJobUpdated,
    handleJobRemoved,
    $reset,
  };
});
