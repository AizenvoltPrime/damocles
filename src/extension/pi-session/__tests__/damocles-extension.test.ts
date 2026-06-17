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

  it('injects the plan-mode instruction into before_agent_start only in plan mode', () => {
    const handlers: Handlers = {};
    const planning = new Map<string, PanelGateContext>([['A', panel('allow', true)], ['B', panel('allow', false)]]);
    createDamoclesExtensionFactory({ get: (id) => planning.get(id) })(fakePi(handlers) as never);

    const inPlan = handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: 'BASE' }, ctxFor('A')) as { systemPrompt: string };
    expect(inPlan.systemPrompt).toContain('BASE');
    expect(inPlan.systemPrompt).toContain('Plan mode is active');

    expect(handlers.before_agent_start({ type: 'before_agent_start', systemPrompt: 'BASE' }, ctxFor('B'))).toBeUndefined();
  });
});
