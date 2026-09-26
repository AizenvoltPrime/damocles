import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { BackgroundTask } from '@shared/types/background-tasks';

export const useBackgroundTaskStore = defineStore('backgroundTasks', () => {
  const isOverlayOpen = ref(false);
  const tasks = ref<BackgroundTask[]>([]);

  const activeTasks = computed(() => tasks.value.filter(t => t.status === 'running'));

  function openOverlay(): void {
    isOverlayOpen.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
  }

  function handleTaskStarted(task: BackgroundTask): void {
    const idx = tasks.value.findIndex(t => t.taskId === task.taskId);
    if (idx >= 0) {
      tasks.value[idx] = task;
    } else {
      tasks.value.push(task);
    }
  }

  /** Returns whether the task was running, so only the first outcome counts. */
  function handleTaskCompleted(taskId: string, status: Exclude<BackgroundTask['status'], 'running'>): boolean {
    const task = tasks.value.find(t => t.taskId === taskId);
    if (task?.status !== 'running') return false;
    task.status = status;
    return true;
  }

  function removeTask(taskId: string): void {
    tasks.value = tasks.value.filter(t => t.taskId !== taskId);
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    tasks.value = [];
  }

  return {
    isOverlayOpen,
    tasks,
    activeTasks,
    openOverlay,
    closeOverlay,
    handleTaskStarted,
    handleTaskCompleted,
    removeTask,
    $reset,
  };
});
