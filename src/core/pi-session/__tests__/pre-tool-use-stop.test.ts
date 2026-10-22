import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSession, ToolCallEvent, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { FEEDBACK_MARKER, POLICY_BLOCK_MARKER } from '../../../shared/types/constants';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { PermissionHandler, PermissionResult } from '../../permission-handler';
import { createDamoclesExtensionFactory } from '../damocles-extension';
import { dispatchToolCall, type DispatchDeps } from '../hooks/dispatch';
import type { HookCommon } from '../hooks/payload';
import type { HookEntry } from '../hooks/types';
import { runPermissionGate, type PanelGateContext, type PreToolUseHookGate } from '../permission-gate';
import { createSubagentExtensionFactory, type SubagentGateContext } from '../subagents/subagent-extension-factory';
import { runSubagent } from '../subagents/subagent-runner';
import { trackRunLifecycle } from '../run-lifecycle';
import { mapPiToolName, normalizeToolInput } from '../tool-normalization';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import { realPiSessions } from './real-pi-fixtures';

/** A Stop or a run abort while a PreToolUse hook runs: real hook processes, real pi sessions where the caller is a factory. */

// The hanging hooks answer only after 30 s, past this timeout, so a hook gone well before it was killed by the abort.
const HOOK_TIMEOUT_MS = 20_000;
const PROMPT_MS = 5_000;
const STOPPED = 'The user stopped this command before it started, so it did not run.';

const dirs: string[] = [];

// Nothing kills a hook by pid: once it exits, Windows can hand its pid to another process. The runner kills it at HOOK_TIMEOUT_MS and it exits by itself at 30 s.
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const node = (script: string, extra: Partial<HookEntry> = {}): HookEntry => ({ command: [process.execPath, '-e', script], ...extra });

/** A PreToolUse hook that starts a child of its own, writes both pids, and answers allow only after 30 s. */
function hangingHook(): { entry: HookEntry; pids: () => number[] | undefined; answered: () => boolean } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-pretool-hang-'));
  dirs.push(dir);
  const pidFile = path.join(dir, 'pids');
  const answeredFile = path.join(dir, 'answered');
  const script = [
    "process.stdin.resume(); process.stdin.on('end', () => {",
    "  const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });",
    `  require('fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid);`,
    `  setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(answeredFile)}, 'answered'); process.stdout.write(JSON.stringify({ decision: 'allow' })); process.exit(0); }, 30000);`,
    '});',
  ].join('\n');
  const pids = (): number[] | undefined => {
    const read = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').split(' ').map(Number) : [];
    if (read.length !== 2 || read.some((pid) => !Number.isInteger(pid) || pid <= 0)) return undefined;
    return read;
  };
  return { entry: node(script, { timeoutMs: HOOK_TIMEOUT_MS }), pids, answered: () => fs.existsSync(answeredFile) };
}

function deps(toolCall: HookEntry[]): DispatchDeps {
  return {
    config: { getEntries: (key: string) => (key === 'tool_call' ? toolCall : []), hasEntries: (key: string) => key === 'tool_call' && toolCall.length > 0 } as never,
    workspaceRoot: process.cwd(),
    userHome: os.homedir(),
  };
}

function permissionHandler(canUse: () => Promise<PermissionResult> = async () => ({ behavior: 'allow', updatedInput: {} })) {
  const canUseTool = vi.fn<PermissionHandler['canUseTool']>(canUse);
  const matchRule = vi.fn<PermissionHandler['matchRule']>(async () => null);
  const handler = { canUseTool, matchRule, decide: () => 'allow', isPlanFile: () => false } as unknown as PermissionHandler;
  return { handler, canUseTool, matchRule };
}

function gatePanel(store: ShellCancelStore, emitted: ExtensionToWebviewMessage[] = [], canUse?: () => Promise<PermissionResult>) {
  const { handler, canUseTool, matchRule } = permissionHandler(canUse);
  const panel: PanelGateContext = {
    permissionHandler: handler,
    isPlanMode: () => false,
    shellCancel: store.forContext(() => undefined),
    budgetStopRequested: () => false,
    getSessionModel: () => 'claude-opus-5-5',
    memoryWorkspace: () => process.cwd(),
    getSystemPromptEnv: () => ({
      cwd: process.cwd(),
      model: 'claude-opus-5-5',
      isGitRepo: false,
      platform: process.platform,
      shell: 'pwsh',
      osVersion: 'test',
      compassEnabled: false,
      thinkingDisabled: true,
    }),
    getPlanFilePath: () => path.join(os.tmpdir(), 'plan-test.md'),
    postMessage: (message) => emitted.push(message),
  };
  return { panel, canUseTool, matchRule };
}

/** A PowerShell tool that only counts its runs. */
function countingShell(): { definition: ToolDefinition; runs: () => number } {
  let runs = 0;
  const definition = {
    name: 'PowerShell',
    label: 'PowerShell',
    description: 'Run a PowerShell command',
    parameters: Type.Object({ command: Type.String() }),
    execute: async () => {
      runs++;
      return { content: [{ type: 'text', text: 'ran' }], details: {} };
    },
  } as unknown as ToolDefinition;
  return { definition, runs: () => runs };
}

const callShell = fauxAssistantMessage(fauxToolCall('PowerShell', { command: 'npm install' }, { id: 'call-1' }), { stopReason: 'toolUse' });
const done: FauxResponseStep = fauxAssistantMessage('Done.');

/** The text of the tool result pi recorded for `toolCallId`. */
function toolResultText(session: AgentSession, toolCallId: string): string | undefined {
  for (const message of session.messages as unknown as Array<{ role: string; toolCallId?: string; content?: Array<{ type: string; text?: string }> }>) {
    if (message.role === 'toolResult' && message.toolCallId === toolCallId) return (message.content ?? []).map((part) => part.text ?? '').join('');
  }
  return undefined;
}

/** When pi ended `toolCallId`, in `Date.now()` time. */
function executionEnd(session: AgentSession, toolCallId: string): () => number | undefined {
  let endedAt: number | undefined;
  session.subscribe((event) => {
    if (event.type === 'tool_execution_end' && event.toolCallId === toolCallId) endedAt = Date.now();
  });
  return () => endedAt;
}

describe('a Stop while a PreToolUse hook runs, through real pi sessions', () => {
  const pi = realPiSessions();
  afterEach(() => pi.dispose());

  it('main chat: kills the hook with its child, blocks the call as stopped and never runs it, well inside the hook\'s timeout', async () => {
    const hook = hangingHook();
    const store = new ShellCancelStore();
    const emitted: ExtensionToWebviewMessage[] = [];
    const { panel, canUseTool } = gatePanel(store, emitted);
    const damocles = createDamoclesExtensionFactory(
      { get: () => panel, values: () => [panel] },
      { get: () => undefined },
      { config: deps([hook.entry]).config, workspaceRoot: process.cwd(), userHome: os.homedir() },
    );
    const shell = countingShell();
    const { session, contexts } = await pi.boot(shell.definition, [callShell, done], (api) => damocles(api));
    const ended = executionEnd(session, 'call-1');

    const run = session.prompt('work');
    await vi.waitFor(() => expect(hook.pids()).toBeDefined(), { timeout: 10_000 });
    const [parent, child] = hook.pids()!;
    const stoppedAt = Date.now();
    expect(store.cancel('call-1')).toBe(true);

    await vi.waitFor(() => expect([alive(parent!), alive(child!)]).toEqual([false, false]), { timeout: PROMPT_MS });
    await run;

    expect(hook.answered()).toBe(false);
    expect(ended()! - stoppedAt).toBeLessThan(PROMPT_MS);
    const text = toolResultText(session, 'call-1');
    expect(text).toContain(STOPPED);
    expect(text).toContain(FEEDBACK_MARKER);
    expect(text).not.toContain(POLICY_BLOCK_MARKER);
    expect(shell.runs()).toBe(0);
    expect(canUseTool).not.toHaveBeenCalled();
    // One Stop leaves the turn running.
    expect(contexts).toHaveLength(2);
  }, 40_000);

  /** A subagent or team member session as `AgentManager` and the team build it: one factory, its Stop aborting the run. */
  async function nestedSession(responses: FauxResponseStep[]) {
    const hook = hangingHook();
    const store = new ShellCancelStore();
    const agentStop = new AbortController();
    const { handler, canUseTool } = permissionHandler();
    const ctx: SubagentGateContext = {
      permissionHandler: handler,
      isPlanMode: () => false,
      shellCancel: store.forContext(() => undefined),
      parentToolUseId: 'agent-call',
      stopSignal: agentStop.signal,
      deferrableToolNames: [],
      hooks: deps([hook.entry]),
    };
    const shell = countingShell();
    const { session, contexts } = await pi.boot(shell.definition, responses, (api) => createSubagentExtensionFactory(ctx)(api));
    const ended = executionEnd(session, 'call-1');
    const run = runSubagent({ createSession: async () => session, onSessionCreated: trackRunLifecycle, prompt: 'work', signal: agentStop.signal });
    await vi.waitFor(() => expect(hook.pids()).toBeDefined(), { timeout: 10_000 });
    return { hook, store, agentStop, canUseTool, shell, session, contexts, ended, run };
  }

  it('subagent or team member: a Stop of the call kills the hook, blocks the call as stopped and never runs it', async () => {
    const { hook, store, canUseTool, shell, session, contexts, ended, run } = await nestedSession([callShell, done]);
    const [parent, child] = hook.pids()!;
    const stoppedAt = Date.now();
    expect(store.cancel('call-1')).toBe(true);

    await vi.waitFor(() => expect([alive(parent!), alive(child!)]).toEqual([false, false]), { timeout: PROMPT_MS });
    await run;

    expect(hook.answered()).toBe(false);
    expect(ended()! - stoppedAt).toBeLessThan(PROMPT_MS);
    const text = toolResultText(session, 'call-1');
    expect(text).toContain(STOPPED);
    expect(text).toContain(FEEDBACK_MARKER);
    expect(shell.runs()).toBe(0);
    expect(canUseTool).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(2);
  }, 40_000);

  it('subagent or team member: the agent\'s own Stop aborts its run, which kills the hook, and the call never runs', async () => {
    const { hook, agentStop, canUseTool, shell, session, contexts, run } = await nestedSession([callShell, done]);
    const [parent, child] = hook.pids()!;
    const stoppedAt = Date.now();
    agentStop.abort();

    await vi.waitFor(() => expect([alive(parent!), alive(child!)]).toEqual([false, false]), { timeout: PROMPT_MS });
    await run;

    expect(Date.now() - stoppedAt).toBeLessThan(PROMPT_MS);
    expect(hook.answered()).toBe(false);
    // pi 1.4.0 replaces any `tool_call` result of an aborted run with this error (`agent-loop.js:506-511` in pi-agent-core).
    expect(toolResultText(session, 'call-1')).toBe('Operation aborted');
    expect(shell.runs()).toBe(0);
    expect(canUseTool).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(1);
  }, 40_000);
});

const common: HookCommon = { session_id: 's', transcript_path: '', cwd: process.cwd() };

function ev(toolName: string, toolCallId: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: 'tool_call', toolName, toolCallId, input } as unknown as ToolCallEvent;
}

/** The PreToolUse gate the factories build, over real hook processes, with its notices and stash recorded. */
function hookGate(entries: HookEntry[]): PreToolUseHookGate & { onDecision: Mock; notify: Mock; stashContext: Mock } {
  const dispatch = deps(entries);
  return {
    run: (event, signal) =>
      dispatchToolCall(dispatch, {
        common,
        toolName: mapPiToolName(event.toolName),
        toolInput: normalizeToolInput(event.toolName, event.input as Record<string, unknown>),
      }, signal),
    onDecision: vi.fn(),
    notify: vi.fn(),
    stashContext: vi.fn(),
  };
}

const rewriteAndAllow = node(
  "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ decision: 'allow', updated_input: { command: 'rewritten' }, context: 'HOOK-CONTEXT', system_message: 'HOOK-NOTICE' })));",
);

describe('the gate with real PreToolUse hook processes', () => {
  it('a Stop during the second of two hooks drops the first one\'s rewrite, context and allow but shows its notice, and kills the second', async () => {
    const second = hangingHook();
    const store = new ShellCancelStore();
    const { panel, canUseTool, matchRule } = gatePanel(store);
    const gate = hookGate([rewriteAndAllow, second.entry]);
    const event = ev('PowerShell', 'c1', { command: 'original' });

    const pending = runPermissionGate(event, panel, new AbortController().signal, null, gate);
    await vi.waitFor(() => expect(second.pids()).toBeDefined(), { timeout: 10_000 });
    const [parent, child] = second.pids()!;
    const stoppedAt = Date.now();
    expect(store.cancel('c1')).toBe(true);

    await vi.waitFor(() => expect([alive(parent!), alive(child!)]).toEqual([false, false]), { timeout: PROMPT_MS });
    const result = await pending;

    expect(Date.now() - stoppedAt).toBeLessThan(PROMPT_MS);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(STOPPED);
    expect(result?.reason).toContain(FEEDBACK_MARKER);
    expect(result).not.toHaveProperty('terminate');
    expect(event.input).toEqual({ command: 'original' });
    expect(gate.stashContext).not.toHaveBeenCalled();
    expect(gate.onDecision).not.toHaveBeenCalled();
    expect(gate.notify).toHaveBeenCalledExactlyOnceWith(['HOOK-NOTICE']);
    expect(canUseTool).not.toHaveBeenCalled();
    expect(matchRule).not.toHaveBeenCalled();
    expect(second.answered()).toBe(false);
  }, 40_000);

  it.each([
    ['a read, which the full gate would run unasked', 'read', { path: 'a.ts' }],
    ['a write', 'write', { path: 'a.ts', content: 'x' }],
    ['a shell call', 'PowerShell', { command: 'npm install' }],
  ])('a run abort during a hook blocks %s as an unasked deny, never consulting the full gate', async (_name, tool, input) => {
    const hook = hangingHook();
    const { panel, canUseTool, matchRule } = gatePanel(new ShellCancelStore());
    const gate = hookGate([rewriteAndAllow, hook.entry]);
    const run = new AbortController();
    const event = ev(tool, 'r1', { ...input });

    const pending = runPermissionGate(event, panel, run.signal, null, gate);
    await vi.waitFor(() => expect(hook.pids()).toBeDefined(), { timeout: 10_000 });
    const [parent, child] = hook.pids()!;
    const abortedAt = Date.now();
    run.abort();

    await vi.waitFor(() => expect([alive(parent!), alive(child!)]).toEqual([false, false]), { timeout: PROMPT_MS });
    const result = await pending;

    expect(Date.now() - abortedAt).toBeLessThan(PROMPT_MS);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).toContain('The session was aborted before this tool call could run');
    expect(result?.reason).not.toContain(FEEDBACK_MARKER);
    expect(result).not.toHaveProperty('terminate');
    expect(event.input).toEqual(input);
    expect(canUseTool).not.toHaveBeenCalled();
    expect(matchRule).not.toHaveBeenCalled();
    expect(gate.onDecision).not.toHaveBeenCalled();
    expect(gate.stashContext).not.toHaveBeenCalled();
  }, 40_000);

  it('a run abort during the checkpoint wait blocks the call with the same unasked deny', async () => {
    const { panel } = gatePanel(new ShellCancelStore());
    const wait = vi.fn((signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })));
    panel.checkpointBaseline = { folder: process.cwd(), wait };
    const run = new AbortController();

    const pending = runPermissionGate(ev('write', 'w1', { path: path.join(process.cwd(), 'a.ts'), content: 'x' }), panel, run.signal);
    await vi.waitFor(() => expect(wait).toHaveBeenCalled());
    run.abort();
    const result = await pending;

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
    expect(result?.reason).toContain('The session was aborted before this tool call could run');
    expect(result).not.toHaveProperty('terminate');
  });

  describe('a hook that is not aborted behaves as before', () => {
    it('one that finishes rewrites the input, stashes its context and force-allows', async () => {
      const { panel, canUseTool } = gatePanel(new ShellCancelStore());
      const gate = hookGate([rewriteAndAllow]);
      const event = ev('PowerShell', 'n1', { command: 'original' });

      expect(await runPermissionGate(event, panel, new AbortController().signal, null, gate)).toBeUndefined();

      expect(event.input).toEqual({ command: 'rewritten' });
      expect(gate.stashContext).toHaveBeenCalledWith('n1', 'HOOK-CONTEXT');
      expect(gate.notify).toHaveBeenCalledWith(['HOOK-NOTICE']);
      expect(gate.onDecision).toHaveBeenCalledWith('PowerShell', 'allow', undefined, false);
      expect(canUseTool).not.toHaveBeenCalled();
    });

    it('one that answers nothing hands the call to the full gate', async () => {
      const { panel, canUseTool } = gatePanel(new ShellCancelStore());
      const gate = hookGate([node("process.stdin.resume(); process.stdin.on('end', () => {});")]);

      expect(await runPermissionGate(ev('PowerShell', 'n2', { command: 'make' }), panel, new AbortController().signal, null, gate)).toBeUndefined();

      expect(canUseTool).toHaveBeenCalledTimes(1);
      expect(gate.onDecision).not.toHaveBeenCalled();
    });

    it('one that denies blocks with its reason as a policy block', async () => {
      const { panel, canUseTool } = gatePanel(new ShellCancelStore());
      const gate = hookGate([node("process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'not here' })));")]);

      const result = await runPermissionGate(ev('PowerShell', 'n3', { command: 'make' }), panel, new AbortController().signal, null, gate);

      expect(result?.block).toBe(true);
      expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
      expect(result?.reason).toContain('not here');
      expect(result).not.toHaveProperty('terminate');
      expect(gate.onDecision).toHaveBeenCalledWith('PowerShell', 'deny', 'not here', false);
      expect(canUseTool).not.toHaveBeenCalled();
    });

    it.each([
      ['a write', 'write', { path: 'a.ts', content: 'x' }],
      ['a shell call', 'PowerShell', { command: 'make' }],
    ])('one that times out fails closed for %s, even beside a force-allow', async (_name, tool, input) => {
      const { panel, canUseTool } = gatePanel(new ShellCancelStore());
      const slow = node("process.stdin.resume(); setTimeout(() => {}, 30000);", { timeoutMs: 300 });
      const gate = hookGate([rewriteAndAllow, slow]);

      const result = await runPermissionGate(ev(tool, 't1', { ...input }), panel, new AbortController().signal, null, gate);

      expect(result?.block).toBe(true);
      expect(result?.reason).toContain(POLICY_BLOCK_MARKER);
      expect(result?.reason).toContain('could not be approved');
      expect(gate.onDecision).not.toHaveBeenCalled();
      expect(canUseTool).not.toHaveBeenCalled();
    }, 20_000);

    it('one that times out on a read leaves the read to the full gate', async () => {
      const { panel, matchRule } = gatePanel(new ShellCancelStore());
      const gate = hookGate([node("process.stdin.resume(); setTimeout(() => {}, 30000);", { timeoutMs: 300 })]);

      expect(await runPermissionGate(ev('read', 't2', { path: 'a.ts' }), panel, new AbortController().signal, null, gate)).toBeUndefined();
      expect(matchRule).toHaveBeenCalledTimes(1);
    }, 20_000);
  });
});
