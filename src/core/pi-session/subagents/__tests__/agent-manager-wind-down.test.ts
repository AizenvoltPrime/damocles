import { afterEach, describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { AgentManager, type SubagentEngine } from '../agent-manager';
import { AgentRegistry } from '../agent-types';
import { buildNestedMcpToolset } from '../../tools/mcp-tools';
import { ShellCancelStore } from '../../tools/shell-cancel-registry';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { McpResourceRuleFilter } from '../../../permission-handler/mcp-resource-rule';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';
import type { AgentWindDown } from '../../../../shared/types/wind-down';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { WIND_DOWN_NOTICE_MS } from '../../wind-down-notice';
import { heldSettleSessions, type HeldSettleSession } from '../../__tests__/held-settle-fixture';

/**
 * A subagent's Stop whose run a pi extension's `agent_settled` handler holds, on a real pi session built with the gate
 * `AgentManager` builds for it. Its card learns what the stop waits for only once the wait outlasts `WIND_DOWN_NOTICE_MS`.
 */

const sessions = heldSettleSessions();
afterEach(() => sessions.dispose());

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);
}

const NO_RESOURCE_RULES = async (): Promise<McpResourceRuleFilter> => ({ serverCovered: () => false, resourceDenied: () => false, resourceDenyRule: () => undefined, contentCovered: () => false });
const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

/** An engine whose one subagent session is a real one whose `agent_settled` handler waits for the test. */
function heldEngine(posted: ExtensionToWebviewMessage[]): { engine: SubagentEngine; held: () => Promise<{ booted: HeldSettleSession; settle: ReturnType<HeldSettleSession['hold']> }> } {
  let resolveHeld!: (value: { booted: HeldSettleSession; settle: ReturnType<HeldSettleSession['hold']> }) => void;
  const heldPromise = new Promise<{ booted: HeldSettleSession; settle: ReturnType<HeldSettleSession['hold']> }>((resolve) => { resolveHeld = resolve; });
  const engine: SubagentEngine = {
    cwd: process.cwd(),
    trust: createFakePlatform().trust,
    registry: new AgentRegistry(),
    createSession: async (opts) => {
      const booted = await sessions.boot([fauxAssistantMessage('Done.')], { extensionFactory: opts.extensionFactory });
      resolveHeld({ booted, settle: booted.hold() });
      return booted.session;
    },
    forgetSession: (session) => session.dispose(),
    permissionHandler: {} as never,
    isPlanMode: () => false,
    shellCancelFor: () => new ShellCancelStore().forContext(() => undefined),
    postMessage: (message) => posted.push(message),
    getParentSystemPrompt: () => '',
    getParentSessionId: () => 'parent-sid',
    subagentStoreDir: () => '/store',
    recordInvocation: () => {},
    parentBranch: () => [],
    assertResumableModel: () => {},
    parentFullToolNames: () => [],
    buildAgentToolset: () => ({ customTools: [], mcp: buildNestedMcpToolset(piStub, null, { eligible: new Set(), disabledEntries: [], resourceRuleFilter: NO_RESOURCE_RULES }) }),
    disposeBrowserScope: () => {},
    cancelAgentDialogs: () => {},
    resolveModel: () => ({}),
    modelDollarBilled: () => true,
    onSubagentCost: () => {},
    onRunsChanged: () => {},
  };
  return { engine, held: () => heldPromise };
}

function windDowns(posted: readonly ExtensionToWebviewMessage[]): Array<AgentWindDown | null> {
  return posted.flatMap((m) => (m.type === 'statusUpdate' && m.status === 'windingDown' && m.parentToolUseId === 'tc-1' ? [m.windDown] : []));
}

const SPAWN = { kind: 'spawn', type: 'general-purpose', prompt: 'do the task', description: 'dig', toolCallId: 'tc-1', runInBackground: true } as const;

describe("a subagent's Stop while a pi extension holds its run's wind-down", () => {
  it('publishes what pi awaits once the wait outlasts the notice delay, and clears it before the card resolves', async () => {
    const posted: ExtensionToWebviewMessage[] = [];
    const { engine, held } = heldEngine(posted);
    const manager = new AgentManager(engine, 1);
    const id = manager.spawn(SPAWN);
    const { booted, settle } = await within(held(), 10_000, 'the subagent session');
    await within(settle.waiting, 10_000, 'the agent_settled handler');

    expect(manager.abort(id, 'user')).toBe(true);
    await sleep(WIND_DOWN_NOTICE_MS - 1_000);
    expect(windDowns(posted)).toEqual([]);
    await vi.waitFor(() => expect(windDowns(posted)).toEqual([{ phase: 'settle', events: ['agent_settled'], extensions: [booted.extensionPath] }]), { timeout: 3_000 });

    settle.release();
    await within(manager.getRecord(id)!.promise!, 10_000, 'the stopped subagent');
    expect(windDowns(posted)).toEqual([{ phase: 'settle', events: ['agent_settled'], extensions: [booted.extensionPath] }, null]);
    const cleared = posted.findIndex((m) => m.type === 'statusUpdate' && m.status === 'windingDown' && m.windDown === null);
    expect(cleared).toBeLessThan(posted.findIndex((m) => m.type === 'subagentStop'));
    manager.dispose();
  }, 30_000);

  it("replays the running card, its Background Tasks row and its wind-down to a reloaded webview, and nothing once the run settled", async () => {
    const posted: ExtensionToWebviewMessage[] = [];
    const { engine, held } = heldEngine(posted);
    const manager = new AgentManager(engine, 1);
    const id = manager.spawn(SPAWN);
    const { booted, settle } = await within(held(), 10_000, 'the subagent session');
    await within(settle.waiting, 10_000, 'the agent_settled handler');
    manager.abort(id, 'user');
    const shown: AgentWindDown = { phase: 'settle', events: ['agent_settled'], extensions: [booted.extensionPath] };
    await vi.waitFor(() => expect(windDowns(posted)).toEqual([shown]), { timeout: WIND_DOWN_NOTICE_MS + 2_000 });

    const sinceReload = posted.length;
    manager.replayLive();
    expect(posted.slice(sinceReload)).toEqual([
      { type: 'taskStarted', taskId: id, toolUseId: 'tc-1', description: 'dig', taskType: 'general-purpose', isBackground: true },
      { type: 'backgroundTaskStarted', task: { taskId: id, toolUseId: 'tc-1', description: 'dig', status: 'running' } },
      { type: 'statusUpdate', status: 'windingDown', windDown: shown, parentToolUseId: 'tc-1' },
    ]);

    settle.release();
    await within(manager.getRecord(id)!.promise!, 10_000, 'the stopped subagent');
    expect(windDowns(posted.slice(sinceReload))).toEqual([shown, null]);
    const afterSettle = posted.length;
    manager.replayLive();
    expect(posted.slice(afterSettle)).toEqual([]);
    manager.dispose();
  }, 30_000);

  it('publishes nothing when the wind-down ends before the notice delay', async () => {
    const posted: ExtensionToWebviewMessage[] = [];
    const { engine, held } = heldEngine(posted);
    const manager = new AgentManager(engine, 1);
    const id = manager.spawn(SPAWN);
    const { settle } = await within(held(), 10_000, 'the subagent session');
    await within(settle.waiting, 10_000, 'the agent_settled handler');

    manager.abort(id, 'user');
    settle.release();
    await within(manager.getRecord(id)!.promise!, 10_000, 'the stopped subagent');
    await sleep(WIND_DOWN_NOTICE_MS + 500);
    expect(windDowns(posted)).toEqual([]);
    manager.dispose();
  }, 30_000);
});
