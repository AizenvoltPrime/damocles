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
