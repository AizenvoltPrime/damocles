import { describe, it, expect, vi } from 'vitest';
import { validateToolArguments, type Tool } from '@earendil-works/pi-ai';
import { buildSubagentTools, NO_USER_INPUT, type UserInput } from '../subagent-tools';
import { recordResultText } from '../../subagents/status-note';
import type { AgentManager } from '../../subagents/agent-manager';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { AgentRecord } from '../../subagents/types';
import { emptyAgentUsage } from '../../../../shared/usage-accounting';

function rec(over: Partial<AgentRecord>): AgentRecord {
  return {
    id: 'a1', type: 'Explore', description: 'find things', status: 'completed', toolCallId: 'tc1',
    toolUses: 0, startedAt: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, usage: emptyAgentUsage(), compactionCount: 0,
    ...over,
  };
}

describe('recordResultText', () => {
  it('prefixes a line per user steer before the composed result text', () => {
    const out = recordResultText(rec({ result: 'done', userSteers: [{ message: 'focus on tests' }, { message: 'skip UI' }] }));
    expect(out).toBe('[User steered this agent mid-task: "focus on tests"]\n[User steered this agent mid-task: "skip UI"]\ndone');
  });

  it('notes the image count of an image steer, and an image-only steer as (no text)', () => {
    const out = recordResultText(rec({ result: 'done', userSteers: [{ message: 'look at this', imageCount: 2 }, { message: '', imageCount: 1 }] }));
    expect(out).toBe('[User steered this agent mid-task: "look at this" (+2 images)]\n[User steered this agent mid-task: (no text) (+1 image)]\ndone');
  });

  it('is byte-for-byte unchanged when no user steers occurred', () => {
    expect(recordResultText(rec({ result: 'done' }))).toBe('done');
  });
});

describe('Agent tool result details', () => {
  const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  type Exec = (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }>; details: unknown }>;

  function agentTool(manager: Partial<AgentManager>): Exec {
    const tools = buildSubagentTools(piStub, { getSpawnableAgents: () => [], ...manager } as AgentManager, NO_USER_INPUT);
    return (tools[0] as unknown as { execute: Exec }).execute;
  }
  const params = { description: 'd', prompt: 'p', subagent_type: 'Explore' };

  it('a background spawn acknowledges with the agent id and async_launched', async () => {
    const execute = agentTool({ resolveRunInBackground: () => true, spawn: () => 'agent-1' });
    const result = await execute('tc1', params);
    expect(result.details).toEqual({ agentId: 'agent-1', status: 'async_launched' });
  });

  it('a foreground spawn carries its terminal status and stop reason, outside the model-visible text', async () => {
    const execute = agentTool({
      resolveRunInBackground: () => false,
      spawnAndWait: async () => rec({ id: 'agent-2', status: 'stopped', stopReason: 'shutdown', result: 'partial' }),
    });
    const result = await execute('tc2', params);
    expect(result.details).toEqual({ agentId: 'agent-2', status: 'stopped', stopReason: 'shutdown' });
    expect(result.content[0]!.text).not.toContain('shutdown');
  });

  it.each([
    ['stopped', { status: 'stopped', stopReason: 'user', result: 'partial' }],
    ['completed', { status: 'completed', result: 'ok' }],
    ['error', { status: 'error', error: 'boom' }],
  ] as const)('a foreground %s result JSON carries the agent status', async (status, over) => {
    const execute = agentTool({ resolveRunInBackground: () => false, spawnAndWait: async () => rec({ id: 'agent-s', ...over }) });
    const result = await execute('tc-s', params);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ agentId: 'agent-s', agentStatus: status });
  });

  it('a clean foreground completion has no stop reason', async () => {
    const execute = agentTool({ resolveRunInBackground: () => false, spawnAndWait: async () => rec({ id: 'agent-3', result: 'ok' }) });
    expect((await execute('tc3', params)).details).toEqual({ agentId: 'agent-3', status: 'completed' });
  });

  const RESUMED_MODE = 'A resumed agent keeps the foreground or background mode it was started in.';
  const RESUME_INSTEAD = 'To continue a stopped agent, pass resume instead.';

  it.each([
    ['neither form', {}, `A new agent needs description, prompt and subagent_type: missing description, prompt, subagent_type. ${RESUME_INSTEAD}`],
    ['a partial spawn', { description: 'd', prompt: 'p' }, `A new agent needs description, prompt and subagent_type: missing subagent_type. ${RESUME_INSTEAD}`],
    ['both forms', { ...params, resume: '0a1b2c3d-4e5f-4a0' }, 'A resume takes only resume and an optional message: remove description, prompt, subagent_type.'],
    ['a resume with run_in_background', { resume: '0a1b2c3d-4e5f-4a0', message: 'go on', run_in_background: true }, `A resume takes only resume and an optional message: remove run_in_background. ${RESUMED_MODE}`],
    ['a resume with run_in_background false', { resume: '0a1b2c3d-4e5f-4a0', run_in_background: false }, `A resume takes only resume and an optional message: remove run_in_background. ${RESUMED_MODE}`],
    ['a message without resume', { ...params, message: 'go' }, 'message goes only with resume: put a new agent\'s instructions in prompt.'],
    ['a message on a partial spawn', { prompt: 'p', message: 'go' }, `A new agent needs description, prompt and subagent_type: missing description, subagent_type. ${RESUME_INSTEAD} message goes only with resume: put a new agent's instructions in prompt.`],
  ])('rejects %s, naming the fields to change', async (_label, args, error) => {
    const resume = async () => { throw new Error('resume must not run'); };
    const execute = agentTool({ resolveRunInBackground: () => false, resume, spawn: () => 'never', spawnAndWait: resume });
    await expect(execute('tc', args)).rejects.toThrow(new Error(error));
  });

  it('a foreground resume blocks and returns the resumed run result and details', async () => {
    const resumed = rec({ id: '0a1b2c3d-4e5f-4a0', toolCallId: 'tc-r', result: 'fixed', background: false });
    resumed.promise = Promise.resolve('fixed');
    const calls: unknown[] = [];
    const execute = agentTool({ resume: async (req) => (calls.push(req), resumed) });
    const signal = new AbortController().signal;

    const result = await execute('tc-r', { resume: '0a1b2c3d-4e5f-4a0', message: 'go on' }, signal);

    expect(calls).toEqual([{ kind: 'resume', agentId: '0a1b2c3d-4e5f-4a0', message: 'go on', toolCallId: 'tc-r', signal }]);
    expect(result.details).toEqual({ agentId: '0a1b2c3d-4e5f-4a0', status: 'completed' });
    expect(result.content[0]!.text).toContain('fixed');
  });

  it('a background resume acknowledges at once; its result comes through the keep-alive', async () => {
    const resumed = rec({ id: '0a1b2c3d-4e5f-4a0', status: 'running', background: true });
    resumed.promise = new Promise(() => {});
    const execute = agentTool({ resume: async () => resumed });

    const result = await execute('tc-r', { resume: '0a1b2c3d-4e5f-4a0' });

    expect(result.details).toEqual({ agentId: '0a1b2c3d-4e5f-4a0', status: 'async_launched' });
  });

  it('a resume validation error is thrown verbatim so pi marks the result as an error', async () => {
    const execute = agentTool({ resume: async () => { throw new Error('No interrupted subagent "0a1b2c3d-4e5f-4a0" in this conversation.'); } });
    await expect(execute('tc-r', { resume: '0a1b2c3d-4e5f-4a0' })).rejects.toThrow('No interrupted subagent "0a1b2c3d-4e5f-4a0" in this conversation.');
  });

  it('a stopped foreground result names the resume call; a budget stop says it cannot be resumed', () => {
    expect(recordResultText(rec({ id: 'x1', status: 'stopped', stopReason: 'user', result: 'half' }))).toBe(
      'half (STOPPED BY THE USER before completion; output is partial. Resume it with Agent({resume:"x1"}) if the user asks to continue.)',
    );
    expect(recordResultText(rec({ id: 'x1', status: 'stopped', stopReason: 'budget', result: 'half' }))).toBe(
      'half (stopped by the budget limit before completion; output is partial and it cannot be resumed)',
    );
  });
});

describe('GetSubagentResult wait', () => {
  const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  type Exec = (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
  const EARLY = 'Subagent "a1" is still running. The user sent a message while you waited; read it, then call GetSubagentResult again with wait:true if you still need the result.';

  /** A user input signal the test fires, as PiSession's queue does when the user queues a message. */
  function fakeInput(pending = false) {
    const waiters = new Set<() => void>();
    const input: UserInput = {
      pending: () => pending,
      next: (signal) => new Promise<void>((resolve) => {
        const done = (): void => {
          waiters.delete(done);
          resolve();
        };
        waiters.add(done);
        signal.addEventListener('abort', done, { once: true });
      }),
    };
    return { input, fire: () => { pending = true; for (const waiter of [...waiters]) waiter(); }, waiting: () => waiters.size };
  }

  function getResult(record: AgentRecord, input: UserInput): Exec {
    const manager = { getSpawnableAgents: () => [], branchRecord: () => record } as unknown as AgentManager;
    return (buildSubagentTools(piStub, manager, input)[1] as unknown as { execute: Exec }).execute;
  }

  function running(): { record: AgentRecord; finish: (text: string) => void } {
    let finish!: (text: string) => void;
    const record = rec({ status: 'running' });
    record.promise = new Promise<string>((resolve) => { finish = (text) => { Object.assign(record, { status: 'completed', result: text }); resolve(text); }; });
    return { record, finish };
  }

  /** The result if `promise` settles within one macrotask, else 'pending'. */
  async function withinATurn<T>(promise: Promise<T>): Promise<T | 'pending'> {
    return Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))]);
  }

  it('returns as soon as the user queues a message, telling the model to read it', async () => {
    const { record } = running();
    const { input, fire, waiting } = fakeInput();
    const result = getResult(record, input)('tc', { agent_id: 'a1', wait: true });
    await vi.waitFor(() => expect(waiting()).toBe(1));
    fire();
    const answered = await withinATurn(result);
    expect(answered).not.toBe('pending');
    expect((answered as Awaited<typeof result>).content[0]!.text).toBe(EARLY);
    expect(waiting()).toBe(0);
  });

  it('returns at once when the user already queued something', async () => {
    const { record } = running();
    const result = await withinATurn(getResult(record, fakeInput(true).input)('tc', { agent_id: 'a1', wait: true }));
    expect(result).not.toBe('pending');
    expect((result as { content: Array<{ text: string }> }).content[0]!.text).toBe(EARLY);
  });

  it('returns at once on a Stop, and stops listening for input', async () => {
    const { record } = running();
    const { input, waiting } = fakeInput();
    const stop = new AbortController();
    const result = getResult(record, input)('tc', { agent_id: 'a1', wait: true }, stop.signal);
    await vi.waitFor(() => expect(waiting()).toBe(1));
    stop.abort();
    const answered = await withinATurn(result);
    expect(answered).not.toBe('pending');
    expect((answered as Awaited<typeof result>).content[0]!.text).toBe('Subagent "a1" is still running. Call again with wait:true to block until it finishes.');
    expect(waiting()).toBe(0);
  });

  it('returns the result when the agent finishes first, and stops listening for input', async () => {
    const { record, finish } = running();
    const { input, waiting } = fakeInput();
    const result = getResult(record, input)('tc', { agent_id: 'a1', wait: true });
    await vi.waitFor(() => expect(waiting()).toBe(1));
    finish('all done');
    expect((await result).content[0]!.text).toBe('all done');
    expect(waiting()).toBe(0);
  });
});

describe('SteerSubagent arguments', () => {
  const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  const steerTool = buildSubagentTools(piStub, { getSpawnableAgents: () => [] } as unknown as AgentManager, NO_USER_INPUT)[2] as unknown as Tool;
  const validate = (message: string) =>
    validateToolArguments(steerTool, { type: 'toolCall', id: 'tc', name: steerTool.name, arguments: { agent_id: 'a1', message } });

  // A blank message would deliver the bare marker, which the steering protocol reads as an image-only steer.
  it.each(['', '   ', '\n\t'])('pi rejects the blank message %j before execute, naming the field', (message) => {
    expect(() => validate(message)).toThrow('- message: must match pattern');
  });

  it('accepts a message with text', () => {
    expect(validate(' focus on tests ')).toEqual({ agent_id: 'a1', message: ' focus on tests ' });
  });
});
