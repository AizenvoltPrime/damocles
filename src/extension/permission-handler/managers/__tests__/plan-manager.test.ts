import { describe, it, expect, vi } from 'vitest';
import { PlanManager } from '../plan-manager';
import { PermissionState } from '../../state';
import type { CanUseToolContext, PostMessageFn } from '../../types';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';

function makeContext(): { context: CanUseToolContext } {
  const controller = new AbortController();
  return {
    context: { signal: controller.signal, toolUseID: 't1' },
  };
}

describe('PlanManager.handleExitPlanMode', () => {
  it('denies with the write-the-plan instruction when no plan file exists', async () => {
    const state = new PermissionState();
    state.permissionMode = 'plan';
    const posted: ExtensionToWebviewMessage[] = [];
    const manager = new PlanManager(state, () => ((m) => posted.push(m)) as PostMessageFn);
    manager.setPlanContentResolver(async () => null);

    const { context } = makeContext();
    const result = await manager.handleExitPlanMode({}, context);

    expect(result.behavior).toBe('deny');
    if (result.behavior === 'deny') expect(result.message).toMatch(/No plan file found/);
    // No approval overlay is shown when blocked.
    expect(posted.some((m) => m.type === 'requestPlanApproval')).toBe(false);
  });

  it('denies when the plan file is present but blank', async () => {
    const state = new PermissionState();
    state.permissionMode = 'plan';
    const manager = new PlanManager(state, () => (() => undefined) as PostMessageFn);
    manager.setPlanContentResolver(async () => '   \n  ');

    const { context } = makeContext();
    const result = await manager.handleExitPlanMode({}, context);
    expect(result.behavior).toBe('deny');
  });

  it('posts the on-disk plan file content as the approval overlay payload', async () => {
    const state = new PermissionState();
    state.permissionMode = 'plan';
    const posted: ExtensionToWebviewMessage[] = [];
    const manager = new PlanManager(state, () => ((m) => posted.push(m)) as PostMessageFn);
    manager.setPlanContentResolver(async () => '# Plan: from disk');

    const { context } = makeContext();
    void manager.handleExitPlanMode({}, context);
    // Let the resolver + post run.
    await new Promise((r) => setTimeout(r, 0));

    const req = posted.find((m) => m.type === 'requestPlanApproval');
    expect(req).toBeDefined();
    if (req && req.type === 'requestPlanApproval') {
      expect(req.planContent).toBe('# Plan: from disk');
    }
  });

  it('resolves allow with no plan in updatedInput once approved', async () => {
    const state = new PermissionState();
    state.permissionMode = 'plan';
    const manager = new PlanManager(state, () => (() => undefined) as PostMessageFn);
    manager.setPlanContentResolver(async () => '# Plan: do X');

    const { context } = makeContext();
    const pending = manager.handleExitPlanMode({}, context);
    await new Promise((r) => setTimeout(r, 0));
    manager.resolvePlanApproval('t1', true, { approvalMode: 'acceptEdits' });

    const result = await pending;
    expect(result.behavior).toBe('allow');
    if (result.behavior === 'allow') {
      expect(result.updatedInput).toEqual({ approved: true, approvalMode: 'acceptEdits' });
      expect('plan' in result.updatedInput).toBe(false);
    }
  });
});
