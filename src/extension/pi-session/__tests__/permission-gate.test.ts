import { describe, it, expect, vi } from 'vitest';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { runPermissionGate, gateErrorFallback, type PanelGateContext } from '../permission-gate';
import { FEEDBACK_MARKER } from '../../../shared/types/constants';
import type { PermissionResult } from '../../permission-handler';

function ev(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: 'tool_call', toolName, toolCallId, input } as unknown as ToolCallEvent;
}

function makePanel(opts: {
  plan?: boolean;
  canUse?: () => Promise<PermissionResult>;
  evaluate?: () => Promise<'allow' | 'deny' | 'ask'>;
}) {
  const canUseTool = vi.fn(opts.canUse ?? (async (): Promise<PermissionResult> => ({ behavior: 'allow', updatedInput: {} })));
  const evaluatePermission = vi.fn(opts.evaluate ?? (async () => 'allow' as const));
  const permissionHandler = { canUseTool, evaluatePermission } as unknown as PanelGateContext['permissionHandler'];
  const panel: PanelGateContext = {
    permissionHandler,
    isPlanMode: () => Boolean(opts.plan),
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
    postMessage: () => undefined,
    currentPromptIndex: () => 0,
  };
  return { panel, canUseTool, evaluatePermission };
}

describe('runPermissionGate', () => {
  it('auto-allows read tools without calling canUseTool', async () => {
    const { panel, canUseTool, evaluatePermission } = makePanel({ evaluate: async () => 'allow' });
    const result = await runPermissionGate(ev('read', 't1', { path: '/a.ts' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    // The evaluator sees the Damocles shape (file_path), not pi's raw `path`.
    expect(evaluatePermission).toHaveBeenCalledWith('Read', { file_path: '/a.ts' });
  });

  it('blocks a read tool denied by a settings rule, rendering as denied (marker present)', async () => {
    const { panel } = makePanel({ evaluate: async () => 'deny' });
    const result = await runPermissionGate(ev('read', 't1'), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(FEEDBACK_MARKER);
  });

  it('routes write tools through canUseTool with the pi toolCallId as the correlation id', async () => {
    const { panel, canUseTool } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    const result = await runPermissionGate(ev('write', 'call-42', { path: '/a.ts', content: 'x' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
    const [name, input, ctx] = canUseTool.mock.calls[0];
    expect(name).toBe('Write');
    expect(input).toEqual({ file_path: '/a.ts', content: 'x' });
    expect(ctx.toolUseID).toBe('call-42');
  });

  it('blocks a denied write and formats the reason as denied (FR-9 marker)', async () => {
    const { panel } = makePanel({ canUse: async () => ({ behavior: 'deny', message: 'User rejected the file modification' }) });
    const result = await runPermissionGate(ev('Edit', 'c1', { file_path: '/a', old_string: 'a', new_string: 'b' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(FEEDBACK_MARKER);
  });

  it('blocks write/shell in plan mode without prompting (defense in depth)', async () => {
    const { panel, canUseTool } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'rm -rf /' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('always-allows interactive + task-list tools at the gate (they own their own interaction)', async () => {
    const { panel, canUseTool } = makePanel({});
    for (const name of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']) {
      expect(await runPermissionGate(ev(name, 'c'), panel, undefined)).toBeUndefined();
    }
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('auto-allows module tools via the settings evaluator without prompting (FR-4)', async () => {
    const { panel, canUseTool, evaluatePermission } = makePanel({ evaluate: async () => 'allow' });
    const result = await runPermissionGate(ev('SaveObservation', 'm1', { title: 'x' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(evaluatePermission).toHaveBeenCalledWith('SaveObservation', { title: 'x' });
  });

  it('blocks a module tool denied by a settings rule (denied marker present)', async () => {
    const { panel, canUseTool } = makePanel({ evaluate: async () => 'deny' });
    const result = await runPermissionGate(ev('BrowserOpen', 'm1'), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(FEEDBACK_MARKER);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('routes module tools through the evaluator even in plan mode (read-only compass stays usable)', async () => {
    const { panel, canUseTool, evaluatePermission } = makePanel({ plan: true, evaluate: async () => 'allow' });
    const result = await runPermissionGate(ev('CompassSearch', 'm1', { query: 'x' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(evaluatePermission).toHaveBeenCalledWith('CompassSearch', { query: 'x' });
  });

  it('correlates parallel write approvals by distinct toolCallId', async () => {
    const { panel, canUseTool } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    await Promise.all([
      runPermissionGate(ev('Edit', 'edit-A', { file_path: '/a' }), panel, undefined),
      runPermissionGate(ev('Edit', 'edit-B', { file_path: '/b' }), panel, undefined),
    ]);
    const ids = canUseTool.mock.calls.map((c) => c[2].toolUseID).sort();
    expect(ids).toEqual(['edit-A', 'edit-B']);
  });
});

describe('gateErrorFallback (fail-closed on gate exception)', () => {
  it('blocks write/shell/unknown tools by default', () => {
    expect(gateErrorFallback('write')?.block).toBe(true);
    expect(gateErrorFallback('bash')?.block).toBe(true);
    expect(gateErrorFallback('Edit')?.block).toBe(true);
    expect(gateErrorFallback('PowerShell')?.block).toBe(true);
    expect(gateErrorFallback('SaveObservation')?.block).toBe(true); // 'other' category → blocked
  });

  it('lets read-only tools through (harmless, auto-allowed on the normal path)', () => {
    expect(gateErrorFallback('read')).toBeUndefined();
    expect(gateErrorFallback('grep')).toBeUndefined();
    expect(gateErrorFallback('ls')).toBeUndefined();
  });
});
