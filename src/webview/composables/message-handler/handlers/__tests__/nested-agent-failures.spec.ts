// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createStreamingHandlers } from '../streaming-handlers';
import { createUIHandlers } from '../ui-handlers';
import type { HandlerContext, StoreContext } from '../../types';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { TeamState } from '@shared/types/team';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

/**
 * A nested agent's failed-call messages carry `parentToolUseId`, which names a subagent card's `Agent`
 * call or a team agent. They reach that transcript and status line, never the main chat's.
 */

type Msg<T extends ExtensionToWebviewMessage['type']> = Extract<ExtensionToWebviewMessage, { type: T }>;

function context(): HandlerContext {
  return {
    stores: {
      streamingStore: useStreamingStore(),
      subagentStore: useSubagentStore(),
      teamStore: useTeamStore(),
      uiStore: useUIStore(),
      settingsStore: useSettingsStore(),
      sessionStore: { setCurrentSession: () => undefined, trackFileAccess: () => undefined },
    } as unknown as StoreContext,
  } as unknown as HandlerContext;
}

const streaming = createStreamingHandlers();
const ui = createUIHandlers();
const send = {
  error: (msg: Msg<'error'>, ctx: HandlerContext) => streaming.error!(msg, ctx),
  retracted: (msg: Msg<'assistantRetracted'>, ctx: HandlerContext) => streaming.assistantRetracted!(msg, ctx),
  partial: (msg: Msg<'partial'>, ctx: HandlerContext) => streaming.partial!(msg, ctx),
  assistant: (msg: Msg<'assistant'>, ctx: HandlerContext) => streaming.assistant!(msg, ctx),
  status: (msg: Msg<'statusUpdate'>, ctx: HandlerContext) => ui.statusUpdate!(msg, ctx),
};

function teamWithAgent(agentId: string): TeamState {
  return {
    teamId: 'team-1', toolUseId: 'toolu_team', title: 'Team', status: 'running', phase: 'working',
    agents: [{
      agentId, name: 'worker', role: 'specialist', specialization: '', model: '', profileId: null, attempt: 0,
      status: 'running', activeMs: 0, runningSince: 1, toolCount: 0, lastToolName: null, totalInputTokens: 0,
      totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, dollarBilled: true, effort: null,
      progressSummary: null, result: null, logFilePath: null,
    }],
    messages: [], scratchpad: [], result: null, startTime: 1, endTime: null, totalToolCount: 0, runs: [],
  };
}

describe('a subagent failed call', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('withdraws the retried attempt from the card, marks it retrying, and shows a failure pi kept on the card only', () => {
    const ctx = context();
    const subagents = useSubagentStore();
    subagents.registerAgentTool('toolu_agent', { description: 'dig', prompt: 'p', subagent_type: 'Explore' });

    send.partial({ type: 'partial', data: { type: 'partial', content: [], session_id: 'S', messageId: 'ag:a:1', streamingText: 'Let me' }, parentToolUseId: 'toolu_agent' }, ctx);
    send.assistant({ type: 'assistant', data: { type: 'assistant', message: { id: 'ag:a:1', role: 'assistant', content: [{ type: 'text', text: 'Let me' }], model: '', stop_reason: null }, session_id: 'S' }, parentToolUseId: 'toolu_agent' }, ctx);
    send.retracted({ type: 'assistantRetracted', messageId: 'ag:a:1', parentToolUseId: 'toolu_agent' }, ctx);
    send.status({ type: 'statusUpdate', status: 'retrying', attempt: 1, maxAttempts: 3, parentToolUseId: 'toolu_agent' }, ctx);

    expect(subagents.subagents['toolu_agent']!.messages).toEqual([]);
    expect(subagents.subagents['toolu_agent']!.retry).toEqual({ attempt: 1, maxAttempts: 3 });
    expect(useUIStore().retryStatus).toBeNull();

    send.status({ type: 'statusUpdate', status: 'ready', parentToolUseId: 'toolu_agent' }, ctx);
    send.error({ type: 'error', message: '529 overloaded_error', parentToolUseId: 'toolu_agent' }, ctx);

    expect(subagents.subagents['toolu_agent']!.retry).toBeUndefined();
    expect(subagents.subagents['toolu_agent']!.messages.map((m) => [m.role, m.content])).toEqual([['error', '529 overloaded_error']]);
    expect(useStreamingStore().messages).toEqual([]);
  });

  it('leaves the main status bar alone when a nested ready arrives during the main retry', () => {
    const ctx = context();
    useSubagentStore().registerAgentTool('toolu_agent', { description: 'dig', prompt: 'p' });
    send.status({ type: 'statusUpdate', status: 'retrying', attempt: 2, maxAttempts: 3 }, ctx);

    send.status({ type: 'statusUpdate', status: 'ready', parentToolUseId: 'toolu_agent' }, ctx);

    expect(useUIStore().retryStatus).toEqual({ attempt: 2, maxAttempts: 3 });
  });
});

describe('a team agent failed call', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('reaches that agent\'s transcript and status line', () => {
    const ctx = context();
    const team = useTeamStore();
    team.restoreTeamFromHistory(teamWithAgent('agent-1'));
    team.handleAgentStreamDelta('agent-1', 'text', 'Let me');
    team.handleAgentAssistant('agent-1', 'm-1', [{ type: 'text', text: 'Let me' }], 1);

    send.retracted({ type: 'assistantRetracted', messageId: 'm-1', parentToolUseId: 'agent-1' }, ctx);
    send.status({ type: 'statusUpdate', status: 'retrying', attempt: 1, maxAttempts: 3, parentToolUseId: 'agent-1' }, ctx);
    expect(team.agentMessages['agent-1']).toEqual([]);
    expect(team.agentRetry['agent-1']).toEqual({ attempt: 1, maxAttempts: 3 });

    send.status({ type: 'statusUpdate', status: 'ready', parentToolUseId: 'agent-1' }, ctx);
    send.error({ type: 'error', message: '529 overloaded_error', parentToolUseId: 'agent-1' }, ctx);

    expect(team.agentRetry['agent-1']).toBeUndefined();
    expect(team.agentMessages['agent-1']!.map((m) => [m.role, m.content])).toEqual([['error', '529 overloaded_error']]);
    expect(useStreamingStore().messages).toEqual([]);
    expect(useUIStore().retryStatus).toBeNull();
  });

  it('drops a failure whose owner no transcript holds, rather than showing it in the main chat', () => {
    const ctx = context();

    send.error({ type: 'error', message: 'stray', parentToolUseId: 'gone' }, ctx);
    send.retracted({ type: 'assistantRetracted', messageId: 'x', parentToolUseId: 'gone' }, ctx);

    expect(useStreamingStore().messages).toEqual([]);
  });
});
