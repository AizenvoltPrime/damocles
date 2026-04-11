import { ref } from 'vue';
import { defineStore } from 'pinia';

export type MonitorStatus = 'starting' | 'monitoring' | 'completed' | 'failed' | 'stopped';

export interface MonitorState {
  toolUseId: string;
  taskId: string | null;
  command: string;
  description: string;
  persistent: boolean;
  timeoutMs: number;
  status: MonitorStatus;
  eventCount: number;
  startTime: number;
}

export const useMonitorStore = defineStore('monitors', () => {
  const monitors = ref<Map<string, MonitorState>>(new Map());
  const taskToToolUse = ref<Map<string, string>>(new Map());

  function trackInput(toolUseId: string, input: Record<string, unknown>): void {
    monitors.value.set(toolUseId, {
      toolUseId,
      taskId: null,
      command: typeof input.command === 'string' ? input.command : '',
      description: typeof input.description === 'string' ? input.description : '',
      persistent: input.persistent === true,
      timeoutMs: typeof input.timeout_ms === 'number' ? input.timeout_ms : 300000,
      status: 'starting',
      eventCount: 0,
      startTime: Date.now(),
    });
  }

  function registerMonitor(toolUseId: string, taskId: string, timeoutMs: number, persistent?: boolean): void {
    const existing = monitors.value.get(toolUseId);
    if (existing) {
      existing.taskId = taskId;
      existing.timeoutMs = timeoutMs;
      if (persistent !== undefined) existing.persistent = persistent;
    } else {
      monitors.value.set(toolUseId, {
        toolUseId,
        taskId,
        command: '',
        description: '',
        persistent: persistent ?? false,
        timeoutMs,
        status: 'starting',
        eventCount: 0,
        startTime: Date.now(),
      });
    }
    taskToToolUse.value.set(taskId, toolUseId);
  }

  function activateMonitor(toolUseId: string, taskId: string): void {
    const monitor = monitors.value.get(toolUseId);
    if (!monitor) return;
    monitor.taskId = taskId;
    monitor.status = 'monitoring';
    taskToToolUse.value.set(taskId, toolUseId);
  }

  function incrementEventCount(taskId: string): void {
    const toolUseId = taskToToolUse.value.get(taskId);
    if (!toolUseId) return;
    const monitor = monitors.value.get(toolUseId);
    if (!monitor) return;
    monitor.eventCount++;
    if (monitor.status === 'starting') monitor.status = 'monitoring';
  }

  function completeMonitor(taskId: string, finalStatus: 'completed' | 'failed' | 'stopped'): void {
    const toolUseId = taskToToolUse.value.get(taskId);
    if (!toolUseId) return;
    const monitor = monitors.value.get(toolUseId);
    if (monitor) monitor.status = finalStatus;
  }

  function restoreFromHistory(toolUseId: string, input: Record<string, unknown>, metadata: Record<string, unknown> | null | undefined): void {
    const command = typeof input?.command === 'string' ? input.command : '';
    const description = typeof input?.description === 'string' ? input.description : '';
    const persistent = input?.persistent === true;
    const inputTimeout = typeof input?.timeout_ms === 'number' ? input.timeout_ms : 300000;

    if (metadata && typeof metadata.taskId === 'string') {
      const taskId = metadata.taskId;
      const timeoutMs = typeof metadata.timeoutMs === 'number' ? metadata.timeoutMs : inputTimeout;
      monitors.value.set(toolUseId, {
        toolUseId,
        taskId,
        command,
        description,
        persistent: metadata.persistent === true || persistent,
        timeoutMs,
        status: 'completed',
        eventCount: 0,
        startTime: Date.now(),
      });
      taskToToolUse.value.set(taskId, toolUseId);
    } else {
      monitors.value.set(toolUseId, {
        toolUseId,
        taskId: null,
        command,
        description,
        persistent,
        timeoutMs: inputTimeout,
        status: 'stopped',
        eventCount: 0,
        startTime: Date.now(),
      });
    }
  }

  function failByToolUseId(toolUseId: string): void {
    const monitor = monitors.value.get(toolUseId);
    if (monitor) monitor.status = 'failed';
  }

  function getByToolUseId(toolUseId: string): MonitorState | undefined {
    return monitors.value.get(toolUseId);
  }

  function $reset(): void {
    monitors.value.clear();
    taskToToolUse.value.clear();
  }

  return {
    monitors,
    taskToToolUse,
    trackInput,
    registerMonitor,
    activateMonitor,
    incrementEventCount,
    completeMonitor,
    failByToolUseId,
    restoreFromHistory,
    getByToolUseId,
    $reset,
  };
});
