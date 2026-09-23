import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { createSubagentHandlers } from '../subagent-handlers';
import type { HandlerContext, StoreContext } from '../../types';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { defined } from '@/__tests__/helpers';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

type Steered = Extract<ExtensionToWebviewMessage, { type: 'subagentSteered' }>;
type Started = Extract<ExtensionToWebviewMessage, { type: 'subagentStart' }>;

const MEMBER = 'abcdef12-0000-4000-8000-000000000001';

function context(): HandlerContext {
  const stores = { streamingStore: useStreamingStore(), subagentStore: useSubagentStore() };
  return { stores: stores as unknown as StoreContext } as unknown as HandlerContext;
}

function teamSteer(over: Partial<Steered> = {}): Steered {
  return {
    type: 'subagentSteered',
    agentId: MEMBER,
    toolUseId: null,
    description: 'Refactor · reviewer',
    message: 'check the tests',
    status: 'steered',
    team: { teamId: 'team-1', teamTitle: 'Refactor', memberName: 'reviewer', role: 'specialist' },
    ...over,
  };
}

function steer(msg: Steered, ctx: HandlerContext): void {
  defined(createSubagentHandlers().subagentSteered, 'subagentSteered handler')(msg, ctx);
}

describe('subagentSteered for a team member', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('adds the chat chip naming the team and member', () => {
    const ctx = context();

    steer(teamSteer(), ctx);

    const chip = defined(ctx.stores.streamingStore.messages.at(-1), 'chip');
    expect(chip).toMatchObject({ role: 'user', content: 'check the tests', isInjected: true });
    expect(chip.steerTarget).toEqual({ agentId: MEMBER, description: 'Refactor · reviewer' });
  });

  it('writes nothing into a subagent card, because the member runner echoes the steer itself', () => {
    const ctx = context();
    ctx.stores.subagentStore.registerAgentTool('toolu_1', { subagent_type: 'Explore', description: 'find', prompt: 'p' });

    steer(teamSteer({ toolUseId: 'toolu_1' }), ctx);

    expect(defined(ctx.stores.subagentStore.subagents['toolu_1'], 'card').messages).toEqual([]);
  });

  it('reports a member that already finished as an error instead of a chip', () => {
    const ctx = context();

    steer(teamSteer({ status: 'finished' }), ctx);

    const last = defined(ctx.stores.streamingStore.messages.at(-1), 'message');
    expect(last.role).toBe('error');
    expect(last.steerTarget).toBeUndefined();
  });
});

describe('subagentStart for a resume', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('fills in the type and description a resume call does not carry', () => {
    const ctx = context();
    const AGENT = '0a1b2c3d-4e5f-4a0';
    ctx.stores.subagentStore.registerAgentTool('tc-r', { resume: AGENT });
    const start: Started = { type: 'subagentStart', agentId: AGENT, agentType: 'Explore', toolUseId: 'tc-r', isBackground: true, description: 'dig in', resumedFrom: AGENT };

    defined(createSubagentHandlers().subagentStart, 'subagentStart handler')(start, ctx);

    expect(ctx.stores.subagentStore.subagents['tc-r']).toMatchObject({
      agentType: 'Explore',
      description: 'dig in',
      isBackground: true,
      resume: { agentId: AGENT, loaded: true },
    });
  });
});
