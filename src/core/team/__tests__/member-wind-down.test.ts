import { afterEach, describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { AgentRunner } from '../agent-runner';
import { MessageBus } from '../message-bus';
import type { AgentResult, AgentRunConfig } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { AgentWindDown } from '../../../shared/types/wind-down';
import { WIND_DOWN_NOTICE_MS } from '../../pi-session/wind-down-notice';
import { trackRunLifecycle } from '../../pi-session/run-lifecycle';
import { heldSettleSessions } from '../../pi-session/__tests__/held-settle-fixture';

/**
 * A member's Stop whose run a pi extension's `agent_settled` handler holds, on a real pi session driven by the real
 * `AgentRunner`. The card learns what the stop waits for only once the wait outlasts `WIND_DOWN_NOTICE_MS`.
 */

const sessions = heldSettleSessions();
afterEach(() => sessions.dispose());

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);
}

function runMember(session: AgentSession, stop: AbortController, messages: ExtensionToWebviewMessage[], published: Array<AgentWindDown | null>): Promise<AgentResult> {
  const config: AgentRunConfig = {
    agentId: 'member-1',
    name: 'worker',
    role: 'specialist',
    initial: { kind: 'prompt', text: 'do the task' },
    // Bound as `TeamRunner.createMemberSession` binds a member's session.
    createSession: async () => {
      trackRunLifecycle(session);
      return session;
    },
    forgetSession: (s) => s.dispose(),
    abortSignal: stop.signal,
    messageBus: new MessageBus('team-1'),
    onMessage: (message) => messages.push(message),
    onWindDown: (windDown) => published.push(windDown),
    teamId: 'team-1',
    bindNoteDelivery: () => () => undefined,
    bindTakeUndelivered: () => () => undefined,
    keepAlive: () => false,
  };
  return new AgentRunner().startAgent(config);
}

/** A tool that ignores its abort signal until the test releases it. */
function stubbornTool(): { definition: ToolDefinition; started: Promise<void>; release: () => void } {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const definition = {
    name: 'stubborn',
    label: 'stubborn',
    description: 'A tool that finishes when it finishes',
    parameters: Type.Object({}),
    execute: async () => {
      markStarted();
      await released;
      return { content: [{ type: 'text', text: 'ok' }], details: {} };
    },
  } as unknown as ToolDefinition;
  return { definition, started, release };
}

describe("a member's Stop while a pi extension holds its run's wind-down", () => {
  it('publishes what pi awaits once the wait outlasts the notice delay, and clears it when the run settles', async () => {
    const held = await sessions.boot([fauxAssistantMessage('Done.')]);
    const settle = held.hold();
    const stop = new AbortController();
    const messages: ExtensionToWebviewMessage[] = [];
    const published: Array<AgentWindDown | null> = [];
    const run = runMember(held.session, stop, messages, published);
    await within(settle.waiting, 10_000, 'the agent_settled handler');

    stop.abort();
    await sleep(WIND_DOWN_NOTICE_MS - 1_000);
    expect(published).toEqual([]);
    // pi already ended the run, so only its agent_settled handlers are left (agent-session.js:686-691 in pi 1.3.0).
    await vi.waitFor(() => expect(published).toEqual([{ phase: 'settle', events: ['agent_settled'], extensions: [held.extensionPath] }]), { timeout: 3_000 });

    settle.release();
    const result = await within(run, 10_000, 'the stopped member');
    expect(result.status).toBe('cancelled');
    expect(published).toEqual([{ phase: 'settle', events: ['agent_settled'], extensions: [held.extensionPath] }, null]);
  }, 30_000);

  it('follows the run from its tool call to its settle handlers, which pi runs without agent_before_settle after the stop', async () => {
    const tool = stubbornTool();
    const held = await sessions.boot(
      [fauxAssistantMessage(fauxToolCall('stubborn', {}, { id: 'c1' }), { stopReason: 'toolUse' })],
      { customTools: [tool.definition] },
    );
    const settle = held.hold();
    const stop = new AbortController();
    const messages: ExtensionToWebviewMessage[] = [];
    const published: Array<AgentWindDown | null> = [];
    const run = runMember(held.session, stop, messages, published);
    await within(tool.started, 10_000, 'the tool call');

    stop.abort();
    await vi.waitFor(() => expect(published).toEqual([{ phase: 'run', events: [], extensions: [held.extensionPath] }]), { timeout: WIND_DOWN_NOTICE_MS + 2_000 });

    tool.release();
    await within(settle.waiting, 10_000, 'the agent_settled handler');
    await vi.waitFor(() => expect(published.at(-1)).toEqual({ phase: 'settle', events: ['agent_settled'], extensions: [held.extensionPath] }));

    settle.release();
    await within(run, 10_000, 'the stopped member');
    expect(published).toEqual([
      { phase: 'run', events: [], extensions: [held.extensionPath] },
      { phase: 'settle', events: ['agent_settled'], extensions: [held.extensionPath] },
      null,
    ]);
  }, 30_000);

  it('publishes nothing when the wind-down ends before the notice delay', async () => {
    const held = await sessions.boot([fauxAssistantMessage('Done.')]);
    const settle = held.hold();
    const stop = new AbortController();
    const messages: ExtensionToWebviewMessage[] = [];
    const published: Array<AgentWindDown | null> = [];
    const run = runMember(held.session, stop, messages, published);
    await within(settle.waiting, 10_000, 'the agent_settled handler');

    stop.abort();
    settle.release();
    expect((await within(run, 10_000, 'the stopped member')).status).toBe('cancelled');
    await sleep(WIND_DOWN_NOTICE_MS + 500);
    expect(published).toEqual([]);
  }, 30_000);
});
