import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import { PermissionHandler } from '../../permission-handler';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { PLAN_VERSION_DETAIL_KEY } from '../../../shared/types/session';
import { planVersionOnBranch } from '../plan-version';
import { createPlanModeTools } from '../tools/plan-mode-tools';
import { reconstructMessages } from '../session-store/history-loader';

/** D51: a plan's version is one more than the plans the user was shown before it on its branch, stamped by core. */

let clock = 0;

function prompt(sm: SessionManager, text: string): string {
  return sm.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: ++clock });
}

function planCall(sm: SessionManager, id: string): string {
  return sm.appendMessage({
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'ExitPlanMode', arguments: {} }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: ++clock,
  });
}

function planResult(sm: SessionManager, id: string, details: Record<string, number | null> | undefined, isError: boolean): string {
  return sm.appendMessage({
    role: 'toolResult',
    toolCallId: id,
    toolName: 'ExitPlanMode',
    content: [{ type: 'text', text: isError ? 'revise' : 'approved' }],
    ...(details ? { details } : {}),
    isError,
    timestamp: ++clock,
  });
}

/** Two plans, a compaction that summarises them, and a third plan. */
function twoPlansThenCompaction(): SessionManager {
  const sm = SessionManager.inMemory('/work');
  prompt(sm, 'plan it');
  planCall(sm, 'p1');
  planResult(sm, 'p1', { [PLAN_VERSION_DETAIL_KEY]: 1 }, true);
  prompt(sm, 'again');
  planCall(sm, 'p2');
  planResult(sm, 'p2', { [PLAN_VERSION_DETAIL_KEY]: 2 }, true);
  const kept = prompt(sm, 'third time');
  sm.appendCompaction('summary of the first two plans', kept, 1000);
  return sm;
}

describe('plan version on the branch', () => {
  it('counts the plans a compaction summarised, so the third plan is version 3', () => {
    const sm = twoPlansThenCompaction();
    planCall(sm, 'p3');
    expect(planVersionOnBranch(sm.getBranch(), 'p3')).toBe(3);
    expect(planVersionOnBranch(sm.getBranch(), 'p1')).toBe(1);
  });

  it('numbers a call its assistant message has not reached the branch with yet as the next plan', () => {
    expect(planVersionOnBranch(twoPlansThenCompaction().getBranch(), 'p3')).toBe(3);
  });

  it('continues a rewind from the plans its own branch holds', () => {
    const sm = twoPlansThenCompaction();
    const beforeThird = sm.getLeafId()!;
    planCall(sm, 'p3');
    planResult(sm, 'p3', { [PLAN_VERSION_DETAIL_KEY]: 3 }, false);
    prompt(sm, 'implement');
    planCall(sm, 'p4');
    expect(planVersionOnBranch(sm.getBranch(), 'p4')).toBe(4);

    sm.branch(beforeThird);
    planCall(sm, 'p5');
    expect(planVersionOnBranch(sm.getBranch(), 'p5')).toBe(3);
  });

  it('continues a fork from the plans of the branch it copied', () => {
    const sm = twoPlansThenCompaction();
    planCall(sm, 'p3');
    planResult(sm, 'p3', { [PLAN_VERSION_DETAIL_KEY]: 3 }, true);
    const third = sm.getLeafId()!;
    sm.createBranchedSession(third);
    prompt(sm, 'in the fork');
    planCall(sm, 'p4');
    expect(planVersionOnBranch(sm.getBranch(), 'p4')).toBe(4);
  });

  it('counts no call that showed no plan, and none whose result never landed', () => {
    const sm = SessionManager.inMemory('/work');
    prompt(sm, 'plan it');
    planCall(sm, 'blocked');
    planResult(sm, 'blocked', { [PLAN_VERSION_DETAIL_KEY]: null }, true);
    planCall(sm, 'interrupted');
    prompt(sm, 'again');
    planCall(sm, 'p1');
    expect(planVersionOnBranch(sm.getBranch(), 'p1')).toBe(1);
  });

  it('counts a plan recorded before versions were stamped', () => {
    const sm = SessionManager.inMemory('/work');
    prompt(sm, 'old plan');
    planCall(sm, 'legacy');
    planResult(sm, 'legacy', undefined, true);
    planCall(sm, 'next');
    expect(planVersionOnBranch(sm.getBranch(), 'next')).toBe(2);
  });
});

describe('ExitPlanMode records its version', () => {
  const pi = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  type Exit = { execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: undefined, ctx: unknown) => Promise<{ details: unknown; isError?: boolean }> };

  it('on the result details and the plan approval request, whether the plan is approved or sent back', async () => {
    const requests: Extract<ExtensionToWebviewMessage, { type: 'requestPlanApproval' }>[] = [];
    let approve = true;
    const handler = new PermissionHandler(createFakePlatform());
    handler.setPermissionMode('plan');
    handler.setPlanContentResolver(async () => '1. Do it');
    handler.setPostMessage((msg) => {
      if (msg.type !== 'requestPlanApproval') return;
      requests.push(msg);
      handler.resolvePlanApproval(msg.toolUseId, approve);
    });
    const exit = createPlanModeTools(pi, handler)[1] as unknown as Exit;
    const sm = twoPlansThenCompaction();
    const ctx = { sessionManager: sm };

    planCall(sm, 'p3');
    approve = false;
    const sentBack = await exit.execute('p3', {}, new AbortController().signal, undefined, ctx);
    expect(sentBack).toMatchObject({ isError: true, details: { [PLAN_VERSION_DETAIL_KEY]: 3 } });
    planResult(sm, 'p3', sentBack.details as Record<string, number>, true);

    planCall(sm, 'p4');
    approve = true;
    handler.setPermissionMode('plan');
    const approved = await exit.execute('p4', {}, new AbortController().signal, undefined, ctx);
    expect(approved.details).toEqual({ [PLAN_VERSION_DETAIL_KEY]: 4 });
    expect(approved.isError).toBeUndefined();
    expect(requests.map((r) => [r.toolUseId, r.planVersion])).toEqual([['p3', 3], ['p4', 4]]);
  });

  it('stamps no version on a call that showed no plan, so the next plan shown is version 1', async () => {
    const requests: Extract<ExtensionToWebviewMessage, { type: 'requestPlanApproval' }>[] = [];
    let plan = '';
    const handler = new PermissionHandler(createFakePlatform());
    handler.setPermissionMode('plan');
    handler.setPlanContentResolver(async () => plan);
    handler.setPostMessage((msg) => {
      if (msg.type !== 'requestPlanApproval') return;
      requests.push(msg);
      handler.resolvePlanApproval(msg.toolUseId, false);
    });
    const exit = createPlanModeTools(pi, handler)[1] as unknown as Exit;
    const sm = SessionManager.inMemory('/work');
    const ctx = { sessionManager: sm };
    prompt(sm, 'plan it');

    planCall(sm, 'no-file');
    const blocked = await exit.execute('no-file', {}, new AbortController().signal, undefined, ctx);
    expect(blocked).toMatchObject({ isError: true, details: { [PLAN_VERSION_DETAIL_KEY]: null } });
    planResult(sm, 'no-file', blocked.details as Record<string, null>, true);

    plan = '1. Do it';
    planCall(sm, 'shown');
    const sentBack = await exit.execute('shown', {}, new AbortController().signal, undefined, ctx);
    expect(sentBack.details).toEqual({ [PLAN_VERSION_DETAIL_KEY]: 1 });
    expect(requests.map((r) => [r.toolUseId, r.planVersion])).toEqual([['shown', 1]]);
    planResult(sm, 'shown', sentBack.details as Record<string, number>, true);

    handler.setPermissionMode('default');
    planCall(sm, 'outside');
    const outside = await exit.execute('outside', {}, new AbortController().signal, undefined, ctx);
    expect(outside.details).toEqual({ [PLAN_VERSION_DETAIL_KEY]: null });
  });

  it('keeps the number of a plan the user was shown and then stopped, words the stop as one, and counts it', async () => {
    const handler = new PermissionHandler(createFakePlatform());
    handler.setPermissionMode('plan');
    handler.setPlanContentResolver(async () => '1. Do it');
    const run = new AbortController();
    handler.setPostMessage((msg) => {
      if (msg.type === 'requestPlanApproval') queueMicrotask(() => run.abort());
    });
    const exit = createPlanModeTools(pi, handler)[1] as unknown as Exit;
    const sm = SessionManager.inMemory('/work');
    prompt(sm, 'plan it');

    planCall(sm, 'stopped');
    const stopped = (await exit.execute('stopped', {}, run.signal, undefined, { sessionManager: sm })) as { details: unknown; isError?: boolean; content: { text: string }[] };
    expect(stopped).toMatchObject({ isError: true, details: { [PLAN_VERSION_DETAIL_KEY]: 1 } });
    expect(stopped.content[0]!.text).toContain('The session was aborted before the user answered this plan');
    planResult(sm, 'stopped', stopped.details as Record<string, number>, true);

    planCall(sm, 'next');
    expect(planVersionOnBranch(sm.getBranch(), 'next')).toBe(2);
  });

  it('runs both plan-mode tools in order with their batch, so a plan written beside ExitPlanMode exists when it is read', () => {
    const handler = new PermissionHandler(createFakePlatform());
    const tools = createPlanModeTools(pi, handler) as unknown as { executionMode?: string }[];
    expect(tools.map((tool) => tool.executionMode)).toEqual(['sequential', 'sequential']);
  });

  it('hands the version to the approval on the context, never as tool input the model did not send', async () => {
    const handler = new PermissionHandler(createFakePlatform());
    handler.setPermissionMode('plan');
    const canUseTool = vi.spyOn(handler, 'canUseTool').mockResolvedValue({ behavior: 'allow', updatedInput: {} });
    const exit = createPlanModeTools(pi, handler)[1] as unknown as Exit;
    const sm = twoPlansThenCompaction();
    planCall(sm, 'p3');

    await exit.execute('p3', {}, new AbortController().signal, undefined, { sessionManager: sm });

    expect(canUseTool).toHaveBeenCalledWith('ExitPlanMode', {}, expect.objectContaining({ toolUseID: 'p3', planVersion: 3 }));
  });

  it('keeps the recorded number on a reload, and a call recorded without one replays without one', () => {
    const sm = SessionManager.inMemory('/work');
    prompt(sm, 'old plan');
    planCall(sm, 'legacy');
    planResult(sm, 'legacy', undefined, false);
    prompt(sm, 'new plan');
    planCall(sm, 'p2');
    planResult(sm, 'p2', { [PLAN_VERSION_DETAIL_KEY]: 2 }, true);

    const tools = reconstructMessages(sm.getBranch()).messages.flatMap((m) => (m.kind === 'assistant' ? m.tools : []));
    expect(tools.map((tool) => [tool.id, tool.metadata?.[PLAN_VERSION_DETAIL_KEY]])).toEqual([['legacy', undefined], ['p2', 2]]);
  });
});
