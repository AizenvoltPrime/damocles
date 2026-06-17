import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'fs/promises';
import type { PiCodingAgentModule } from '../pi-loader';
import type { PermissionHandler } from '../../permission-handler';
import { buildCustomTools, CUSTOM_TOOL_NAMES } from '../tools';
import { FEEDBACK_MARKER } from '../../../shared/types/constants';

vi.mock('fs/promises', () => ({ readFile: vi.fn() }));

const editExec = vi.fn(async () => ({ content: [{ type: 'text', text: 'edited' }], details: { diff: 'd', patch: 'p' } }));

function fakePi(): PiCodingAgentModule {
  return {
    defineTool: (tool: unknown) => tool,
    createEditToolDefinition: vi.fn(() => ({ execute: editExec })),
  } as unknown as PiCodingAgentModule;
}

function fakePermissionHandler(): PermissionHandler {
  return {
    canUseTool: vi.fn(async (name: string) =>
      name === 'AskUserQuestion'
        ? {
            behavior: 'allow',
            updatedInput: {
              questions: [{ question: 'Pick one?' }],
              answers: { 'Pick one?': 'chosen' },
              annotations: { 'Pick one?': { notes: 'my note' } },
            },
          }
        : { behavior: 'allow', updatedInput: {} },
    ),
    getPermissionMode: vi.fn(() => 'plan'),
    activatePlanMode: vi.fn(async () => undefined),
  } as unknown as PermissionHandler;
}

function build(permissionHandler = fakePermissionHandler()) {
  const tools = buildCustomTools({ pi: fakePi(), cwd: '/cwd', permissionHandler, getSessionId: () => 'sid' });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, (typeof tools)[number]>;
  return { tools, byName, permissionHandler };
}

function props(tool: { parameters: unknown }): string[] {
  return Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {});
}

function parsed(result: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe('buildCustomTools — conformance', () => {
  it('registers exactly the Damocles custom tools, in order', () => {
    const { tools } = build();
    expect(tools.map((t) => t.name)).toEqual([...CUSTOM_TOOL_NAMES]);
  });

  it('added tools use the Claude-Code schemas', () => {
    const { byName } = build();
    expect(props(byName.Edit)).toEqual(['file_path', 'old_string', 'new_string', 'replace_all']);
    expect(props(byName.PowerShell)).toEqual(['command', 'timeout', 'description']);
    expect(props(byName.TaskCreate)).toEqual(['subject', 'description', 'activeForm', 'metadata']);
    expect(props(byName.TaskUpdate)).toEqual(['taskId', 'subject', 'description', 'activeForm', 'status', 'addBlocks', 'addBlockedBy', 'owner', 'metadata']);
    expect(props(byName.TaskList)).toEqual([]);
    expect(props(byName.TaskGet)).toEqual(['taskId']);
    expect(props(byName.AskUserQuestion)).toEqual(['questions']);
  });

  it('does not register any dropped tools', () => {
    for (const dropped of ['CronCreate', 'Workflow', 'TaskStop', 'TaskOutput', 'Monitor', 'EnterWorktree', 'ToolSearch', 'NotebookEdit', 'LSP', 'Agent', 'StructuredOutput']) {
      expect(CUSTOM_TOOL_NAMES).not.toContain(dropped);
    }
  });
});

describe('buildCustomTools — behavior', () => {
  it('Edit delegates the mutation to pi edit with the translated shape', async () => {
    const { byName } = build();
    await byName.Edit.execute('id', { file_path: '/a', old_string: 'x', new_string: 'y' }, undefined, undefined, {} as never);
    expect(editExec).toHaveBeenCalled();
    expect(editExec.mock.calls[0][1]).toEqual({ path: '/a', edits: [{ oldText: 'x', newText: 'y' }] });
  });

  it('Edit replace_all collapses every occurrence into one whole-file edit pi can apply uniquely', async () => {
    editExec.mockClear();
    vi.mocked(readFile).mockResolvedValue(Buffer.from('foo a foo b foo'));
    const { byName } = build();
    await byName.Edit.execute('id', { file_path: '/a', old_string: 'foo', new_string: 'bar', replace_all: true }, undefined, undefined, {} as never);
    expect(editExec.mock.calls[0][1]).toEqual({ path: '/a', edits: [{ oldText: 'foo a foo b foo', newText: 'bar a bar b bar' }] });
  });

  it('Edit replace_all throws when old_string is absent (mirrors CC not-found)', async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('nothing here'));
    const { byName } = build();
    await expect(
      byName.Edit.execute('id', { file_path: '/a', old_string: 'foo', new_string: 'bar', replace_all: true }, undefined, undefined, {} as never),
    ).rejects.toThrow('not found');
  });

  it('AskUserQuestion returns the full SDK output (questions + answers + annotations) the card and model read', async () => {
    const { byName, permissionHandler } = build();
    const result = parsed(await byName.AskUserQuestion.execute('id', { questions: [{ question: 'Pick one?' }] }, undefined, undefined, {} as never));
    expect(permissionHandler.canUseTool).toHaveBeenCalledWith('AskUserQuestion', expect.anything(), expect.anything());
    expect(result.answers).toEqual({ 'Pick one?': 'chosen' });
    expect(result.annotations).toEqual({ 'Pick one?': { notes: 'my note' } });
    expect(result.questions).toEqual([{ question: 'Pick one?' }]);
  });

  it('EnterPlanMode activates plan mode', async () => {
    const { byName, permissionHandler } = build();
    await byName.EnterPlanMode.execute('id', {}, undefined, undefined, {} as never);
    expect(permissionHandler.activatePlanMode).toHaveBeenCalled();
  });

  it('ExitPlanMode rejection throws an error tool result carrying the denial marker (renders denied, not completed)', async () => {
    const ph = {
      canUseTool: vi.fn(async () => ({ behavior: 'deny', message: `Plan rejected. ${FEEDBACK_MARKER} please add tests first` })),
      getPermissionMode: vi.fn(() => 'plan'),
      activatePlanMode: vi.fn(async () => undefined),
    } as unknown as PermissionHandler;
    const { byName } = build(ph);
    await expect(
      byName.ExitPlanMode.execute('id', { plan: 'p' }, undefined, undefined, {} as never),
    ).rejects.toThrow(FEEDBACK_MARKER);
  });

  it('AskUserQuestion cancellation throws with the denial marker (renders denied, not completed)', async () => {
    const ph = {
      canUseTool: vi.fn(async () => ({ behavior: 'deny', message: 'User cancelled the question prompt' })),
      getPermissionMode: vi.fn(() => 'default'),
      activatePlanMode: vi.fn(async () => undefined),
    } as unknown as PermissionHandler;
    const { byName } = build(ph);
    await expect(
      byName.AskUserQuestion.execute('id', { questions: [] }, undefined, undefined, {} as never),
    ).rejects.toThrow(FEEDBACK_MARKER);
  });

  it('Task tools mirror the SDK contract: create returns id+subject, list/get reflect state', async () => {
    const { byName } = build();

    const created = parsed(await byName.TaskCreate.execute('id', { subject: 'Ship it', description: 'do the thing', activeForm: 'Shipping it' }, undefined, undefined, {} as never));
    expect(created).toEqual({ task: { id: '1', subject: 'Ship it' } });

    const listed = parsed(await byName.TaskList.execute('id', {}, undefined, undefined, {} as never));
    expect(listed.tasks).toEqual([{ id: '1', subject: 'Ship it', status: 'pending', blockedBy: [] }]);

    const got = parsed(await byName.TaskGet.execute('id', { taskId: '1' }, undefined, undefined, {} as never));
    expect(got.task).toMatchObject({ id: '1', subject: 'Ship it', description: 'do the thing', status: 'pending', blocks: [], blockedBy: [] });
  });

  it('TaskUpdate changes status (with statusChange) and reports updated fields', async () => {
    const { byName } = build();
    await byName.TaskCreate.execute('id', { subject: 'A', description: 'a' }, undefined, undefined, {} as never);

    const upd = parsed(await byName.TaskUpdate.execute('id', { taskId: '1', status: 'in_progress' }, undefined, undefined, {} as never));
    expect(upd).toEqual({ success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'in_progress' } });

    const got = parsed(await byName.TaskGet.execute('id', { taskId: '1' }, undefined, undefined, {} as never));
    expect((got.task as { status: string }).status).toBe('in_progress');
  });

  it('TaskUpdate addBlockedBy records reciprocal blocks/blockedBy edges', async () => {
    const { byName } = build();
    await byName.TaskCreate.execute('id', { subject: 'A', description: 'a' }, undefined, undefined, {} as never);
    await byName.TaskCreate.execute('id', { subject: 'B', description: 'b' }, undefined, undefined, {} as never);

    await byName.TaskUpdate.execute('id', { taskId: '2', addBlockedBy: ['1'] }, undefined, undefined, {} as never);

    const two = parsed(await byName.TaskGet.execute('id', { taskId: '2' }, undefined, undefined, {} as never));
    expect((two.task as { blockedBy: string[] }).blockedBy).toEqual(['1']);
    const one = parsed(await byName.TaskGet.execute('id', { taskId: '1' }, undefined, undefined, {} as never));
    expect((one.task as { blocks: string[] }).blocks).toEqual(['2']);
  });

  it('TaskUpdate status:deleted removes the task and cleans dependency edges', async () => {
    const { byName } = build();
    await byName.TaskCreate.execute('id', { subject: 'A', description: 'a' }, undefined, undefined, {} as never);
    await byName.TaskCreate.execute('id', { subject: 'B', description: 'b' }, undefined, undefined, {} as never);
    await byName.TaskUpdate.execute('id', { taskId: '2', addBlockedBy: ['1'] }, undefined, undefined, {} as never);

    await byName.TaskUpdate.execute('id', { taskId: '1', status: 'deleted' }, undefined, undefined, {} as never);

    const listed = parsed(await byName.TaskList.execute('id', {}, undefined, undefined, {} as never));
    expect((listed.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual(['2']);
    const two = parsed(await byName.TaskGet.execute('id', { taskId: '2' }, undefined, undefined, {} as never));
    expect((two.task as { blockedBy: string[] }).blockedBy).toEqual([]);
  });

  it('TaskUpdate on a missing task fails without throwing', async () => {
    const { byName } = build();
    const res = parsed(await byName.TaskUpdate.execute('id', { taskId: '99' }, undefined, undefined, {} as never));
    expect(res.success).toBe(false);
    expect(res.error).toContain('99');
  });
});
