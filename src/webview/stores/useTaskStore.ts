import { ref, computed } from "vue";
import { defineStore } from "pinia";
import type {
  Task,
  TaskCreateInput,
  TaskCreateOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
  TaskListOutput,
  TaskGetOutput,
} from "@shared/types/subagents";

export type TrackedTaskInput =
  | { tool: "TaskCreate"; input: TaskCreateInput }
  | { tool: "TaskUpdate"; input: TaskUpdateInput };

export const useTaskStore = defineStore("task", () => {
  const tasks = ref<Task[]>([]);
  const pendingInputs = ref<Map<string, TrackedTaskInput>>(new Map());

  const hasTasks = computed(() => tasks.value.length > 0);
  const hasInProgress = computed(() => tasks.value.some(t => t.status === "in_progress"));
  const completedCount = computed(() => tasks.value.filter(t => t.status === "completed").length);

  function trackToolInput(toolId: string, tracked: TrackedTaskInput) {
    pendingInputs.value.set(toolId, tracked);
  }

  function getToolInput(toolId: string): TrackedTaskInput | undefined {
    return pendingInputs.value.get(toolId);
  }

  function clearToolInput(toolId: string) {
    pendingInputs.value.delete(toolId);
  }

  function handleTaskCreate(toolId: string, result: TaskCreateOutput) {
    if (!result.task.id || !result.task.subject) {
      clearToolInput(toolId);
      return;
    }
    const tracked = getToolInput(toolId);
    clearToolInput(toolId);

    const fromInput = tracked?.tool === "TaskCreate" ? tracked.input : undefined;
    const newTask: Task = {
      id: result.task.id,
      subject: result.task.subject,
      description: fromInput?.description || undefined,
      status: "pending",
      activeForm: fromInput?.activeForm || undefined,
      metadata: fromInput?.metadata || undefined,
    };
    tasks.value = [...tasks.value, newTask];
  }

  function handleTaskUpdate(toolId: string, result: TaskUpdateOutput) {
    const tracked = getToolInput(toolId);
    clearToolInput(toolId);

    if (!result.success || result.error) return;
    if (!tracked || tracked.tool !== "TaskUpdate") return;

    const input = tracked.input;
    const updates: Partial<Task> = {};
    if (input.status && input.status !== "deleted") updates.status = input.status;
    if (input.subject) updates.subject = input.subject;
    if (input.description) updates.description = input.description;
    if (input.activeForm) updates.activeForm = input.activeForm;
    if (input.owner) updates.owner = input.owner;
    if (input.metadata) updates.metadata = input.metadata;

    if (input.addBlockedBy) {
      const current = tasks.value.find(t => t.id === result.taskId);
      updates.blockedBy = [...new Set([...(current?.blockedBy || []), ...input.addBlockedBy])];
    }
    if (input.addBlocks) {
      const current = tasks.value.find(t => t.id === result.taskId);
      updates.blocks = [...new Set([...(current?.blocks || []), ...input.addBlocks])];
    }

    tasks.value = tasks.value.map(t =>
      t.id === result.taskId ? { ...t, ...updates } : t
    );
  }

  function handleTaskList(result: TaskListOutput) {
    const existingById = new Map(tasks.value.map(t => [t.id, t]));
    tasks.value = result.tasks
      .filter(t => t.id && t.subject)
      .map(sdkTask => {
        const existing = existingById.get(sdkTask.id);
        return {
          ...(existing ?? {}),
          id: sdkTask.id,
          subject: sdkTask.subject,
          status: sdkTask.status,
          owner: sdkTask.owner ?? existing?.owner,
          blockedBy: sdkTask.blockedBy,
        } satisfies Task;
      });
  }

  function handleTaskGet(result: TaskGetOutput) {
    if (!result.task) return;
    const { id, subject, description, status, blocks, blockedBy } = result.task;
    if (!id || !subject) return;
    const existing = tasks.value.find(t => t.id === id);
    const merged: Task = {
      ...(existing ?? {}),
      id,
      subject,
      description,
      status,
      blocks,
      blockedBy,
    };
    tasks.value = existing
      ? tasks.value.map(t => t.id === id ? merged : t)
      : [...tasks.value, merged];
  }

  function clearTasks() {
    tasks.value = [];
    pendingInputs.value.clear();
  }

  function $reset() {
    clearTasks();
  }

  return {
    tasks,
    hasTasks,
    hasInProgress,
    completedCount,
    trackToolInput,
    handleTaskCreate,
    handleTaskUpdate,
    handleTaskList,
    handleTaskGet,
    clearTasks,
    $reset,
  };
});
