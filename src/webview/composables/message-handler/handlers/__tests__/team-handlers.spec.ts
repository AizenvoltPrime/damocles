// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createTeamHandlers } from '../team-handlers';
import type { HandlerContext } from '../../types';
import { useTeamStore } from '@/stores/useTeamStore';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

type ToolResult = Extract<ExtensionToWebviewMessage, { type: 'teamAgentToolResult' }>;

function dispatch(msg: ToolResult): void {
  const handler = createTeamHandlers().teamAgentToolResult;
  if (!handler) throw new Error('no teamAgentToolResult handler registered');
  handler(msg, {} as HandlerContext);
}

describe('teamAgentStatusUpdate', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("forwards the update's stopwatch to the store, which takes the agent's time from it", () => {
    const teamStore = useTeamStore();
    teamStore.restoreTeamFromHistory({
      teamId: 'team-1', toolUseId: 'tc-1', title: 'Team', status: 'running', phase: 'working',
      agents: [{
        agentId: 'agent-1', name: 'backend', role: 'specialist', specialization: '', model: 'm', profileId: null, attempt: 0,
        status: 'running', activeMs: 0, runningSince: 1_000, toolCount: 0, lastToolName: null,
        totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
        dollarBilled: true, effort: null, progressSummary: null, result: null, logFilePath: null,
      }],
      messages: [], scratchpad: [], result: null, startTime: 1_000, endTime: null, totalToolCount: 0, runs: [],
    });

    const handler = createTeamHandlers().teamAgentStatusUpdate;
    if (!handler) throw new Error('no teamAgentStatusUpdate handler registered');
    handler({ type: 'teamAgentStatusUpdate', teamId: 'team-1', agentId: 'agent-1', status: 'completed', stopwatch: { activeMs: 42_400, runningSince: null } }, {} as HandlerContext);

    expect(teamStore.teams['team-1']?.agents[0]).toMatchObject({ status: 'completed', activeMs: 42_400, runningSince: null });
  });
});

describe('teamAgentToolResult', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('lands the image count, error flag and metadata on the member tool call', () => {
    const teamStore = useTeamStore();
    teamStore.agentMessages = {
      'agent-1': [{ id: 'am1', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 't-1', name: 'BrowserScreenshot', input: {}, status: 'running' }] }],
    };

    dispatch({
      type: 'teamAgentToolResult',
      teamId: 'team-1',
      agentId: 'agent-1',
      toolUseId: 't-1',
      result: 'Screenshot taken',
      isError: false,
      metadata: { url: 'https://example.com' },
      imageCount: 2,
    });

    const tool = teamStore.agentMessages['agent-1']?.[0]?.toolCalls?.[0];
    expect(tool).toMatchObject({ result: 'Screenshot taken', isError: false, imageCount: 2, metadata: { url: 'https://example.com' }, status: 'completed' });
  });
});
