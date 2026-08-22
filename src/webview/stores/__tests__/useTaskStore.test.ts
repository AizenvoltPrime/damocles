import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTaskStore } from '../useTaskStore';
import type {
  Task,
  TaskCreateInput,
  TaskCreateOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
  TaskListOutput,
  TaskGetOutput,
} from '@shared/types/subagents';

const createOutput = (id: string, subject: string): TaskCreateOutput => ({
  task: { id, subject },
});

const updateOutput = (overrides: Partial<TaskUpdateOutput> & { taskId: string }): TaskUpdateOutput => ({
  success: true,
  ...overrides,
});

describe('useTaskStore.handleTaskCreate', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('creates a task and merges tracked TaskCreateInput fields', () => {
    const store = useTaskStore();
    const input: TaskCreateInput = {
      subject: 'Build feature',
      description: 'Add the X module',
      activeForm: 'Building feature',
      metadata: { priority: 'high' },
    };
    store.trackToolInput('tool-1', { tool: 'TaskCreate', input });
    store.handleTaskCreate('tool-1', createOutput('t1', 'Build feature'));

    expect(store.tasks).toEqual<Task[]>([{
      id: 't1',
      subject: 'Build feature',
      description: 'Add the X module',
      status: 'pending',
      activeForm: 'Building feature',
      metadata: { priority: 'high' },
    }]);
  });

  it('clears pendingInputs after consumption', () => {
    const store = useTaskStore();
    store.trackToolInput('tool-1', {
      tool: 'TaskCreate',
      input: { subject: 's', description: 'd' },
    });
    store.handleTaskCreate('tool-1', createOutput('t1', 's'));

    store.trackToolInput('tool-1', {
      tool: 'TaskCreate',
      input: { subject: 's2', description: 'd2' },
    });
    store.handleTaskCreate('tool-1', createOutput('t2', 's2'));
    const t2 = store.tasks.find(t => t.id === 't2');
    expect(t2?.description).toBe('d2');
  });

  it('creates with only SDK fields when no tracked input is present', () => {
    const store = useTaskStore();
    store.handleTaskCreate('tool-untracked', createOutput('t1', 'Subject only'));

    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0]).toMatchObject({ id: 't1', subject: 'Subject only', status: 'pending' });
    expect(store.tasks[0]?.description).toBeUndefined();
    expect(store.tasks[0]?.activeForm).toBeUndefined();
  });

  it('bails when SDK output is missing required fields', () => {
    const store = useTaskStore();
    store.handleTaskCreate('tool-1', { task: { id: '', subject: '' } });
    expect(store.tasks).toHaveLength(0);
  });
});

describe('useTaskStore.handleTaskUpdate', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const seed = (store: ReturnType<typeof useTaskStore>, task: Task) => {
    store.tasks.push(task);
  };

  it('bails when result.success is false', () => {
    const store = useTaskStore();
    seed(store, { id: 't1', subject: 's', status: 'pending' });
    store.trackToolInput('u1', {
      tool: 'TaskUpdate',
      input: { taskId: 't1', status: 'completed' },
    });
    store.handleTaskUpdate('u1', updateOutput({ taskId: 't1', success: false }));
    expect(store.tasks[0]?.status).toBe('pending');
  });

  it('bails when result.error is truthy', () => {
    const store = useTaskStore();
    seed(store, { id: 't1', subject: 's', status: 'pending' });
    store.trackToolInput('u1', {
      tool: 'TaskUpdate',
      input: { taskId: 't1', status: 'completed' },
    });
    store.handleTaskUpdate('u1', updateOutput({ taskId: 't1', error: 'something broke' }));
    expect(store.tasks[0]?.status).toBe('pending');
  });

  it('applies status, subject, description, activeForm, owner, and metadata updates', () => {
    const store = useTaskStore();
    seed(store, { id: 't1', subject: 'old', status: 'pending' });
    const input: TaskUpdateInput = {
      taskId: 't1',
      subject: 'new subject',
      description: 'new desc',
      activeForm: 'doing it',
      status: 'in_progress',
      owner: 'alice',
      metadata: { tag: 'v2' },
    };
    store.trackToolInput('u1', { tool: 'TaskUpdate', input });
    store.handleTaskUpdate('u1', updateOutput({ taskId: 't1' }));

    expect(store.tasks[0]).toMatchObject({
      id: 't1',
      subject: 'new subject',
      description: 'new desc',
      activeForm: 'doing it',
      status: 'in_progress',
      owner: 'alice',
      metadata: { tag: 'v2' },
    });
  });

  it('treats "deleted" status as no-op for the status field', () => {
    const store = useTaskStore();
    seed(store, { id: 't1', subject: 's', status: 'in_progress' });
    store.trackToolInput('u1', {
      tool: 'TaskUpdate',
      input: { taskId: 't1', status: 'deleted' },
    });
    store.handleTaskUpdate('u1', updateOutput({ taskId: 't1' }));
    expect(store.tasks[0]?.status).toBe('in_progress');
  });

  it('merges addBlockedBy and addBlocks with existing arrays without duplicates', () => {
    const store = useTaskStore();
    seed(store, { id: 't1', subject: 's', status: 'pending', blockedBy: ['a'], blocks: ['x'] });
    store.trackToolInput('u1', {
      tool: 'TaskUpdate',
      input: { taskId: 't1', addBlockedBy: ['a', 'b'], addBlocks: ['x', 'y'] },
    });
    store.handleTaskUpdate('u1', updateOutput({ taskId: 't1' }));

    expect(store.tasks[0]?.blockedBy).toEqual(['a', 'b']);
    expect(store.tasks[0]?.blocks).toEqual(['x', 'y']);
  });

  it('bails when no tracked input is present', () => {
    const store = useTaskStore();
    seed(store, { id: 't1', subject: 's', status: 'pending' });
    store.handleTaskUpdate('untracked', updateOutput({ taskId: 't1' }));
    expect(store.tasks[0]?.status).toBe('pending');
  });
});

describe('useTaskStore.handleTaskList', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('preserves description, activeForm, blocks, and metadata for existing ids (merge-by-id)', () => {
    const store = useTaskStore();
    store.tasks.push({
      id: 't1',
      subject: 'original',
      description: 'x',
      activeForm: 'y',
      status: 'pending',
      blocks: ['b1'],
      metadata: { k: 'v' },
    });
    const result: TaskListOutput = {
      tasks: [{ id: 't1', subject: 'updated', status: 'in_progress', blockedBy: [] }],
    };
    store.handleTaskList(result);

    expect(store.tasks[0]).toMatchObject({
      id: 't1',
      subject: 'updated',
      status: 'in_progress',
      description: 'x',
      activeForm: 'y',
      blocks: ['b1'],
      metadata: { k: 'v' },
    });
  });

  it('preserves existing owner when SDK omits it on refresh', () => {
    const store = useTaskStore();
    store.tasks.push({ id: 't1', subject: 's', status: 'pending', owner: 'alice' });
    store.handleTaskList({
      tasks: [{ id: 't1', subject: 's', status: 'in_progress', blockedBy: [] }],
    });
    expect(store.tasks[0]?.owner).toBe('alice');
    expect(store.tasks[0]?.status).toBe('in_progress');
  });

  it('overwrites existing owner when SDK provides a new one', () => {
    const store = useTaskStore();
    store.tasks.push({ id: 't1', subject: 's', status: 'pending', owner: 'alice' });
    store.handleTaskList({
      tasks: [{ id: 't1', subject: 's', status: 'pending', owner: 'bob', blockedBy: [] }],
    });
    expect(store.tasks[0]?.owner).toBe('bob');
  });

  it('drops tasks absent from SDK response', () => {
    const store = useTaskStore();
    store.tasks.push(
      { id: 't1', subject: 's1', status: 'pending' },
      { id: 't2', subject: 's2', status: 'pending' },
    );
    store.handleTaskList({
      tasks: [{ id: 't1', subject: 's1', status: 'pending', blockedBy: [] }],
    });
    expect(store.tasks.map(t => t.id)).toEqual(['t1']);
  });

  it('adds new tasks from SDK response with only SDK-supplied fields', () => {
    const store = useTaskStore();
    store.handleTaskList({
      tasks: [{ id: 't1', subject: 'fresh', status: 'pending', owner: 'bob', blockedBy: ['x'] }],
    });
    expect(store.tasks).toEqual<Task[]>([{
      id: 't1',
      subject: 'fresh',
      status: 'pending',
      owner: 'bob',
      blockedBy: ['x'],
    }]);
  });

  it('filters out entries missing id or subject', () => {
    const store = useTaskStore();
    store.handleTaskList({
      tasks: [
        { id: '', subject: 's', status: 'pending', blockedBy: [] },
        { id: 't1', subject: '', status: 'pending', blockedBy: [] },
        { id: 't2', subject: 'ok', status: 'pending', blockedBy: [] },
      ],
    });
    expect(store.tasks.map(t => t.id)).toEqual(['t2']);
  });
});

describe('useTaskStore.handleTaskGet', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('no-ops when result.task is null', () => {
    const store = useTaskStore();
    store.tasks.push({ id: 't1', subject: 's', status: 'pending' });
    const result: TaskGetOutput = { task: null };
    store.handleTaskGet(result);
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0]?.id).toBe('t1');
  });

  it('merges with existing local fields when id matches', () => {
    const store = useTaskStore();
    store.tasks.push({
      id: 't1',
      subject: 'old',
      status: 'pending',
      activeForm: 'preserved',
      metadata: { keep: true },
    });
    store.handleTaskGet({
      task: {
        id: 't1',
        subject: 'new',
        description: 'new desc',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
      },
    });

    expect(store.tasks[0]).toMatchObject({
      id: 't1',
      subject: 'new',
      description: 'new desc',
      status: 'in_progress',
      activeForm: 'preserved',
      metadata: { keep: true },
    });
  });

  it('inserts a new task when id is not in store', () => {
    const store = useTaskStore();
    store.handleTaskGet({
      task: {
        id: 't1',
        subject: 'fresh',
        description: 'd',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      },
    });
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0]).toMatchObject({ id: 't1', subject: 'fresh', description: 'd' });
  });
});
