import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'fs/promises';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../pi-loader';
import type { PermissionHandler } from '../../permission-handler';
import { buildCustomTools, CUSTOM_TOOL_NAMES, OVERRIDE_TOOL_NAMES } from '../tools';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import { WEB_PI_TOOL_NAMES } from '../web-access';
import { FEEDBACK_MARKER } from '../../../shared/types/constants';

vi.mock('fs/promises', () => ({ readFile: vi.fn() }));

type EditToolExecute = ReturnType<PiCodingAgentModule['createEditToolDefinition']>['execute'];

const editExec = vi.fn<EditToolExecute>(async () => ({ content: [{ type: 'text', text: 'edited' }], details: { diff: 'd', patch: 'p' } }));

function fakePi(): PiCodingAgentModule {
  return {
    defineTool: (tool: unknown) => tool,
    createEditToolDefinition: vi.fn(() => ({ execute: editExec })),
    // The bash override spreads its metadata from a delegate built at construction, so this stub must
    // answer with a whole definition, not just an `execute`.
    createBashToolDefinition: vi.fn(() => ({ name: 'bash', label: 'Bash', description: 'pi bash', parameters: {}, execute: vi.fn() })),
  } as unknown as PiCodingAgentModule;
}

/** Required of every caller, and irrelevant to what this file asserts. */
const shellDeps = (): { getShellOptions: () => Record<string, never>; shellCancel: ShellCancelStore; deliverUserNote: (text: string) => void; shellJob: undefined } => ({
  getShellOptions: () => ({}),
  shellCancel: new ShellCancelStore(),
  deliverUserNote: () => undefined,
  // The job object is win32-only and this file asserts tool composition, not process lifetime.
  shellJob: undefined,
});

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

type BuiltTool = ReturnType<typeof buildCustomTools>[number];
type SubagentManagerArg = NonNullable<Parameters<typeof buildCustomTools>[0]['subagentManager']>;

/** Name lookup that fails loudly: an absent tool must not silently read as `undefined`. */
function lookup(tools: readonly BuiltTool[]): (name: string) => BuiltTool {
  return (name) => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`custom tool not registered: ${name}`);
    return found;
  };
}

function build(permissionHandler = fakePermissionHandler()) {
  // A stub subagent manager so the three Phase 5 subagent tools are appended. Registration reads the
  // spawnable-agent list (to advertise subagent_type values); the primary session always wires one.
  const subagentManager = { getSpawnableAgents: () => [] } as unknown as SubagentManagerArg;
  const tools = buildCustomTools({ pi: fakePi(), cwd: '/cwd', permissionHandler, getSessionId: () => 'sid', subagentManager, ...shellDeps() });
  return { tools, tool: lookup(tools), permissionHandler };
}

type SteerStatus = 'steered' | 'queued' | 'finished' | 'failed' | 'not-found';
type SteerRecord = { type: string; description: string };

function buildWithSteer(status: SteerStatus, record?: SteerRecord) {
  const subagentManager = {
    getSpawnableAgents: () => [],
    steer: async () => status,
    getRecord: () => record,
  } as unknown as SubagentManagerArg;
  const tools = buildCustomTools({ pi: fakePi(), cwd: '/cwd', permissionHandler: fakePermissionHandler(), getSessionId: () => 'sid', subagentManager, ...shellDeps() });
  return { tool: lookup(tools) };
}

function props(tool: BuiltTool): string[] {
  return Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {});
}

/** The tool result's leading text block, asserting it IS text rather than reading `undefined`. */
function parsedText(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('tool result did not start with a text block');
  return first.text;
}

function parsed(result: AgentToolResult<unknown>): Record<string, unknown> {
  return JSON.parse(parsedText(result)) as Record<string, unknown>;
}

describe('buildCustomTools — conformance', () => {
  it('registers the Damocles custom tools then the always-built web tools, in order', () => {
    const { tools } = build();
    expect(tools.map((t) => t.name)).toEqual([...OVERRIDE_TOOL_NAMES, ...CUSTOM_TOOL_NAMES, ...WEB_PI_TOOL_NAMES]);
  });

  it('added tools use the Claude-Code schemas', () => {
    const { tool } = build();
    expect(props(tool('Edit'))).toEqual(['file_path', 'old_string', 'new_string', 'replace_all']);
    expect(props(tool('PowerShell'))).toEqual(['command', 'timeout', 'description']);
    expect(props(tool('TaskCreate'))).toEqual(['subject', 'description', 'activeForm', 'metadata']);
    expect(props(tool('TaskUpdate'))).toEqual(['taskId', 'subject', 'description', 'activeForm', 'status', 'addBlocks', 'addBlockedBy', 'owner', 'metadata']);
    expect(props(tool('TaskList'))).toEqual([]);
    expect(props(tool('TaskGet'))).toEqual(['taskId']);
    expect(props(tool('AskUserQuestion'))).toEqual(['questions']);
  });

  // `ToolSearch` left this list deliberately: it EXISTS, but `pi.setActiveTools`/`getActiveTools` live
  // only on `ExtensionAPI`, never on the `ExtensionContext` a customTools `execute` receives — so it is
  // registered by the extension factory (`damocles-extension.ts`), not by `buildCustomTools`.
  // `CUSTOM_TOOL_NAMES` legitimately omits it; its registration is covered by damocles-extension.test.ts
  // and its behaviour by tool-search.test.ts. Everything below is still genuinely dropped.
  it('does not register any dropped tools', () => {
    for (const dropped of ['CronCreate', 'Workflow', 'TaskStop', 'TaskOutput', 'EnterWorktree', 'NotebookEdit', 'LSP', 'StructuredOutput']) {
      expect(CUSTOM_TOOL_NAMES).not.toContain(dropped);
    }
  });

  it('registers the three native subagent tools (Phase 5)', () => {
    const names = build().tools.map((t) => t.name);
    expect(names).toContain('Agent');
    expect(names).toContain('GetSubagentResult');
    expect(names).toContain('SteerSubagent');
  });

  it('omits the subagent tools when no manager is wired (nested subagents — no recursion)', () => {
    const nested = buildCustomTools({ pi: fakePi(), cwd: '/cwd', permissionHandler: fakePermissionHandler(), getSessionId: () => 'sid', ...shellDeps() });
    const names = nested.map((t) => t.name);
    expect(names).not.toContain('Agent');
    expect(names).not.toContain('GetSubagentResult');
    expect(names).not.toContain('SteerSubagent');
  });
});

describe('buildCustomTools — behavior', () => {
  it('Edit delegates the mutation to pi edit with the translated shape', async () => {
    const { tool } = build();
    await tool('Edit').execute('id', { file_path: '/a', old_string: 'x', new_string: 'y' }, undefined, undefined, {} as never);
    expect(editExec).toHaveBeenCalled();
    expect(editExec.mock.calls[0]![1]).toEqual({ path: '/a', edits: [{ oldText: 'x', newText: 'y' }] });
  });

  it('Edit replace_all collapses every occurrence into one whole-file edit pi can apply uniquely', async () => {
    editExec.mockClear();
    vi.mocked(readFile).mockResolvedValue(Buffer.from('foo a foo b foo'));
    const { tool } = build();
    await tool('Edit').execute('id', { file_path: '/a', old_string: 'foo', new_string: 'bar', replace_all: true }, undefined, undefined, {} as never);
    expect(editExec.mock.calls[0]![1]).toEqual({ path: '/a', edits: [{ oldText: 'foo a foo b foo', newText: 'bar a bar b bar' }] });
  });

  it('Edit replace_all throws when old_string is absent (mirrors CC not-found)', async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from('nothing here'));
    const { tool } = build();
    await expect(
      tool('Edit').execute('id', { file_path: '/a', old_string: 'foo', new_string: 'bar', replace_all: true }, undefined, undefined, {} as never),
    ).rejects.toThrow('not found');
  });

  it('AskUserQuestion returns the full SDK output (questions + answers + annotations) the card and model read', async () => {
    const { tool, permissionHandler } = build();
    const result = parsed(await tool('AskUserQuestion').execute('id', { questions: [{ question: 'Pick one?' }] }, undefined, undefined, {} as never));
    expect(permissionHandler.canUseTool).toHaveBeenCalledWith('AskUserQuestion', expect.anything(), expect.anything());
    expect(result.answers).toEqual({ 'Pick one?': 'chosen' });
    expect(result.annotations).toEqual({ 'Pick one?': { notes: 'my note' } });
    expect(result.questions).toEqual([{ question: 'Pick one?' }]);
  });

  it('EnterPlanMode activates plan mode', async () => {
    const { tool, permissionHandler } = build();
    await tool('EnterPlanMode').execute('id', {}, undefined, undefined, {} as never);
    expect(permissionHandler.activatePlanMode).toHaveBeenCalled();
  });

  it('ExitPlanMode rejection throws an error tool result carrying the denial marker (renders denied, not completed)', async () => {
    const ph = {
      canUseTool: vi.fn(async () => ({ behavior: 'deny', message: `Plan rejected. ${FEEDBACK_MARKER} please add tests first` })),
      getPermissionMode: vi.fn(() => 'plan'),
      activatePlanMode: vi.fn(async () => undefined),
    } as unknown as PermissionHandler;
    const { tool } = build(ph);
    await expect(
      tool('ExitPlanMode').execute('id', {}, undefined, undefined, {} as never),
    ).rejects.toThrow(FEEDBACK_MARKER);
  });

  it('AskUserQuestion cancellation throws with the denial marker (renders denied, not completed)', async () => {
    const ph = {
      canUseTool: vi.fn(async () => ({ behavior: 'deny', message: 'User cancelled the question prompt' })),
      getPermissionMode: vi.fn(() => 'default'),
      activatePlanMode: vi.fn(async () => undefined),
    } as unknown as PermissionHandler;
    const { tool } = build(ph);
    await expect(
      tool('AskUserQuestion').execute('id', { questions: [] }, undefined, undefined, {} as never),
    ).rejects.toThrow(FEEDBACK_MARKER);
  });

  it('Task tools mirror the SDK contract: create returns id+subject, list/get reflect state', async () => {
    const { tool } = build();

    const created = parsed(await tool('TaskCreate').execute('id', { subject: 'Ship it', description: 'do the thing', activeForm: 'Shipping it' }, undefined, undefined, {} as never));
    expect(created).toEqual({ task: { id: '1', subject: 'Ship it' } });

    const listed = parsed(await tool('TaskList').execute('id', {}, undefined, undefined, {} as never));
    expect(listed.tasks).toEqual([{ id: '1', subject: 'Ship it', status: 'pending', blockedBy: [] }]);

    const got = parsed(await tool('TaskGet').execute('id', { taskId: '1' }, undefined, undefined, {} as never));
    expect(got.task).toMatchObject({ id: '1', subject: 'Ship it', description: 'do the thing', status: 'pending', blocks: [], blockedBy: [] });
  });

  it('TaskUpdate changes status (with statusChange) and reports updated fields', async () => {
    const { tool } = build();
    await tool('TaskCreate').execute('id', { subject: 'A', description: 'a' }, undefined, undefined, {} as never);

    const upd = parsed(await tool('TaskUpdate').execute('id', { taskId: '1', status: 'in_progress' }, undefined, undefined, {} as never));
    expect(upd).toEqual({ success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'in_progress' } });

    const got = parsed(await tool('TaskGet').execute('id', { taskId: '1' }, undefined, undefined, {} as never));
    expect((got.task as { status: string }).status).toBe('in_progress');
  });

  it('TaskUpdate addBlockedBy records reciprocal blocks/blockedBy edges', async () => {
    const { tool } = build();
    await tool('TaskCreate').execute('id', { subject: 'A', description: 'a' }, undefined, undefined, {} as never);
    await tool('TaskCreate').execute('id', { subject: 'B', description: 'b' }, undefined, undefined, {} as never);

    await tool('TaskUpdate').execute('id', { taskId: '2', addBlockedBy: ['1'] }, undefined, undefined, {} as never);

    const two = parsed(await tool('TaskGet').execute('id', { taskId: '2' }, undefined, undefined, {} as never));
    expect((two.task as { blockedBy: string[] }).blockedBy).toEqual(['1']);
    const one = parsed(await tool('TaskGet').execute('id', { taskId: '1' }, undefined, undefined, {} as never));
    expect((one.task as { blocks: string[] }).blocks).toEqual(['2']);
  });

  it('TaskUpdate status:deleted removes the task and cleans dependency edges', async () => {
    const { tool } = build();
    await tool('TaskCreate').execute('id', { subject: 'A', description: 'a' }, undefined, undefined, {} as never);
    await tool('TaskCreate').execute('id', { subject: 'B', description: 'b' }, undefined, undefined, {} as never);
    await tool('TaskUpdate').execute('id', { taskId: '2', addBlockedBy: ['1'] }, undefined, undefined, {} as never);

    await tool('TaskUpdate').execute('id', { taskId: '1', status: 'deleted' }, undefined, undefined, {} as never);

    const listed = parsed(await tool('TaskList').execute('id', {}, undefined, undefined, {} as never));
    expect((listed.tasks as Array<{ id: string }>).map((t) => t.id)).toEqual(['2']);
    const two = parsed(await tool('TaskGet').execute('id', { taskId: '2' }, undefined, undefined, {} as never));
    expect((two.task as { blockedBy: string[] }).blockedBy).toEqual([]);
  });

  it('TaskUpdate on a missing task fails without throwing', async () => {
    const { tool } = build();
    const res = parsed(await tool('TaskUpdate').execute('id', { taskId: '99' }, undefined, undefined, {} as never));
    expect(res.success).toBe(false);
    expect(res.error).toContain('99');
  });
});

describe('SteerSubagent — details + phrasings', () => {
  const record: SteerRecord = { type: 'general-purpose', description: 'The background worker' };

  const expectedText: Record<SteerStatus, string> = {
    steered: 'Steering message delivered to subagent "a1".',
    queued: 'Subagent "a1" is not ready yet; the message was queued and will be delivered when it starts.',
    finished: 'Subagent "a1" has already finished — nothing to steer.',
    failed: 'Steering message could NOT be delivered to subagent "a1" (it may be mid-shutdown). Try again or read its result with GetSubagentResult.',
    'not-found': 'No subagent found with id "a1".',
  };

  for (const status of ['steered', 'queued', 'finished', 'failed', 'not-found'] as SteerStatus[]) {
    it(`emits details.steerStatus="${status}" and preserves the model-facing phrasing`, async () => {
      const { tool } = buildWithSteer(status, record);
      const result = await tool('SteerSubagent').execute('tc', { agent_id: 'a1', message: 'go left' }, undefined, undefined, {} as never);
      expect((result as { details: { steerStatus: string } }).details.steerStatus).toBe(status);
      expect(parsedText(result)).toBe(expectedText[status]);
    });
  }

  it('carries agentType/description from the looked-up record', async () => {
    const { tool } = buildWithSteer('steered', record);
    const result = await tool('SteerSubagent').execute('tc', { agent_id: 'a1', message: 'go left' }, undefined, undefined, {} as never);
    const details = (result as { details: { agentType?: string; description?: string } }).details;
    expect(details.agentType).toBe('general-purpose');
    expect(details.description).toBe('The background worker');
  });

  it('omits agentType/description when no record exists', async () => {
    const { tool } = buildWithSteer('not-found', undefined);
    const result = await tool('SteerSubagent').execute('tc', { agent_id: 'a1', message: 'go left' }, undefined, undefined, {} as never);
    expect((result as { details: object }).details).toEqual({ steerStatus: 'not-found' });
  });
});

/**
 * `deliverUserNote` is per build context, and this is the seam that carries it from the deps object to
 * the shell tools. Which agent each context names is asserted in `tools/__tests__/note-delivery.test.ts`.
 */
describe('cancel note delivery wiring', () => {
  /** A bash delegate that settles only when the signal it was handed aborts, so a Stop lands on a live call. */
  function hangingPi(): PiCodingAgentModule {
    return {
      ...fakePi(),
      createBashToolDefinition: () => ({
        name: 'bash',
        label: 'Bash',
        description: 'pi bash',
        parameters: {},
        execute: async (_id: string, _params: unknown, signal?: AbortSignal) => {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return { content: [{ type: 'text', text: 'partial' }], details: undefined };
        },
      }),
    } as unknown as PiCodingAgentModule;
  }

  function buildShellContext(shellCancel: ShellCancelStore, deliverUserNote: (text: string) => void) {
    const tools = buildCustomTools({
      pi: hangingPi(),
      cwd: '/cwd',
      permissionHandler: fakePermissionHandler(),
      getSessionId: () => 'sid',
      getShellOptions: () => ({}),
      shellCancel,
      deliverUserNote,
      shellJob: undefined,
    });
    return lookup(tools)('bash');
  }

  it('threads the context callback into the shell tools, so a Stop with a note reaches it', async () => {
    const delivered: string[] = [];
    const shellCancel = new ShellCancelStore();
    const bash = buildShellContext(shellCancel, (text) => delivered.push(text));

    const pending = bash.execute('c1', { command: 'sleep 300' }, undefined, undefined, {} as never);
    // Non-vacuous: an unregistered call answers false, so this also proves the tool registered itself.
    expect(shellCancel.cancel('c1', 'wrong loop, use seq 1 5')).toBe(true);
    await pending;

    expect(delivered).toEqual(['wrong loop, use seq 1 5']);
  });

  it("gives each context its own delivery, so one agent's note never lands on another", async () => {
    const main: string[] = [];
    const nested: string[] = [];
    const shellCancel = new ShellCancelStore();
    const mainBash = buildShellContext(shellCancel, (text) => main.push(text));
    const nestedBash = buildShellContext(shellCancel, (text) => nested.push(text));

    const mainPending = mainBash.execute('main-1', { command: 'sleep 300' }, undefined, undefined, {} as never);
    const nestedPending = nestedBash.execute('nested-1', { command: 'sleep 300' }, undefined, undefined, {} as never);

    expect(shellCancel.cancel('nested-1', 'wrong dir')).toBe(true);
    await nestedPending;
    expect(nested).toEqual(['wrong dir']);
    expect(main).toEqual([]);

    expect(shellCancel.cancel('main-1', 'and stop that too')).toBe(true);
    await mainPending;
    expect(main).toEqual(['and stop that too']);
    expect(nested).toEqual(['wrong dir']);
  });
});
