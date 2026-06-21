import { describe, it, expect, vi } from 'vitest';
import { createDamoclesExtensionFactory } from '../damocles-extension';
import type { PanelGateContext } from '../permission-gate';

type Handlers = Record<string, (event: unknown, ctx: unknown) => unknown>;

function fakePi(handlers: Handlers): unknown {
  return { on: (event: string, handler: (e: unknown, c: unknown) => unknown) => { handlers[event] = handler; } };
}

function ctxFor(sessionId: string): unknown {
  return { sessionManager: { getSessionId: () => sessionId }, signal: undefined };
}

function panel(evaluate: 'allow' | 'deny', plan = false): PanelGateContext {
  return {
    permissionHandler: {
      evaluatePermission: vi.fn(async () => evaluate),
      canUseTool: vi.fn(async () => ({ behavior: 'allow', updatedInput: {} })),
    } as unknown as PanelGateContext['permissionHandler'],
    isPlanMode: () => plan,
    getSessionModel: () => 'claude-opus-4-8',
    getSystemPromptEnv: () => ({
      cwd: '/repo',
      model: 'claude-opus-4-8',
      isGitRepo: true,
      platform: 'linux',
      shell: 'bash',
      osVersion: 'Linux test',
      compassEnabled: false,
    }),
    getPlanFilePath: () => '/home/.damocles/plans/plan-test.md',
    postMessage: () => undefined,
    currentPromptIndex: () => 0,
  };
}

const readEvent = { type: 'tool_call', toolName: 'read', toolCallId: 't', input: {} };

describe('createDamoclesExtensionFactory (US-004 routing)', () => {
  it('routes a tool_call to the panel that owns the session id', async () => {
    const handlers: Handlers = {};
    const panelA = panel('allow');
    const panelB = panel('deny');
    const registry = new Map<string, PanelGateContext>([['A', panelA], ['B', panelB]]);
    createDamoclesExtensionFactory({ get: (id) => registry.get(id) })(fakePi(handlers) as never);

    expect(await handlers.tool_call(readEvent, ctxFor('A'))).toBeUndefined();
    expect(panelA.permissionHandler.evaluatePermission).toHaveBeenCalledTimes(1);
    expect(panelB.permissionHandler.evaluatePermission).not.toHaveBeenCalled();

    const blocked = (await handlers.tool_call(readEvent, ctxFor('B'))) as { block?: boolean } | undefined;
    expect(blocked?.block).toBe(true);
  });

  it('no-ops when no panel is registered for the session', async () => {
    const handlers: Handlers = {};
    createDamoclesExtensionFactory({ get: () => undefined })(fakePi(handlers) as never);
    expect(await handlers.tool_call(readEvent, ctxFor('missing'))).toBeUndefined();
  });

  it('returns the Damocles system prompt (replacing pi boilerplate), with plan instruction only in plan mode', async () => {
    const handlers: Handlers = {};
    const planning = new Map<string, PanelGateContext>([['A', panel('allow', true)], ['B', panel('allow', false)]]);
    createDamoclesExtensionFactory({ get: (id) => planning.get(id) })(fakePi(handlers) as never);

    const baseEvent = { type: 'before_agent_start', prompt: 'hi', systemPrompt: 'PI BASE', systemPromptOptions: { cwd: '/repo' } };

    const inPlan = (await handlers.before_agent_start({ ...baseEvent }, ctxFor('A'))) as { systemPrompt: string };
    expect(inPlan.systemPrompt).not.toContain('operating inside pi');
    expect(inPlan.systemPrompt).not.toContain('PI BASE');
    expect(inPlan.systemPrompt).toContain('AI coding agent');
    expect(inPlan.systemPrompt).toContain('Plan mode is active');

    const notPlan = (await handlers.before_agent_start({ ...baseEvent }, ctxFor('B'))) as { systemPrompt: string };
    expect(notPlan.systemPrompt).toContain('AI coding agent');
    expect(notPlan.systemPrompt).not.toContain('Plan mode is active');

    expect(await handlers.before_agent_start({ ...baseEvent }, ctxFor('missing'))).toBeUndefined();
  });
});
