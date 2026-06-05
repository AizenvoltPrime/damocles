import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { BackgroundTask } from '@shared/types/background-tasks';

export const useBackgroundTaskStore = defineStore('backgroundTasks', () => {
  const isOverlayOpen = ref(false);
  const tasks = ref<BackgroundTask[]>([]);
  const selectedTaskId = ref<string | null>(null);

  const activeTasks = computed(() => tasks.value.filter(t => t.status === 'running'));
  const activeTaskCount = computed(() => activeTasks.value.length);
  const selectedTask = computed(() =>
    selectedTaskId.value ? tasks.value.find(t => t.taskId === selectedTaskId.value) ?? null : null
  );

  function openOverlay(): void {
    isOverlayOpen.value = true;
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    selectedTaskId.value = null;
  }

  function selectTask(taskId: string): void {
    selectedTaskId.value = taskId;
  }

  function backToList(): void {
    selectedTaskId.value = null;
  }

  function handleTaskStarted(task: BackgroundTask): void {
    const idx = tasks.value.findIndex(t => t.taskId === task.taskId);
    if (idx >= 0) {
      tasks.value[idx] = task;
    } else {
      tasks.value.push(task);
    }
  }

  function handleTaskProgress(
    taskId: string,
    progressSummary: string,
    usage?: BackgroundTask['usage'],
    lastToolName?: string,
  ): void {
    const task = tasks.value.find(t => t.taskId === taskId);
    if (task) {
      task.progressSummary = progressSummary;
      if (usage !== undefined) task.usage = usage;
      if (lastToolName !== undefined) task.lastToolName = lastToolName;
    }
  }

  function handleTaskCompleted(
    taskId: string,
    status: 'completed' | 'failed' | 'stopped',
    summary: string,
    outputFile: string | null,
    usage?: BackgroundTask['usage'],
  ): boolean {
    const task = tasks.value.find(t => t.taskId === taskId);
    if (!task) return false;
    const wasRunning = task.status === 'running';
    if (wasRunning) {
      task.status = status;
      task.endTime = Date.now();
    }
    if (summary) task.summary = summary;
    if (outputFile) task.outputFile = outputFile;
    if (usage !== undefined) task.usage = usage;
    return wasRunning;
  }

  function removeTask(taskId: string): void {
    tasks.value = tasks.value.filter(t => t.taskId !== taskId);
    if (selectedTaskId.value === taskId) {
      selectedTaskId.value = null;
    }
  }

  function $reset(): void {
    isOverlayOpen.value = false;
    tasks.value = [];
    selectedTaskId.value = null;
  }

  return {
    isOverlayOpen,
    tasks,
    selectedTaskId,
    activeTasks,
    activeTaskCount,
    selectedTask,
    openOverlay,
    closeOverlay,
    selectTask,
    backToList,
    handleTaskStarted,
    handleTaskProgress,
    handleTaskCompleted,
    removeTask,
    $reset,
  };
});
