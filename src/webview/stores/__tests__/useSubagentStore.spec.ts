import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useSubagentStore } from '../useSubagentStore';

describe('useSubagentStore.registerAgentTool', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('flags the card as background when the Agent tool ran with run_in_background', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc1', { subagent_type: 'Explore', description: 'find', run_in_background: true });
    expect(store.subagents['tc1'].isBackground).toBe(true);
  });

  it('leaves isBackground false for a foreground Agent spawn', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc2', { subagent_type: 'Explore', description: 'find' });
    expect(store.subagents['tc2'].isBackground).toBe(false);
  });

  it('startSubagent corrects isBackground to the resolved flag (template default not in the call params)', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc3', { subagent_type: 'Explore', description: 'find' }); // param omitted → false
    expect(store.subagents['tc3'].isBackground).toBe(false);
    store.startSubagent('agent-3', 'Explore', 'tc3', true); // extension resolved background via frontmatter
    expect(store.subagents['tc3'].isBackground).toBe(true);
    expect(store.subagents['tc3'].sdkAgentId).toBe('agent-3');
  });

  it('startSubagent leaves isBackground untouched when no resolved flag is sent', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc4', { subagent_type: 'Explore', description: 'find', run_in_background: true });
    store.startSubagent('agent-4', 'Explore', 'tc4');
    expect(store.subagents['tc4'].isBackground).toBe(true);
  });
});

describe('useSubagentStore live completion (foreground card)', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('setSubagentResult resolves a running foreground card; a later duplicate completion does not re-open it or reset endTime', () => {
    const store = useSubagentStore();
    store.registerAgentTool('tc1', { subagent_type: 'Explore', description: 'find' });
    expect(store.subagents['tc1'].status).toBe('running');

    // The synthesized toolCompleted{Agent} path: set the result while running → completes the card.
    store.setSubagentResult('tc1', { content: 'done', sdkAgentId: 'agent-1' });
    const completed = store.subagents['tc1'];
    expect(completed.status).toBe('completed');
    expect(completed.result?.content).toBe('done');
    const endTime = completed.endTime;

    // The parent stream's later real toolCompleted{Agent} (foreground) must not downgrade the card or
    // reset its end time (status + endTime are the guarded, terminal-once invariants).
    store.completeSubagent('tc1');
    store.setSubagentResult('tc1', { content: 'done', sdkAgentId: 'agent-1' });
    expect(store.subagents['tc1'].status).toBe('completed');
    expect(store.subagents['tc1'].endTime).toBe(endTime);
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
    const s = store.subagents['toolu_1'];
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
    const s = store.subagents['toolu_2'];
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
    expect(store.subagents['toolu_3'].status).toBe('failed');
  });

  it('falls back to the presence heuristic for legacy transcripts without a persisted status', () => {
    const store = useSubagentStore();
    store.restoreSubagentFromHistory({
      id: 'toolu_4',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'find', prompt: 'p' },
      result: JSON.stringify({ content: [{ type: 'text', text: 'done' }], agentId: 'agent-4' }),
    });
    expect(store.subagents['toolu_4'].status).toBe('completed');
  });
});
