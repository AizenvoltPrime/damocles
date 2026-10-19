import { afterEach, describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentSession, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { AgentRunner } from '../agent-runner';
import { MessageBus } from '../message-bus';
import type { AgentResult, AgentRunConfig } from '../types';
import { trackRunLifecycle } from '../../pi-session/run-lifecycle';
import { heldSettleSessions } from '../../pi-session/__tests__/held-settle-fixture';

/**
 * A run a user's pi extension opens in a team member's session, with no runner prompt behind it, on a real pi session driven
 * by the real `AgentRunner`. The runner hands pi its next prompt only once that run is over, and a Stop waits it out before
 * the member lets go of its session.
 */

const sessions = heldSettleSessions();
afterEach(() => sessions.dispose());

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);
}

interface Member {
  run: Promise<AgentResult>;
  bus: MessageBus;
  stop: AbortController;
  /** Resolves at the member's next park, after a turn the runner awaited ended. */
  nextPark: () => Promise<void>;
  setAlive: (alive: boolean) => void;
  /** What happened to the session, in order: pi's `agent_settled`, and the runner letting go of it (`forget`). */
  order: string[];
  /** The user messages the member's card shows. */
  echoes: string[];
}

/** A member bound as `TeamRunner.createMemberSession` binds one, which parks after its opening task while `alive`. */
function startMember(session: AgentSession): Member {
  const bus = new MessageBus('team-1');
  const stop = new AbortController();
  const order: string[] = [];
  const echoes: string[] = [];
  session.subscribe((event) => {
    if (event.type === 'agent_settled') order.push('agent_settled');
  });
  let alive = true;
  let parks = 0;
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const config: AgentRunConfig = {
    agentId: 'member-1',
    name: 'worker',
    role: 'specialist',
    initial: { kind: 'prompt', text: 'do the task' },
    createSession: async () => {
      trackRunLifecycle(session);
      return session;
    },
    forgetSession: (s) => {
      order.push('forget');
      s.dispose();
    },
    abortSignal: stop.signal,
    messageBus: bus,
    onMessage: (message) => {
      if (message.type === 'teamAgentUserMessage') echoes.push(message.content);
    },
    onWindDown: () => undefined,
    teamId: 'team-1',
    bindNoteDelivery: () => () => undefined,
    bindTakeUndelivered: () => () => undefined,
    keepAlive: () => alive,
    onTurnEnd: () => {
      parks++;
      for (const waiter of waiters.filter((w) => parks >= w.n)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
  };
  const nextPark = (): Promise<void> => {
    const n = parks + 1;
    return new Promise<void>((resolve) => waiters.push({ n, resolve }));
  };
  return { run: new AgentRunner().startAgent(config), bus, stop, nextPark, setAlive: (value) => { alive = value; }, order, echoes };
}

const userTexts = (session: AgentSession): string[] =>
  session.messages.flatMap((m) => (m.role === 'user' ? [typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')] : []));

/** A tool that finishes when the test releases it, whatever the run's abort signal says. */
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

describe("a run a user's pi extension opens in a member's session", () => {
  it('holds a message that arrives while pi settles that run until the run is over, then answers it in a run of its own', async () => {
    const held = await sessions.boot(['Done.', 'Extension reply.', 'Member reply.'].map((text) => fauxAssistantMessage(text)));
    const member = startMember(held.session);
    await within(member.nextPark(), 10_000, 'the first park');

    const settle = held.hold();
    held.sendFromExtension('from the extension');
    await within(settle.waiting, 10_000, "the extension run's agent_settled handler");
    // Nothing more is owed once this message is answered.
    member.setAlive(false);
    member.bus.send('peer', 'worker', 'please answer');
    await sleep(500);
    expect(member.order).toEqual(['agent_settled']);

    settle.release();
    const result = await within(member.run, 10_000, 'the member');
    expect(result.status).toBe('completed');
    expect(result.finalResponse).toBe('Member reply.');
    expect(userTexts(held.session)).toEqual(['do the task', 'from the extension', '[Message from peer]: please answer']);
    expect(member.order).toEqual(['agent_settled', 'agent_settled', 'agent_settled', 'forget']);
  }, 30_000);

  it('delivers a message held through that settle into the run pi opens from it for the extension, rather than racing it', async () => {
    const held = await sessions.boot(['Done.', 'Extension reply.', 'Follow-up reply.', 'Member reply.'].map((text) => fauxAssistantMessage(text)));
    const member = startMember(held.session);
    await within(member.nextPark(), 10_000, 'the first park');

    const settle = held.hold();
    held.sendFromNextSettle('extension follow-up');
    held.sendFromExtension('from the extension');
    await within(settle.waiting, 10_000, "the extension run's agent_settled handler");
    member.setAlive(false);
    member.bus.send('peer', 'worker', 'please answer');

    settle.release();
    const result = await within(member.run, 10_000, 'the member');
    // pi opens the extension's run first, and the held message joins it at its start (`inbox.onArrival` on `agent_start`).
    expect(userTexts(held.session)).toEqual(['do the task', 'from the extension', 'extension follow-up', '[Message from peer]: please answer']);
    expect(result.status).toBe('completed');
    expect(result.finalResponse).toBe('Follow-up reply.');
    expect(member.order).toEqual(['agent_settled', 'agent_settled', 'agent_settled', 'forget']);
  }, 30_000);

  it('waits for a run the extension opened before the opening task, and shows that task once pi commits it', async () => {
    const held = await sessions.boot(['Extension reply.', 'Done.'].map((text) => fauxAssistantMessage(text)));
    held.sendFromExtension('from the extension');
    const member = startMember(held.session);
    member.setAlive(false);

    const result = await within(member.run, 10_000, 'the member');
    expect(result).toMatchObject({ status: 'completed', finalResponse: 'Done.' });
    expect(userTexts(held.session)).toEqual(['from the extension', 'do the task']);
    expect(member.echoes).toEqual(['do the task']);
  }, 30_000);

  it("takes the opening task as a follow-up of a run the extension opens while pi's input handlers hold that task", async () => {
    const held = await sessions.boot(['Extension reply.', 'Done.'].map((text) => fauxAssistantMessage(text)), { input: true });
    const input = held.holdInput();
    const member = startMember(held.session);
    member.setAlive(false);
    await within(input.waiting, 10_000, 'the input handler holding the opening task');
    held.sendFromExtension('from the extension');
    await within(new Promise<void>((resolve) => held.session.subscribe((event) => { if (event.type === 'agent_start') resolve(); })), 10_000, "the extension's run");

    input.release();
    const result = await within(member.run, 10_000, 'the member');
    expect(result).toMatchObject({ status: 'completed', finalResponse: 'Done.' });
    expect(userTexts(held.session)).toEqual(['from the extension', 'do the task']);
    expect(member.echoes).toEqual(['do the task']);
  }, 30_000);

  it('a Stop while pi still prepares that run lets go of the session at once, and pi stops the run at its start', async () => {
    const held = await sessions.boot(['Done.', 'Unused.'].map((text) => fauxAssistantMessage(text)), { beforeAgentStart: true });
    const member = startMember(held.session);
    await within(member.nextPark(), 10_000, 'the first park');
    const ends: string[] = [];
    held.session.agent.subscribe((event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') ends.push(`${event.message.stopReason}: ${event.message.errorMessage ?? ''}`);
    });

    const start = held.holdBeforeAgentStart();
    held.sendFromExtension('from the extension');
    await within(start.waiting, 10_000, "the extension run's before_agent_start handler");
    member.stop.abort();
    expect((await within(member.run, 10_000, 'the stopped member')).status).toBe('cancelled');
    expect(member.order).toEqual(['agent_settled', 'forget']);

    start.release();
    // The run's request setup rejects under the aborted signal before any request (`model-runtime.js:456-460` in pi-coding-agent 1.3.0).
    await vi.waitFor(() => expect(ends).toEqual(['error: This operation was aborted']), { timeout: 10_000 });
  }, 30_000);

  it('a Stop waits for that run to end before the member lets go of its session', async () => {
    const tool = stubbornTool();
    const held = await sessions.boot(
      [fauxAssistantMessage('Done.'), fauxAssistantMessage(fauxToolCall('stubborn', {}, { id: 'c1' }), { stopReason: 'toolUse' }), fauxAssistantMessage('Unused.')],
      { customTools: [tool.definition] },
    );
    const member = startMember(held.session);
    await within(member.nextPark(), 10_000, 'the first park');

    held.sendFromExtension('from the extension');
    await within(tool.started, 10_000, "the extension run's tool call");
    member.stop.abort();
    await sleep(500);
    expect(member.order).toEqual(['agent_settled']);

    tool.release();
    const result = await within(member.run, 10_000, 'the stopped member');
    expect(result.status).toBe('cancelled');
    expect(member.order).toEqual(['agent_settled', 'agent_settled', 'forget']);
  }, 30_000);
});
