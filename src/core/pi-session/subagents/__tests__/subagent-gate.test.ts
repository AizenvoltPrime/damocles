import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { runPermissionGate, buildCanUseToolContext, type GatePermissionContext } from '../../permission-gate';
import { POLICY_BLOCK_MARKER } from '../../../../shared/types/constants';
import type { PermissionHandler, PermissionResult } from '../../../permission-handler';
import { createSubagentExtensionFactory } from '../subagent-extension-factory';
import { isPlanFilePath } from '../../../paths';
import { ShellCancelStore } from '../../tools/shell-cancel-registry';

function ev(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: 'tool_call', toolName, toolCallId, input } as unknown as ToolCallEvent;
}

function makeGate(plan: boolean) {
  const canUseTool = vi.fn<PermissionHandler['canUseTool']>(async (): Promise<PermissionResult> => ({ behavior: 'allow', updatedInput: {} }));
  const ctx: GatePermissionContext = {
    permissionHandler: { canUseTool, decide: vi.fn(() => 'allow' as const), matchRule: vi.fn(async () => null), isPlanFile: isPlanFilePath } as unknown as GatePermissionContext['permissionHandler'],
    isPlanMode: () => plan,
    shellCancel: new ShellCancelStore().forContext(() => undefined),
  };
  return { ctx, canUseTool };
}

describe('nested subagent gate routing', () => {
  it('buildCanUseToolContext defaults parentToolUseId to null, and carries it when supplied', () => {
    expect(buildCanUseToolContext('t1', undefined).parentToolUseId).toBeNull();
    expect(buildCanUseToolContext('t1', undefined, 'parent-99').parentToolUseId).toBe('parent-99');
  });

  it('stamps the spawning Agent tool-call id as parentToolUseId on the subagent write approval', async () => {
    const { ctx, canUseTool } = makeGate(false);
    await runPermissionGate(ev('Edit', 'nested-call', { file_path: '/a', old_string: 'a', new_string: 'b' }), ctx, undefined, 'agent-parent-1');
    expect(canUseTool).toHaveBeenCalledTimes(1);
    const passedCtx = canUseTool.mock.calls[0]![2];
    expect(passedCtx.parentToolUseId).toBe('agent-parent-1');
    expect(passedCtx.toolUseID).toBe('nested-call');
  });

  it('inherit-parent-mode: a subagent write is blocked when the panel is in plan mode', async () => {
    const { ctx, canUseTool } = makeGate(true);
    const result = await runPermissionGate(ev('write', 'nested-call', { path: '/a', content: 'x' }), ctx, undefined, 'agent-parent-1');
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('a subagent read is auto-allowed (no approval prompt)', async () => {
    const { ctx, canUseTool } = makeGate(false);
    const result = await runPermissionGate(ev('read', 'nested-call', { path: '/a.ts' }), ctx, undefined, 'agent-parent-1');
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
  });
});

describe('nested agents and the parent turn checkpoint', () => {
  it('holds a nested file change until the parent turn baseline lands, and never a nested read', async () => {
    let releaseBaseline!: () => void;
    const parentBaseline = new Promise<void>((resolve) => { releaseBaseline = resolve; });
    const waited: string[] = [];
    const { ctx } = makeGate(false);
    const handlers: Record<string, (event: unknown, hookCtx: unknown) => Promise<unknown>> = {};
    createSubagentExtensionFactory({
      ...ctx,
      parentToolUseId: 'agent-parent-1',
      deferrableToolNames: [],
      checkpointBaseline: {
        folder: path.resolve('/'),
        wait: async (_signal, toolName) => {
          waited.push(toolName);
          await parentBaseline;
        },
      },
    })({ on: (event: string, handler: (e: unknown, c: unknown) => Promise<unknown>) => { handlers[event] = handler; } } as never);
    const hookCtx = { signal: undefined, sessionManager: { getSessionId: () => 'nested' } };

    await handlers['tool_call']!(ev('read', 'r1', { path: '/a.ts' }), hookCtx);
    let settled = false;
    const edit = handlers['tool_call']!(ev('Edit', 'e1', { file_path: '/a', old_string: 'a', new_string: 'b' }), hookCtx).then(() => { settled = true; });
    await vi.waitFor(() => expect(waited).toEqual(['Edit']));
    expect(settled).toBe(false);
    releaseBaseline();
    await edit;
    expect(waited).toEqual(['Edit']);
  });
});

describe('nested shell cancel entries', () => {
  it('drops the entry of a shell call that ends without executing, as when another extension blocks it', async () => {
    const store = new ShellCancelStore();
    const shellCancel = store.forContext(() => undefined);
    const admit = vi.spyOn(shellCancel, 'admit');
    const handlers: Record<string, (event: unknown, hookCtx: unknown) => unknown> = {};
    createSubagentExtensionFactory({ ...makeGate(false).ctx, shellCancel, parentToolUseId: 'agent-parent-1', deferrableToolNames: [] })(
      { on: (event: string, handler: (e: unknown, c: unknown) => unknown) => { handlers[event] = handler; } } as never,
    );
    const hookCtx = { signal: undefined, sessionManager: { getSessionId: () => 'nested' } };

    expect(await handlers['tool_call']!(ev('bash', 'b1', { command: 'make' }), hookCtx)).toBeUndefined();
    expect(admit).toHaveLastReturnedWith(expect.any(AbortSignal));
    handlers['tool_execution_end']!({ type: 'tool_execution_end', toolCallId: 'b1', toolName: 'bash', result: { content: [] }, isError: true }, hookCtx);

    expect(store.cancel('b1')).toBe(false);
  });
});
