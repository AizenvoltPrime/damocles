import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { createSubagentHandlers } from '../subagent-handlers';
import type { HandlerContext, StoreContext } from '../../types';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { subagentStatusLine, useSubagentStore } from '@/stores/useSubagentStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { createUIHandlers } from '../ui-handlers';
import { i18n } from '@/i18n';
import { defined } from '@/__tests__/helpers';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

type Steered = Extract<ExtensionToWebviewMessage, { type: 'subagentSteered' }>;
type Started = Extract<ExtensionToWebviewMessage, { type: 'subagentStart' }>;

const MEMBER = 'abcdef12-0000-4000-8000-000000000001';

function context(settleSteer = vi.fn()): HandlerContext {
  const stores = { streamingStore: useStreamingStore(), subagentStore: useSubagentStore() };
  const chatInputRef = ref({ settleSteer });
  return { stores: stores as unknown as StoreContext, refs: { chatInputRef } } as unknown as HandlerContext;
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

describe('subagentSteered for a subagent with images', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const PNG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

  function subagentSteer(over: Partial<Steered> = {}): Steered {
    return { type: 'subagentSteered', agentId: 'agent-1', toolUseId: 'toolu_1', message: 'check the tests', status: 'steered', ...over };
  }

  it('puts the images on the chat chip and on the subagent overlay row', () => {
    const ctx = context();
    ctx.stores.subagentStore.registerAgentTool('toolu_1', { subagent_type: 'Explore', description: 'find', prompt: 'p' });

    steer(subagentSteer({ message: 'look at this', images: [PNG, PNG] }), ctx);

    const chip = defined(ctx.stores.streamingStore.messages.at(-1), 'chip');
    expect(chip).toMatchObject({ role: 'user', content: 'look at this', isInjected: true, contentBlocks: [PNG, PNG] });
    const row = defined(defined(ctx.stores.subagentStore.subagents['toolu_1'], 'card').messages.at(-1), 'row');
    expect(row).toMatchObject({ role: 'user', content: 'look at this', contentBlocks: [PNG, PNG] });
  });

  it('leaves a text-only steer without contentBlocks', () => {
    const ctx = context();

    steer(subagentSteer(), ctx);

    expect(defined(ctx.stores.streamingStore.messages.at(-1), 'chip').contentBlocks).toBeUndefined();
  });
});

describe('subagentSteered and the draft the composer holds', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it.each([
    ['steered', true],
    ['queued', true],
    ['finished', false],
    ['not-found', false],
    ['failed', false],
  ] as const)('settles a %s steer as delivered=%s', (status, delivered) => {
    const settleSteer = vi.fn();

    steer(teamSteer({ status, requestId: 'req-1' }), context(settleSteer));

    expect(settleSteer).toHaveBeenCalledWith('req-1', delivered);
  });

  it('settles nothing for a steer the user did not send, which carries no request id', () => {
    const settleSteer = vi.fn();

    steer(teamSteer({ status: 'failed' }), context(settleSteer));

    expect(settleSteer).not.toHaveBeenCalled();
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

describe('subagentUsageUpdate', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const usage = { totalInputTokens: 1, totalOutputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, costUsd: 0.5 };
  const update = (msg: Extract<ExtensionToWebviewMessage, { type: 'subagentUsageUpdate' }>, ctx: HandlerContext) =>
    defined(createSubagentHandlers().subagentUsageUpdate, 'subagentUsageUpdate handler')(msg, ctx);

  it('stores the usage and billing flag on the card', () => {
    const ctx = context();
    ctx.stores.subagentStore.registerAgentTool('toolu_1', { subagent_type: 'Explore', description: 'find' });

    update({ type: 'subagentUsageUpdate', agentToolId: 'toolu_1', usage, dollarBilled: false }, ctx);
    expect(ctx.stores.subagentStore.subagents['toolu_1']).toMatchObject({ usage, dollarBilled: false });
  });

  it('keeps a known billing flag when an update carries none', () => {
    const ctx = context();
    ctx.stores.subagentStore.registerAgentTool('toolu_1', { subagent_type: 'Explore', description: 'find' });
    update({ type: 'subagentUsageUpdate', agentToolId: 'toolu_1', usage, dollarBilled: false }, ctx);
    update({ type: 'subagentUsageUpdate', agentToolId: 'toolu_1', usage: { ...usage, costUsd: 0.75 } }, ctx);

    expect(ctx.stores.subagentStore.subagents['toolu_1']).toMatchObject({ usage: { costUsd: 0.75 }, dollarBilled: false });
  });
});

describe("a reloaded subagent card whose run core still holds", () => {
  beforeEach(() => setActivePinia(createPinia()));

  const SHOWN = { phase: 'settle' as const, events: ['agent_settled'], extensions: ['/agent/extensions/held.js'] };

  it('runs again with its Background Tasks row and wind-down from what core replays, and drops the line on the clear', () => {
    const stores = { streamingStore: useStreamingStore(), subagentStore: useSubagentStore(), teamStore: useTeamStore(), backgroundTaskStore: useBackgroundTaskStore() };
    const ctx = { stores: stores as unknown as StoreContext, refs: {} } as unknown as HandlerContext;
    // The transcript of a run that has not settled ends without an outcome, which a replay shows as stopped.
    stores.subagentStore.restoreSubagentFromHistory({
      id: 'toolu_1',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'dig', prompt: 'p', run_in_background: true },
      result: JSON.stringify({ status: 'async_launched', agentId: 'agent-1' }),
      agentStatus: 'interrupted',
      sdkAgentId: 'agent-1',
    });
    expect(defined(stores.subagentStore.subagents['toolu_1'], 'card').status).toBe('cancelled');

    const handlers = { ...createSubagentHandlers(), ...createUIHandlers() } as Record<string, (msg: ExtensionToWebviewMessage, ctx: HandlerContext) => void>;
    defined(handlers['taskStarted'], 'taskStarted')({ type: 'taskStarted', taskId: 'agent-1', toolUseId: 'toolu_1', description: 'dig', taskType: 'Explore', isBackground: true }, ctx);
    // What the `backgroundTaskStarted` handler does, which needs a component's i18n.
    stores.backgroundTaskStore.handleTaskStarted({ taskId: 'agent-1', toolUseId: 'toolu_1', description: 'dig', status: 'running' });
    defined(handlers['statusUpdate'], 'statusUpdate')({ type: 'statusUpdate', status: 'windingDown', windDown: SHOWN, parentToolUseId: 'toolu_1' }, ctx);

    const card = defined(stores.subagentStore.subagents['toolu_1'], 'card');
    expect(card.status).toBe('running');
    expect(card.windDown).toEqual(SHOWN);
    expect(subagentStatusLine(card, (key, params) => i18n.global.t(key, params))).toBe(
      "Stopping: waiting for pi's agent_settled handlers to return. pi gives them no abort signal. pi extensions with such a handler: /agent/extensions/held.js.",
    );
    expect(stores.backgroundTaskStore.activeTasks.map((task) => task.toolUseId)).toEqual(['toolu_1']);

    defined(handlers['statusUpdate'], 'statusUpdate')({ type: 'statusUpdate', status: 'windingDown', windDown: null, parentToolUseId: 'toolu_1' }, ctx);
    expect(defined(stores.subagentStore.subagents['toolu_1'], 'card').windDown).toBeUndefined();
  });
});
