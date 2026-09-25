import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { ContentBlock } from '@shared/types/content';
import { CANCELLED_TOOL_DETAIL_KEY, type ToolCall } from '@shared/types/session';
import { subagentHeading, useSubagentStore } from '../useSubagentStore';
import { i18n } from '@/i18n';
import { defined } from '@/__tests__/helpers';

function nestedTool(store: ReturnType<typeof useSubagentStore>, agentId: string, toolId: string): ToolCall {
  const agent = defined(store.subagents[agentId], agentId);
  const direct = agent.toolCalls.find(t => t.id === toolId);
  if (direct) return direct;
  const nested = agent.messages.flatMap(m => m.toolCalls ?? []).find(t => t.id === toolId);
  return defined(nested, toolId);
}

describe('useSubagentStore.registerAgentTool', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('flags the card as background when the Agent tool ran with run_in_background', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc1', { subagent_type: 'Explore', description: 'find', run_in_background: true });
    expect(defined(store.subagents['tc1'], 'tc1').isBackground).toBe(true);
  });

  it('leaves isBackground false for a foreground Agent spawn', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc2', { subagent_type: 'Explore', description: 'find' });
    expect(defined(store.subagents['tc2'], 'tc2').isBackground).toBe(false);
  });

  it('startSubagent corrects isBackground to the resolved flag (template default not in the call params)', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc3', { subagent_type: 'Explore', description: 'find' }); // param omitted → false
    expect(defined(store.subagents['tc3'], 'tc3').isBackground).toBe(false);
    store.startSubagent('agent-3', 'Explore', 'tc3', true); // extension resolved background via frontmatter
    expect(defined(store.subagents['tc3'], 'tc3').isBackground).toBe(true);
    expect(defined(store.subagents['tc3'], 'tc3').sdkAgentId).toBe('agent-3');
  });

  it('startSubagent leaves isBackground untouched when no resolved flag is sent', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc4', { subagent_type: 'Explore', description: 'find', run_in_background: true });
    store.startSubagent('agent-4', 'Explore', 'tc4');
    expect(defined(store.subagents['tc4'], 'tc4').isBackground).toBe(true);
  });
});

describe('useSubagentStore live completion (foreground card)', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('setSubagentResult resolves a running foreground card; a later duplicate completion does not re-open it or reset endTime', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc1', { subagent_type: 'Explore', description: 'find' });
    expect(defined(store.subagents['tc1'], 'tc1').status).toBe('running');

    // The synthesized toolCompleted{Agent} path: set the result while running → completes the card.
    store.setSubagentResult('tc1', { content: 'done', sdkAgentId: 'agent-1' });
    const completed = defined(store.subagents['tc1'], 'tc1');
    expect(completed.status).toBe('completed');
    expect(completed.result?.content).toBe('done');
    const endTime = completed.endTime;

    // The parent stream's later real toolCompleted{Agent} (foreground) must not downgrade the card or
    // reset its end time (status + endTime are the guarded, terminal-once invariants).
    store.completeSubagent('tc1');
    store.setSubagentResult('tc1', { content: 'done', sdkAgentId: 'agent-1' });
    expect(defined(store.subagents['tc1'], 'tc1').status).toBe('completed');
    expect(defined(store.subagents['tc1'], 'tc1').endTime).toBe(endTime);
  });
});

describe('useSubagentStore.restoreSubagentFromHistory', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const STOPPED_NOTE = ' (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)';

  it('restores a user-stopped background subagent as cancelled with the stopped note (not completed/prompt)', () => {
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({
      id: 'toolu_1',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'find vehicle files', prompt: 'search vehicles', run_in_background: true },
      // The persisted parent Agent result for a background spawn is only the async-launch ack.
      result: JSON.stringify({ status: 'async_launched', agentId: 'agent-1' }),
      agentStatus: 'stopped',
      agentResultText: STOPPED_NOTE,
      agentMessages: [{ role: 'user', contentBlocks: [{ type: 'text', text: 'search vehicles' }] }],
    });
    const s = defined(store.subagents['toolu_1'], 'toolu_1');
    expect(s.status).toBe('cancelled');
    expect(s.result?.content).toBe(STOPPED_NOTE);
  });

  it('restores a clean completion as completed with the persisted final text', () => {
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({
      id: 'toolu_2',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'find', prompt: 'p' },
      result: JSON.stringify({ status: 'async_launched', agentId: 'agent-2' }),
      agentStatus: 'completed',
      agentResultText: 'Found 3 vehicle files.',
    });
    const s = defined(store.subagents['toolu_2'], 'toolu_2');
    expect(s.status).toBe('completed');
    expect(s.result?.content).toBe('Found 3 vehicle files.');
  });

  it('restores an errored subagent as failed', () => {
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({
      id: 'toolu_3',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'find', prompt: 'p' },
      agentStatus: 'error',
      agentResultText: 'boom',
    });
    expect(defined(store.subagents['toolu_3'], 'toolu_3').status).toBe('failed');
  });

  it('restores an interrupted subagent (no status recorded anywhere) as cancelled, not completed', () => {
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({
      id: 'toolu_3b',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'find', prompt: 'p', run_in_background: true },
      result: JSON.stringify({ status: 'async_launched', agentId: 'agent-3b' }),
      agentStatus: 'interrupted',
    });
    expect(defined(store.subagents['toolu_3b'], 'toolu_3b').status).toBe('cancelled');
  });

  it('falls back to the presence heuristic for legacy transcripts without a persisted status', () => {
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({
      id: 'toolu_4',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'find', prompt: 'p' },
      result: JSON.stringify({ content: [{ type: 'text', text: 'done' }], agentId: 'agent-4' }),
    });
    expect(defined(store.subagents['toolu_4'], 'toolu_4').status).toBe('completed');
  });
});

describe('useSubagentStore nested tool status', () => {
  beforeEach(() => setActivePinia(createPinia()));

  /** The blocks of one sealed nested assistant message, as `streaming-handlers` hands them over. */
  const shellBlocks: ContentBlock[] = [
    { type: 'tool_use', id: 'nested-1', name: 'Bash', input: { command: 'npm test' } },
  ];

  it('leaves a block the subagent has not started yet pending rather than completed', () => {
    const store = useSubagentStore();
    store.registerAgentTool('agent-1', { subagent_type: 'Explore', description: 'find' });

    const built = store.buildToolCallsWithStatus('agent-1', shellBlocks);

    expect(defined(built[0], 'nested-1').status).toBe('pending');
  });

  it('lets the real outcome land on a block that was sealed before the tool started', () => {
    // pi seals the assistant message first, so the card exists before `toolPending` and before the
    // result. A terminal seed here outranks both and freezes the card on a status it invented.
    const store = useSubagentStore();
    store.registerAgentTool('agent-1', { subagent_type: 'Explore', description: 'find' });
    store.addMessageToSubagent('agent-1', {
      id: 'm-1',
      role: 'assistant',
      content: '',
      contentBlocks: shellBlocks,
      toolCalls: store.buildToolCallsWithStatus('agent-1', shellBlocks),
      timestamp: 1,
    });

    expect(store.updateSubagentToolStatus('nested-1', 'running')).toBe(true);
    expect(nestedTool(store, 'agent-1', 'nested-1').status).toBe('running');

    expect(store.updateSubagentToolStatus('nested-1', 'failed', undefined, 'command not found')).toBe(true);

    const tool = nestedTool(store, 'agent-1', 'nested-1');
    expect(tool.status).toBe('failed');
    expect(tool.errorMessage).toBe('command not found');
  });

  it('applies abandoned to a started tool and clears the optimistic stopping flag', () => {
    const store = useSubagentStore();
    store.registerAgentTool('agent-1', { subagent_type: 'Explore', description: 'find' });
    store.addToolCallToSubagent('agent-1', { id: 'nested-1', name: 'Bash', input: { command: 'sleep 300' }, status: 'running' });
    store.updateSubagentToolLiveOutput('nested-1', 'half a line', false);
    expect(store.markSubagentToolCancelRequested('nested-1')).toBe(true);

    expect(store.updateSubagentToolStatus('nested-1', 'abandoned')).toBe(true);

    const tool = nestedTool(store, 'agent-1', 'nested-1');
    expect(tool.status).toBe('abandoned');
    expect(tool.cancelRequested).toBeUndefined();
    expect(tool.liveOutput).toBeUndefined();
  });

  it('does not let abandoned overwrite a recorded success', () => {
    const store = useSubagentStore();
    store.registerAgentTool('agent-1', { subagent_type: 'Explore', description: 'find' });
    store.addToolCallToSubagent('agent-1', { id: 'nested-1', name: 'Bash', input: {}, status: 'running' });
    store.updateSubagentToolStatus('nested-1', 'completed', 'all of it');

    store.updateSubagentToolStatus('nested-1', 'abandoned');

    expect(nestedTool(store, 'agent-1', 'nested-1').status).toBe('completed');
  });
});

describe('useSubagentStore steer images', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const PNG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

  it('puts a live steer\'s images on its overlay row', () => {
    const store = useSubagentStore();
    store.registerAgentTool('agent-1', { subagent_type: 'Explore', description: 'find' });

    store.addUserMessageToSubagent('agent-1', 'look', [PNG]);

    expect(defined(store.subagents['agent-1'], 'card').messages.at(-1)).toMatchObject({ role: 'user', content: 'look', contentBlocks: [PNG] });
  });

  it('keeps a steer\'s images when the sealing snapshot replaces the transcript', () => {
    const store = useSubagentStore();
    store.registerAgentTool('agent-1', { subagent_type: 'Explore', description: 'find' });

    store.replaceSubagentMessages('agent-1', [
      { role: 'user', contentBlocks: [{ type: 'text', text: 'the task' }] },
      { role: 'user', contentBlocks: [{ type: 'text', text: 'look' }, PNG] },
    ]);

    const rows = defined(store.subagents['agent-1'], 'card').messages;
    expect(rows.at(-1)).toMatchObject({ role: 'user', contentBlocks: [{ type: 'text', text: 'look' }, PNG] });
  });
});

describe('useSubagentStore sealed transcript rehydration', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('reads a nested call with no recorded result as unrecorded rather than as a success', () => {
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({
      id: 'toolu_1',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'find', prompt: 'p' },
      agentStatus: 'stopped',
      agentResultText: 'stopped',
      agentMessages: [{
        role: 'assistant',
        contentBlocks: [{ type: 'tool_use', id: 'nested-1', name: 'Bash', input: { command: 'sleep 300' } }],
      }],
    });

    expect(nestedTool(store, 'toolu_1', 'nested-1').status).toBe('unrecorded');
  });

  it('still reads a recorded result as completed and a recorded error as failed', () => {
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({
      id: 'toolu_2',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'find', prompt: 'p' },
      agentStatus: 'completed',
      agentResultText: 'done',
      agentMessages: [{
        role: 'assistant',
        contentBlocks: [
          { type: 'tool_use', id: 'ok-1', name: 'Bash', input: {}, result: 'output' },
          { type: 'tool_use', id: 'bad-1', name: 'Bash', input: {}, result: 'boom', isError: true },
        ],
      }],
    });

    expect(nestedTool(store, 'toolu_2', 'ok-1').status).toBe('completed');
    expect(nestedTool(store, 'toolu_2', 'bad-1').status).toBe('failed');
  });

  it('resolves a tool still marked running when the sealing snapshot arrives', () => {
    // The snapshot is emitted once, from the bridge's `finish`, so nothing will ever update this call
    // again. Carrying `running` across it leaves a spinner for the session's life.
    const store = useSubagentStore();
    store.registerAgentTool('agent-1', { subagent_type: 'Explore', description: 'find' });
    store.addToolCallToSubagent('agent-1', { id: 'nested-1', name: 'Bash', input: { command: 'sleep 300' }, status: 'running' });
    store.markSubagentToolCancelRequested('nested-1');

    store.replaceSubagentMessages('agent-1', [{
      role: 'assistant',
      contentBlocks: [{ type: 'tool_use', id: 'nested-1', name: 'Bash', input: { command: 'sleep 300' } }],
    }]);

    const tool = nestedTool(store, 'agent-1', 'nested-1');
    expect(tool.status).toBe('unrecorded');
    expect(tool.cancelRequested).toBeUndefined();
  });

  it('keeps a terminal live status the snapshot cannot express', () => {
    // The snapshot carries no metadata, so the cancelled marker survives only as the tracked status.
    const store = useSubagentStore();
    store.registerAgentTool('agent-1', { subagent_type: 'Explore', description: 'find' });
    store.addToolCallToSubagent('agent-1', { id: 'nested-1', name: 'Bash', input: {}, status: 'running' });
    store.updateSubagentToolStatus('nested-1', 'completed', 'partial');
    store.updateSubagentToolMetadata('nested-1', { [CANCELLED_TOOL_DETAIL_KEY]: true });
    expect(nestedTool(store, 'agent-1', 'nested-1').status).toBe('cancelled');

    store.replaceSubagentMessages('agent-1', [{
      role: 'assistant',
      contentBlocks: [{ type: 'tool_use', id: 'nested-1', name: 'Bash', input: {}, result: 'partial' }],
    }]);

    expect(nestedTool(store, 'agent-1', 'nested-1').status).toBe('cancelled');
  });
});

describe('useSubagentStore resume cards', () => {
  beforeEach(() => setActivePinia(createPinia()));
  const t = (key: string, params: Record<string, unknown>): string => i18n.global.t(key, params);
  const AGENT = '0a1b2c3d-4e5f-4a0';

  it('shows "Resuming <id8>" until the agent starts, then its own description with the Resumed badge', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc-r', { resume: AGENT, message: 'finish it' });
    const pending = defined(store.subagents['tc-r'], 'tc-r');
    expect(pending.prompt).toBe('finish it');
    expect(subagentHeading(pending, t)).toEqual({ title: 'Resuming 0a1b2c3d', resumed: false });

    store.startSubagent(AGENT, 'Explore', 'tc-r', true, { description: 'dig in', resumedFrom: AGENT });
    const loaded = defined(store.subagents['tc-r'], 'tc-r');
    expect(loaded).toMatchObject({ agentType: 'Explore', description: 'dig in', isBackground: true, resume: { agentId: AGENT, loaded: true } });
    expect(subagentHeading(loaded, t)).toEqual({ title: 'dig in', resumed: true });
  });

  it('leaves the type unset on a resume card until the agent names it, rather than guessing one', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc-r', { resume: AGENT });

    expect(defined(store.subagents['tc-r'], 'tc-r').agentType).toBeUndefined();
  });

  it('takes the type and description from the spawn card of the same agent at once', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc1', { subagent_type: 'Explore', description: 'dig in', prompt: 'p' });
    store.startSubagent(AGENT, 'Explore', 'tc1', false, { description: 'dig in' });
    store.cancelRunningSubagents();

    store.registerAgentTool('tc-r', { resume: AGENT, message: 'finish it' });

    const pending = defined(store.subagents['tc-r'], 'tc-r');
    expect(pending.agentType).toBe('Explore');
    expect(subagentHeading(pending, t)).toEqual({ title: 'dig in', resumed: true });
  });

  it('titles a resumed agent that carries no description by its type, as a spawn card does', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc-r', { resume: AGENT });

    store.startSubagent(AGENT, 'Explore', 'tc-r', false, { resumedFrom: AGENT });

    const loaded = defined(store.subagents['tc-r'], 'tc-r');
    expect(loaded.agentType).toBe('Explore');
    expect(subagentHeading(loaded, t)).toEqual({ title: 'Explore', resumed: true });
  });

  it('a spawn card has no resume label, and the original card stays cancelled after a resume', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc1', { subagent_type: 'Explore', description: 'dig in', prompt: 'p' });
    store.startSubagent(AGENT, 'Explore', 'tc1', false, { description: 'dig in' });
    store.cancelRunningSubagents();
    store.registerAgentTool('tc-r', { resume: AGENT });
    store.startSubagent(AGENT, 'Explore', 'tc-r', false, { description: 'dig in', resumedFrom: AGENT });

    const original = defined(store.subagents['tc1'], 'tc1');
    expect(original.status).toBe('cancelled');
    expect(subagentHeading(original, t)).toEqual({ title: 'dig in', resumed: false });
    expect(defined(store.subagents['tc-r'], 'tc-r').status).toBe('running');
  });

  it('restores a resume card from history with the launch details and the Resumed badge', () => {
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({
      id: 'tc-r',
      name: 'Agent',
      input: { resume: AGENT, message: 'finish it' },
      sdkAgentId: AGENT,
      agentResumedFrom: AGENT,
      agentLaunch: { agentType: 'Explore', description: 'dig in', prompt: 'look', background: true },
      agentStatus: 'completed',
      agentResultText: 'second half',
    });
    const restored = defined(store.subagents['tc-r'], 'tc-r');
    expect(restored).toMatchObject({ agentType: 'Explore', prompt: 'finish it', isBackground: true, status: 'completed' });
    expect(subagentHeading(restored, t)).toEqual({ title: 'dig in', resumed: true });
  });

  it('a resume card whose agent file is gone keeps the "Resuming" label and shows no type', () => {
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({ id: 'tc-r', name: 'Agent', input: { resume: AGENT }, agentResumedFrom: AGENT, agentStatus: 'interrupted' });
    const restored = defined(store.subagents['tc-r'], 'tc-r');
    expect(restored.status).toBe('cancelled');
    expect(restored.agentType).toBeUndefined();
    expect(subagentHeading(restored, t).title).toBe('Resuming 0a1b2c3d');
  });

  it('a restored resume card whose agent file is gone takes the details of the restored spawn card', () => {
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({
      id: 'tc1',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'dig in', prompt: 'p' },
      sdkAgentId: AGENT,
      agentStatus: 'interrupted',
    });
    store.restoreSubagentFromHistory({ id: 'tc-r', name: 'Agent', input: { resume: AGENT }, sdkAgentId: AGENT, agentResumedFrom: AGENT, agentStatus: 'completed' });

    const restored = defined(store.subagents['tc-r'], 'tc-r');
    expect(restored.agentType).toBe('Explore');
    expect(subagentHeading(restored, t)).toEqual({ title: 'dig in', resumed: true });
  });

  it('restores a refused resume as failed with no result, as the live card showed it', () => {
    // A refused resume writes no invocation entry, so the host attaches no status to the call.
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({
      id: 'tc-r',
      name: 'Agent',
      input: { resume: AGENT, message: 'finish it' },
      result: `Subagent "${AGENT}" is still running.`,
      isError: true,
    });

    const restored = defined(store.subagents['tc-r'], 'tc-r');
    expect(restored.status).toBe('failed');
    expect(restored.result).toBeUndefined();
  });
});
