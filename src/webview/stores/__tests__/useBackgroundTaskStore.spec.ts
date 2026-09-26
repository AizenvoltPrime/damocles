import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { BackgroundTask } from '@shared/types/background-tasks';
import { useBackgroundTaskStore } from '../useBackgroundTaskStore';

function runningTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: 'task-1',
    toolUseId: 'tool-1',
    description: 'do work',
    status: 'running',
    ...overrides,
  };
}

describe('useBackgroundTaskStore.handleTaskCompleted', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('returns false for an unknown taskId', () => {
    const store = useBackgroundTaskStore();
    expect(store.handleTaskCompleted('missing', 'stopped')).toBe(false);
  });

  it('resolves a running task and reports the transition', () => {
    const store = useBackgroundTaskStore();
    store.handleTaskStarted(runningTask());

    expect(store.handleTaskCompleted('task-1', 'stopped')).toBe(true);
    expect(store.tasks.find(t => t.taskId === 'task-1')!.status).toBe('stopped');
  });

  it('keeps the first outcome when a second one arrives', () => {
    const store = useBackgroundTaskStore();
    store.handleTaskStarted(runningTask());

    expect(store.handleTaskCompleted('task-1', 'completed')).toBe(true);
    expect(store.handleTaskCompleted('task-1', 'stopped')).toBe(false);
    expect(store.tasks.find(t => t.taskId === 'task-1')!.status).toBe('completed');
  });
});
