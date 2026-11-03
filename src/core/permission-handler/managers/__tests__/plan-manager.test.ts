import { describe, it, expect } from 'vitest';
import { PlanManager } from '../plan-manager';
import { installLogSink } from '../../../logger';
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
      expect(result.updatedInput).not.toHaveProperty('plan');
    }
    expect(result).not.toHaveProperty('editedPlan');
  });

  it('carries the plan file\'s text on an approval when the user changed it while the plan was open', async () => {
    const state = new PermissionState();
    state.permissionMode = 'plan';
    const manager = new PlanManager(state, () => (() => undefined) as PostMessageFn);
    let onDisk = '# Plan\n1. Ship it\n';
    manager.setPlanContentResolver(async () => onDisk);

    const { context } = makeContext();
    const pending = manager.handleExitPlanMode({}, context);
    await new Promise((r) => setTimeout(r, 0));
    onDisk = '# Plan\n1. Ship it\n2. Roll back first\n';
    manager.resolvePlanApproval('t1', true, { approvalMode: 'manual' });

    expect(await pending).toMatchObject({ behavior: 'allow', editedPlan: '# Plan\n1. Ship it\n2. Roll back first\n' });
  });

  it('approves the plan the user was shown, and logs why, when the plan file cannot be read after the click', async () => {
    const logged: string[] = [];
    installLogSink({ appendLine: (line: string) => void logged.push(line), show: () => undefined, dispose: () => undefined });
    const state = new PermissionState();
    state.permissionMode = 'plan';
    const manager = new PlanManager(state, () => (() => undefined) as PostMessageFn);
    let read: () => string = () => '# Plan\n1. Ship it\n';
    manager.setPlanContentResolver(async () => read());

    const { context } = makeContext();
    const pending = manager.handleExitPlanMode({}, context);
    await new Promise((r) => setTimeout(r, 0));
    read = () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    };
    manager.resolvePlanApproval('t1', true, { approvalMode: 'manual' });

    const result = await pending;
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { approved: true, approvalMode: 'manual' } });
    expect(result).not.toHaveProperty('editedPlan');
    expect(logged.some((line) => line.includes('EBUSY: resource busy or locked'))).toBe(true);
  });

  it('sends no edit for a save that only changed line endings, and sends an edit as the file holds it', async () => {
    const state = new PermissionState();
    state.permissionMode = 'plan';
    const manager = new PlanManager(state, () => (() => undefined) as PostMessageFn);
    let onDisk = '# Plan\n1. Ship it\r\n2. Test it\r';
    manager.setPlanContentResolver(async () => onDisk);

    const first = makeContext();
    const unchanged = manager.handleExitPlanMode({}, first.context);
    await new Promise((r) => setTimeout(r, 0));
    onDisk = '# Plan\r\n1. Ship it\n2. Test it\r\n';
    manager.resolvePlanApproval('t1', true, { approvalMode: 'manual' });
    expect(await unchanged).not.toHaveProperty('editedPlan');

    onDisk = '# Plan\n1. Ship it\n';
    const second = makeContext();
    const edited = manager.handleExitPlanMode({}, second.context);
    await new Promise((r) => setTimeout(r, 0));
    onDisk = '# Plan\r\n1. Ship it\r\n2. Roll back\r\n';
    manager.resolvePlanApproval('t1', true, { approvalMode: 'manual' });
    expect(await edited).toMatchObject({ behavior: 'allow', editedPlan: '# Plan\r\n1. Ship it\r\n2. Roll back\r\n' });
  });
});
