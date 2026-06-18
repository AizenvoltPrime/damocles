import { describe, it, expect, vi } from 'vitest';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { runPermissionGate, buildCanUseToolContext, type GatePermissionContext } from '../../permission-gate';
import { FEEDBACK_MARKER } from '../../../../shared/types/constants';
import type { PermissionResult } from '../../../permission-handler';

function ev(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: 'tool_call', toolName, toolCallId, input } as unknown as ToolCallEvent;
}

function makeGate(plan: boolean) {
  const canUseTool = vi.fn(async (): Promise<PermissionResult> => ({ behavior: 'allow', updatedInput: {} }));
  const ctx: GatePermissionContext = {
    permissionHandler: { canUseTool, evaluatePermission: vi.fn(async () => 'allow' as const) } as unknown as GatePermissionContext['permissionHandler'],
    isPlanMode: () => plan,
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
    const passedCtx = canUseTool.mock.calls[0][2];
    expect(passedCtx.parentToolUseId).toBe('agent-parent-1');
    expect(passedCtx.toolUseID).toBe('nested-call');
  });

  it('inherit-parent-mode: a subagent write is blocked when the panel is in plan mode', async () => {
    const { ctx, canUseTool } = makeGate(true);
    const result = await runPermissionGate(ev('write', 'nested-call', { path: '/a', content: 'x' }), ctx, undefined, 'agent-parent-1');
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(FEEDBACK_MARKER);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('a subagent read is auto-allowed (no approval prompt)', async () => {
    const { ctx, canUseTool } = makeGate(false);
    const result = await runPermissionGate(ev('read', 'nested-call', { path: '/a.ts' }), ctx, undefined, 'agent-parent-1');
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
  });
});
