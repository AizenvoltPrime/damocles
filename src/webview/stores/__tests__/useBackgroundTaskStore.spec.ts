import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { BackgroundTask } from '@shared/types/background-tasks';
import { useBackgroundTaskStore } from '../useBackgroundTaskStore';

function runningTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: 'task-1',
    toolUseId: 'tool-1',
    description: 'do work',
    taskType: null,
    status: 'running',
    startTime: 0,
    endTime: null,
    outputFile: null,
    summary: null,
    progressSummary: null,
    usage: null,
    lastToolName: null,
    ...overrides,
  };
}

describe('useBackgroundTaskStore.handleTaskCompleted', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('returns false for an unknown taskId', () => {
    const store = useBackgroundTaskStore();
    expect(store.handleTaskCompleted('missing', 'stopped', '', null)).toBe(false);
  });

  it('resolves a running task to stopped and reports the first transition', () => {
    const store = useBackgroundTaskStore();
    store.handleTaskStarted(runningTask());

    const transitioned = store.handleTaskCompleted('task-1', 'stopped', '', null);

    expect(transitioned).toBe(true);
    const task = store.tasks.find(t => t.taskId === 'task-1')!;
    expect(task.status).toBe('stopped');
    expect(task.summary).toBeNull();
  });

  it('enriches summary from a later real notification without a second transition or status flip', () => {
    const store = useBackgroundTaskStore();
    store.handleTaskStarted(runningTask());

    expect(store.handleTaskCompleted('task-1', 'stopped', '', null)).toBe(true);
    const second = store.handleTaskCompleted('task-1', 'completed', 'real summary', '/tmp/out.txt');

    expect(second).toBe(false);
    const task = store.tasks.find(t => t.taskId === 'task-1')!;
    expect(task.status).toBe('stopped');
    expect(task.summary).toBe('real summary');
    expect(task.outputFile).toBe('/tmp/out.txt');
  });

  it('keeps the real completion when the real notification wins the race over the proactive stopped', () => {
    const store = useBackgroundTaskStore();
    store.handleTaskStarted(runningTask());

    expect(store.handleTaskCompleted('task-1', 'completed', 'real summary', '/tmp/out.txt')).toBe(true);
    expect(store.handleTaskCompleted('task-1', 'stopped', '', null)).toBe(false);

    const task = store.tasks.find(t => t.taskId === 'task-1')!;
    expect(task.status).toBe('completed');
    expect(task.summary).toBe('real summary');
    expect(task.outputFile).toBe('/tmp/out.txt');
  });
});
