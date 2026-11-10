import { describe, it, expect, vi, afterAll, onTestFinished, type Mock } from 'vitest';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runPermissionGate, gateErrorFallback, callFactsOf, type PanelGateContext, type GatePermissionContext, type PreToolUseHookGate } from '../permission-gate';
import { buildNestedMcpToolset } from '../tools/mcp-tools';
import type { McpToolDescriptor } from '../mcp/types';
import type { McpClientManager } from '../mcp/mcp-client-manager';
import type { PiCodingAgentModule } from '../pi-loader';
import { DAMOCLES_DESIGNS_DIR, DAMOCLES_PLANS_DIR, isPlanFilePath } from '../../paths';
import { designFolderOf } from '../../design/design-paths';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '../../../shared/types/constants';
import { PermissionHandler, type CanUseToolContext, type PermissionResult } from '../../permission-handler';
import { buildUserFileEditDenyResult, buildUnaskedDenyResult } from '../../permission-handler/utils';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ToolCallHookResult } from '../hooks/dispatch';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import { provenReadOnlyShell, type ChatMachine } from '../proven-shell';

function ev(toolName: string, toolCallId: string, input: Record<string, unknown> = {}): ToolCallEvent {
  return { type: 'tool_call', toolName, toolCallId, input } as unknown as ToolCallEvent;
}

// A machine whose PowerShell PATH is empty, so PowerShell finds no script for any command.
const NO_PATH_MACHINE: ChatMachine = {
  platform: process.platform,
  allowedNetworkHosts: () => Promise.resolve(new Set()),
  powerShellSearch: () => Promise.resolve({ path: '', pathext: undefined, pwshHome: undefined }),
};

function makePanel(opts: {
  plan?: boolean;
  readOnlyShell?: boolean;
  canUse?: () => Promise<PermissionResult>;
  decide?: () => 'allow' | 'deny' | 'ask';
  rule?: () => Promise<'allow' | 'deny' | 'ask' | null>;
  mcpReadOnly?: (name: string) => boolean;
}) {
  const canUseTool = vi.fn<PermissionHandler['canUseTool']>(opts.canUse ?? (async (): Promise<PermissionResult> => ({ behavior: 'allow', updatedInput: {} })));
  const decide = vi.fn<PermissionHandler['decide']>(opts.decide ?? (() => 'allow' as const));
  const matchRule = vi.fn<PermissionHandler['matchRule']>(opts.rule ?? (async () => null));
  const permissionHandler = { canUseTool, decide, matchRule, isPlanFile: isPlanFilePath, sessionCwd: () => path.resolve('/repo') } as unknown as PanelGateContext['permissionHandler'];
  const panel: PanelGateContext = {
    permissionHandler,
    isPlanMode: () => Boolean(opts.plan),
    shellCancel: new ShellCancelStore().forContext(() => undefined),
    budgetStopRequested: () => false,
    ...(opts.readOnlyShell ? { readOnlyShell: true } : {}),
    ...(opts.mcpReadOnly ? { isMcpReadOnly: opts.mcpReadOnly } : {}),
    getSessionModel: () => 'claude-opus-4-8',
    memoryWorkspace: () => '/repo',
    getSystemPromptEnv: () => ({
      cwd: '/repo',
      model: 'claude-opus-4-8',
      isGitRepo: true,
      platform: 'linux',
      shell: 'bash',
      osVersion: 'Linux test',
      compassEnabled: false,
      thinkingDisabled: false,
    }),
    getPlanFilePath: () => '/home/.damocles/plans/plan-test.md',
    postMessage: () => undefined,
    machine: NO_PATH_MACHINE,
  };
  return { panel, canUseTool, decide, matchRule };
}

describe('runPermissionGate', () => {
  it('auto-allows read tools without calling canUseTool', async () => {
    const { panel, canUseTool, decide, matchRule } = makePanel({ decide: () => 'allow' });
    const result = await runPermissionGate(ev('read', 't1', { path: '/a.ts' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    // The evaluator sees the Damocles shape (file_path), not pi's raw `path`.
    expect(matchRule).toHaveBeenCalledWith('Read', { file_path: '/a.ts' }, undefined, {});
    expect(decide).toHaveBeenCalledWith('Read', { file_path: '/a.ts' }, null, false, false);
  });

  it('blocks a read tool denied by a settings rule, rendering as denied (marker present)', async () => {
    const { panel } = makePanel({ decide: () => 'deny' });
    const result = await runPermissionGate(ev('read', 't1'), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
  });

  it('routes write tools through canUseTool with the pi toolCallId as the correlation id', async () => {
    const { panel, canUseTool } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    const result = await runPermissionGate(ev('write', 'call-42', { path: '/a.ts', content: 'x' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
    const [name, input, ctx] = canUseTool.mock.calls[0]!;
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

  it('blocks a non-plan-file Edit in plan mode without prompting', async () => {
    const { panel, canUseTool } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('Edit', 'c1', { file_path: '/repo/app.ts', old_string: 'a', new_string: 'b' }), panel, undefined);
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

  it('auto-allows a browser tool in plan mode without prompting (module gate precedes the plan block)', async () => {
    const { panel, canUseTool } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('BrowserOpen', 'c1', { url: 'http://localhost:3000' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('auto-allows a provably read-only shell command in plan mode without prompting', async () => {
    const { panel, canUseTool, matchRule } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'git status' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(matchRule).toHaveBeenCalledWith('Bash', { command: 'git status' }, undefined, {});
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('prompts for a provably read-only shell command in plan mode when an ask rule names it', async () => {
    const { panel, canUseTool } = makePanel({ plan: true, rule: async () => 'ask' });
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'git status' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
  });

  it('blocks a read-only shell command in plan mode when a settings rule denies it (marker present)', async () => {
    const { panel, canUseTool } = makePanel({ plan: true, rule: async () => 'deny' });
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'git status' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('routes a shell command the classifier cannot prove read-only in plan mode to the approval flow', async () => {
    const { panel, canUseTool } = makePanel({ plan: true });
    const command = 'curl -s http://127.0.0.1:9001/v1/models && systemctl list-units';
    const result = await runPermissionGate(ev('bash', 'c1', { command }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(canUseTool.mock.calls[0]?.[0]).toBe('Bash');
  });

  it('attributes a rejected plan-mode shell prompt to the user', async () => {
    const { panel } = makePanel({ plan: true, canUse: async () => ({ behavior: 'deny', message: 'User rejected the command' }) });
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'systemctl list-units' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(FEEDBACK_MARKER);
  });

  it('auto-allows a provably read-only PowerShell command in plan mode without prompting', async () => {
    const { panel, canUseTool, matchRule } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('PowerShell', 'c1', { command: 'Get-Content a.txt' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(matchRule).toHaveBeenCalledWith('PowerShell', { command: 'Get-Content a.txt' }, undefined, {});
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('routes a PowerShell command the classifier cannot prove read-only in plan mode to the approval flow', async () => {
    const { panel, canUseTool } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('PowerShell', 'c1', { command: 'Invoke-WebRequest http://127.0.0.1:9001' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
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

  it('always-allows interactive tools at the gate (they own their own interaction)', async () => {
    const { panel, canUseTool } = makePanel({});
    for (const name of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']) {
      expect(await runPermissionGate(ev(name, 'c'), panel, undefined)).toBeUndefined();
    }
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('auto-allows module tools via the settings rules without prompting (FR-4)', async () => {
    const { panel, canUseTool, matchRule } = makePanel({});
    const result = await runPermissionGate(ev('SaveObservation', 'm1', { title: 'x' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(matchRule).toHaveBeenCalledWith('SaveObservation', { title: 'x' }, undefined, {});
  });

  it('blocks a module tool denied by a settings rule (denied marker present)', async () => {
    const { panel, canUseTool } = makePanel({ rule: async () => 'deny' });
    const result = await runPermissionGate(ev('BrowserOpen', 'm1'), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('prompts for a module tool an ask rule names, even in plan mode', async () => {
    const { panel, canUseTool } = makePanel({ plan: true, rule: async () => 'ask' });
    const result = await runPermissionGate(ev('BrowserOpen', 'm1'), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
  });

  it('routes module tools through the settings rules even in plan mode (read-only compass stays usable)', async () => {
    const { panel, canUseTool, matchRule } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('CompassSearch', 'm1', { query: 'x' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(matchRule).toHaveBeenCalledWith('CompassSearch', { query: 'x' }, undefined, {});
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
    const { panel, canUseTool, decide } = makePanel({
      decide: () => 'allow',
      mcpReadOnly: (n) => n === 'mcp__git__status',
    });
    const result = await runPermissionGate(ev('mcp__git__status', 'm1', { a: 1 }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledWith('mcp__git__status', { a: 1 }, null, false, false);
  });

  it('blocks a read-only MCP tool denied by a settings rule (marker present)', async () => {
    const { panel } = makePanel({ decide: () => 'deny', mcpReadOnly: () => true });
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
    expect(canUseTool.mock.calls[0]![0]).toBe('mcp__git__commit');
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
    expect(nonRead.canUseTool.mock.calls[0]![0]).toBe('mcp__git__commit');

    // A read-only MCP tool still auto-allows via the evaluator without hitting canUseTool.
    const readOnly = makePanel({ plan: true, decide: () => 'allow', mcpReadOnly: () => true });
    const readOnlyResult = await runPermissionGate(ev('mcp__git__status', 'm1'), readOnly.panel, undefined);
    expect(readOnlyResult).toBeUndefined();
    expect(readOnly.canUseTool).not.toHaveBeenCalled();
  });
});

// ---- PreToolUse hooks inside the gate (US-005, Section 3.3) -----------------

function hookResult(partial: Partial<ToolCallHookResult> & { decision: 'allow' | 'deny' | 'ask' }): ToolCallHookResult {
  return { finalInput: {}, mutated: false, anyFailed: false, systemMessages: [], ...partial };
}

const decisionSpy = (): Mock<PreToolUseHookGate['onDecision']> => vi.fn();
const notifySpy = (): Mock<PreToolUseHookGate['notify']> => vi.fn();
const stashSpy = (): Mock<PreToolUseHookGate['stashContext']> => vi.fn();

function preToolUseGate(
  result: ToolCallHookResult | null,
  onDecision: PreToolUseHookGate['onDecision'] = decisionSpy(),
  extra: { notify?: PreToolUseHookGate['notify']; stashContext?: PreToolUseHookGate['stashContext'] } = {},
): PreToolUseHookGate {
  return {
    run: async () => result,
    onDecision,
    notify: extra.notify ?? notifySpy(),
    stashContext: extra.stashContext ?? stashSpy(),
  };
}

describe('runPermissionGate — PreToolUse hooks', () => {
  it('deny blocks the tool with the FR-9 marker and raises the notice', async () => {
    const { panel, canUseTool } = makePanel({});
    const onDecision = decisionSpy();
    const gate = preToolUseGate(hookResult({ decision: 'deny', reason: 'rm -rf blocked' }), onDecision);
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'rm -rf /' }), panel, undefined, null, gate);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).toContain('rm -rf blocked');
    expect(canUseTool).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith('Bash', 'deny', 'rm -rf blocked', false);
  });

  /**
   * The gate's translation of a hook `terminate` into pi's `terminate` — the headline feature. Asserted
   * HERE and not only in the dispatch tests: dispatch decides what a hook asked for, the gate decides
   * what pi is told. `terminate` must be ABSENT rather than `false` on the non-terminating paths
   * (`exactOptionalPropertyTypes`), so these check presence, not falsiness.
   */
  it('a hook deny with terminate ends the turn and the notice says so', async () => {
    const { panel } = makePanel({});
    const onDecision = decisionSpy();
    const gate = preToolUseGate(hookResult({ decision: 'deny', terminate: true, reason: 'stop' }), onDecision);
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'rm -rf /' }), panel, undefined, null, gate);
    expect(result?.block).toBe(true);
    expect(result?.terminate).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(onDecision).toHaveBeenCalledWith('Bash', 'deny', 'stop', true);
  });

  it('a hook deny WITHOUT terminate blocks the call but not the turn', async () => {
    const { panel } = makePanel({});
    const gate = preToolUseGate(hookResult({ decision: 'deny', reason: 'stop' }), decisionSpy());
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'rm -rf /' }), panel, undefined, null, gate);
    expect(result?.block).toBe(true);
    expect(result).not.toHaveProperty('terminate');
  });

  it('a fail-closed hook-infra block never terminates — a broken hook must not kill the turn', async () => {
    const { panel } = makePanel({});
    const gate = preToolUseGate(hookResult({ decision: 'ask', anyFailed: true }));
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'rm -rf /' }), panel, undefined, null, gate);
    expect(result?.block).toBe(true);
    expect(result).not.toHaveProperty('terminate');
  });

  it('allow force-allows, skipping the approval flow and the notice fires', async () => {
    const { panel, canUseTool } = makePanel({});
    const onDecision = decisionSpy();
    const gate = preToolUseGate(hookResult({ decision: 'allow' }), onDecision);
    const result = await runPermissionGate(ev('write', 'c1', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith('Write', 'allow', undefined, false);
  });

  it('allow overrides a plan-mode block', async () => {
    const { panel } = makePanel({ plan: true });
    const gate = preToolUseGate(hookResult({ decision: 'allow' }));
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'ls' }), panel, undefined, null, gate);
    expect(result).toBeUndefined();
  });

  it('updatedInput is denormalized + mutated onto event.input before the gate runs', async () => {
    const { panel, decide } = makePanel({ decide: () => 'allow' });
    const event = ev('read', 'c1', { path: '/orig' });
    const gate = preToolUseGate(hookResult({ decision: 'ask', mutated: true, finalInput: { file_path: '/new' } }));
    const result = await runPermissionGate(event, panel, undefined, null, gate);
    expect(result).toBeUndefined();
    expect((event.input as Record<string, unknown>).path).toBe('/new');
    expect(decide).toHaveBeenCalledWith('Read', { file_path: '/new' }, null, false, false);
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

    const { panel: readPanel } = makePanel({ decide: () => 'allow' });
    const readGate = preToolUseGate(hookResult({ decision: 'ask', anyFailed: true }));
    const readResult = await runPermissionGate(ev('read', 'c2', { path: '/a' }), readPanel, undefined, null, readGate);
    expect(readResult).toBeUndefined();
  });

  /**
   * A force-allow skips the ENTIRE gate — canUseTool, plan mode, the read-only-shell classifier and the
   * settings deny rules. Granting that while a configured hook is provably down (timeout / spawn failure)
   * hands the surviving hook a veto it was never given: the down hook may be exactly the one that would
   * have denied. Fail closed, like the `ask` path already does.
   */
  it('a sibling hook infra failure fails CLOSED even when another hook force-allows (write)', async () => {
    const { panel, canUseTool } = makePanel({});
    const onDecision = decisionSpy();
    const gate = preToolUseGate(hookResult({ decision: 'allow', anyFailed: true }), onDecision);
    const result = await runPermissionGate(ev('write', 'c1', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(result?.block).toBe(true);
    expect(canUseTool).not.toHaveBeenCalled();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('a sibling hook infra failure fails CLOSED even when another hook force-allows (shell, plan mode bypass)', async () => {
    const { panel, canUseTool } = makePanel({ plan: true });
    const gate = preToolUseGate(hookResult({ decision: 'allow', anyFailed: true }));
    const result = await runPermissionGate(ev('bash', 'c1', { command: 'rm -rf /' }), panel, undefined, null, gate);
    expect(result?.block).toBe(true);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('a force-allow with every hook healthy still allows, and does not stash context on the blocked path', async () => {
    const { panel, canUseTool } = makePanel({});
    const onDecision = decisionSpy();
    const stashContext = stashSpy();
    const gate = preToolUseGate(hookResult({ decision: 'allow', additionalContext: 'ctx' }), onDecision, { stashContext });
    const result = await runPermissionGate(ev('write', 'c1', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith('Write', 'allow', undefined, false);

    const failed = preToolUseGate(hookResult({ decision: 'allow', anyFailed: true, additionalContext: 'ctx' }), decisionSpy(), { stashContext });
    await runPermissionGate(ev('write', 'c2', { path: '/a', content: 'x' }), makePanel({}).panel, undefined, null, failed);
    expect(stashContext).toHaveBeenCalledTimes(1);
    expect(stashContext).toHaveBeenCalledWith('c1', 'ctx');
  });

  it('a read tool still force-allows through a sibling infra failure (reads cannot mutate state)', async () => {
    const { panel } = makePanel({ decide: () => 'allow' });
    const gate = preToolUseGate(hookResult({ decision: 'allow', anyFailed: true }));
    const result = await runPermissionGate(ev('read', 'c1', { path: '/a' }), panel, undefined, null, gate);
    expect(result).toBeUndefined();
  });

  it('no hook match (null) leaves the gate behaving exactly as today', async () => {
    const { panel, canUseTool } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    const gate = preToolUseGate(null);
    await runPermissionGate(ev('write', 'c1', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(canUseTool).toHaveBeenCalledTimes(1);
  });

  // ---- H1: systemMessage surfacing + additionalContext delivery (full parity) ----

  it('surfaces hook systemMessage(s) via notify regardless of the decision', async () => {
    const { panel } = makePanel({ decide: () => 'allow' });
    const notify = notifySpy();
    const gate = preToolUseGate(hookResult({ decision: 'ask', systemMessages: ['heads up'] }), decisionSpy(), { notify });
    await runPermissionGate(ev('read', 'c1', { path: '/a' }), panel, undefined, null, gate);
    expect(notify).toHaveBeenCalledWith(['heads up']);
  });

  it('stashes PreToolUse additionalContext (force-allow) for delivery on the tool result', async () => {
    const { panel } = makePanel({});
    const stashContext = stashSpy();
    const gate = preToolUseGate(hookResult({ decision: 'allow', additionalContext: 'extra ctx' }), decisionSpy(), { stashContext });
    await runPermissionGate(ev('write', 'call-1', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(stashContext).toHaveBeenCalledWith('call-1', 'extra ctx');
  });

  it('stashes additionalContext on the normal approval path once the user approves', async () => {
    const { panel } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    const stashContext = stashSpy();
    const gate = preToolUseGate(hookResult({ decision: 'ask', additionalContext: 'ctx' }), decisionSpy(), { stashContext });
    await runPermissionGate(ev('write', 'call-7', { path: '/a', content: 'x' }), panel, undefined, null, gate);
    expect(stashContext).toHaveBeenCalledWith('call-7', 'ctx');
  });

  it('does NOT stash additionalContext when the tool is denied (no result will arrive)', async () => {
    const { panel } = makePanel({});
    const stashContext = stashSpy();
    const gate = preToolUseGate(hookResult({ decision: 'deny', reason: 'no', additionalContext: 'ctx' }), decisionSpy(), { stashContext });
    await runPermissionGate(ev('bash', 'call-1', { command: 'x' }), panel, undefined, null, gate);
    expect(stashContext).not.toHaveBeenCalled();
  });

  it('does NOT stash additionalContext when the user denies on the approval path', async () => {
    const { panel } = makePanel({ canUse: async () => ({ behavior: 'deny', message: 'rejected' }) });
    const stashContext = stashSpy();
    const gate = preToolUseGate(hookResult({ decision: 'ask', additionalContext: 'ctx' }), decisionSpy(), { stashContext });
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
    expect(canUseTool.mock.calls[0]![1]).toMatchObject({ file_path: '/safe' });
  });

  it('updatedInput rewrite reaches pi-native Write, denormalized back to its raw `path`', async () => {
    const { panel, canUseTool } = makePanel({ canUse: async () => ({ behavior: 'allow', updatedInput: {} }) });
    const event = ev('write', 'call-write', { path: '/orig', content: 'x' });
    const gate = preToolUseGate(hookResult({ decision: 'ask', mutated: true, finalInput: { file_path: '/safe', content: 'x' } }));
    await runPermissionGate(event, panel, undefined, null, gate);
    // Write executes from raw pi input, so the CC `file_path` must be denormalized back to `path`.
    expect((event.input as Record<string, unknown>).path).toBe('/safe');
    expect('file_path' in (event.input as Record<string, unknown>)).toBe(false);
    expect(canUseTool.mock.calls[0]![1]).toMatchObject({ file_path: '/safe' });
  });
});

describe('runPermissionGate — read-only agents (readOnlyShell)', () => {
  it('auto-allows a provably read-only command without prompting', async () => {
    const { panel, canUseTool } = makePanel({ readOnlyShell: true });
    const result = await runPermissionGate(ev('bash', 't1', { command: 'git status' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('auto-allows a browser tool — the module gate precedes the read-only block', async () => {
    const { panel, canUseTool } = makePanel({ readOnlyShell: true });
    const result = await runPermissionGate(ev('BrowserOpen', 't1', { url: 'http://localhost:3000' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('routes every shell write vector to the approval flow, never running one unasked', async () => {
    const { panel, canUseTool } = makePanel({ readOnlyShell: true });
    const commands = [
      'echo hi > /tmp/out.txt',
      'cat <<EOF > notes.md\nx\nEOF',
      'echo hi | tee /tmp/out.txt',
      'cp a.ts b.ts',
      'rm -rf build',
    ];
    for (const command of commands) {
      expect(await runPermissionGate(ev('bash', 't1', { command }), panel, undefined), command).toBeUndefined();
    }
    expect(canUseTool).toHaveBeenCalledTimes(commands.length);
  });

  it('asks for a non-read-only command in plan mode as well', async () => {
    const { panel, canUseTool } = makePanel({ readOnlyShell: true, plan: true });
    const result = await runPermissionGate(ev('bash', 't1', { command: 'npm test' }), panel, undefined);
    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
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
    const result = await runPermissionGate(ev('write', 't1', { path: '/repo/f.txt', content: 'x' }), panel, undefined);
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
    const result = await runPermissionGate(ev('write', 't1', { path: '/repo/app.ts', content: 'x' }), panel, undefined);
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

describe('block attribution through the real PermissionHandler — every unasked deny is policy', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-gate-policy-'));
  afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));

  function realPanel(post: ((msg: ExtensionToWebviewMessage) => void) | null): { panel: PanelGateContext; handler: PermissionHandler } {
    const handler = new PermissionHandler(createFakePlatform());
    handler.setWorkspacePath(workspace);
    handler.setCwd(workspace);
    if (post) handler.setPostMessage(post);
    const { panel } = makePanel({});
    panel.permissionHandler = handler;
    return { panel, handler };
  }

  function expectPolicyBlock(result: Awaited<ReturnType<typeof runPermissionGate>>): void {
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).not.toContain(FEEDBACK_MARKER);
    expect(result).not.toHaveProperty('terminate');
  }

  it('a settings deny rule of GenerateImage, Edit or Bash', async () => {
    fs.mkdirSync(path.join(workspace, '.damocles'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.damocles', 'settings.local.json'),
      JSON.stringify({ permissions: { deny: ['GenerateImage', 'Edit', 'Bash'] } }));
    try {
      const { panel } = realPanel(() => undefined);
      expectPolicyBlock(await runPermissionGate(ev('GenerateImage', 'g1', { prompt: 'a fox', file_path: 'fox.png' }), panel, undefined));
      expectPolicyBlock(await runPermissionGate(ev('Edit', 'e1', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }), panel, undefined));
      expectPolicyBlock(await runPermissionGate(ev('bash', 'b1', { command: 'ls' }), panel, undefined));
    } finally {
      fs.rmSync(path.join(workspace, '.damocles'), { recursive: true, force: true });
    }
  });

  it('a settings deny rule of an MCP tool, and an ask rule makes it prompt', async () => {
    fs.mkdirSync(path.join(workspace, '.damocles'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.damocles', 'settings.local.json'), JSON.stringify({ permissions: {
      deny: ['mcp__context7__resolve-library-id'], ask: ['mcp__context7__get_library_docs', 'mcp__context7__search'] } }));
    try {
      const handler = new PermissionHandler(createFakePlatform());
      handler.setWorkspacePath(workspace);
      handler.setCwd(workspace);
      const prompted: string[] = [];
      handler.setPostMessage((msg) => {
        if (msg.type !== 'requestPermission') return;
        prompted.push(msg.toolName);
        void handler.resolveApproval(msg.toolUseId, true);
      });
      const { panel } = makePanel({ mcpReadOnly: (name) => name === 'mcp__context7__search' || name === 'mcp__other__read' });
      const raw: Record<string, { server: string; tool: string }> = {
        mcp__context7__resolve_library_id: { server: 'context7', tool: 'resolve-library-id' },
        mcp__context7__get_library_docs: { server: 'context7', tool: 'get_library_docs' },
        mcp__context7__search: { server: 'context7', tool: 'search' },
        mcp__other__tool: { server: 'other', tool: 'tool' },
        mcp__other__read: { server: 'other', tool: 'read' },
      };
      panel.mcpToolIdentity = (name) => raw[name];
      panel.permissionHandler = handler;

      expectPolicyBlock(await runPermissionGate(ev('mcp__context7__resolve_library_id', 'm1'), panel, undefined));
      expect(prompted).toEqual([]);

      expect(await runPermissionGate(ev('mcp__context7__get_library_docs', 'm2'), panel, undefined)).toBeUndefined();
      expect(await runPermissionGate(ev('mcp__context7__search', 'm3'), panel, undefined)).toBeUndefined();
      expect(prompted).toEqual(['mcp__context7__get_library_docs', 'mcp__context7__search']);

      expect(await runPermissionGate(ev('mcp__other__tool', 'm4'), panel, undefined)).toBeUndefined();
      expect(await runPermissionGate(ev('mcp__other__read', 'm5'), panel, undefined)).toBeUndefined();
      expect(prompted).toHaveLength(2);
    } finally {
      fs.rmSync(path.join(workspace, '.damocles'), { recursive: true, force: true });
    }
  });

  it('no webview to ask in', async () => {
    const { panel } = realPanel(null);
    expectPolicyBlock(await runPermissionGate(ev('GenerateImage', 'g1', { prompt: 'a fox', file_path: 'fox.png' }), panel, undefined));
  });

  it('no tool use id to correlate the answer with', async () => {
    const { panel } = realPanel(() => undefined);
    expectPolicyBlock(await runPermissionGate(ev('Edit', '', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }), panel, undefined));
  });

  it('the session was aborted before the prompt was answered', async () => {
    const { panel } = realPanel(() => undefined);
    const controller = new AbortController();
    const pending = runPermissionGate(ev('bash', 'b1', { command: 'ls' }), panel, controller.signal);
    controller.abort();
    const result = await pending;
    expectPolicyBlock(result);
    expect(result?.reason).toContain('aborted before this approval was answered');
  });

  it('a real user rejection still uses the feedback wording', async () => {
    const { panel, handler } = realPanel((msg) => {
      if (msg.type === 'requestPermission') void handler.resolveApproval(msg.toolUseId, false, { customMessage: 'use another file' });
    });
    const result = await runPermissionGate(ev('GenerateImage', 'g1', { prompt: 'a fox', file_path: 'fox.png' }), panel, undefined);
    expect(result?.reason).toContain(FEEDBACK_MARKER);
    expect(result?.reason).not.toContain(POLICY_BLOCK_MARKER);
  });
});

/**
 * An unexplained "no" is the user saying STOP: the model has no information to act on and would burn the
 * rest of the turn guessing, so the deny is forwarded to pi as `terminate`. A "no, do X instead" is
 * INSTRUCTION — terminating would throw it away. Every automatic block is on the instruction side too:
 * it hands the model a reason it is meant to re-plan against, so none of them terminate.
 *
 * `terminate` must be ABSENT, never an explicit `undefined` — the repo compiles with
 * `exactOptionalPropertyTypes: true`, so the conditional-spread idiom at the deny site is load-bearing.
 * These assertions check presence, not falsiness, so a regression to `{ terminate: undefined }` fails.
 */
describe('terminate — an unexplained Deny ends the turn, an explained one does not', () => {
  it('terminates on a Deny with no feedback (the real deny builder sets interrupt)', async () => {
    const { panel } = makePanel({ canUse: async () => buildUserFileEditDenyResult(undefined, 'User rejected the file modification') });
    const result = await runPermissionGate(ev('Edit', 't1', { file_path: '/a', old_string: 'a', new_string: 'b' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.terminate).toBe(true);
  });

  it('does NOT terminate a Deny that carries feedback — the model must act on it, not stop', async () => {
    const { panel } = makePanel({ canUse: async () => buildUserFileEditDenyResult('edit the other file instead', 'User rejected the file modification') });
    const result = await runPermissionGate(ev('Edit', 't1', { file_path: '/a', old_string: 'a', new_string: 'b' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result).not.toHaveProperty('terminate');
    expect(result?.reason).toContain('edit the other file instead');
  });

  it('does NOT terminate a deny nobody was asked about (no webview, teardown, abort)', async () => {
    const { panel } = makePanel({
      canUse: async () => buildUnaskedDenyResult('Cannot request permission: webview not available', 'unused'),
    });
    const result = await runPermissionGate(ev('Edit', 't1', { file_path: '/a', old_string: 'a', new_string: 'b' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result).not.toHaveProperty('terminate');
    expect(result?.reason).toContain('webview not available');
  });

  it('does not terminate a plan-mode block so the model can re-plan', async () => {
    const { panel } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('write', 't1', { path: '/repo/app.ts', content: 'x' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result).not.toHaveProperty('terminate');
  });

  it('does not terminate a read-only-agent write block so the model can re-plan', async () => {
    const { panel } = makePanel({ readOnlyShell: true });
    const result = await runPermissionGate(ev('write', 't1', { path: '/repo/f.txt', content: 'x' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result).not.toHaveProperty('terminate');
  });

  it('does not terminate a settings-rule deny — it is policy, not a user decision', async () => {
    // What `PermissionHandler.canUseTool` returns for a settings deny (permission-handler/index.ts).
    const { panel } = makePanel({ canUse: async () => buildUnaskedDenyResult(undefined, 'Permission denied by settings rule') });
    const result = await runPermissionGate(ev('Edit', 't1', { file_path: '/a', old_string: 'a', new_string: 'b' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result).not.toHaveProperty('terminate');
  });
});

describe('gateErrorFallback (fail-closed on gate exception)', () => {
  it('blocks the call', () => {
    expect(gateErrorFallback().block).toBe(true);
  });

  it('does not terminate — a Damocles bug must not kill the user\'s turn', () => {
    expect(gateErrorFallback()).not.toHaveProperty('terminate');
  });

  it('words the block as policy, since nobody asked the user', () => {
    const reason = gateErrorFallback().reason;
    expect(reason).toContain(POLICY_BLOCK_MARKER);
    expect(reason).not.toContain(FEEDBACK_MARKER);
  });
});

/**
 * Slice 1 (nested MCP) — the NESTED gate: auto-allow vs. `canUseTool`, and the read-only-agent decision.
 *
 * The classifier under test is not a lambda the test invents: it is `NestedMcpToolset.isReadOnly` from
 * a REAL `buildNestedMcpToolset` over real-shaped descriptors, which is what `agent-manager.ts` and
 * `pi-session.ts` actually put into `SubagentGateContext`. A hand-written `(n) => n.endsWith('status')`
 * would pass every assertion below while proving nothing about the object production builds.
 */

/** `defineTool` is the only `pi` member `buildMcpPiTool` touches. */
const nestedPiStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

function nestedDescriptor(piName: string, readOnly: boolean): McpToolDescriptor {
  return {
    piName,
    serverName: piName.split('__')[1] ?? 'git',
    serverId: `test/${piName.split('__')[1] ?? 'git'}`,
    rawToolName: piName.split('__').slice(2).join('__'),
    description: `desc of ${piName}`,
    inputSchema: { type: 'object', properties: {} },
    readOnly,
    exposure: 'deferred',
    exposureSource: 'config',
    configExposure: 'deferred',
  };
}

/**
 * A nested subagent's gate context, with the frozen classifier the spawn actually produced.
 * `readOnlyShell` mirrors `toolset.readOnly` — set for Explore/Plan and any agent with no write tool.
 */
function nestedGate(opts: {
  readOnlyShell?: boolean;
  plan?: boolean;
  canUse?: () => Promise<PermissionResult>;
  decide?: () => 'allow' | 'deny' | 'ask';
} = {}) {
  const canUseTool = vi.fn<PermissionHandler['canUseTool']>(opts.canUse ?? (async (): Promise<PermissionResult> => ({ behavior: 'allow', updatedInput: {} })));
  const decide = vi.fn<PermissionHandler['decide']>(opts.decide ?? (() => 'allow' as const));
  const descriptors = [
    nestedDescriptor('mcp__git__status', true),   // annotated read-only
    nestedDescriptor('mcp__git__commit', false),  // NOT annotated — the common case
  ];
  const manager = {
    getAllToolDescriptors: () => descriptors,
    getToolDescriptor: (n: string) => descriptors.find((d) => d.piName === n),
    resourceServers: () => [],
  } as unknown as McpClientManager;
  const mcp = buildNestedMcpToolset(nestedPiStub, manager, {
    eligible: new Set(descriptors.map((d) => d.piName)),
    disabledEntries: [],
    resourceRuleFilter: async () => ({ serverCovered: () => false, resourceDenied: () => false, resourceDenyRule: () => undefined, contentCovered: () => false }),
  });
  const ctx: GatePermissionContext = {
    permissionHandler: { canUseTool, decide, matchRule: async () => null, isPlanFile: isPlanFilePath, sessionCwd: () => path.resolve('/repo') } as unknown as GatePermissionContext['permissionHandler'],
    isPlanMode: () => Boolean(opts.plan),
    shellCancel: new ShellCancelStore().forContext(() => undefined),
    isMcpReadOnly: mcp.isReadOnly,
    ...(opts.readOnlyShell ? { readOnlyShell: true } : {}),
  };
  return { ctx, canUseTool, decide, mcp };
}

describe('nested gate — MCP auto-allow vs. approval (criterion 10)', () => {
  it('an ANNOTATED read-only MCP tool never reaches canUseTool', async () => {
    // Gate parity with the panel (`pi-session.ts:387`). Without the frozen classifier in the nested
    // context, `toolCategory('mcp__x__y')` is 'other' and EVERY nested MCP call — annotated reads
    // included — falls through to full approval. A UX regression, not a safety one, but a real one.
    const { ctx, canUseTool, decide } = nestedGate();

    const result = await runPermissionGate(ev('mcp__git__status', 'm1', { a: 1 }), ctx, undefined, 'agent-tool-call-7');

    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    // Still routed through the settings evaluator, so a user deny rule is honored.
    expect(decide).toHaveBeenCalledWith('mcp__git__status', { a: 1 }, null, false, false);
  });

  it('a NON-annotated MCP tool DOES reach canUseTool, with parentToolUseId = the spawning tool-call id', async () => {
    // `parentToolUseId` is what makes the approval prompt attach to the SUBAGENT CARD rather than to
    // the primary stream. Dropping it does not deny anything — it just asks the user in the wrong
    // place, on a card they are not looking at, which reads as a hung subagent.
    const { ctx, canUseTool } = nestedGate();

    const result = await runPermissionGate(ev('mcp__git__commit', 'm2', { message: 'x' }), ctx, undefined, 'agent-tool-call-7');

    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
    const [name, input, callCtx] = canUseTool.mock.calls[0]!;
    expect(name).toBe('mcp__git__commit');
    expect(input).toEqual({ message: 'x' });
    expect(callCtx.toolUseID).toBe('m2');
    expect(callCtx.parentToolUseId).toBe('agent-tool-call-7');
  });

  it('an UNKNOWN mcp__* name falls through to canUseTool — the classifier fails CLOSED', async () => {
    // A tool absent from the frozen snapshot (denied by `disallowed_tools`, or vanished) classifies as
    // not-read-only, so it asks rather than auto-allows. False here costs one prompt; true would auto-
    // execute a call the snapshot never vetted.
    const { ctx, canUseTool } = nestedGate();

    await runPermissionGate(ev('mcp__git__push', 'm3', {}), ctx, undefined, 'agent-tool-call-7');

    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(canUseTool.mock.calls[0]![0]).toBe('mcp__git__push');
  });

  it('a settings deny rule still blocks an annotated read-only MCP tool (marker present)', async () => {
    const { ctx } = nestedGate({ decide: () => 'deny' });
    const result = await runPermissionGate(ev('mcp__git__status', 'm1'), ctx, undefined, 'agent-tool-call-7');
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
  });

  it('a nested session WITHOUT the classifier sends even an annotated read to approval (why it is wired)', async () => {
    // The pre-slice behaviour, kept as the contrast case: this is what the `isMcpReadOnly` wiring buys.
    // If someone later drops the field from `SubagentGateContext`, the tests above go red and this one
    // stays green — which is the pair that makes the regression legible instead of merely failing.
    const canUseTool = vi.fn(async (): Promise<PermissionResult> => ({ behavior: 'allow', updatedInput: {} }));
    const ctx: GatePermissionContext = {
      permissionHandler: { canUseTool, decide: vi.fn(() => 'allow' as const), matchRule: vi.fn(async () => null) } as unknown as GatePermissionContext['permissionHandler'],
      isPlanMode: () => false,
      shellCancel: new ShellCancelStore().forContext(() => undefined),
    };

    await runPermissionGate(ev('mcp__git__status', 'm1'), ctx, undefined, 'agent-tool-call-7');

    expect(canUseTool).toHaveBeenCalledTimes(1);
  });
});

/**
 * G4 / criterion 11 — a DELIBERATE pin, not an oversight.
 *
 * `permission-gate.ts:250` blocks `write`/`shell` when `readOnlyShell` is set. `toolCategory('mcp__*')`
 * is `'other'` (`tool-normalization.ts:47-51`), so an MCP tool is NOT caught by that branch — and that
 * is a DECISION (brief §3.4), consistent with two things already in the tree:
 *
 *  - the plan-mode MCP exemption at `permission-gate.ts:236-249`, which states MCP tools follow
 *    normal-mode rules "since the user controls which servers are enabled"; and
 *  - `docs/invariants.md`, which scopes the read-only-agent rule to the SHELL — it is a shell-escape
 *    guard (no regaining `Edit` via `echo > file`), not a general capability ceiling.
 *
 * The rejected alternative was to filter read-only agents down to read-only-ANNOTATED MCP tools. That
 * would make nested agents stricter than the panel AND stricter than plan mode, and since most servers
 * omit `readOnlyHint` entirely it would fail closed against the common case.
 *
 * These tests exist so that a future reader cannot "fix" this in EITHER direction without tripping a
 * test whose name says it was decided. If the decision is ever reversed, this block must be rewritten
 * deliberately — not deleted quietly.
 */
describe('nested gate — a read-only agent MAY call a non-annotated MCP tool: DECIDED, not overlooked (criterion 11 / G4)', () => {
  it('DECIDED: readOnlyShell does NOT block a non-annotated mcp__* — it routes to canUseTool', async () => {
    const { ctx, canUseTool } = nestedGate({ readOnlyShell: true });

    const result = await runPermissionGate(ev('mcp__git__commit', 'm1', { message: 'x' }), ctx, undefined, 'agent-tool-call-7');

    expect(result).toBeUndefined(); // not blocked
    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(canUseTool.mock.calls[0]![0]).toBe('mcp__git__commit');
    expect(canUseTool.mock.calls[0]![2].parentToolUseId).toBe('agent-tool-call-7');
  });

  it('DECIDED: the same agent IS still blocked on write, and a non-read-only shell command asks', async () => {
    // The other half of the pin: write tools are blocked outright, and a shell write cannot run without
    // passing the approval flow on the agent's card.
    const { ctx, canUseTool } = nestedGate({ readOnlyShell: true });

    const write = await runPermissionGate(ev('write', 'w1', { path: '/repo/app.ts', content: 'x' }), ctx, undefined, 'agent-tool-call-7');
    expect(write?.block).toBe(true);
    expect(write?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(write?.reason).toContain('read-only agent');
    expect(canUseTool).not.toHaveBeenCalled();

    await runPermissionGate(ev('bash', 'b1', { command: 'echo hi > /repo/app.ts' }), ctx, undefined, 'agent-tool-call-7');
    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(canUseTool.mock.calls[0]?.[2]).toMatchObject({ parentToolUseId: 'agent-tool-call-7' });
  });

  it('DECIDED: an ANNOTATED read-only MCP tool still auto-allows for a read-only agent', async () => {
    const { ctx, canUseTool, decide } = nestedGate({ readOnlyShell: true });

    const result = await runPermissionGate(ev('mcp__git__status', 'm1'), ctx, undefined, 'agent-tool-call-7');

    expect(result).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledWith('mcp__git__status', {}, null, false, false);
  });

  it('DECIDED: a read-only agent in PLAN MODE behaves the same — both exemptions compose', async () => {
    // `readOnlyShell` and plan mode share the branch at line 250, so the exemption must survive both
    // being true at once. If a future change routed MCP into that branch under only one of the two, the
    // inconsistency would live here.
    const { ctx, canUseTool } = nestedGate({ readOnlyShell: true, plan: true });

    const result = await runPermissionGate(ev('mcp__git__commit', 'm1', { message: 'x' }), ctx, undefined, 'agent-tool-call-7');

    expect(result).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
  });

  it('DECIDED: the residual is real — a read-only agent CAN reach a write-capable MCP tool, and is asked', async () => {
    // Brief §3.4 states this residual plainly, so it is pinned plainly: the trust boundary for MCP is
    // the SERVER ENABLEMENT LIST, not the agent type. The mitigation is that the call is not silent —
    // it prompts. If a future change auto-allowed it, THAT would be the regression, and this catches it.
    const { ctx, canUseTool } = nestedGate({
      readOnlyShell: true,
      canUse: async () => ({ behavior: 'deny', message: 'User rejected the MCP call' }),
    });

    const result = await runPermissionGate(ev('mcp__git__commit', 'm1', { message: 'x' }), ctx, undefined, 'agent-tool-call-7');

    expect(canUseTool).toHaveBeenCalledTimes(1);   // the user WAS asked…
    expect(result?.block).toBe(true);              // …and their answer is honored
    expect(result?.reason).toContain(FEEDBACK_MARKER);
  });
});

describe('runPermissionGate — checkpoint baseline wait', () => {
  const FOLDER = path.resolve('/work/project');
  const inFolder = (rel: string) => path.join(FOLDER, rel);

  /** A panel whose baseline wait records the tool that waited and resolves when the test says so. */
  function waitingPanel(opts: Parameters<typeof makePanel>[0] = {}) {
    const made = makePanel(opts);
    const waited: string[] = [];
    let release!: () => void;
    const baseline = new Promise<void>((resolve) => { release = resolve; });
    made.panel.checkpointBaseline = {
      folder: FOLDER,
      wait: vi.fn(async (_signal: AbortSignal, toolName: string) => {
        waited.push(toolName);
        await baseline;
      }),
    };
    return { ...made, waited, release };
  }

  it('never waits for read tools, read-only MCP, coordination tools, or provably read-only shell', async () => {
    const { panel, waited } = waitingPanel({ mcpReadOnly: (name) => name === 'mcp__docs__search' });
    await runPermissionGate(ev('read', 'r1', { path: '/a.ts' }), panel, undefined);
    await runPermissionGate(ev('ls', 'r2', {}), panel, undefined);
    await runPermissionGate(ev('mcp__docs__search', 'r3', {}), panel, undefined);
    await runPermissionGate(ev('GetSubagentResult', 'r4', {}), panel, undefined);
    await runPermissionGate(ev('SearchMemories', 'r5', {}), panel, undefined);
    await runPermissionGate(ev('team_write_scratchpad', 'r6', {}), panel, undefined);
    await runPermissionGate(ev('bash', 'r7', { command: 'git status && ls -la' }), panel, undefined);
    await runPermissionGate(ev('PowerShell', 'r8', { command: 'Get-ChildItem' }), panel, undefined);
    expect(waited).toEqual([]);
  });

  it('holds a file-changing call until the baseline resolves, and only after its approval', async () => {
    const order: string[] = [];
    const { panel, waited, release, canUseTool } = waitingPanel({
      canUse: async () => { order.push('approved'); return { behavior: 'allow', updatedInput: {} }; },
    });
    let settled = false;
    const pending = runPermissionGate(ev('edit', 'w1', { file_path: inFolder('a.ts') }), panel, undefined).then((r) => { settled = true; return r; });
    await vi.waitFor(() => expect(waited).toEqual(['Edit']));
    order.push('waiting');
    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    release();
    expect(await pending).toBeUndefined();
    expect(order).toEqual(['approved', 'waiting']);
  });

  it('waits for writes, other shell, non-annotated MCP and every spawn tool', async () => {
    const { panel, waited, release } = waitingPanel();
    release();
    await runPermissionGate(ev('write', 'w1', { path: inFolder('a.ts'), content: 'x' }), panel, undefined);
    await runPermissionGate(ev('bash', 'w2', { command: 'rm -rf build' }), panel, undefined);
    await runPermissionGate(ev('mcp__fs__write_file', 'w3', {}), panel, undefined);
    await runPermissionGate(ev('Agent', 'w4', { prompt: 'go' }), panel, undefined);
    await runPermissionGate(ev('create_team', 'w5', {}), panel, undefined);
    await runPermissionGate(ev('team_spawn_specialist', 'w6', {}), panel, undefined);
    expect(waited).toEqual(['Write', 'Bash', 'mcp__fs__write_file', 'Agent', 'create_team', 'team_spawn_specialist']);
  });

  it('never waits for an Edit or Write of the plan file or of a path outside the folder', async () => {
    const { panel, waited, release } = waitingPanel();
    release();
    await runPermissionGate(ev('write', 'p1', { path: path.join(DAMOCLES_PLANS_DIR, 'plan-abc.md'), content: '# plan' }), panel, undefined);
    await runPermissionGate(ev('edit', 'p2', { file_path: path.join(DAMOCLES_PLANS_DIR, 'plan-abc.md'), old_string: 'a', new_string: 'b' }), panel, undefined);
    await runPermissionGate(ev('write', 'o1', { path: path.resolve('/elsewhere/notes.txt'), content: 'x' }), panel, undefined);
    await runPermissionGate(ev('edit', 'o2', { file_path: '../sibling/a.ts', old_string: 'a', new_string: 'b' }), panel, undefined);
    await runPermissionGate(ev('write', 'o3', { path: `${FOLDER}-other${path.sep}a.ts`, content: 'x' }), panel, undefined);
    expect(waited).toEqual([]);
  });

  it('never waits for a plan file write even when the plans dir sits inside the folder', async () => {
    const { panel, waited, release } = waitingPanel();
    release();
    panel.checkpointBaseline = { ...panel.checkpointBaseline!, folder: path.dirname(path.dirname(DAMOCLES_PLANS_DIR)) };
    await runPermissionGate(ev('write', 'p1', { path: path.join(DAMOCLES_PLANS_DIR, 'plan-abc.md'), content: '# plan' }), panel, undefined);
    await runPermissionGate(ev('write', 'p2', { path: path.join(DAMOCLES_PLANS_DIR, '..', 'notes.md'), content: 'x' }), panel, undefined);
    expect(waited).toEqual(['Write']);
  });

  it('waits for an Edit or Write inside the folder, relative or absolute, and for shell writing outside it', async () => {
    const { panel, waited, release } = waitingPanel();
    release();
    await runPermissionGate(ev('edit', 'i1', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }), panel, undefined);
    await runPermissionGate(ev('write', 'i2', { path: inFolder('deep/b.ts'), content: 'x' }), panel, undefined);
    await runPermissionGate(ev('write', 'i3', { content: 'x' }), panel, undefined);
    await runPermissionGate(ev('bash', 'i4', { command: `echo x > ${path.resolve('/elsewhere/out.txt')}` }), panel, undefined);
    await runPermissionGate(ev('PowerShell', 'i5', { command: `Set-Content -Path ${path.join(DAMOCLES_PLANS_DIR, 'plan-abc.md')} -Value x` }), panel, undefined);
    expect(waited).toEqual(['Edit', 'Write', 'Write', 'Bash', 'PowerShell']);
  });

  it('waits on a PreToolUse force-allow, which skips the approval flow', async () => {
    const { panel, waited, release, canUseTool } = waitingPanel();
    release();
    const gate = preToolUseGate(hookResult({ decision: 'allow' }), decisionSpy());
    expect(await runPermissionGate(ev('edit', 'h1', { file_path: inFolder('a.ts') }), panel, undefined, null, gate)).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(waited).toEqual(['Edit']);
  });

  it('never waits for a call it blocks', async () => {
    const { panel, waited } = waitingPanel({ canUse: async () => buildUnaskedDenyResult('no', 'no') });
    const result = await runPermissionGate(ev('write', 'd1', { path: inFolder('a.ts'), content: 'x' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(waited).toEqual([]);
  });
});

describe('runPermissionGate — GenerateImage takes the write gate', () => {
  const input = { prompt: 'a fox', file_path: 'assets/fox.png' };

  it('plan mode blocks it with a policy reason, without prompting', async () => {
    const { panel, canUseTool } = makePanel({ plan: true });
    const result = await runPermissionGate(ev('GenerateImage', 'g1', input), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).not.toContain(FEEDBACK_MARKER);
    expect(result).not.toHaveProperty('terminate');
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('a read-only agent cannot call it', async () => {
    const { panel, canUseTool } = makePanel({ readOnlyShell: true });
    const result = await runPermissionGate(ev('GenerateImage', 'g1', input), panel, undefined);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('outside plan mode it goes to canUseTool with the raw input, never the module auto-allow', async () => {
    const { panel, canUseTool, decide } = makePanel({});
    expect(await runPermissionGate(ev('GenerateImage', 'g1', input), panel, undefined)).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledWith('GenerateImage', input, expect.objectContaining({ toolUseID: 'g1' }));
    expect(decide).not.toHaveBeenCalled();
  });

  it('waits for the checkpoint baseline after approval, so a rewind sees the new file as created this turn', async () => {
    const { panel } = makePanel({});
    const wait = vi.fn(async () => undefined);
    panel.checkpointBaseline = { folder: path.resolve('/work/project'), wait };
    await runPermissionGate(ev('GenerateImage', 'g1', input), panel, undefined);
    expect(wait).toHaveBeenCalledWith(expect.anything(), 'GenerateImage');
  });
});

describe('ask rules through the real PermissionHandler — the prompt runs wherever the mode would auto-approve', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-gate-ask-'));
  afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.damocles'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.damocles', 'settings.local.json'), JSON.stringify({ permissions: { ask: ['Read(notes/**)', 'Edit(src/**)'] } }));
  const sourceFile = path.join(workspace, 'src', 'a.ts');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'a');

  /** A handler whose webview records each prompt and leaves it pending until the test answers it. */
  function askingPanel(mode: 'default' | 'acceptEdits' | 'plan', yolo = false) {
    const handler = new PermissionHandler(createFakePlatform());
    handler.setWorkspacePath(workspace);
    handler.setCwd(workspace);
    handler.setPermissionMode(mode);
    handler.setDangerouslySkipPermissions(yolo);
    const prompts: Array<Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }>> = [];
    handler.setPostMessage((msg) => { if (msg.type === 'requestPermission') prompts.push(msg); });
    const { panel } = makePanel({ plan: mode === 'plan' });
    panel.permissionHandler = handler;
    return { panel, handler, prompts };
  }

  for (const mode of ['default', 'acceptEdits', 'plan'] as const) {
    it(`Read in ${mode} mode prompts, registered as a pending prompt, and runs once approved`, async () => {
      const { panel, handler, prompts } = askingPanel(mode);
      const pending = runPermissionGate(ev('read', 'r1', { path: 'notes/a.txt' }), panel, undefined);
      await expect.poll(() => prompts.length).toBe(1);
      expect(prompts[0]).toMatchObject({ toolUseId: 'r1', toolName: 'Read', toolInput: { file_path: 'notes/a.txt' } });
      expect(handler.pendingPrompts().length > 0).toBe(true);
      await handler.resolveApproval('r1', true);
      expect(await pending).toBeUndefined();
      expect(handler.pendingPrompts().length > 0).toBe(false);
      expect(await runPermissionGate(ev('read', 'r2', { path: 'other/a.txt' }), panel, undefined)).toBeUndefined();
      expect(prompts).toHaveLength(1);
    });
  }

  it('Read under YOLO runs without a prompt', async () => {
    const { panel, prompts } = askingPanel('default', true);
    expect(await runPermissionGate(ev('read', 'r1', { path: 'notes/a.txt' }), panel, undefined)).toBeUndefined();
    expect(prompts).toEqual([]);
  });

  it('plan mode prompts for a shell command it cannot prove read-only and runs it once approved', async () => {
    const { panel, handler, prompts } = askingPanel('plan');
    const pending = runPermissionGate(ev('bash', 's1', { command: 'systemctl list-units' }), panel, undefined);
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]).toMatchObject({ toolUseId: 's1', toolName: 'Bash' });
    await handler.resolveApproval('s1', true);
    expect(await pending).toBeUndefined();
  });

  it('a read-only agent prompts for a shell command it cannot prove read-only, and YOLO runs it without one', async () => {
    const asked = askingPanel('default');
    Object.assign(asked.panel, { readOnlyShell: true });
    const pending = runPermissionGate(ev('bash', 's1', { command: 'npm test' }), asked.panel, undefined, 'agent-1');
    await expect.poll(() => asked.prompts.length).toBe(1);
    expect(asked.prompts[0]).toMatchObject({ toolUseId: 's1', toolName: 'Bash' });
    await asked.handler.resolveApproval('s1', true);
    expect(await pending).toBeUndefined();

    const yolo = askingPanel('default', true);
    Object.assign(yolo.panel, { readOnlyShell: true });
    expect(await runPermissionGate(ev('bash', 's2', { command: 'npm test' }), yolo.panel, undefined, 'agent-1')).toBeUndefined();
    expect(yolo.prompts).toEqual([]);
  });

  it('plan mode under YOLO runs that shell command without a prompt but still blocks an Edit', async () => {
    const { panel, prompts } = askingPanel('plan', true);
    expect(await runPermissionGate(ev('bash', 's1', { command: 'systemctl list-units' }), panel, undefined)).toBeUndefined();
    const edit = await runPermissionGate(ev('Edit', 'e1', { file_path: sourceFile, old_string: 'a', new_string: 'b' }), panel, undefined);
    expect(edit?.block).toBe(true);
    expect(edit?.reason).toContain('Plan mode is active');
    expect(prompts).toEqual([]);
  });

  it('a rejected Read prompt is the user\'s answer', async () => {
    const { panel, handler, prompts } = askingPanel('default');
    const pending = runPermissionGate(ev('read', 'r1', { path: 'notes/a.txt' }), panel, undefined);
    await expect.poll(() => prompts.length).toBe(1);
    await handler.resolveApproval('r1', false, { customMessage: 'not that file' });
    const result = await pending;
    expect(result?.reason).toContain(FEEDBACK_MARKER);
    expect(result?.reason).toContain('not that file');
  });

  it('Edit in acceptEdits mode prompts with its diff', async () => {
    const { panel, handler, prompts } = askingPanel('acceptEdits');
    const pending = runPermissionGate(ev('Edit', 'e1', { file_path: sourceFile, old_string: 'a', new_string: 'b' }), panel, undefined);
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]).toMatchObject({ toolName: 'Edit', filePath: sourceFile, patch: expect.stringContaining('\n-a\n') });
    expect(prompts[0]!.patch).toContain('\n+b\n');
    await handler.resolveApproval('e1', true);
    expect(await pending).toBeUndefined();
  });

  it('plan mode resolves the plan file against the session cwd, not the process cwd', async () => {
    const { panel, prompts } = askingPanel('plan');
    // One level below the session cwd: from the session cwd the path climbs one level too far. With the
    // real process cwd, a shallower session cwd clamps the extra `..` at the root and reaches the plan file.
    const processCwd = vi.spyOn(process, 'cwd').mockReturnValue(path.join(workspace, 'nested'));
    onTestFinished(() => processCwd.mockRestore());
    const planPath = path.join(DAMOCLES_PLANS_DIR, 'plan-abc12345.md');
    const fromProcessCwd = path.relative(process.cwd(), planPath);
    expect(path.resolve(fromProcessCwd)).toBe(planPath);
    const result = await runPermissionGate(ev('write', 'w1', { path: fromProcessCwd, content: '# plan' }), panel, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('Plan mode is active');
    expect(prompts).toEqual([]);
  });
});

describe('runPermissionGate — a Stop before the shell call runs', () => {
  const FOLDER = path.resolve('/work/project');
  const allow = async (): Promise<PermissionResult> => ({ behavior: 'allow', updatedInput: {} });

  /** A panel whose gate handle delivers notes into `notes`, as the panel's own delivery would. */
  function stoppablePanel(opts: Parameters<typeof makePanel>[0] = {}) {
    const made = makePanel(opts);
    const store = new ShellCancelStore();
    const notes: string[] = [];
    made.panel.shellCancel = store.forContext((text) => notes.push(text));
    return { ...made, store, notes };
  }

  /** A baseline that is never ready, so only the signal the gate hands it can end the wait. */
  function neverReadyBaseline(panel: PanelGateContext): Mock {
    const wait = vi.fn((signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })));
    panel.checkpointBaseline = { folder: FOLDER, wait };
    return wait;
  }

  it('ends a checkpoint wait that is never ready and blocks the call as the user stopped it', async () => {
    const { panel, store, notes } = stoppablePanel({ canUse: allow });
    const wait = neverReadyBaseline(panel);
    const run = new AbortController();

    const pending = runPermissionGate(ev('bash', 's1', { command: 'npm install' }), panel, run.signal);
    await vi.waitFor(() => expect(wait).toHaveBeenCalled());
    expect(store.cancel('s1', 'wrong folder')).toBe(true);
    const result = await pending;

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(FEEDBACK_MARKER);
    expect(result?.reason).toContain('The user stopped this command before it started, so it did not run.');
    expect(result?.reason).not.toContain(POLICY_BLOCK_MARKER);
    // The note is user turn content and already went out as a user message.
    expect(result?.reason).not.toContain('wrong folder');
    expect(notes).toEqual(['wrong folder']);
    // One Stop leaves the turn running.
    expect(result).not.toHaveProperty('terminate');
    expect(run.signal.aborted).toBe(false);
    expect(store.cancel('s1')).toBe(false);
  });

  it('blocks a call stopped while its PreToolUse hook ran, without asking for approval', async () => {
    const { panel, store, canUseTool } = stoppablePanel({ canUse: allow });
    let finishHook: (() => void) | undefined;
    const hooks: PreToolUseHookGate = {
      ...preToolUseGate(null),
      run: () => new Promise((resolve) => { finishHook = () => resolve(hookResult({ decision: 'ask' })); }),
    };

    const pending = runPermissionGate(ev('PowerShell', 's2', { command: 'Remove-Item build -Recurse' }), panel, undefined, null, hooks);
    await vi.waitFor(() => expect(finishHook).toBeDefined());
    expect(store.cancel('s2')).toBe(true);
    finishHook!();
    const result = await pending;

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('before it started');
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('admits only the cancellable shell tools', async () => {
    const { panel, store } = stoppablePanel({ canUse: allow });
    neverReadyBaseline(panel);
    const run = new AbortController();

    const pending = runPermissionGate(ev('write', 'w1', { path: path.join(FOLDER, 'a.ts'), content: 'x' }), panel, run.signal);
    await vi.waitFor(() => expect(panel.checkpointBaseline!.wait).toHaveBeenCalled());

    expect(store.cancel('w1')).toBe(false);
    run.abort();
    await pending;
  });

  it('keeps an allowed call\'s entry for execute, and drops it when the run aborts first', async () => {
    const { panel, store } = stoppablePanel({ canUse: allow });
    const run = new AbortController();

    expect(await runPermissionGate(ev('bash', 's3', { command: 'make' }), panel, run.signal)).toBeUndefined();
    expect(await runPermissionGate(ev('bash', 's4', { command: 'make' }), panel, run.signal)).toBeUndefined();
    expect(store.cancel('s3')).toBe(true);
    run.abort();

    expect(store.cancel('s4')).toBe(false);
  });

  it('drops the entry of a call it blocks or fails to decide', async () => {
    const denied = stoppablePanel({ canUse: async () => ({ behavior: 'deny', message: 'no' }) });
    expect((await runPermissionGate(ev('bash', 's5', { command: 'make' }), denied.panel, undefined))?.block).toBe(true);
    expect(denied.store.cancel('s5')).toBe(false);

    const failing = stoppablePanel({ canUse: async () => { throw new Error('prompt failed'); } });
    await expect(runPermissionGate(ev('bash', 's6', { command: 'make' }), failing.panel, undefined)).rejects.toThrow('prompt failed');
    expect(failing.store.cancel('s6')).toBe(false);
  });

  it('blocks a call stopped while the approval was being decided, even when the approval then arrives', async () => {
    let approve: (() => void) | undefined;
    const { panel, store } = stoppablePanel({
      canUse: () => new Promise<PermissionResult>((resolve) => { approve = () => resolve({ behavior: 'allow', updatedInput: {} }); }),
    });
    const posted: ExtensionToWebviewMessage[] = [];
    panel.postMessage = (msg) => posted.push(msg);

    const pending = runPermissionGate(ev('bash', 's7', { command: 'make' }), panel, new AbortController().signal);
    await vi.waitFor(() => expect(approve).toBeDefined());
    expect(store.cancel('s7')).toBe(true);
    approve!();
    const result = await pending;

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('before it started');
    expect(result?.reason).not.toContain(POLICY_BLOCK_MARKER);
    expect(posted.filter((m) => m.type === 'toolPending')).toEqual([]);
  });
});

describe('runPermissionGate — a prompted call goes back to running once the gate lets it through', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-gate-running-'));
  afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));

  /** The real handler, so its prompt, its answer and the gate's report reach `posted` in the order the webview gets them. */
  function promptingPanel(answer: (msg: ExtensionToWebviewMessage, handler: PermissionHandler) => void) {
    const posted: ExtensionToWebviewMessage[] = [];
    const handler = new PermissionHandler(createFakePlatform());
    handler.setWorkspacePath(workspace);
    handler.setCwd(workspace);
    const post = (msg: ExtensionToWebviewMessage): void => {
      posted.push(msg);
      answer(msg, handler);
    };
    handler.setPostMessage(post);
    const { panel } = makePanel({});
    const store = new ShellCancelStore();
    Object.assign(panel, { permissionHandler: handler, postMessage: post, shellCancel: store.forContext(() => undefined) });
    return { panel, handler, posted, store };
  }

  const kinds = (posted: ExtensionToWebviewMessage[]): string[] =>
    posted.map((m) => m.type);

  it('reports a call the user approved as running, after the prompt', async () => {
    const { panel, posted } = promptingPanel((msg, handler) => {
      if (msg.type === 'requestPermission') queueMicrotask(() => void handler.resolveApproval(msg.toolUseId, true));
    });

    expect(await runPermissionGate(ev('bash', 'r1', { command: 'make' }), panel, undefined)).toBeUndefined();

    expect(kinds(posted)).toEqual(['requestPermission', 'toolPending']);
    expect(posted[1]).toEqual({ type: 'toolPending', toolUseId: 'r1', toolName: 'Bash', input: { command: 'make' }, parentToolUseId: null });
  });

  it('reports a call it blocks as nothing more than the block', async () => {
    const { panel, posted } = promptingPanel((msg, handler) => {
      if (msg.type === 'requestPermission') queueMicrotask(() => void handler.resolveApproval(msg.toolUseId, false));
    });

    expect((await runPermissionGate(ev('bash', 'r3', { command: 'make' }), panel, undefined))?.block).toBe(true);
    expect(kinds(posted)).toEqual(['requestPermission']);
  });

  it('reports it before the checkpoint wait, so a Stop is offered while the call waits', async () => {
    const { panel, posted, store } = promptingPanel((msg, handler) => {
      if (msg.type === 'requestPermission') queueMicrotask(() => void handler.resolveApproval(msg.toolUseId, true));
    });
    const wait = vi.fn((signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })));
    panel.checkpointBaseline = { folder: workspace, wait };

    const pending = runPermissionGate(ev('bash', 'r4', { command: 'npm install' }), panel, undefined);
    await vi.waitFor(() => expect(wait).toHaveBeenCalled());
    expect(kinds(posted)).toEqual(['requestPermission', 'toolPending']);
    expect(store.cancel('r4')).toBe(true);

    expect((await pending)?.reason).toContain('before it started');
  });

  it('withdraws the prompt of a call stopped while it is up, and blocks the call as the user\'s stop', async () => {
    const { panel, handler, posted, store } = promptingPanel(() => undefined);

    const pending = runPermissionGate(ev('bash', 'r5', { command: 'make' }), panel, new AbortController().signal);
    await vi.waitFor(() => expect(kinds(posted)).toEqual(['requestPermission']));
    expect(store.cancel('r5', 'wrong folder')).toBe(true);
    const result = await pending;

    expect(kinds(posted)).toEqual(['requestPermission', 'permissionAutoResolved']);
    expect(handler.pendingPrompts()).toEqual([]);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(FEEDBACK_MARKER);
    expect(result?.reason).toContain('The user stopped this command before it started');
    expect(result?.reason).not.toContain(POLICY_BLOCK_MARKER);
    expect(result).not.toHaveProperty('terminate');
  });
});

describe('runPermissionGate — an MCP resource call is checked as one of its server\'s tools', () => {
  it('passes the server the input names as the call\'s MCP identity, and none without a server', async () => {
    const { panel, matchRule } = makePanel({});
    await runPermissionGate(ev('read_mcp_resource', 'r1', { server: 'secret', uri: 'secret://a' }), panel, undefined);
    await runPermissionGate(ev('list_mcp_resources', 'r2', { server: 'secret' }), panel, undefined);
    await runPermissionGate(ev('list_mcp_resource_templates', 'r3', { server: 'secret' }), panel, undefined);
    await runPermissionGate(ev('list_mcp_resources', 'r4', {}), panel, undefined);
    await runPermissionGate(ev('list_mcp_resources', 'r5', { server: '' }), panel, undefined);
    await runPermissionGate(ev('read_mcp_resource', 'r6', { server: ['secret'], uri: 'secret://a' }), panel, undefined);
    expect(matchRule.mock.calls.map((call) => call[2])).toEqual([
      { server: 'secret', tool: 'read_mcp_resource' },
      { server: 'secret', tool: 'list_mcp_resources' },
      { server: 'secret', tool: 'list_mcp_resource_templates' },
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('takes the server from the input a PreToolUse hook rewrote', async () => {
    const { panel, matchRule } = makePanel({});
    const gate = preToolUseGate(hookResult({ decision: 'ask', mutated: true, finalInput: { server: 'secret', uri: 'secret://a' } }));
    await runPermissionGate(ev('read_mcp_resource', 'r1', { server: 'public', uri: 'secret://a' }), panel, undefined, null, gate);
    expect(matchRule).toHaveBeenCalledWith('read_mcp_resource', { server: 'secret', uri: 'secret://a' }, { server: 'secret', tool: 'read_mcp_resource' }, {});
  });

  it('passes the identity to the approval prompt an ask rule raises', async () => {
    const { panel, canUseTool } = makePanel({ rule: async () => 'ask', decide: () => 'ask' });
    await runPermissionGate(ev('read_mcp_resource', 'r1', { server: 'secret', uri: 'secret://a' }), panel, undefined);
    expect(canUseTool.mock.calls[0]![2].mcpTool).toEqual({ server: 'secret', tool: 'read_mcp_resource' });
  });
});

describe('MCP resource calls through the real PermissionHandler, in every mode and for nested agents', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-gate-resources-'));
  afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, '.damocles'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.damocles', 'settings.local.json'), JSON.stringify({ permissions: {
    deny: ['mcp__secret__*', 'mcp__vault__read_mcp_resource(vault://passwords)'],
    ask: ['mcp__audit', 'mcp__vault__read_mcp_resource(vault://logs/*)'],
  } }));

  type Caller = 'panel' | 'subagent' | 'read-only subagent' | 'team agent';
  /** The gate context `caller` gets, over a real handler whose webview records each prompt and approves it. */
  function gateFor(caller: Caller, mode: 'default' | 'acceptEdits' | 'plan', yolo = false) {
    const handler = new PermissionHandler(createFakePlatform());
    handler.setWorkspacePath(workspace);
    handler.setCwd(workspace);
    handler.setPermissionMode(mode);
    handler.setDangerouslySkipPermissions(yolo);
    const prompts: string[] = [];
    handler.setPostMessage((msg) => {
      if (msg.type !== 'requestPermission') return;
      prompts.push(`${msg.toolName} ${JSON.stringify(msg.toolInput)}`);
      void handler.resolveApproval(msg.toolUseId, true);
    });
    const { panel } = makePanel({ plan: mode === 'plan' });
    panel.permissionHandler = handler;
    if (caller === 'panel') return { ctx: panel as GatePermissionContext, parent: null, prompts };
    const ctx: GatePermissionContext = {
      permissionHandler: handler,
      isPlanMode: () => mode === 'plan',
      shellCancel: new ShellCancelStore().forContext(() => undefined),
      ...(caller === 'read-only subagent' ? { readOnlyShell: true } : {}),
      ...(caller === 'team agent' ? {} : { postMessage: () => undefined }),
    };
    return { ctx, parent: 'agent-1', prompts };
  }

  function expectPolicyBlock(result: Awaited<ReturnType<typeof runPermissionGate>>): void {
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result).not.toHaveProperty('terminate');
  }

  for (const caller of ['panel', 'subagent', 'read-only subagent', 'team agent'] as const) {
    for (const mode of ['default', 'acceptEdits', 'plan'] as const) {
      it(`${caller} in ${mode} mode: a server deny blocks, a server ask prompts, a URI deny or ask covers only its URIs`, async () => {
        const { ctx, parent, prompts } = gateFor(caller, mode);
        const call = (id: string, toolName: string, input: Record<string, unknown>) => runPermissionGate(ev(toolName, id, input), ctx, undefined, parent);

        expectPolicyBlock(await call('c1', 'read_mcp_resource', { server: 'secret', uri: 'secret://a' }));
        expectPolicyBlock(await call('c2', 'list_mcp_resources', { server: 'secret' }));
        expectPolicyBlock(await call('c3', 'list_mcp_resource_templates', { server: 'secret' }));
        expectPolicyBlock(await call('c4', 'read_mcp_resource', { server: 'vault', uri: 'vault://passwords' }));
        expect(prompts).toEqual([]);

        expect(await call('c5', 'read_mcp_resource', { server: 'vault', uri: 'vault://passwords/old' })).toBeUndefined();
        expect(await call('c6', 'list_mcp_resources', { server: 'vault' })).toBeUndefined();
        expect(await call('c7', 'read_mcp_resource', { server: 'public', uri: 'vault://passwords' })).toBeUndefined();
        expect(await call('c8', 'list_mcp_resources', {})).toBeUndefined();
        expect(prompts).toEqual([]);

        expect(await call('c9', 'read_mcp_resource', { server: 'audit', uri: 'audit://x' })).toBeUndefined();
        expect(await call('c10', 'list_mcp_resources', { server: 'audit' })).toBeUndefined();
        expect(await call('c11', 'read_mcp_resource', { server: 'vault', uri: 'vault://logs/today' })).toBeUndefined();
        expect(prompts).toEqual([
          'read_mcp_resource {"server":"audit","uri":"audit://x"}',
          'list_mcp_resources {"server":"audit"}',
          'read_mcp_resource {"server":"vault","uri":"vault://logs/today"}',
        ]);
      });
    }

    it(`${caller} under YOLO: every resource call runs without a prompt`, async () => {
      const { ctx, parent, prompts } = gateFor(caller, 'default', true);
      for (const [id, input] of [['y1', { server: 'secret', uri: 'secret://a' }], ['y2', { server: 'vault', uri: 'vault://passwords' }], ['y3', { server: 'audit', uri: 'audit://x' }]] as const) {
        expect(await runPermissionGate(ev('read_mcp_resource', id, input), ctx, undefined, parent)).toBeUndefined();
      }
      expect(prompts).toEqual([]);
    });
  }
});

describe('a design chat\'s posture (PD-4, PD-25)', () => {
  const DESIGN_FOLDER = designFolderOf('gate-design-abcd1234');
  const PROJECT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'design-gate-project-')));
  afterAll(() => {
    fs.rmSync(PROJECT, { recursive: true, force: true });
    fs.rmSync(DESIGN_FOLDER, { recursive: true, force: true });
  });

  function designChat(opts: { yolo?: boolean; mcpReadOnly?: (name: string) => boolean } = {}) {
    const handler = new PermissionHandler(createFakePlatform());
    handler.setCwd(PROJECT);
    handler.setWorkspacePath(PROJECT);
    if (opts.yolo) handler.setDangerouslySkipPermissions(true);
    const canUseTool = vi.spyOn(handler, 'canUseTool').mockImplementation(async () => ({ behavior: 'deny', message: 'asked', userAnswered: true } as unknown as PermissionResult));
    const gate: GatePermissionContext = {
      permissionHandler: handler,
      isPlanMode: () => false,
      shellCancel: new ShellCancelStore().forContext(() => undefined),
      designScope: () => ({ folder: DESIGN_FOLDER, cwd: PROJECT }),
      ...(opts.mcpReadOnly ? { isMcpReadOnly: opts.mcpReadOnly } : {}),
    };
    return { gate, canUseTool, handler };
  }

  it('writes a screen in its folder with no prompt in default mode', async () => {
    const { gate, canUseTool } = designChat();
    expect(await runPermissionGate(ev('write', 'd1', { path: path.join(DESIGN_FOLDER, 'screens', 'S1-contacts.html'), content: '<html></html>' }), gate, undefined)).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('blocks a project file in default mode and under YOLO, with a policy reason', async () => {
    for (const yolo of [false, true]) {
      const { gate, canUseTool } = designChat({ yolo });
      const result = await runPermissionGate(ev('write', 'd2', { path: path.join(PROJECT, 'src', 'app.ts'), content: 'x' }), gate, undefined);
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
      expect(result?.reason).toContain('only files in its design folder');
      expect(canUseTool).not.toHaveBeenCalled();
    }
  });

  it('blocks before a PreToolUse hook\'s force-allow', async () => {
    const { gate } = designChat({ yolo: true });
    const onDecision = decisionSpy();
    const result = await runPermissionGate(ev('edit', 'd3', { file_path: path.join(PROJECT, 'a.ts'), old_string: 'a', new_string: 'b' }), gate, undefined, null, preToolUseGate(hookResult({ decision: 'allow' }), onDecision));
    expect(result?.block).toBe(true);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('blocks writing decisions.md or manifest.json', async () => {
    const { gate } = designChat({ yolo: true });
    for (const file of ['decisions.md', 'manifest.json']) {
      expect((await runPermissionGate(ev('write', 'd4', { path: path.join(DESIGN_FOLDER, file), content: 'x' }), gate, undefined))?.reason).toMatch(/writes only design\.md/);
    }
  });

  it('runs a proven read-only command unasked and blocks echo x > a.txt under YOLO too', async () => {
    const { gate, canUseTool } = designChat({ yolo: true });
    expect(await runPermissionGate(ev('bash', 'd5', { command: 'ls -la' }), gate, undefined)).toBeUndefined();
    const blocked = await runPermissionGate(ev('bash', 'd6', { command: 'echo x > a.txt' }), gate, undefined);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/proven read-only/);
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('asks for an MCP tool with no read-only annotation under YOLO, and runs an annotated one', async () => {
    const { gate, canUseTool } = designChat({ yolo: true, mcpReadOnly: (name) => name === 'mcp__figma__get_file' });
    expect(await runPermissionGate(ev('mcp__figma__get_file', 'd7', {}), gate, undefined)).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
    await runPermissionGate(ev('mcp__figma__post_comment', 'd8', {}), gate, undefined);
    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(canUseTool.mock.calls[0]![2]).toMatchObject({ requiresUser: true });
  });

  it('leaves the read-only-agent MCP posture of a chat with no design scope unchanged', async () => {
    const { gate, canUseTool } = designChat({ yolo: true });
    const plain: GatePermissionContext = { ...gate, readOnlyShell: true };
    delete (plain as { designScope?: unknown }).designScope;
    canUseTool.mockImplementation(async () => ({ behavior: 'allow', updatedInput: {} }));
    expect(await runPermissionGate(ev('mcp__figma__post_comment', 'd9', {}), plain, undefined)).toBeUndefined();
    expect(canUseTool.mock.calls[0]![2]).not.toHaveProperty('requiresUser');
  });

  it('still asks for a non-read-only MCP call after a PreToolUse hook allowed it, and a hook deny still denies', async () => {
    const { gate, canUseTool } = designChat({ yolo: true, mcpReadOnly: (name) => name === 'mcp__figma__get_file' });
    await runPermissionGate(ev('mcp__figma__post_comment', 'h1', {}), gate, undefined, null, preToolUseGate(hookResult({ decision: 'allow' })));
    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(canUseTool.mock.calls[0]![2]).toMatchObject({ requiresUser: true });
    expect(await runPermissionGate(ev('mcp__figma__get_file', 'h2', {}), gate, undefined, null, preToolUseGate(hookResult({ decision: 'allow' })))).toBeUndefined();
    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect((await runPermissionGate(ev('mcp__figma__post_comment', 'h3', {}), gate, undefined, null, preToolUseGate(hookResult({ decision: 'deny' }))))?.block).toBe(true);
    expect(canUseTool).toHaveBeenCalledTimes(1);
  });

  it('cannot load or run a browser tool that acts on the page', async () => {
    const { gate } = designChat({ yolo: true });
    expect((await runPermissionGate(ev('BrowserClick', 'd10', { ref: 'e1' }), gate, undefined))?.reason).toMatch(/only look at pages/);
  });

  it('runs the design tools by settings rule, and only the ones that write no design file skip the checkpoint baseline (PD-42)', async () => {
    const { gate } = designChat();
    const waited: string[] = [];
    gate.checkpointBaseline = { folder: DESIGN_FOLDER, wait: async (_signal, toolName) => { waited.push(toolName); } };
    const inputs: Record<string, Record<string, unknown>> = { ImportAsset: { path: 'img/logo.png' }, RemoveDesignFile: { file: 'screens/S0-probe.html' }, OpenPreview: { file: 'variants/accent/b.html' } };
    for (const name of ['Inventory', 'ExtractTokens', 'ImportAsset', 'RecordDecision', 'DesignCheck', 'FinishDesign', 'MapReference', 'RemoveDesignFile', 'StartDesign', 'LoadDesignSkill', 'DeclareTweaks', 'OpenPreview']) {
      expect(await runPermissionGate(ev(name, `t-${name}`, inputs[name] ?? {}), gate, undefined)).toBeUndefined();
    }
    expect(waited).toEqual(['Inventory', 'ExtractTokens', 'ImportAsset', 'RecordDecision', 'DesignCheck', 'FinishDesign', 'MapReference', 'RemoveDesignFile']);
  });

  it('raises no force-allow notice for a hook allow that the user still has to approve, and raises it where the hook\'s allow runs the call', async () => {
    const { gate, canUseTool } = designChat({ yolo: true, mcpReadOnly: (name) => name === 'mcp__figma__get_file' });
    const onDecision = decisionSpy();
    await runPermissionGate(ev('mcp__figma__post_comment', 'n1', {}), gate, undefined, null, preToolUseGate(hookResult({ decision: 'allow' }), onDecision));
    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(onDecision).not.toHaveBeenCalled();
    expect(await runPermissionGate(ev('mcp__figma__get_file', 'n2', {}), gate, undefined, null, preToolUseGate(hookResult({ decision: 'allow' }), onDecision))).toBeUndefined();
    expect(onDecision).toHaveBeenCalledWith('mcp__figma__get_file', 'allow', undefined, false);
  });
});

describe('one writer per design file, for every chat (D65)', () => {
  const DESIGN_FOLDER = designFolderOf('gate-writer-abcd1234');
  const STATE_LINK = path.join(DAMOCLES_DESIGNS_DIR, '.state', 'gate-writer-abcd1234', 'link.json');
  const PROJECT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'design-writer-project-')));
  afterAll(() => {
    fs.rmSync(PROJECT, { recursive: true, force: true });
    fs.rmSync(DESIGN_FOLDER, { recursive: true, force: true });
  });

  function plainChat(mode: 'default' | 'acceptEdits', yolo: boolean) {
    const handler = new PermissionHandler(createFakePlatform());
    handler.setCwd(PROJECT);
    handler.setWorkspacePath(PROJECT);
    handler.setPermissionMode(mode);
    handler.setDangerouslySkipPermissions(yolo);
    const canUseTool = vi.spyOn(handler, 'canUseTool');
    const gate: GatePermissionContext = { permissionHandler: handler, isPlanMode: () => false, shellCancel: new ShellCancelStore().forContext(() => undefined) };
    return { gate, canUseTool };
  }

  for (const [mode, yolo] of [['default', false], ['acceptEdits', false], ['default', true]] as const) {
    it(`blocks a parent's write of .state and of a core-owned design file in ${mode} mode${yolo ? ' under YOLO' : ''}, with a policy reason`, async () => {
      const { gate, canUseTool } = plainChat(mode, yolo);
      for (const target of [STATE_LINK, path.join(DESIGN_FOLDER, 'decisions.md')]) {
        const result = await runPermissionGate(ev('write', 'w1', { path: target, content: 'x' }), gate, undefined);
        expect(result?.block).toBe(true);
        expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
        expect(result?.reason).toContain('is in the designs folder');
      }
      expect((await runPermissionGate(ev('Edit', 'e1', { file_path: path.join(DESIGN_FOLDER, 'manifest.json'), old_string: 'a', new_string: 'b' }), gate, undefined))?.block).toBe(true);
      expect((await runPermissionGate(ev('GenerateImage', 'g1', { file_path: path.join(DESIGN_FOLDER, 'assets', 'x.png'), prompt: 'x' }), gate, undefined))?.block).toBe(true);
      expect(canUseTool).not.toHaveBeenCalled();
    });
  }

  it('blocks before a PreToolUse hook\'s force-allow, and raises no notice', async () => {
    const { gate, canUseTool } = plainChat('default', true);
    const onDecision = decisionSpy();
    for (const target of [STATE_LINK, path.join(DESIGN_FOLDER, 'decisions.md')]) {
      const result = await runPermissionGate(ev('write', 'h1', { path: target, content: 'x' }), gate, undefined, null, preToolUseGate(hookResult({ decision: 'allow' }), onDecision));
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain('is in the designs folder');
    }
    expect(onDecision).not.toHaveBeenCalled();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('lets a parent write a designer file of a design folder, through the normal approval flow', async () => {
    const { gate } = plainChat('default', true);
    expect(await runPermissionGate(ev('write', 'p1', { path: path.join(DESIGN_FOLDER, 'design.md'), content: 'x' }), gate, undefined)).toBeUndefined();
    expect(await runPermissionGate(ev('write', 'p2', { path: path.join(PROJECT, 'a.ts'), content: 'x' }), gate, undefined)).toBeUndefined();
  });

  it('blocks a nested agent\'s write of a core-owned design file too', async () => {
    const { gate } = plainChat('default', true);
    const result = await runPermissionGate(ev('write', 'a1', { path: path.join(DESIGN_FOLDER, 'tokens.css'), content: 'x' }), gate, undefined, 'agent-1');
    expect(result?.reason).toContain('is in the designs folder');
  });
});

describe('a chat whose design role cannot be read fails closed', () => {
  const PROJECT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'design-unreadable-project-')));
  afterAll(() => fs.rmSync(PROJECT, { recursive: true, force: true }));

  function unreadableChat() {
    const handler = new PermissionHandler(createFakePlatform());
    handler.setCwd(PROJECT);
    handler.setWorkspacePath(PROJECT);
    handler.setDangerouslySkipPermissions(true);
    const canUseTool = vi.spyOn(handler, 'canUseTool');
    const gate: GatePermissionContext = {
      permissionHandler: handler,
      isPlanMode: () => false,
      shellCancel: new ShellCancelStore().forContext(() => undefined),
      designScope: () => ({ unreadable: true }),
      isMcpReadOnly: (name) => name === 'mcp__figma__get_file',
    };
    return { gate, canUseTool };
  }

  it('blocks writes, every shell command, design tools, page-acting browser tools and MCP calls that are not read-only, under YOLO and a hook allow', async () => {
    const { gate, canUseTool } = unreadableChat();
    const onDecision = decisionSpy();
    for (const [name, input] of [
      ['write', { path: path.join(PROJECT, 'a.ts'), content: 'x' }],
      ['bash', { command: 'ls -la' }],
      ['FinishDesign', {}],
      ['BrowserClick', { ref: 'e1' }],
      ['mcp__figma__post_comment', {}],
    ] as const) {
      for (const hook of [undefined, preToolUseGate(hookResult({ decision: 'allow' }), onDecision)]) {
        const result = await runPermissionGate(ev(name, `u-${name}`, input), gate, undefined, null, hook);
        expect(result?.block).toBe(true);
        expect(result?.reason).toContain('design role cannot be read');
      }
    }
    expect(onDecision).not.toHaveBeenCalled();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('still reads', async () => {
    const { gate } = unreadableChat();
    expect(await runPermissionGate(ev('read', 'r1', { path: path.join(PROJECT, 'a.ts') }), gate, undefined)).toBeUndefined();
    expect(await runPermissionGate(ev('mcp__figma__get_file', 'r2', {}), gate, undefined)).toBeUndefined();
  });
});

describe('a design chat\'s MCP call that is not read-only, under YOLO, through the real PermissionHandler', () => {
  const DESIGN_FOLDER = designFolderOf('gate-yolo-abcd1234');
  const PROJECT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'design-yolo-project-')));
  afterAll(() => fs.rmSync(PROJECT, { recursive: true, force: true }));

  function yoloDesignChat(rules: Record<string, string[]>) {
    const workspace = fs.mkdtempSync(path.join(PROJECT, 'ws-'));
    fs.mkdirSync(path.join(workspace, '.damocles'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.damocles', 'settings.local.json'), JSON.stringify({ permissions: rules }));
    const handler = new PermissionHandler(createFakePlatform());
    handler.setCwd(workspace);
    handler.setWorkspacePath(workspace);
    handler.setDangerouslySkipPermissions(true);
    const prompts: Array<Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }>> = [];
    handler.setPostMessage((msg) => { if (msg.type === 'requestPermission') prompts.push(msg); });
    const gate: GatePermissionContext = {
      permissionHandler: handler,
      isPlanMode: () => false,
      shellCancel: new ShellCancelStore().forContext(() => undefined),
      designScope: () => ({ folder: DESIGN_FOLDER, cwd: workspace }),
      isMcpReadOnly: () => false,
    };
    return { gate, handler, prompts };
  }

  it('denies it on a deny rule, as the rule says', async () => {
    const { gate, prompts } = yoloDesignChat({ deny: ['mcp__figma__post_comment'] });
    const result = await runPermissionGate(ev('mcp__figma__post_comment', 'm1', {}), gate, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).toContain('Permission denied by a rule in your Damocles settings');
    expect(prompts).toEqual([]);
  });

  it('cannot hand canUseTool requiresUser without the rule, at compile time', () => {
    // @ts-expect-error: a call only the user approves must carry its settings rule
    const missing: CanUseToolContext = { signal: new AbortController().signal, toolUseID: null, requiresUser: true };
    expect(missing.requiresUser).toBe(true);
  });

  it('still asks on an allow rule, and turning YOLO on again settles nothing', async () => {
    const { gate, handler, prompts } = yoloDesignChat({ allow: ['mcp__figma__post_comment'] });
    const pending = runPermissionGate(ev('mcp__figma__post_comment', 'm2', {}), gate, undefined);
    await expect.poll(() => prompts.length).toBe(1);
    handler.setDangerouslySkipPermissions(false);
    handler.setDangerouslySkipPermissions(true);
    expect(handler.pendingPrompts().length > 0).toBe(true);
    await handler.resolveApproval('m2', false, { customMessage: 'not now' });
    expect((await pending)?.reason).toContain(FEEDBACK_MARKER);
  });
});

describe('ImportAsset\'s permission: a URL as a WebFetch of it, an outside file as a Read of it, a project path as today (D101)', () => {
  const DESIGN_FOLDER = designFolderOf('gate-import-abcd1234');
  const ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'design-import-')));
  afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
  /** Claude Code's `//` absolute form of a native path: `C:\x` as `//c/x`, `/tmp/x` as `//tmp/x`. */
  const absRule = (native: string): string => {
    const slashed = native.split(path.sep).join('/');
    return `/${/^[A-Za-z]:\//.test(slashed) ? `/${slashed[0]!.toLowerCase()}${slashed.slice(2)}` : slashed}`;
  };

  function importingChat(rules: Record<string, string[]>) {
    const workspace = fs.mkdtempSync(path.join(ROOT, 'ws-'));
    fs.mkdirSync(path.join(workspace, '.damocles'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.damocles', 'settings.local.json'), JSON.stringify({ permissions: rules }));
    const handler = new PermissionHandler(createFakePlatform());
    handler.setCwd(workspace);
    handler.setWorkspacePath(workspace);
    const prompts: Array<Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }>> = [];
    handler.setPostMessage((msg) => { if (msg.type === 'requestPermission') prompts.push(msg); });
    const gate: GatePermissionContext = {
      permissionHandler: handler,
      isPlanMode: () => false,
      shellCancel: new ShellCancelStore().forContext(() => undefined),
      designScope: () => ({ folder: DESIGN_FOLDER, cwd: workspace }),
    };
    return { gate, handler, prompts, workspace };
  }
  const importing = (id: string, input: Record<string, unknown>) => ev('ImportAsset', id, input);

  it('refuses a URL a settings deny rule WebFetch(domain:example.com) names, and runs one from another host unasked', async () => {
    const { gate, prompts } = importingChat({ deny: ['WebFetch(domain:example.com)'] });
    for (const url of ['https://example.com/photo.avif', 'https://EXAMPLE.com./photo.avif']) {
      const result = await runPermissionGate(importing(`u-${url}`, { url }), gate, undefined);
      expect(result?.block, url).toBe(true);
      expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
      expect(result?.reason).toContain('Permission denied by a rule in your Damocles settings');
    }
    expect(await runPermissionGate(importing('u-other', { url: 'https://images.other.org/photo.avif' }), gate, undefined)).toBeUndefined();
    expect(prompts).toEqual([]);
  });

  it('prompts for a URL an ask rule WebFetch(domain:example.com) names, as ImportAsset', async () => {
    const { gate, handler, prompts } = importingChat({ ask: ['WebFetch(domain:example.com)'] });
    const pending = runPermissionGate(importing('u-ask', { url: 'https://example.com/photo.png' }), gate, undefined);
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]!.toolName).toBe('ImportAsset');
    await handler.resolveApproval('u-ask', true);
    expect(await pending).toBeUndefined();
  });

  it('refuses an outside file a Read deny rule on its folder covers, and copies one elsewhere unasked', async () => {
    const photos = fs.mkdtempSync(path.join(ROOT, 'photos-'));
    const { gate, prompts } = importingChat({ deny: [`Read(${absRule(photos)}/**)`] });
    const denied = await runPermissionGate(importing('f-deny', { file: path.join(photos, 'wallpaper.jpg') }), gate, undefined);
    expect(denied?.block).toBe(true);
    expect(denied?.reason).toContain('Permission denied by a rule in your Damocles settings');
    expect(await runPermissionGate(importing('f-other', { file: path.join(ROOT, 'elsewhere', 'wallpaper.jpg') }), gate, undefined)).toBeUndefined();
    expect(prompts).toEqual([]);
  });

  it('decides a project path as a Read of it, so a Read rule covers it and a WebFetch rule does not, beside its own ImportAsset rule', async () => {
    const read = importingChat({ deny: ['Read(secrets/**)'] });
    for (const [id, input] of [['p-path', { path: 'secrets/x.png' }], ['p-file', { file: 'secrets/x.png' }]] as const) {
      const result = await runPermissionGate(importing(id, input), read.gate, undefined);
      expect(result?.block, id).toBe(true);
      expect(result?.reason).toContain('Permission denied by a rule in your Damocles settings');
    }
    expect(await runPermissionGate(importing('p-other', { path: 'img/logo.png' }), read.gate, undefined)).toBeUndefined();
    const web = importingChat({ deny: ['WebFetch'] });
    expect(await runPermissionGate(importing('p-web', { path: 'img/logo.png' }), web.gate, undefined)).toBeUndefined();
    const askRead = importingChat({ ask: ['Read(img/**)'] });
    const pending = runPermissionGate(importing('p-ask', { path: 'img/logo.png' }), askRead.gate, undefined);
    await expect.poll(() => askRead.prompts.length).toBe(1);
    expect(askRead.prompts[0]!.toolName).toBe('ImportAsset');
    await askRead.handler.resolveApproval('p-ask', true);
    expect(await pending).toBeUndefined();
    const own = importingChat({ deny: ['ImportAsset'] });
    expect((await runPermissionGate(importing('p-own', { path: 'img/logo.png' }), own.gate, undefined))?.block).toBe(true);
  });

  it('under YOLO keeps the design write rule and, as YOLO does for Read and WebFetch, skips their deny rules', async () => {
    const { gate, handler, workspace } = importingChat({ deny: ['Read(secrets/**)', 'WebFetch(domain:example.com)', 'ImportAsset'] });
    handler.setDangerouslySkipPermissions(true);
    for (const input of [{ path: 'secrets/x.png' }, { file: 'secrets/x.png' }, { url: 'https://example.com/a.png' }]) {
      expect(await runPermissionGate(importing(`y-${JSON.stringify(input)}`, input), gate, undefined), JSON.stringify(input)).toBeUndefined();
    }
    const superseded: GatePermissionContext = { ...gate, designScope: () => ({ folder: DESIGN_FOLDER, cwd: workspace, superseded: true }) };
    const unreadable: GatePermissionContext = { ...gate, designScope: () => ({ unreadable: true }) };
    for (const [label, context] of [['superseded', superseded], ['unreadable', unreadable]] as const) {
      const result = await runPermissionGate(importing(`y-${label}`, { path: 'img/logo.png' }), context, undefined);
      expect(result?.block, label).toBe(true);
      expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    }
  });

  it('keeps an ImportAsset rule for a URL and a file too, the stricter of it and the WebFetch or Read rule deciding', async () => {
    const own = importingChat({ deny: ['ImportAsset'] });
    for (const input of [{ url: 'https://example.com/a.png' }, { file: path.join(ROOT, 'a.png') }]) {
      const result = await runPermissionGate(importing(`o-${JSON.stringify(input)}`, input), own.gate, undefined);
      expect(result?.block, JSON.stringify(input)).toBe(true);
      expect(result?.reason).toContain('Permission denied by a rule in your Damocles settings');
    }
    const askOwn = importingChat({ ask: ['ImportAsset'], allow: ['WebFetch(domain:example.com)'] });
    const pending = runPermissionGate(importing('o-ask', { url: 'https://example.com/a.png' }), askOwn.gate, undefined);
    await expect.poll(() => askOwn.prompts.length).toBe(1);
    await askOwn.handler.resolveApproval('o-ask', false, { customMessage: 'not that one' });
    expect((await pending)?.block).toBe(true);
    const denyWeb = importingChat({ allow: ['ImportAsset'], deny: ['WebFetch(domain:example.com)'] });
    expect((await runPermissionGate(importing('o-web', { url: 'https://example.com/a.png' }), denyWeb.gate, undefined))?.block).toBe(true);
  });

  it('decides a file named as Read takes it by the path Read resolves, so a deny rule on the folder covers each spelling', async () => {
    const photos = fs.mkdtempSync(path.join(ROOT, 'spelled-'));
    const { gate } = importingChat({ deny: [`Read(${absRule(photos)}/**)`] });
    const spellings = [path.join(photos, 'wall\u00a0paper.png'), pathToFileURL(path.join(photos, 'wall paper.png')).href];
    if (process.platform === 'win32') spellings.push(`/${photos[0]!.toLowerCase()}${photos.slice(2).split(path.sep).join('/')}/wall paper.png`);
    for (const file of spellings) expect((await runPermissionGate(importing(`s-${file}`, { file }), gate, undefined))?.block, file).toBe(true);
  });

  it('blocks a call that names no single source, which no rule can decide', async () => {
    const { gate } = importingChat({});
    for (const input of [{}, { path: 'a.png', url: 'https://example.com/a.png' }, { file: '' }, { url: 42 }]) {
      const result = await runPermissionGate(importing(`x-${JSON.stringify(input)}`, input), gate, undefined);
      expect(result?.block, JSON.stringify(input)).toBe(true);
      expect(result?.reason).toContain('ImportAsset takes exactly one of path, file and url');
    }
  });

  it('still blocks a shell write in the design chat', async () => {
    const { gate } = importingChat({ allow: ['Bash'] });
    const result = await runPermissionGate(ev('bash', 's-1', { command: 'curl -o assets/a.png https://example.com/a.png' }), gate, undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('A design chat runs only shell commands proven read-only');
  });
});

describe.runIf(process.platform === 'win32')('a file tool whose path may reach a network host asks (win32)', () => {
  const machine = (hosts: string[] = []): ChatMachine => ({ platform: 'win32', allowedNetworkHosts: () => Promise.resolve(new Set(hosts)) });
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

  /** A chat in a fresh project whose settings hold `permissions`; its webview records each prompt and leaves it open. */
  function networkChat(opts: { mode?: 'default' | 'acceptEdits' | 'plan'; yolo?: boolean; permissions?: Record<string, string[]> } = {}) {
    const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-gate-unc-')));
    roots.push(workspace);
    fs.mkdirSync(path.join(workspace, '.damocles'));
    fs.writeFileSync(path.join(workspace, '.damocles', 'settings.local.json'), JSON.stringify({ permissions: opts.permissions ?? {} }));
    const platform = createFakePlatform();
    const handler = new PermissionHandler(platform);
    handler.setWorkspacePath(workspace);
    handler.setCwd(workspace);
    handler.setPermissionMode(opts.mode ?? 'default');
    handler.setDangerouslySkipPermissions(opts.yolo ?? false);
    const prompts: Array<Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }>> = [];
    handler.setPostMessage((msg) => { if (msg.type === 'requestPermission') prompts.push(msg); });
    const { panel } = makePanel({ plan: opts.mode === 'plan' });
    panel.permissionHandler = handler;
    panel.machine = machine();
    return { panel, handler, prompts, workspace, platform };
  }

  for (const mode of ['default', 'acceptEdits', 'plan'] as const) {
    it(`asks for Read, Grep, Glob and Ls of a network share in ${mode} mode`, async () => {
      const { panel, handler, prompts } = networkChat({ mode });
      const calls = [ev('read', 'n1', { path: '\\\\evil\\s\\x' }), ev('grep', 'n2', { pattern: 'a', path: '//evil/s' }), ev('find', 'n3', { pattern: '*', path: '\\\\?\\UNC\\evil\\s' }), ev('ls', 'n4', { path: '\\\\evil@SSL\\s' })];
      for (const [index, call] of calls.entries()) {
        const pending = runPermissionGate(call, panel, undefined);
        await expect.poll(() => prompts.length).toBe(index + 1);
        await handler.resolveApproval(call.toolCallId, true);
        expect(await pending).toBeUndefined();
      }
      expect(prompts.map((prompt) => prompt.toolName)).toEqual(['Read', 'Grep', 'Glob', 'Ls']);
    });
  }

  it('asks for an ImportAsset of a network file, as a Read of it', async () => {
    const { panel, handler, prompts } = networkChat();
    const pending = runPermissionGate(ev('ImportAsset', 'i1', { file: '\\\\evil\\s\\logo.png', name: 'logo' }), panel, undefined);
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]).toMatchObject({ toolName: 'ImportAsset' });
    await handler.resolveApproval('i1', false);
    expect((await pending)?.block).toBe(true);
  });

  it('asks for a Write of a network path in acceptEdits, with a prompt that reads no file', async () => {
    const { panel, handler, prompts, platform } = networkChat({ mode: 'acceptEdits' });
    const readText = vi.spyOn(platform.editor, 'readText');
    const pending = runPermissionGate(ev('write', 'w1', { path: '\\\\evil\\s\\x.txt', content: 'x' }), panel, undefined);
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]).toMatchObject({ toolName: 'Write' });
    expect(readText).not.toHaveBeenCalled();
    await handler.resolveApproval('w1', true);
    expect(await pending).toBeUndefined();
  });

  it('asks for a browser load of a file: URL on a share and an upload of a network file, and runs a local one', async () => {
    const { panel, handler, prompts, workspace } = networkChat();
    for (const [index, call] of [ev('BrowserNavigate', 'b1', { url: 'file://evil/s/x.html' }), ev('BrowserOpen', 'b2', { url: 'FILE:////evil/s/x.html' }), ev('BrowserUpload', 'b3', { paths: [path.join(workspace, 'a.png'), '\\\\evil\\s\\x.png'] })].entries()) {
      const pending = runPermissionGate(call, panel, undefined);
      await expect.poll(() => prompts.length).toBe(index + 1);
      await handler.resolveApproval(call.toolCallId, true);
      expect(await pending).toBeUndefined();
    }
    expect(await runPermissionGate(ev('BrowserNavigate', 'b4', { url: pathToFileURL(path.join(workspace, 'a.html')).href }), panel, undefined)).toBeUndefined();
    expect(await runPermissionGate(ev('BrowserNavigate', 'b5', { url: 'https://example.com/' }), panel, undefined)).toBeUndefined();
    expect(prompts).toHaveLength(3);
  });

  it('runs a local Read with no prompt', async () => {
    const { panel, prompts, workspace } = networkChat();
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'a');
    expect(await runPermissionGate(ev('read', 'l1', { path: 'a.txt' }), panel, undefined)).toBeUndefined();
    expect(prompts).toEqual([]);
  });

  it('runs it unasked when an allow rule names it, blocks it when a deny rule does, and YOLO approves it', async () => {
    const allowed = networkChat({ permissions: { allow: ['Read'] } });
    expect(await runPermissionGate(ev('read', 'a1', { path: '\\\\evil\\s\\x' }), allowed.panel, undefined)).toBeUndefined();
    expect(allowed.prompts).toEqual([]);

    const denied = networkChat({ permissions: { deny: ['Read(//evil/**)'] } });
    const result = await runPermissionGate(ev('read', 'd1', { path: '\\\\evil\\s\\x' }), denied.panel, undefined);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(denied.prompts).toEqual([]);

    const yolo = networkChat({ yolo: true });
    expect(await runPermissionGate(ev('read', 'y1', { path: '\\\\evil\\s\\x' }), yolo.panel, undefined)).toBeUndefined();
    expect(yolo.prompts).toEqual([]);
  });

  it('asks for a Read through a junction whose target is a share', async () => {
    const { panel, handler, prompts, workspace } = networkChat();
    const link = path.join(workspace, 'shared');
    fs.mkdirSync(path.join(workspace, 'real'));
    fs.symlinkSync(path.join(workspace, 'real'), link, 'junction');
    const readlink = fs.promises.readlink.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) =>
      (String(file).toLowerCase() === link.toLowerCase() ? '\\\\attacker\\share' : readlink(file))) as typeof fs.promises.readlink);
    onTestFinished(() => { spy.mockRestore(); });
    const pending = runPermissionGate(ev('read', 'j1', { path: 'shared/a.txt' }), panel, undefined);
    await expect.poll(() => prompts.length).toBe(1);
    await handler.resolveApproval('j1', true);
    expect(await pending).toBeUndefined();
  });

  it('asks for a Read and a Write through a junction to a share that a path allow rule names, which only a tool-wide allow rule runs', async () => {
    const { panel, handler, prompts, workspace } = networkChat({ permissions: { allow: ['Read(shared/**)', 'Edit(shared/**)'] } });
    const link = path.join(workspace, 'shared');
    fs.mkdirSync(path.join(workspace, 'real'));
    fs.symlinkSync(path.join(workspace, 'real'), link, 'junction');
    const readlink = fs.promises.readlink.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'readlink').mockImplementation((async (file: fs.PathLike) =>
      (String(file).toLowerCase() === link.toLowerCase() ? '\\\\attacker\\share' : readlink(file))) as typeof fs.promises.readlink);
    onTestFinished(() => { spy.mockRestore(); });
    for (const [index, call] of [ev('read', 'p1', { path: 'shared/a.txt' }), ev('write', 'p2', { path: 'shared/x.txt', content: 'x' })].entries()) {
      const pending = runPermissionGate(call, panel, undefined);
      await expect.poll(() => prompts.length).toBe(index + 1);
      await handler.resolveApproval(call.toolCallId, false);
      expect((await pending)?.block).toBe(true);
    }

    const toolWide = networkChat({ permissions: { allow: ['Read'] } });
    const otherLink = path.join(toolWide.workspace, 'shared');
    fs.mkdirSync(path.join(toolWide.workspace, 'real'));
    fs.symlinkSync(path.join(toolWide.workspace, 'real'), otherLink, 'junction');
    spy.mockImplementation((async (file: fs.PathLike) =>
      ([link, otherLink].some((known) => String(file).toLowerCase() === known.toLowerCase()) ? '\\\\attacker\\share' : readlink(file))) as typeof fs.promises.readlink);
    expect(await runPermissionGate(ev('read', 'p3', { path: 'shared/a.txt' }), toolWide.panel, undefined)).toBeUndefined();
    expect(toolWide.prompts).toEqual([]);
  });

  it('allows the hosts of the chat\'s folders and WSL\'s, in every spelling, and nothing else', async () => {
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation((async () => ({ isSymbolicLink: () => false })) as never);
    onTestFinished(() => { lstat.mockRestore(); });
    const cwd = () => path.resolve('/repo');
    const facts = (searched: string, hosts: string[]) => callFactsOf('Grep', { pattern: 'a', path: searched }, machine(hosts), cwd);
    expect(await facts('\\\\nas\\proj\\src', ['nas'])).toEqual({ reachesNetwork: false });
    expect(await facts('//NAS/proj/src', ['nas'])).toEqual({ reachesNetwork: false });
    expect(await facts('\\\\?\\UNC\\nas\\proj\\src', ['nas'])).toEqual({ reachesNetwork: false });
    expect(await facts('\\\\nas\\proj\\src', [])).toEqual({ reachesNetwork: true });
    expect(await facts('\\\\wsl.localhost\\Ubuntu\\home', [])).toEqual({ reachesNetwork: false });
    expect(await facts('\\\\wsl$\\Ubuntu\\home', [])).toEqual({ reachesNetwork: false });
    expect(await facts('\\\\wsl.localhost@SSL\\Ubuntu\\home', [])).toEqual({ reachesNetwork: true });
    expect(await facts('\\\\evil\\s', ['nas'])).toEqual({ reachesNetwork: true });
  });
});

describe('the three readers of a shell call\'s read-only verdict agree (plan mode and read-only agents, design chats, the checkpoint wait)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-gate-path-'));
  const DESIGN = designFolderOf('gate-agree-abcd1234');
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(DESIGN, { recursive: true, force: true });
  });

  // A Windows machine whose PowerShell PATH is one folder holding `files`.
  function windows(...files: string[]): ChatMachine {
    const folder = fs.mkdtempSync(path.join(root, 'bin-'));
    for (const file of files) fs.writeFileSync(path.join(folder, file), '');
    return { platform: 'win32', allowedNetworkHosts: () => Promise.resolve(new Set()), powerShellSearch: () => Promise.resolve({ path: folder, pathext: '.COM;.EXE;.BAT;.CMD', pwshHome: undefined }) };
  }

  async function expectReadersAgree(cases: Array<[string, string, ChatMachine, boolean]>): Promise<void> {
    for (const [tool, command, machine, expected] of cases) {
      const proven = (await provenReadOnlyShell(tool, { command }, machine)).readOnly;
      expect(proven, `proven: ${tool} ${command}`).toBe(expected);

      const plan = makePanel({ plan: true });
      plan.panel.machine = machine;
      await runPermissionGate(ev(tool, 'p1', { command }), plan.panel, undefined);
      expect(plan.canUseTool.mock.calls.length === 0, `plan mode: ${tool} ${command}`).toBe(proven);

      const designed = makePanel({});
      designed.panel.machine = machine;
      designed.panel.designScope = () => ({ folder: DESIGN, cwd: root });
      const result = await runPermissionGate(ev(tool, 'd1', { command }), designed.panel, undefined);
      expect(result?.block !== true, `design chat: ${tool} ${command}`).toBe(proven);

      const waiting = makePanel({});
      waiting.panel.machine = machine;
      const waited: string[] = [];
      waiting.panel.checkpointBaseline = { folder: root, wait: async (_signal, toolName) => { waited.push(toolName); } };
      await runPermissionGate(ev(tool, 'c1', { command }), waiting.panel, undefined);
      expect(waited.length === 0, `checkpoint wait: ${tool} ${command}`).toBe(proven);
    }
  }

  it('runs, blocks and waits exactly as provenReadOnlyShell proves, for a call no PATH lookup decides', async () => {
    await expectReadersAgree([
      ['PowerShell', 'Set-Content a.txt x', windows(), false],
      ['Bash', 'rg TODO src', windows('rg.cmd'), true],
      ['Bash', 'cat //evil/s/x', windows(), false],
    ]);
  });

  // The PATH folder is a real folder of this host, which a POSIX host spells as a relative one under win32's rules.
  it.runIf(process.platform === 'win32')('runs, blocks and waits exactly as provenReadOnlyShell proves, for a PowerShell program PATH decides', async () => {
    await expectReadersAgree([
      ['PowerShell', 'rg TODO src', windows('rg.exe'), true],
      ['PowerShell', 'rg TODO src', windows('rg.exe', 'rg.cmd'), false],
      ['PowerShell', 'Get-ChildItem | rg x', windows('rg.bat'), false],
      ['PowerShell', 'Get-Content a.txt', windows('Get-Content.ps1'), false],
      ['PowerShell', 'Get-Content a.txt', windows('rg.cmd'), true],
    ]);
  });
});
