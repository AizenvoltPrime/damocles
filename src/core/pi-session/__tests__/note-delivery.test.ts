import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { PermissionHandler } from '../../permission-handler';
import type { PiCodingAgentModule } from '../pi-loader';
import type { SessionOptions } from '../../session-types';
import { PiSession } from '../pi-session';
import type { CustomToolDeps } from '../tools';
import { buildCustomTools } from '../tools';
import { log } from '../../logger';
import { createFakePlatform } from '../../../__mocks__/fake-platform';

// The only visible trace a team note left nothing behind, so it is asserted rather than assumed.
vi.mock('../../logger', () => ({ log: vi.fn() }));

vi.mock('../tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools')>()),
  buildCustomTools: vi.fn(() => []),
}));

const NOTE = 'wrong loop, use seq 1 5';

type PromptOptions = { streamingBehavior?: 'steer' | 'followUp'; preflightResult?: (accepted: boolean) => void };

/**
 * pi's own queue as the note path reaches it: while streaming, `prompt()` queues by `streamingBehavior`
 * and reports acceptance through `preflightResult`; `clearQueue()` hands back and empties both queues.
 */
function piQueue() {
  const steering: string[] = [];
  const followUp: string[] = [];
  const session = {
    isStreaming: true,
    steers: steering,
    followUps: followUp,
    // The panel echo stamps the prompt index, which is read from the branch.
    sessionManager: { getBranch: () => [] },
    prompt: vi.fn(async (text: string, opts?: PromptOptions) => {
      if (session.isStreaming) (opts?.streamingBehavior === 'followUp' ? followUp : steering).push(text);
      opts?.preflightResult?.(true);
    }),
    sendUserMessage: vi.fn(async (text: string, opts?: { deliverAs?: 'steer' | 'followUp' }) => {
      if (session.isStreaming) (opts?.deliverAs === 'followUp' ? followUp : steering).push(text);
    }),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    clearQueue: vi.fn(() => ({ steering: steering.splice(0), followUp: followUp.splice(0) })),
    waitForIdle: vi.fn(async () => undefined),
    extensionRunner: { hasHandlers: () => false },
  };
  return session;
}
type PiQueue = ReturnType<typeof piQueue>;

interface Harness {
  session: PiSession;
  emitted: ExtensionToWebviewMessage[];
  steer: ReturnType<typeof vi.fn>;
  deliverUserNote: ReturnType<typeof vi.fn>;
  busSend: ReturnType<typeof vi.fn>;
  piSession: PiQueue;
}

/** Only the collaborators a note can reach; anything a note must not touch is here so it can be asserted silent. */
function harness(): Harness {
  const emitted: ExtensionToWebviewMessage[] = [];
  const steer = vi.fn(async () => 'steered');
  const deliverUserNote = vi.fn(() => true);
  const busSend = vi.fn();

  const options = {
    cwd: '/cwd',
    platform: createFakePlatform(),
    permissionHandler: { getPermissionMode: () => 'default', setPendingPromptsListener: () => {}, hasPendingPrompts: () => false } as unknown as PermissionHandler,
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
  const piSession = piQueue();
  internals.runtime = { session: piSession };
  internals.subagentManager = { steer, abortAll: vi.fn(), getRecord: () => ({ type: 'Explore', description: 'look' }) };
  // The note path must not depend on the MCP snapshot, so the spawn's other half is stubbed out.
  internals.buildNestedMcp = () => ({ tools: [], names: [] });
  internals.agentRegistry = {};

  return { session, emitted, steer, deliverUserNote, busSend, piSession };
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
  it('steers the panel session its own note, so it lands at the next tool boundary of the running run', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(h.piSession.prompt).toHaveBeenCalledTimes(1));

    expect(h.piSession.prompt).toHaveBeenCalledWith(NOTE, {
      expandPromptTemplates: false,
      streamingBehavior: 'steer',
      source: 'extension',
      preflightResult: expect.any(Function),
    });
    expect(h.piSession.steers).toEqual([NOTE]);
    expect(h.piSession.followUps).toEqual([]);
    expect(h.steer).not.toHaveBeenCalled();
    expect(h.busSend).not.toHaveBeenCalled();
  });

  it('queues the note with template expansion off, because a leading slash in it must not dispatch as a slash command', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).main()('/help with the failing spec');
    await vi.waitFor(() => expect(h.piSession.prompt).toHaveBeenCalledTimes(1));

    const [text, opts] = h.piSession.prompt.mock.calls[0]!;
    expect(text).toBe('/help with the failing spec');
    expect(opts).toMatchObject({ expandPromptTemplates: false });
    // `steer()` runs the extension-command check and template expansion whatever the caller asks.
    expect(h.piSession.steer).not.toHaveBeenCalled();
  });

  it('reaches the session the tools were built against, not the one that replaced it', async () => {
    const h = harness();
    const oldSession = piQueue();
    const deliver = deliveries(h.session, () => oldSession).main();

    // A reset swaps the panel's live session; the leftover call's delivery must not follow it.
    (h.session as unknown as { runtime: unknown }).runtime = { session: h.piSession };
    deliver(NOTE);
    await vi.waitFor(() => expect(oldSession.prompt).toHaveBeenCalledTimes(1));

    expect(h.piSession.prompt).not.toHaveBeenCalled();
  });

  it('sends a subagent its own note through the steer channel, and the panel session nothing', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).subagent('agent-7')(NOTE);
    await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1));

    expect(h.steer).toHaveBeenCalledWith('agent-7', NOTE, undefined);
    expect(h.piSession.prompt).not.toHaveBeenCalled();
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
    expect(h.piSession.prompt).not.toHaveBeenCalled();
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
    const rejecting = { ...piQueue(), prompt: vi.fn(async () => { throw new Error('session is being replaced'); }) };
    deliveries(h.session, () => rejecting).main()(NOTE);
    await vi.waitFor(() => expect(rejecting.prompt).toHaveBeenCalledTimes(1));
    await Promise.resolve();

    expect(echoes(h.emitted)).toEqual([]);
    // Nothing of it is left listed, so a later chip batch with the same text still collapses.
    expect(h.session.onQueuedInputsDelivered(NOTE)).toBe(false);
  });

  it('does not echo a panel note whose session no longer exists', async () => {
    const h = harness();
    deliveries(h.session, () => undefined).main()(NOTE);
    await Promise.resolve();
    await Promise.resolve();

    expect(echoes(h.emitted)).toEqual([]);
    expect(h.piSession.prompt).not.toHaveBeenCalled();
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
    h.session.queueInput('rerun the failing spec', 'q1');
    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(echoes(h.emitted)).toContain('userMessage'));

    // pi raises the same user message_end for the note that it raises for a delivered batch. The note
    // owes a mid-stream marker of its own, so it consumes no prompt index, but leaves the chips pending.
    expect(h.session.onQueuedInputsDelivered(NOTE)).toBe(true);
    expect(h.emitted.some((m) => m.type === 'queueBatchProcessed')).toBe(false);

    // The batch's own delivery still collapses the chips and still owes a mid-stream marker.
    expect(h.session.onQueuedInputsDelivered('rerun the failing spec')).toBe(true);
    expect(h.emitted.find((m) => m.type === 'queueBatchProcessed')).toMatchObject({ messageIds: ['q1'] });
  });

  it('consumes the note only once, so a later batch with the same text still collapses', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(echoes(h.emitted)).toContain('userMessage'));
    expect(h.session.onQueuedInputsDelivered(NOTE)).toBe(true);
    expect(h.emitted.some((m) => m.type === 'queueBatchProcessed')).toBe(false);

    h.session.queueInput(NOTE, 'q1');
    expect(h.session.onQueuedInputsDelivered(NOTE)).toBe(true);
    expect(h.emitted.find((m) => m.type === 'queueBatchProcessed')).toMatchObject({ messageIds: ['q1'] });
  });
});

describe('a note that pi accepted is not silently discarded later', () => {
  it('corrects the echo when the budget stop drops a note the agent never read', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(echoes(h.emitted)).toEqual(['userMessage']));
    expect(h.piSession.steers).toEqual([NOTE]);

    const internals = h.session as unknown as { processingFlag: boolean; stopForBudget: () => void };
    internals.processingFlag = true;
    internals.stopForBudget();

    // The echo said the agent was told; the clear means it never will be, so the transcript is corrected.
    const notices = h.emitted.filter((m) => m.type === 'notification').map((m) => m.message);
    expect(notices.some((t) => t.includes('discarded your cancel note'))).toBe(true);
  });

  it('corrects nothing for a queued message the panel never echoed', () => {
    const h = harness();
    h.piSession.followUps.push('a follow-up from somewhere else');
    h.piSession.steers.push('a steer from somewhere else');

    const internals = h.session as unknown as { processingFlag: boolean; stopForBudget: () => void };
    internals.processingFlag = true;
    internals.stopForBudget();

    const notices = h.emitted.filter((m) => m.type === 'notification').map((m) => m.message);
    expect(notices.some((t) => t.includes('discarded your cancel note'))).toBe(false);
    expect(notices.some((t) => t.includes('Budget limit reached'))).toBe(true);
  });

  it('puts the note back ahead of the batch when a message queued after it re-steers pi\'s queue', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).main()('/compact and use seq 1 5');
    await vi.waitFor(() => expect(h.piSession.steers).toEqual(['/compact and use seq 1 5']));

    // The re-steer clears pi's whole queue, which held the note.
    h.session.queueInput('rerun the failing spec', 'q1');
    await vi.waitFor(() => expect(h.piSession.steers).toEqual(['/compact and use seq 1 5', 'rerun the failing spec']));

    // Put back as literal text: `steer()` would run the command check and template expansion on it.
    expect(h.piSession.sendUserMessage).toHaveBeenCalledWith('/compact and use seq 1 5', { deliverAs: 'steer', expandPromptTemplates: false });
    expect(h.piSession.steer).not.toHaveBeenCalled();
  });

  it('moves a note ahead of a batch queued before it, so the batch waits one boundary', async () => {
    const h = harness();
    h.session.queueInput('rerun the failing spec', 'q1');
    expect(h.piSession.steers).toEqual(['rerun the failing spec']);

    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(h.piSession.steers).toEqual([NOTE, 'rerun the failing spec']));
  });

  it('keeps a batch whose text equals a note a batch, putting back only the note', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(h.piSession.steers).toEqual([NOTE]));

    h.session.queueInput(NOTE, 'q1');
    await vi.waitFor(() => expect(h.piSession.steers).toEqual([NOTE, NOTE]));
    h.session.queueInput('and the lint', 'q2');
    await vi.waitFor(() => expect(h.piSession.steers).toEqual([NOTE, `${NOTE}\n\nand the lint`]));
  });

  it('re-queues a preserved follow-up as literal text when a chip re-steers the buffer', () => {
    const h = harness();
    h.piSession.followUps.push('/compact and use seq 1 5');

    h.session.queueInput('rerun the failing spec', 'q1');

    expect(h.piSession.sendUserMessage).toHaveBeenCalledWith('/compact and use seq 1 5', { deliverAs: 'followUp', expandPromptTemplates: false });
    expect(h.piSession.followUps).toEqual(['/compact and use seq 1 5']);
    // `followUp()` runs the extension-command check and the template expansion.
    expect(h.piSession.followUp).not.toHaveBeenCalled();
  });
});

describe('a note for a run that was stopped', () => {
  const stopped = (h: Harness): void => {
    (h.session as unknown as { abortPromise: Promise<void> | null }).abortPromise = new Promise(() => undefined);
  };
  const noticeTexts = (h: Harness): string[] => h.emitted.flatMap((m) => (m.type === 'notification' ? [m.message] : []));

  it('is never handed to pi while an ESC winds the run down, and the user is told it was not sent', () => {
    const h = harness();
    stopped(h);
    deliveries(h.session, () => h.piSession).main()(NOTE);

    expect(h.piSession.prompt).not.toHaveBeenCalled();
    expect(echoes(h.emitted)).toEqual([]);
    expect(noticeTexts(h)).toEqual(['Your cancel note was not sent: the turn was stopped.']);
  });

  it('is taken back out when the ESC lands while pi runs its input handlers', async () => {
    const h = harness();
    let proceed!: () => void;
    const inputHandlers = new Promise<void>((resolve) => { proceed = resolve; });
    const queue = h.piSession.prompt.getMockImplementation()!;
    h.piSession.prompt.mockImplementation(async (text: string, opts?: PromptOptions) => {
      await inputHandlers;
      await queue(text, opts);
    });
    deliveries(h.session, () => h.piSession).main()(NOTE);
    stopped(h);
    proceed();
    await vi.waitFor(() => expect(noticeTexts(h)).toHaveLength(1));

    expect(h.piSession.steers).toEqual([]);
    expect(echoes(h.emitted)).toEqual([]);
    // Nothing of it is left listed, so a later chip batch with the same text still collapses.
    h.session.queueInput(NOTE, 'q1');
    expect(h.session.onQueuedInputsDelivered(NOTE)).toBe(true);
    expect(h.emitted.find((m) => m.type === 'queueBatchProcessed')).toMatchObject({ messageIds: ['q1'] });
  });

  it('is corrected on ESC once echoed, and ESC hands the chips back to the input', async () => {
    const h = harness();
    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(echoes(h.emitted)).toEqual(['userMessage']));
    h.session.queueInput('rerun the failing spec', 'q1');
    await vi.waitFor(() => expect(h.piSession.steers).toEqual([NOTE, 'rerun the failing spec']));
    (h.piSession as unknown as { abort: () => Promise<void> }).abort = vi.fn(async () => undefined);

    await h.session.interrupt();

    expect(h.piSession.steers).toEqual([]);
    expect(h.emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q1', returnToInput: true });
    expect(noticeTexts(h)).toEqual(['Stopping the turn discarded your cancel note before the agent read it.']);
  });
});

describe('a batch that grew while its re-steer was in flight', () => {
  it('collapses only the chips pi delivered and re-steers the rest', async () => {
    const h = harness();
    h.session.queueInput('first', 'q1');
    h.session.queueInput('second', 'q2');
    expect(h.piSession.steers).toEqual(['first']);

    // pi delivers the batch it holds before the pending pass re-steers the grown buffer.
    expect(h.session.onQueuedInputsDelivered('first')).toBe(true);
    expect(h.emitted.find((m) => m.type === 'queueBatchProcessed')).toMatchObject({ messageIds: ['q1'], combinedContent: 'first' });
    h.piSession.steers.splice(0);
    await vi.waitFor(() => expect(h.piSession.steers).toEqual(['second']));
  });
});

describe('a note accepted with no run in progress', () => {
  it('opens a turn for the run it starts and echoes it, listed so its delivery is owed a mid-stream marker', async () => {
    const h = harness();
    h.piSession.isStreaming = false;
    deliveries(h.session, () => h.piSession).main()(NOTE);
    await vi.waitFor(() => expect(echoes(h.emitted)).toEqual(['userMessage']));

    expect(h.emitted).toContainEqual(expect.objectContaining({ type: 'processing', isProcessing: true }));
    // Its re-steer is skipped: nothing is queued in a run that has not started.
    expect(h.piSession.clearQueue).not.toHaveBeenCalled();
    expect(h.session.onQueuedInputsDelivered(NOTE)).toBe(true);
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

    expect(h.steer).toHaveBeenCalledWith('agent-7', NOTE, undefined);
    expect(h.piSession.prompt).not.toHaveBeenCalled();
  });

  it('gives a team agent a delivery bound to its own runner', () => {
    const h = harness();
    const build = (h.session as unknown as { buildTeamAgentCustomTools: (pi: PiCodingAgentModule, ctx: unknown) => unknown }).buildTeamAgentCustomTools;
    build.call(h.session, fakePi(), teamContext('webview', h.deliverUserNote, h.busSend));

    expect(buildCustomTools).toHaveBeenCalledTimes(1);
    noteDepsOf(0).deliverUserNote(NOTE);

    expect(h.deliverUserNote).toHaveBeenCalledWith(NOTE);
    expect(h.busSend).not.toHaveBeenCalled();
    expect(h.piSession.prompt).not.toHaveBeenCalled();
    expect(h.steer).not.toHaveBeenCalled();
  });
});
