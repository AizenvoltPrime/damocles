import { describe, it, expect, vi } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { PermissionHandler } from '../../../permission-handler';
import { createPlanModeTools } from '../plan-mode-tools';

function fakePi(): PiCodingAgentModule {
  return { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
}

function fakePermissionHandler(activate = vi.fn(async () => undefined)): PermissionHandler {
  return { activatePlanMode: activate, getPermissionMode: () => 'plan' } as unknown as PermissionHandler;
}

async function runEnter(getPlanFilePath?: () => string) {
  const activate = vi.fn(async () => undefined);
  const [enter] = createPlanModeTools(fakePi(), fakePermissionHandler(activate), getPlanFilePath);
  const result = await (enter as unknown as { execute: (id: string, p: unknown, s: unknown) => Promise<{ content: { text: string }[] }> }).execute('t1', {}, undefined);
  return { activate, text: result.content[0]?.text ?? '' };
}

describe('EnterPlanMode tool', () => {
  it('activates plan mode and names the concrete plan path when provided (mid-turn entry has no path in the prompt)', async () => {
    const planPath = '/home/.damocles/plans/create-hello-world-abcd1234.md';
    const { activate, text } = await runEnter(() => planPath);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(text).toContain(planPath);
    expect(text).toContain('ExitPlanMode');
  });

  it('reads the path at execute time (not build time)', async () => {
    let current = '/home/.damocles/plans/plan-aaaa1111.md';
    const [enter] = createPlanModeTools(fakePi(), fakePermissionHandler(), () => current);
    current = '/home/.damocles/plans/real-request-bbbb2222.md';
    const result = await (enter as unknown as { execute: (id: string, p: unknown, s: unknown) => Promise<{ content: { text: string }[] }> }).execute('t1', {}, undefined);
    expect(result.content[0]?.text).toContain('real-request-bbbb2222.md');
  });

  it('falls back to a system-prompt reference when no path getter is wired (subagents)', async () => {
    const { text } = await runEnter(undefined);
    expect(text).toContain('named in your system prompt');
  });
});
