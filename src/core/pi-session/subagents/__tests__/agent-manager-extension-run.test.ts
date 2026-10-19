import { afterEach, describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { AgentManager, type SubagentEngine } from '../agent-manager';
import { AgentRegistry } from '../agent-types';
import { buildNestedMcpToolset } from '../../tools/mcp-tools';
import { ShellCancelStore } from '../../tools/shell-cancel-registry';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { McpResourceRuleFilter } from '../../../permission-handler/mcp-resource-rule';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { heldSettleSessions, type HeldSettleSession } from '../../__tests__/held-settle-fixture';

/**
 * A run a user's pi extension opens in a subagent's session, and a steer that reaches a subagent while pi settles its run, on
 * real pi sessions built with the gate `AgentManager` builds for them.
 */

const sessions = heldSettleSessions();
afterEach(() => sessions.dispose());

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);
}

const NO_RESOURCE_RULES = async (): Promise<McpResourceRuleFilter> => ({ serverCovered: () => false, resourceDenied: () => false, resourceDenyRule: () => undefined, contentCovered: () => false });
const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

/** An engine whose one subagent session is a real one, handed to `prepare` before the manager receives it. */
function realEngine(responses: FauxResponseStep[], prepare: (booted: HeldSettleSession) => void, boot: { beforeAgentStart?: boolean } = {}): {
  engine: SubagentEngine;
  booted: () => Promise<HeldSettleSession>;
  order: string[];
} {
  const order: string[] = [];
  let resolveBooted!: (booted: HeldSettleSession) => void;
  const bootedPromise = new Promise<HeldSettleSession>((resolve) => { resolveBooted = resolve; });
  const engine: SubagentEngine = {
    cwd: process.cwd(),
    trust: createFakePlatform().trust,
    registry: new AgentRegistry(),
    createSession: async (opts) => {
      const booted = await sessions.boot(responses, { ...boot, extensionFactory: opts.extensionFactory });
      booted.session.subscribe((event) => {
        if (event.type === 'agent_settled') order.push('agent_settled');
      });
      prepare(booted);
      resolveBooted(booted);
      return booted.session;
    },
    forgetSession: (session) => {
      order.push('forget');
      session.dispose();
    },
    permissionHandler: {} as never,
    isPlanMode: () => false,
    shellCancelFor: () => new ShellCancelStore().forContext(() => undefined),
    postMessage: () => undefined,
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
  return { engine, booted: () => bootedPromise, order };
}

const SPAWN = { kind: 'spawn', type: 'general-purpose', prompt: 'do the task', description: 'dig', toolCallId: 'tc-1', runInBackground: true } as const;

const userTexts = (session: AgentSession): string[] =>
  session.messages.flatMap((m) => (m.role === 'user' ? [typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')] : []));

describe("a run a user's pi extension opens in a subagent's session", () => {
  it('runs the task once that run is over, instead of failing the subagent', async () => {
    const { engine, booted } = realEngine(['Extension reply.', 'Done.'].map((text) => fauxAssistantMessage(text)), (b) => b.sendFromExtension('from the extension'));
    const manager = new AgentManager(engine, 1);
    const id = manager.spawn(SPAWN);
    const { session } = await within(booted(), 10_000, 'the subagent session');

    await within(manager.getRecord(id)!.promise!, 10_000, 'the subagent');
    expect(manager.getRecord(id)).toMatchObject({ status: 'completed', result: 'Done.' });
    expect(userTexts(session)).toEqual(['from the extension', 'do the task']);
    manager.dispose();
  }, 30_000);

  it('a Stop waits for that run to end before the manager lets go of the session', async () => {
    let settle!: ReturnType<HeldSettleSession['hold']>;
    const { engine, booted, order } = realEngine([fauxAssistantMessage('Extension reply.'), fauxAssistantMessage('Unused.')], (b) => {
      settle = b.hold();
      b.sendFromExtension('from the extension');
    });
    const manager = new AgentManager(engine, 1);
    const id = manager.spawn(SPAWN);
    const { session } = await within(booted(), 10_000, 'the subagent session');
    let waiting = false;
    void settle.waiting.then(() => { waiting = true; });
    await vi.waitFor(() => expect(waiting || order.includes('forget')).toBe(true), { timeout: 10_000 });
    expect(order).toEqual([]);

    expect(manager.abort(id, 'user')).toBe(true);
    await sleep(500);
    expect(order).toEqual([]);

    settle.release();
    await within(manager.getRecord(id)!.promise!, 10_000, 'the stopped subagent');
    expect(order).toEqual(['agent_settled', 'forget']);
    expect(userTexts(session)).toEqual(['from the extension']);
    manager.dispose();
  }, 30_000);
});

describe("a Stop while pi still prepares a run a user's pi extension opened in a subagent's session", () => {
  it('lets go of the session at once, and pi stops that run at its start', async () => {
    let start!: ReturnType<HeldSettleSession['holdBeforeAgentStart']>;
    const { engine, booted, order } = realEngine([fauxAssistantMessage('Unused.')], (b) => {
      start = b.holdBeforeAgentStart();
      b.sendFromExtension('from the extension');
    }, { beforeAgentStart: true });
    const manager = new AgentManager(engine, 1);
    const id = manager.spawn(SPAWN);
    const { session } = await within(booted(), 10_000, 'the subagent session');
    const ends: string[] = [];
    session.agent.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') ends.push(`${event.message.stopReason}: ${event.message.errorMessage ?? ''}`);
    });
    await within(start.waiting, 10_000, "the extension run's before_agent_start handler");

    expect(manager.abort(id, 'user')).toBe(true);
    await within(manager.getRecord(id)!.promise!, 10_000, 'the stopped subagent');
    expect(order).toEqual(['forget']);

    start.release();
    // The run's request setup rejects under the aborted signal before any request (`model-runtime.js:456-460` in pi-coding-agent 1.3.0).
    await vi.waitFor(() => expect(ends).toEqual(['error: This operation was aborted']), { timeout: 10_000 });
    manager.dispose();
  }, 30_000);
});

describe("a steer that reaches a subagent while pi runs its run's agent_settled handlers", () => {
  it('is reported finished rather than steered, since that run takes no more messages', async () => {
    let settle!: ReturnType<HeldSettleSession['hold']>;
    const { engine, booted } = realEngine([fauxAssistantMessage('Done.')], (b) => { settle = b.hold(); });
    const manager = new AgentManager(engine, 1);
    const id = manager.spawn(SPAWN);
    const { session } = await within(booted(), 10_000, 'the subagent session');
    await within(settle.waiting, 10_000, 'the agent_settled handler');

    expect(await manager.steer(id, 'also do this')).toBe('finished');
    expect(session.getSteeringMessages()).toEqual([]);
    settle.release();
    await within(manager.getRecord(id)!.promise!, 10_000, 'the subagent');
    expect(manager.getRecord(id)).toMatchObject({ status: 'completed', result: 'Done.' });
    manager.dispose();
  }, 30_000);
});
