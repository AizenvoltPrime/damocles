import { describe, it, expect, vi } from 'vitest';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import * as path from 'path';
import { runPermissionGate, gateErrorFallback, type PanelGateContext, type PreToolUseHookGate } from '../permission-gate';
import { DAMOCLES_PLANS_DIR } from '../../paths';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '../../../shared/types/constants';
import type { PermissionResult } from '../../permission-handler';
import type { ToolCallHookResult } from '../hooks/dispatch';

function ev(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: 'tool_call', toolName, toolCallId, input } as unknown as ToolCallEvent;
}

function makePanel(opts: {
  plan?: boolean;
  readOnlyShell?: boolean;
  canUse?: () => Promise<PermissionResult>;
  evaluate?: () => Promise<'allow' | 'deny' | 'ask'>;
  mcpReadOnly?: (name: string) => boolean;
}) {
  const canUseTool = vi.fn(opts.canUse ?? (async (): Promise<PermissionResult> => ({ behavior: 'allow', updatedInput: {} })));
  const evaluatePermission = vi.fn(opts.evaluate ?? (async () => 'allow' as const));
  const permissionHandler = { canUseTool, evaluatePermission } as unknown as PanelGateContext['permissionHandler'];
  const panel: PanelGateContext = {
    permissionHandler,
    isPlanMode: () => Boolean(opts.plan),
    ...(opts.readOnlyShell ? { readOnlyShell: true } : {}),
    ...(opts.mcpReadOnly ? { isMcpReadOnly: opts.mcpReadOnly } : {}),
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
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
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

  it('blocks a non-plan-file write in plan mode (only the plan file is exempt)', async () => {
    const { panel, canUseTool } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('write', 'c1', { path: '/repo/app.ts', content: 'x' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('auto-allows team_record_verification in plan mode — the one team tool that touches fs/git', async () => {
    // It shells out (read-only `git rev-parse`/`git status`) and reads files to fingerprint the tree,
    // which the "team tools touch no fs/shell" justification for GATEABLE_MODULE_NAMES no longer covers.
    // Pin the classification rather than assume it: strictly read-only, so auto-allow is correct, but a
    // future team tool that WRITES must not inherit this by analogy.
    const { panel, canUseTool } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('team_record_verification', 'c1', { command: 'npx vitest run', result: 'pass' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('auto-allows a provably read-only shell command in plan mode without prompting', async () => {
    const { panel, canUseTool, evaluatePermission } = makePanel({ plan: true, evaluate: async () => 'allow' });
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'git status' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(evaluatePermission).toHaveBeenCalledWith('Bash', { command: 'git status' });
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('blocks a read-only shell command in plan mode when a settings rule denies it (marker present)', async () => {
    const { panel, canUseTool } = makePanel({ plan: true, evaluate: async () => 'deny' });
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'git status' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('blocks a non-read-only shell command in plan mode with a teaching reason (no prompt fallback)', async () => {
    const { panel, canUseTool } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'git commit -m x' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).toContain('not recognized as read-only');
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('auto-allows a provably read-only PowerShell command in plan mode without prompting', async () => {
    const { panel, canUseTool, evaluatePermission } = makePanel({ plan: true, evaluate: async () => 'allow' });
    const result = await runPermissionGate(ev('PowerShell', 'c1', { command: 'Get-Content a.txt' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(evaluatePermission).toHaveBeenCalledWith('PowerShell', { command: 'Get-Content a.txt' });
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('blocks a non-read-only PowerShell command in plan mode with a teaching reason (no prompt fallback)', async () => {
    const { panel, canUseTool } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('PowerShell', 'c1', { command: 'Set-Content a.txt x' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).toContain('not recognized as read-only');
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('blocks Monitor in plan mode (never read-only) without prompting', async () => {
    const { panel, canUseTool } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('Monitor', 'c1', { command: 'anything' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('routes a shell command through canUseTool in non-plan mode (normal mode unchanged)', async () => {
    const { panel, canUseTool } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'git status' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
  });

  it('allows Write/Edit to the plan file in plan mode (falls through to canUseTool → evaluator auto-allows)', async () => {
    const planPath = path.join(DAMOCLES_PLANS_DIR, 'plan-abc12345.md');
    const write = makePanel({ plan: true });
    const writeResult = await runPermissionGate(ev('write', 'c1', { path: planPath, content: '# plan' }), write.panel, undefined);
    expect(writeResult).toBeUndefined();
    expect(write.canUseTool).toHaveBeenCalledTimes(1);

    const edit = makePanel({ plan: true });
    const editResult = await runPermissionGate(ev('Edit', 'c2', { file_path: planPath, old_string: 'a', new_string: 'b' }), edit.panel, undefined);
    expect(editResult).toBeUndefined();
    expect(edit.canUseTool).toHaveBeenCalledTimes(1);
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
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
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

  // ---- MCP tools (US-014.4) --------------------------------------------------

  it('auto-allows a read-only MCP tool via the evaluator without prompting', async () => {
    const { panel, canUseTool, evaluatePermission } = makePanel({
      evaluate: async () => 'allow',
      mcpReadOnly: (n) => n === 'mcp__git__status',
    });
    const result = await runPermissionGate(ev('mcp__git__status', 'm1', { a: 1 }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(evaluatePermission).toHaveBeenCalledWith('mcp__git__status', { a: 1 });
  });

  it('blocks a read-only MCP tool denied by a settings rule (marker present)', async () => {
    const { panel } = makePanel({ evaluate: async () => 'deny', mcpReadOnly: () => true });
    const result = await runPermissionGate(ev('mcp__git__status', 'm1'), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
  });

  it('routes a non-read MCP tool through the full approval flow', async () => {
    const { panel, canUseTool } = makePanel({
      canUse: async () => ({ behavior: 'allow', updatedInput: {} }),
      mcpReadOnly: () => false,
    });
    const result = await runPermissionGate(ev('mcp__git__commit', 'm1', { message: 'x' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(canUseTool.mock.calls[0][0]).toBe('mcp__git__commit');
  });

  it('in plan mode MCP tools follow normal-mode rules (not blocked by plan-mode defense)', async () => {
    // A non-read MCP tool in plan mode is no longer blocked — it routes through canUseTool like every
    // other mode (which auto-allows mcp__ tools via the EvaluatorManager).
    const nonRead = makePanel({
      plan: true,
      canUse: async () => ({ behavior: 'allow', updatedInput: {} }),
      mcpReadOnly: () => false,
    });
    const nonReadResult = await runPermissionGate(ev('mcp__git__commit', 'm1', { message: 'x' }), nonRead.panel, undefined);
    expect(nonReadResult).toBeUndefined();
    expect(nonRead.canUseTool).toHaveBeenCalledTimes(1);
    expect(nonRead.canUseTool.mock.calls[0][0]).toBe('mcp__git__commit');

    // A read-only MCP tool still auto-allows via evaluatePermission without hitting canUseTool.
    const readOnly = makePanel({ plan: true, evaluate: async () => 'allow', mcpReadOnly: () => true });
    const readOnlyResult = await runPermissionGate(ev('mcp__git__status', 'm1'), readOnly.panel, undefined);
    expect(readOnlyResult).toBeUndefined();
    expect(readOnly.canUseTool).not.toHaveBeenCalled();
  });
});

// ---- PreToolUse hooks inside the gate (US-005, Section 3.3) -----------------

function hookResult(partial: Partial<ToolCallHookResult> & { decision: 'allow' | 'deny' | 'ask' }): ToolCallHookResult {
  return { finalInput: {}, mutated: false, anyFailed: false, systemMessages: [], ...partial };
}

function preToolUseGate(
  result: ToolCallHookResult | null,
  onDecision = vi.fn(),
  extra: { notify?: ReturnType<typeof vi.fn>; stashContext?: ReturnType<typeof vi.fn> } = {},
): PreToolUseHookGate {
  return {
    run: async () => result,
    onDecision,
    notify: extra.notify ?? vi.fn(),
    stashContext: extra.stashContext ?? vi.fn(),
  };
}

describe('runPermissionGate — PreToolUse hooks', () => {
  it('deny blocks the tool with the FR-9 marker and raises the notice', async () => {
    const { panel, canUseTool } = makePanel({});
    const onDecision = vi.fn();
    const gate = preToolUseGate(hookResult({ decision: 'deny', reason: 'rm -rf blocked' }), onDecision);
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'rm -rf /' }), panel, undefined, null, gate);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).toContain('rm -rf blocked');
    expect(canUseTool).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith('Bash', 'deny', 'rm -rf blocked');
  });

  it('allow force-allows, skipping the approval flow and the notice fires', async () => {
    const { panel, canUseTool } = makePanel({});
    const onDecision = vi.fn();
    const gate = preToolUseGate(hookResult({ decision: 'allow' }), onDecision);
    const result = await runPermissionGate(ev('write', 'c1', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith('Write', 'allow', undefined);
  });

  it('allow overrides a plan-mode block', async () => {
    const { panel } = makePanel({ plan: true });
    const gate = preToolUseGate(hookResult({ decision: 'allow' }));
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'ls' }), panel, undefined, null, gate);
    expect(result).toBeUndefined();
  });

  it('updatedInput is denormalized + mutated onto event.input before the gate runs', async () => {
    const { panel, evaluatePermission } = makePanel({ evaluate: async () => 'allow' });
    const event = ev('read', 'c1', { path: '/orig' });
    const gate = preToolUseGate(hookResult({ decision: 'ask', mutated: true, finalInput: { file_path: '/new' } }));
    const result = await runPermissionGate(event, panel, undefined, null, gate);
    expect(result).toBeUndefined();
    expect((event.input as Record<string, unknown>).path).toBe('/new');
    expect(evaluatePermission).toHaveBeenCalledWith('Read', { file_path: '/new' });
  });

  it('ask falls through to the normal approval flow', async () => {
    const { panel, canUseTool } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    const gate = preToolUseGate(hookResult({ decision: 'ask' }));
    await runPermissionGate(ev('write', 'c1', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(canUseTool).toHaveBeenCalledTimes(1);
  });

  it('infra failure is fail-closed for write/shell (blocked) but not for reads', async () => {
    const { panel: writePanel, canUseTool: writeCanUse } = makePanel({});
    const writeGate = preToolUseGate(hookResult({ decision: 'ask', anyFailed: true }));
    const writeResult = await runPermissionGate(ev('write', 'c1', { path: '/a', content: 'x' }), writePanel, undefined, null, writeGate);
    expect(writeResult?.block).toBe(true);
    expect(writeCanUse).not.toHaveBeenCalled();

    const { panel: readPanel } = makePanel({ evaluate: async () => 'allow' });
    const readGate = preToolUseGate(hookResult({ decision: 'ask', anyFailed: true }));
    const readResult = await runPermissionGate(ev('read', 'c2', { path: '/a' }), readPanel, undefined, null, readGate);
    expect(readResult).toBeUndefined();
  });

  it('allow wins over a sibling hook infra failure (allow precedes the fail-closed check)', async () => {
    const { panel, canUseTool } = makePanel({});
    const onDecision = vi.fn();
    const gate = preToolUseGate(hookResult({ decision: 'allow', anyFailed: true }), onDecision);
    const result = await runPermissionGate(ev('write', 'c1', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith('Write', 'allow', undefined);
  });

  it('no hook match (null) leaves the gate behaving exactly as today', async () => {
    const { panel, canUseTool } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    const gate = preToolUseGate(null);
    await runPermissionGate(ev('write', 'c1', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(canUseTool).toHaveBeenCalledTimes(1);
  });

  // ---- H1: systemMessage surfacing + additionalContext delivery (full parity) ----

  it('surfaces hook systemMessage(s) via notify regardless of the decision', async () => {
    const { panel } = makePanel({ evaluate: async () => 'allow' });
    const notify = vi.fn();
    const gate = preToolUseGate(hookResult({ decision: 'ask', systemMessages: ['heads up'] }), vi.fn(), { notify });
    await runPermissionGate(ev('read', 'c1', { path: '/a' }), panel, undefined, null, gate);
    expect(notify).toHaveBeenCalledWith(['heads up']);
  });

  it('stashes PreToolUse additionalContext (force-allow) for delivery on the tool result', async () => {
    const { panel } = makePanel({});
    const stashContext = vi.fn();
    const gate = preToolUseGate(hookResult({ decision: 'allow', additionalContext: 'extra ctx' }), vi.fn(), { stashContext });
    await runPermissionGate(ev('write', 'call-1', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(stashContext).toHaveBeenCalledWith('call-1', 'extra ctx');
  });

  it('stashes additionalContext on the normal approval path once the user approves', async () => {
    const { panel } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    const stashContext = vi.fn();
    const gate = preToolUseGate(hookResult({ decision: 'ask', additionalContext: 'ctx' }), vi.fn(), { stashContext });
    await runPermissionGate(ev('write', 'call-7', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(stashContext).toHaveBeenCalledWith('call-7', 'ctx');
  });

  it('does NOT stash additionalContext when the tool is denied (no result will arrive)', async () => {
    const { panel } = makePanel({});
    const stashContext = vi.fn();
    const gate = preToolUseGate(hookResult({ decision: 'deny', reason: 'no', additionalContext: 'ctx' }), vi.fn(), { stashContext });
    await runPermissionGate(ev('bash', 'call-1', { command: 'x' }), panel, undefined, null, gate);
    expect(stashContext).not.toHaveBeenCalled();
  });

  it('does NOT stash additionalContext when the user denies on the approval path', async () => {
    const { panel } = makePanel({ canUse: async () => ({ behavior: 'deny', message: 'rejected' }) });
    const stashContext = vi.fn();
    const gate = preToolUseGate(hookResult({ decision: 'ask', additionalContext: 'ctx' }), vi.fn(), { stashContext });
    await runPermissionGate(ev('write', 'call-8', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(stashContext).not.toHaveBeenCalled();
  });

  // ---- H3: an updatedInput rewrite actually reaches Edit + Write -----------------

  it('updatedInput rewrite reaches the custom Edit tool unchanged (its native shape IS the CC shape)', async () => {
    const { panel, canUseTool } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    const event = ev('Edit', 'call-edit', { file_path: '/orig', old_string: 'a', new_string: 'b' });
    const gate = preToolUseGate(
      hookResult({ decision: 'ask', mutated: true, finalInput: { file_path: '/safe', old_string: 'a', new_string: 'b' } }),
    );
    await runPermissionGate(event, panel, undefined, null, gate);
    // The custom Edit tool executes from event.input, so the rewritten CC-shaped path must land there.
    expect((event.input as Record<string, unknown>).file_path).toBe('/safe');
    expect(canUseTool.mock.calls[0][1]).toMatchObject({ file_path: '/safe' });
  });

  it('updatedInput rewrite reaches pi-native Write, denormalized back to its raw `path`', async () => {
    const { panel, canUseTool } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    const event = ev('write', 'call-write', { path: '/orig', content: 'x' });
    const gate = preToolUseGate(hookResult({ decision: 'ask', mutated: true, finalInput: { file_path: '/safe', content: 'x' } }));
    await runPermissionGate(event, panel, undefined, null, gate);
    // Write executes from raw pi input, so the CC `file_path` must be denormalized back to `path`.
    expect((event.input as Record<string, unknown>).path).toBe('/safe');
    expect('file_path' in (event.input as Record<string, unknown>)).toBe(false);
    expect(canUseTool.mock.calls[0][1]).toMatchObject({ file_path: '/safe' });
  });
});

describe('runPermissionGate — read-only agents (readOnlyShell, outside plan mode)', () => {
  it('auto-allows a provably read-only command without prompting', async () => {
    const { panel, canUseTool } = makePanel({ readOnlyShell: true });
    const result = await runPermissionGate(ev('bash', 't1', { command: 'git status' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('blocks the shell write vectors the Explore/Plan prompts promise are unavailable', async () => {
    const { panel, canUseTool } = makePanel({ readOnlyShell: true });
    for (const command of [
      'echo hi > /tmp/out.txt',
      'cat <<EOF > notes.md\nx\nEOF',
      'echo hi | tee /tmp/out.txt',
      'cp a.ts b.ts',
      'rm -rf build',
    ]) {
      const result = await runPermissionGate(ev('bash', 't1', { command }), panel, undefined);
      expect(result?.block, command).toBe(true);
      expect(result?.reason).toContain('read-only agent');
    }
    // Never routed to approval: under dangerouslySkipPermissions that would auto-approve the write.
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('blocks a write tool outright — the plan-file carve-out is plan mode only', async () => {
    const { panel } = makePanel({ readOnlyShell: true });
    const planFile = path.join(DAMOCLES_PLANS_DIR, 'plan-test.md');
    const result = await runPermissionGate(ev('write', 't1', { path: planFile }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('read-only agent');
  });

  it('leaves a normal agent\'s shell alone (no readOnlyShell → the usual approval flow)', async () => {
    const { panel, canUseTool } = makePanel({});
    const result = await runPermissionGate(ev('bash', 't1', { command: 'rm -rf build' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalled();
  });
});

describe('block attribution — an automatic block must never claim the user refused', () => {
  const USER_CLAIM = "The user doesn't want to proceed";

  it('does not attribute a read-only-agent block to the user', async () => {
    const { panel, canUseTool } = makePanel({ readOnlyShell: true });
    const result = await runPermissionGate(ev('bash', 't1', { command: 'echo x > f.txt' }), panel, undefined);
    // The human was never asked — canUseTool was not even reached — so a model reading this must not
    // conclude a person overruled it and stop to ask.
    expect(canUseTool).not.toHaveBeenCalled();
    expect(result?.reason).not.toContain(USER_CLAIM);
    expect(result?.reason).toContain('blocked automatically and the user was not consulted');
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).not.toContain(FEEDBACK_MARKER);
  });

  it('does not attribute a plan-mode block to the user', async () => {
    const { panel } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('bash', 't1', { command: 'git commit -m x' }), panel, undefined);
    expect(result?.reason).not.toContain(USER_CLAIM);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
  });

  it('STILL attributes a real approval-prompt rejection to the user', async () => {
    const { panel } = makePanel({ canUse: async () => ({ behavior: 'deny', message: 'not this file' }) });
    const result = await runPermissionGate(ev('Edit', 't1', { file_path: '/a', old_string: 'a', new_string: 'b' }), panel, undefined);
    expect(result?.reason).toContain(USER_CLAIM);
    expect(result?.reason).toContain(FEEDBACK_MARKER);
    expect(result?.reason).not.toContain(POLICY_BLOCK_MARKER);
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
