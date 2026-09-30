import { describe, it, expect } from 'vitest';
import { validateToolArguments, type Tool } from '@earendil-works/pi-ai';
import { buildSubagentTools } from '../subagent-tools';
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
    const tools = buildSubagentTools(piStub, { getSpawnableAgents: () => [], ...manager } as AgentManager);
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

  const BAD = 'Pass either resume (with optional message) or description + prompt + subagent_type.';

  it.each([
    ['neither form', {}],
    ['a partial spawn', { description: 'd', prompt: 'p' }],
    ['both forms', { ...params, resume: '0a1b2c3d-4e5f-4a0' }],
    ['a resume with spawn options', { resume: '0a1b2c3d-4e5f-4a0', run_in_background: true }],
    ['a message without resume', { ...params, message: 'go' }],
  ])('rejects %s', async (_label, args) => {
    const execute = agentTool({ resolveRunInBackground: () => false });
    await expect(execute('tc', args)).rejects.toThrow(BAD);
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

describe('SteerSubagent arguments', () => {
  const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  const steerTool = buildSubagentTools(piStub, { getSpawnableAgents: () => [] } as unknown as AgentManager)[2] as unknown as Tool;
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
