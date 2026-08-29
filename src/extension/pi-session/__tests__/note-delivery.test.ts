import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { PermissionHandler } from '../../permission-handler';
import type { PiCodingAgentModule } from '../pi-loader';
import type { SessionOptions } from '../../session-types';
import { PiSession } from '../pi-session';
import type { CustomToolDeps } from '../tools';
import { buildCustomTools } from '../tools';
import { log } from '../../logger';

// The only visible trace a team note left nothing behind, so it is asserted rather than assumed.
vi.mock('../../logger', () => ({ log: vi.fn() }));

vi.mock('../tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools')>()),
  buildCustomTools: vi.fn(() => []),
}));

const NOTE = 'wrong loop, use seq 1 5';

interface Harness {
  session: PiSession;
  emitted: ExtensionToWebviewMessage[];
  sendUserMessage: ReturnType<typeof vi.fn>;
  steer: ReturnType<typeof vi.fn>;
  deliverUserNote: ReturnType<typeof vi.fn>;
  busSend: ReturnType<typeof vi.fn>;
  piSession: { sendUserMessage: ReturnType<typeof vi.fn> };
}

/** Only the collaborators a note can reach; anything a note must not touch is here so it can be asserted silent. */
function harness(): Harness {
  const emitted: ExtensionToWebviewMessage[] = [];
  const sendUserMessage = vi.fn(async () => undefined);
  const steer = vi.fn(async () => 'steered');
  const deliverUserNote = vi.fn(() => true);
  const busSend = vi.fn();

  const options = {
    cwd: '/cwd',
    permissionHandler: { getPermissionMode: () => 'default' } as unknown as PermissionHandler,
    onMessage: (message: ExtensionToWebviewMessage) => emitted.push(message),
    resolveThinking: () => ({ thinkingDisabled: true, effort: null, maxThinkingTokens: null }),
  } as unknown as SessionOptions;

  const session = new PiSession(options);
  const internals = session as unknown as {
    runtime: unknown;
    subagentManager: unknown;
    buildNestedMcp: unknown;
    agentRegistry: unknown;
  };
  const piSession = { sendUserMessage, prompt: vi.fn(async () => undefined), steer: vi.fn(async () => undefined) };
  internals.runtime = { session: piSession };
  internals.subagentManager = { steer, abortAll: vi.fn(), getRecord: () => ({ type: 'Explore', description: 'look' }) };
  // The note path must not depend on the MCP snapshot, so the spawn's other half is stubbed out.
  internals.buildNestedMcp = () => ({ tools: [], names: [] });
  internals.agentRegistry = {};

  return { session, emitted, sendUserMessage, steer, deliverUserNote, busSend, piSession };
}

type Deliveries = {
  main: () => (text: string) => void;
  subagent: (agentId: string) => (text: string) => void;
  team: (ctx: unknown) => (text: string) => void;
};

/**
 * The main delivery is bound to a concrete session, not to `this.runtime`, so the harness hands it the
 * one it wants the note to reach; a delivery that read `this.runtime` would ignore this argument.
 */
function deliveries(session: PiSession, target: () => unknown): Deliveries {
  const internals = session as unknown as {
    noteDeliveryForMain: (s: () => unknown) => (text: string) => void;
    noteDeliveryForSubagent: (agentId: string) => (text: string) => void;
    noteDeliveryForTeamAgent: (ctx: unknown) => (text: string) => void;
  };
  return {
    main: () => internals.noteDeliveryForMain(target),
    subagent: (agentId) => internals.noteDeliveryForSubagent(agentId),
    team: (ctx) => internals.noteDeliveryForTeamAgent(ctx),
  };
}

function teamContext(agentName: string, deliverUserNote: ReturnType<typeof vi.fn>, busSend: ReturnType<typeof vi.fn>): unknown {
  return { agentName, browserScopeId: `scope-${agentName}`, deliverUserNote, messageBus: { send: busSend } };
}

function fakePi(): PiCodingAgentModule {
  return {
    defineTool: (tool: unknown) => tool,
    createEditToolDefinition: vi.fn(() => ({ execute: vi.fn() })),
    createBashToolDefinition: vi.fn(() => ({ name: 'bash', label: 'Bash', description: '', parameters: {}, execute: vi.fn() })),
  } as unknown as PiCodingAgentModule;
}

/** The webview renders one turn per user-visible echo, so counting them is how a double render is caught. */
function echoes(emitted: readonly ExtensionToWebviewMessage[]): string[] {
  return emitted
    .filter((m) => m.type === 'userMessage' || m.type === 'subagentSteered' || m.type === 'teamAgentUserMessage')
    .map((m) => m.type);
}

function noteDepsOf(call: number): CustomToolDeps {
  return vi.mocked(buildCustomTools).mock.calls[call]![0];
}

beforeEach(() => {
  vi.mocked(buildCustomTools).mockClear();
});

describe('cancel note delivery targets the agent that ran the command', () => {
  it('sends the panel session its own note as a queued user message', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledTimes(1));

    expect(h.sendUserMessage).toHaveBeenCalledWith(NOTE, { deliverAs: 'followUp', expandPromptTemplates: false });
    expect(h.steer).not.toHaveBeenCalled();
    expect(h.busSend).not.toHaveBeenCalled();
  });

  it('leaves a note starting with a slash as literal text', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).main()('/compact now');
    await vi.waitFor(() => expect(h.sendUserMessage).toHaveBeenCalledTimes(1));

    const [text, opts] = h.sendUserMessage.mock.calls[0]!;
    expect(text).toBe('/compact now');
    expect(opts).toMatchObject({ expandPromptTemplates: false });
  });

  it('reaches the session the tools were built against, not the one that replaced it', async () => {
    const h = harness();
    const oldSession = { sendUserMessage: vi.fn(async () => undefined) };
    const deliver = deliveries(h.session, () => oldSession).main();

    // A reset swaps the panel's live session; the leftover call's delivery must not follow it.
    (h.session as unknown as { runtime: unknown }).runtime = { session: h.piSession };
    deliver(NOTE);
    await vi.waitFor(() => expect(oldSession.sendUserMessage).toHaveBeenCalledTimes(1));

    expect(h.sendUserMessage).not.toHaveBeenCalled();
  });

  it('sends a subagent its own note through the steer channel, and the panel session nothing', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).subagent('agent-7')(NOTE);
    await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1));

    expect(h.steer).toHaveBeenCalledWith('agent-7', NOTE);
    expect(h.sendUserMessage).not.toHaveBeenCalled();
    expect(h.busSend).not.toHaveBeenCalled();
  });

  it('sends a team agent its own note through the runner delivery, never through the bus', () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).team(teamContext('ext-cancel', h.deliverUserNote, h.busSend))(NOTE);

    expect(h.deliverUserNote).toHaveBeenCalledTimes(1);
    expect(h.deliverUserNote).toHaveBeenCalledWith(NOTE);
    // The bus dropped the note two ways, the unsubscribe race and the sender self-filter, so the seam
    // must not fall back to it.
    expect(h.busSend).not.toHaveBeenCalled();
    expect(h.sendUserMessage).not.toHaveBeenCalled();
    expect(h.steer).not.toHaveBeenCalled();
  });

  it('keeps two team agents apart', () => {
    const h = harness();
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const d = deliveries(h.session, () => h.piSession);
    d.team(teamContext('webview', first, h.busSend))('first');
    d.team(teamContext('ext-process', second, h.busSend))('second');

    expect(first.mock.calls).toEqual([['first']]);
    expect(second.mock.calls).toEqual([['second']]);
  });
});

describe('the note is echoed once per context', () => {
  it('echoes the panel session note as an injected user turn', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(echoes(h.emitted)).toEqual(['userMessage']));

    const echo = h.emitted.find((m) => m.type === 'userMessage');
    expect(echo).toMatchObject({ content: NOTE, isInjected: true });
  });

  it('does not echo a panel note pi refused, so the user is never told the agent was told', async () => {
    const h = harness();
    const rejecting = { sendUserMessage: vi.fn(async () => { throw new Error('session is being replaced'); }) };
    deliveries(h.session, () => rejecting).main()(NOTE);
    await vi.waitFor(() => expect(rejecting.sendUserMessage).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(echoes(h.emitted)).toEqual([]);
  });

  it('does not echo a panel note whose session no longer exists', async () => {
    const h = harness();
    deliveries(h.session, () => undefined).main()(NOTE);
    await Promise.resolve();
    await Promise.resolve();

    expect(echoes(h.emitted)).toEqual([]);
    expect(h.sendUserMessage).not.toHaveBeenCalled();
  });

  it('echoes a subagent note through the steer chip and adds no panel turn', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).subagent('agent-7')(NOTE);
    await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1));

    expect(echoes(h.emitted)).toEqual(['subagentSteered']);
    expect(h.emitted.find((m) => m.type === 'subagentSteered')).toMatchObject({ agentId: 'agent-7', message: NOTE });
  });

  it('leaves a team agent note to the runner and adds no panel turn', () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).team(teamContext('ext-cancel', h.deliverUserNote, h.busSend))(NOTE);

    // The runner echoes it itself, so a second echo here would render the note twice.
    expect(echoes(h.emitted)).toEqual([]);
    expect(h.deliverUserNote).toHaveBeenCalledTimes(1);
  });

  it('adds no echo of its own when the team runner reports nothing consumed the note', () => {
    const h = harness();
    const refused = vi.fn(() => false);
    deliveries(h.session, () => h.piSession).team(teamContext('ext-cancel', refused, h.busSend))(NOTE);

    expect(echoes(h.emitted)).toEqual([]);
    expect(h.busSend).not.toHaveBeenCalled();
    // Zero echo plus zero log is the silent drop the finding is about; the log names the agent.
    expect(vi.mocked(log).mock.calls.some((call) => String(call[0]).includes('reached no live run') && call.includes('ext-cancel'))).toBe(true);
  });
});

describe('a delivered note is not mistaken for a queued chip batch', () => {
  it('leaves the chips pending when the delivery pi reports is the note', async () => {
    const h = harness();
    (h.piSession as unknown as { isStreaming: boolean }).isStreaming = true;
    (h.piSession as unknown as { clearQueue: () => unknown }).clearQueue = () => ({ followUp: [] });
    h.session.queueInput('rerun the failing spec', 'q1');
    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(echoes(h.emitted)).toContain('userMessage'));

    // pi raises the same user message_end for the note that it raises for a delivered batch.
    expect(h.session.onQueuedInputsDelivered(NOTE)).toBe(false);
    expect(h.emitted.some((m) => m.type === 'queueBatchProcessed')).toBe(false);

    // The batch's own delivery still collapses the chips and still owes a mid-stream marker.
    expect(h.session.onQueuedInputsDelivered('rerun the failing spec')).toBe(true);
    expect(h.emitted.find((m) => m.type === 'queueBatchProcessed')).toMatchObject({ messageIds: ['q1'] });
  });

  it('consumes the note only once, so a later batch with the same text still collapses', async () => {
    const h = harness();
    (h.piSession as unknown as { isStreaming: boolean }).isStreaming = true;
    (h.piSession as unknown as { clearQueue: () => unknown }).clearQueue = () => ({ followUp: [] });
    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(echoes(h.emitted)).toContain('userMessage'));
    expect(h.session.onQueuedInputsDelivered(NOTE)).toBe(false);

    h.session.queueInput(NOTE, 'q1');
    expect(h.session.onQueuedInputsDelivered(NOTE)).toBe(true);
  });
});

/** A stand-in for pi's own follow-up queue, so a test can see what survives a clear and what is re-queued. */
function queueingSession(): {
  sendUserMessage: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  clearQueue: ReturnType<typeof vi.fn>;
  isStreaming: boolean;
  pending: string[];
} {
  const pending: string[] = [];
  return {
    pending,
    isStreaming: true,
    sendUserMessage: vi.fn(async (text: string) => { pending.push(text); }),
    followUp: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    clearQueue: vi.fn(() => ({ steering: [], followUp: pending.splice(0) })),
  };
}

describe('a note that pi accepted is not silently discarded later', () => {
  it('corrects the echo when the budget stop drops a note the agent never read', async () => {
    const h = harness();
    const target = queueingSession();
    (h.session as unknown as { runtime: unknown }).runtime = { session: target };
    deliveries(h.session, () => target).main()(NOTE);
    await vi.waitFor(() => expect(echoes(h.emitted)).toEqual(['userMessage']));
    expect(target.pending).toEqual([NOTE]);

    const internals = h.session as unknown as { processingFlag: boolean; stopForBudget: () => void };
    internals.processingFlag = true;
    internals.stopForBudget();

    // The echo said the agent was told; the clear means it never will be, so the transcript is corrected.
    const notices = h.emitted.filter((m) => m.type === 'notification').map((m) => m.message);
    expect(notices.some((t) => t.includes('discarded your cancel note'))).toBe(true);
  });

  it('corrects nothing for a follow-up the panel never echoed', () => {
    const h = harness();
    const target = queueingSession();
    target.pending.push('a follow-up from somewhere else');
    (h.session as unknown as { runtime: unknown }).runtime = { session: target };

    const internals = h.session as unknown as { processingFlag: boolean; stopForBudget: () => void };
    internals.processingFlag = true;
    internals.stopForBudget();

    const notices = h.emitted.filter((m) => m.type === 'notification').map((m) => m.message);
    expect(notices.some((t) => t.includes('discarded your cancel note'))).toBe(false);
    expect(notices.some((t) => t.includes('Budget limit reached'))).toBe(true);
  });

  it('re-queues a preserved follow-up as literal text when a chip re-steers the buffer', async () => {
    const h = harness();
    const target = queueingSession();
    (h.session as unknown as { runtime: unknown }).runtime = { session: target };
    deliveries(h.session, () => target).main()('/compact and use seq 1 5');
    await vi.waitFor(() => expect(target.pending).toHaveLength(1));
    target.sendUserMessage.mockClear();

    // The re-steer takes pi's whole queue and must put the follow-ups back exactly as they went in.
    h.session.queueInput('rerun the failing spec', 'q1');

    expect(target.sendUserMessage).toHaveBeenCalledWith('/compact and use seq 1 5', { deliverAs: 'followUp', expandPromptTemplates: false });
    // `followUp()` runs the extension-command check and the template expansion, which is the guard the
    // note was queued with `expandPromptTemplates: false` to avoid.
    expect(target.followUp).not.toHaveBeenCalled();
  });
});

describe('each build context supplies its own delivery', () => {
  it('gives a spawned subagent a delivery bound to its own agent id', async () => {
    const h = harness();
    const engine = (h.session as unknown as { buildSubagentEngine: (pi: PiCodingAgentModule) => { buildAgentToolset: (input: unknown) => unknown } })
      .buildSubagentEngine(fakePi());
    engine.buildAgentToolset({ agentId: 'agent-7', agentName: 'Explore', mcpDisallowed: [] });

    expect(buildCustomTools).toHaveBeenCalledTimes(1);
    noteDepsOf(0).deliverUserNote(NOTE);
    await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1));

    expect(h.steer).toHaveBeenCalledWith('agent-7', NOTE);
    expect(h.sendUserMessage).not.toHaveBeenCalled();
  });

  it('gives a team agent a delivery bound to its own runner', () => {
    const h = harness();
    const build = (h.session as unknown as { buildTeamAgentCustomTools: (pi: PiCodingAgentModule, ctx: unknown) => unknown }).buildTeamAgentCustomTools;
    build.call(h.session, fakePi(), teamContext('webview', h.deliverUserNote, h.busSend));

    expect(buildCustomTools).toHaveBeenCalledTimes(1);
    noteDepsOf(0).deliverUserNote(NOTE);

    expect(h.deliverUserNote).toHaveBeenCalledWith(NOTE);
    expect(h.busSend).not.toHaveBeenCalled();
    expect(h.sendUserMessage).not.toHaveBeenCalled();
    expect(h.steer).not.toHaveBeenCalled();
  });
});
