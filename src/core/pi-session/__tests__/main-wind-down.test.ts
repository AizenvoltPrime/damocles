import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession, PromptOptions } from '@earendil-works/pi-coding-agent';
import { STEER_INSTRUCTION_PREFIX } from '../../../shared/steer';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { AgentWindDown } from '../../../shared/types/wind-down';
import type { SendOutcome } from '../../chat-session';
import type { PiSession } from '../pi-session';
import { DAMOCLES_MID_STREAM_ENTRY, DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY } from '../session-store/constants';
import { nextPromptIndex } from '../session-store/prompt-index';
import { WIND_DOWN_NOTICE_MS } from '../wind-down-notice';
import type { RunLifecycle } from '../run-lifecycle';
import { HELD_DRAFT_ENTRY, heldSettleSessions, type HeldSettleSession } from './held-settle-fixture';
import { panelSession } from './real-pi-fixtures';

/**
 * The main chat's Stop whose run a handler pi awaits holds, on a real pi session built as the main chat's (no path-loaded
 * extension runs there, so the hold is an inline handler's, as Damocles' configured Stop hook dispatch is) and driven
 * through `PiSession`'s own send and Stop paths. The turn shows stopped at once while the next send waits, so the chat
 * says what pi still finishes once the wait outlasts `WIND_DOWN_NOTICE_MS`, and a reloaded webview hears it again.
 */

const sessions = heldSettleSessions();
const dirs: string[] = [];
afterEach(() => {
  sessions.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);
}

interface Internals {
  runtime: { session: AgentSession };
  desiredModel: unknown;
  startPromise: Promise<void> | null;
  titleGenerationAttempted: boolean;
  budgetLimitForEnforcement: () => number | null;
  subscribeEvents: (session: AgentSession) => void;
}

/** A panel bound to `held`'s session as `bindSession` subscribes one, ready to send without `start()` or a title sub-call. */
function boundPanel(held: HeldSettleSession, emitted: ExtensionToWebviewMessage[]): PiSession {
  const panel = panelSession(emitted);
  const inner = panel as unknown as Internals;
  inner.runtime = { session: held.session };
  // The chat's model, which `start()` commits with the session it builds on it; a send without one is refused.
  inner.desiredModel = held.session.model;
  inner.subscribeEvents(held.session);
  inner.startPromise = Promise.resolve();
  inner.titleGenerationAttempted = true;
  inner.budgetLimitForEnforcement = () => null;
  return panel;
}

/** A session on a real file, so a send that waited is checked against the conversation it was written for. */
function onFile(): { kind: 'file'; dir: string; id: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-main-wind-down-')));
  dirs.push(dir);
  return { kind: 'file', dir, id: 'main-chat' };
}

/** The wind-down each `sessionStateChanged` carried, null where it carried none. */
const windDowns = (emitted: readonly ExtensionToWebviewMessage[]): Array<AgentWindDown | null> =>
  emitted.flatMap((m) => (m.type === 'sessionStateChanged' ? [m.windDown ?? null] : []));

/** The published wind-downs as the webview applies them: each change, with the repeats a republish sends folded. */
const shownWindDowns = (emitted: readonly ExtensionToWebviewMessage[]): Array<AgentWindDown | null> =>
  windDowns(emitted).filter((windDown, i, all) => i === 0 ? windDown !== null : JSON.stringify(windDown) !== JSON.stringify(all[i - 1]));

const userTextsInFile = (session: AgentSession): string[] =>
  fs.readFileSync(session.sessionManager.getSessionFile()!, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { type: string; message?: { role: string; content: Array<{ type: string; text?: string }> } })
    .flatMap((entry) => (entry.type === 'message' && entry.message?.role === 'user' ? [entry.message.content.map((p) => p.text ?? '').join('')] : []));

const userMessageSent = (emitted: readonly ExtensionToWebviewMessage[], correlationId: string): boolean =>
  emitted.some((m) => m.type === 'userMessage' && m.correlationId === correlationId);

/** The `data` of each custom entry of `customType` in the session file, in order. */
const customEntriesInFile = (session: AgentSession, customType: string): unknown[] =>
  fs.readFileSync(session.sessionManager.getSessionFile()!, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { type: string; customType?: string; data?: unknown })
    .flatMap((entry) => (entry.type === 'custom' && entry.customType === customType ? [entry.data] : []));

/** The id of the user entry whose text is `text`, from the session file. */
const userEntryIdInFile = (session: AgentSession, text: string): string | undefined =>
  fs.readFileSync(session.sessionManager.getSessionFile()!, 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line) as { type: string; id: string; message?: { role: string; content: Array<{ text?: string }> } })
    .find((entry) => entry.type === 'message' && entry.message?.role === 'user' && entry.message.content.map((p) => p.text ?? '').join('') === text)?.id;

/** Every disposition pi reports to a `preflightResult`, each once, as `<prompt text>: <disposition>`. */
function dispositionsOf(session: AgentSession): string[] {
  const seen: string[] = [];
  const observed = new WeakSet<NonNullable<PromptOptions['preflightResult']>>();
  const prompt = session.prompt.bind(session);
  // pi's deferred prompt calls `this.prompt` again with the same options (agent-session.js:1633 in pi 1.4.0).
  session.prompt = (text: string, options?: PromptOptions) => {
    const original = options?.preflightResult;
    if (!original || observed.has(original)) return prompt(text, options);
    const preflightResult: NonNullable<PromptOptions['preflightResult']> = (disposition) => {
      seen.push(`${text}: ${disposition}`);
      original(disposition);
    };
    observed.add(preflightResult);
    return prompt(text, { ...options, preflightResult });
  };
  return seen;
}

/** A cancel note with no run in progress opens a run of its own (`noteDeliveryForMain`). */
function deliverNote(panel: PiSession, session: AgentSession, text: string): void {
  (panel as unknown as { noteDeliveryForMain: (s: () => AgentSession) => (text: string) => void }).noteDeliveryForMain(() => session)(text);
}

describe("the main chat's Stop while a handler pi awaits holds its run's wind-down", () => {
  it('says the next send waits for the agent_settled handlers once the wait outlasts the delay, and clears it as the send goes to its conversation', async () => {
    const held = await sessions.boot([fauxAssistantMessage('First.'), fauxAssistantMessage('Second.')], { store: onFile(), mainChat: true });
    const settle = held.hold();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = boundPanel(held, emitted);
    const target = held.session.sessionId;

    const first = panel.sendMessage('first', target, 'c1', { content: 'first' });
    await within(settle.waiting, 10_000, 'the agent_settled handler');
    await panel.interrupt();
    // a view that joins while pi winds the stopped run down is shown it stopped, as a watching view is
    expect(panel.liveConversation()?.snapshot.messages.filter((m) => m.type === 'processing')).toEqual([]);
    const second = panel.sendMessage('second', target, 'c2', { content: 'second' });

    await sleep(WIND_DOWN_NOTICE_MS - 1_000);
    expect(shownWindDowns(emitted)).toEqual([]);
    // pi ended the run before the Stop, so only its agent_settled handlers are left (agent-session.js:685-690 in pi 1.4.0).
    const shown: AgentWindDown = { phase: 'settle', events: ['agent_settled'], extensions: [] };
    await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown]), { timeout: 3_000 });
    expect(emitted.filter((m) => m.type === 'sessionStateChanged').at(-1)).toMatchObject({ state: 'idle', windDown: shown });
    expect(userMessageSent(emitted, 'c2')).toBe(false);

    settle.release();
    expect(await within(second, 10_000, 'the waiting send')).toBe('sent');
    await within(first, 10_000, 'the stopped send');
    expect(shownWindDowns(emitted)).toEqual([shown, null]);
    expect(userMessageSent(emitted, 'c2')).toBe(true);
    expect(userTextsInFile(held.session)).toEqual(['first', 'second']);
  }, 30_000);

  it('says the next send waits for the agent_before_settle and agent_settled handlers when the Stop came after the run ended', async () => {
    const held = await sessions.boot([fauxAssistantMessage('First.'), fauxAssistantMessage('Second.')], { store: onFile(), beforeSettle: true, mainChat: true });
    const beforeSettle = held.holdBeforeSettle();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = boundPanel(held, emitted);
    const target = held.session.sessionId;

    const first = panel.sendMessage('first', target, 'c1', { content: 'first' });
    await within(beforeSettle.waiting, 10_000, 'the agent_before_settle handler');
    // pi's abort() waits for the held handler (agent-session.js:1971-1981 in pi 1.4.0), and the turn shows stopped at once.
    const stopping = panel.interrupt();
    expect(emitted).toContainEqual({ type: 'sessionCancelled' });
    const second = panel.sendMessage('second', target, 'c2', { content: 'second' });

    const shown: AgentWindDown = { phase: 'settle', events: ['agent_before_settle', 'agent_settled'], extensions: [] };
    await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown]), { timeout: WIND_DOWN_NOTICE_MS + 2_000 });
    expect(userMessageSent(emitted, 'c2')).toBe(false);

    beforeSettle.release();
    await within(stopping, 10_000, 'the Stop');
    expect(await within(second, 10_000, 'the waiting send')).toBe('sent');
    await within(first, 10_000, 'the stopped send');
    expect(shownWindDowns(emitted)).toEqual([shown, null]);
    // pi committed the held handler's draft after the Stop (agent-session.js:1572-1573), and the send followed it.
    const entries = held.session.sessionManager.getBranch();
    expect(entries.findIndex((e) => e.type === 'custom' && e.customType === HELD_DRAFT_ENTRY))
      .toBeLessThan(entries.findIndex((e) => e.type === 'message' && e.message.role === 'user' && JSON.stringify(e.message.content).includes('second')));
    expect(userTextsInFile(held.session)).toEqual(['first', 'second']);
  }, 30_000);

  it('publishes no wind-down when the stopped run settles within the delay', async () => {
    const held = await sessions.boot([fauxAssistantMessage('First.'), fauxAssistantMessage('Second.')], { store: onFile(), mainChat: true });
    const settle = held.hold();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = boundPanel(held, emitted);
    const target = held.session.sessionId;

    const first = panel.sendMessage('first', target, 'c1', { content: 'first' });
    await within(settle.waiting, 10_000, 'the agent_settled handler');
    await panel.interrupt();
    settle.release();
    await within(first, 10_000, 'the stopped send');
    expect(await within(panel.sendMessage('second', target, 'c2', { content: 'second' }), 10_000, 'the next send')).toBe('sent');
    await sleep(WIND_DOWN_NOTICE_MS + 500);
    expect(windDowns(emitted).filter((windDown) => windDown !== null)).toEqual([]);
  }, 30_000);

  it('a second Stop still gives the waiting message back, and the line stays until the wind-down ends', async () => {
    const held = await sessions.boot([fauxAssistantMessage('First.'), fauxAssistantMessage('Unused.')], { store: onFile(), mainChat: true });
    const settle = held.hold();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = boundPanel(held, emitted);
    const target = held.session.sessionId;

    const first = panel.sendMessage('first', target, 'c1', { content: 'first' });
    await within(settle.waiting, 10_000, 'the agent_settled handler');
    await panel.interrupt();
    const withdrawn = vi.fn();
    const second = panel.sendMessage('second', target, 'c2', { content: 'second' }, withdrawn);
    const shown: AgentWindDown = { phase: 'settle', events: ['agent_settled'], extensions: [] };
    await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown]), { timeout: WIND_DOWN_NOTICE_MS + 2_000 });

    await panel.interrupt();
    expect(withdrawn).toHaveBeenCalledTimes(1);
    expect(emitted).toContainEqual({ type: 'interruptRecovery', correlationId: 'c2', promptContent: 'second' });
    expect(shownWindDowns(emitted)).toEqual([shown]);

    settle.release();
    expect(await within(second, 10_000, 'the withdrawn send')).toBe('withdrawn');
    await within(first, 10_000, 'the stopped send');
    await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown, null]));
    expect(userMessageSent(emitted, 'c2')).toBe(false);
    expect(userTextsInFile(held.session)).toEqual(['first']);
  }, 30_000);

  describe('a Stop of a run no send opened', () => {
    const shown: AgentWindDown = { phase: 'settle', events: ['agent_settled'], extensions: [] };

    /** The published wind-downs as the webview had applied them when pi opened its next run. */
    function atNextRunStart(session: AgentSession, emitted: readonly ExtensionToWebviewMessage[]): Promise<Array<AgentWindDown | null>> {
      return new Promise((resolve) => {
        const unsubscribe = session.subscribe((event) => {
          if (event.type !== 'agent_start') return;
          resolve(shownWindDowns(emitted));
          queueMicrotask(unsubscribe);
        });
      });
    }

    it("shows the wind-down while pi holds a cancel note's run in its agent_settled handlers, and clears it as pi settles that run, before the send", async () => {
      const held = await sessions.boot([fauxAssistantMessage('Noted.'), fauxAssistantMessage('Second.')], { store: onFile(), mainChat: true });
      const settle = held.hold();
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = boundPanel(held, emitted);

      // A cancel note with no run in progress opens a run of its own.
      (panel as unknown as { noteDeliveryForMain: (s: () => AgentSession) => (text: string) => void }).noteDeliveryForMain(() => held.session)('note');
      await within(settle.waiting, 10_000, 'the agent_settled handler');
      await panel.interrupt();
      const second = panel.sendMessage('second', held.session.sessionId, 'c2', { content: 'second' });
      const sendRun = atNextRunStart(held.session, emitted);

      await sleep(WIND_DOWN_NOTICE_MS - 1_000);
      expect(shownWindDowns(emitted)).toEqual([]);
      await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown]), { timeout: 3_000 });
      // The send waits in promptPi until pi has settled the note's run.
      expect(userTextsInFile(held.session)).toEqual(['note']);

      settle.release();
      expect(await within(sendRun, 10_000, "the send's run")).toEqual([shown, null]);
      await within(second, 10_000, 'the send');
      await vi.waitFor(() => expect(userTextsInFile(held.session)).toEqual(['note', 'second']));
      expect(shownWindDowns(emitted)).toEqual([shown, null]);
    }, 30_000);

    it('does the same for a run an extension opened with no turn running, stopped with Esc', async () => {
      const held = await sessions.boot([fauxAssistantMessage('Done.'), fauxAssistantMessage('Second.')], { store: onFile(), mainChat: true });
      const settle = held.hold();
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = boundPanel(held, emitted);

      // An extension's `pi.sendMessage` with `triggerTurn` on an idle session (agent-session.js:3619, :1865-1870 in pi 1.4.0).
      void held.session.sendCustomMessage({ customType: 'extension-turn', content: 'go', display: false }, { triggerTurn: true });
      await within(settle.waiting, 10_000, 'the agent_settled handler');
      panel.cancel();
      const second = panel.sendMessage('second', held.session.sessionId, 'c2', { content: 'second' });
      const sendRun = atNextRunStart(held.session, emitted);

      await sleep(WIND_DOWN_NOTICE_MS - 1_000);
      expect(shownWindDowns(emitted)).toEqual([]);
      await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown]), { timeout: 3_000 });
      expect(userTextsInFile(held.session)).toEqual([]);

      settle.release();
      expect(await within(sendRun, 10_000, "the send's run")).toEqual([shown, null]);
      await within(second, 10_000, 'the send');
      await vi.waitFor(() => expect(userTextsInFile(held.session)).toEqual(['second']));
      expect(shownWindDowns(emitted)).toEqual([shown, null]);
    }, 30_000);

    it('shows it for the run pi opens after the Stop with the send it held before that run, and clears it as pi settles that run', async () => {
      const held = await sessions.boot([fauxAssistantMessage('Second.')], { store: onFile(), mainChat: true, input: true });
      const input = held.holdInput();
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = boundPanel(held, emitted);
      const target = held.session.sessionId;

      const first = panel.sendMessage('first', target, 'c1', { content: 'first' });
      await within(input.waiting, 10_000, 'the input handler');
      const settle = held.hold();
      await panel.interrupt();
      const second = panel.sendMessage('second', target, 'c2', { content: 'second' });
      // pi opens the run once the handler returns, and the Stop's `stopRunAtStart` aborts it at agent_start.
      input.release();
      await within(settle.waiting, 10_000, 'the agent_settled handler of the run pi opened');

      await sleep(WIND_DOWN_NOTICE_MS - 1_000);
      expect(shownWindDowns(emitted)).toEqual([]);
      await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown]), { timeout: 3_000 });
      expect(userMessageSent(emitted, 'c2')).toBe(false);

      settle.release();
      expect(await within(second, 10_000, 'the waiting send')).toBe('sent');
      await within(first, 10_000, 'the stopped send');
      expect(shownWindDowns(emitted)).toEqual([shown, null]);
      expect(userTextsInFile(held.session)).toEqual(['first', 'second']);
    }, 30_000);

    it('publishes no wind-down for a Stop that finds no run in pi', async () => {
      const held = await sessions.boot([fauxAssistantMessage('First.'), fauxAssistantMessage('Second.')], { store: onFile(), mainChat: true });
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = boundPanel(held, emitted);
      const target = held.session.sessionId;

      expect(await within(panel.sendMessage('first', target, 'c1', { content: 'first' }), 10_000, 'the first send')).toBe('sent');
      await panel.interrupt();
      await sleep(WIND_DOWN_NOTICE_MS + 500);
      expect(windDowns(emitted).filter((windDown) => windDown !== null)).toEqual([]);
      expect(await within(panel.sendMessage('second', target, 'c2', { content: 'second' }), 10_000, 'the next send')).toBe('sent');
      expect(userTextsInFile(held.session)).toEqual(['first', 'second']);
    }, 30_000);
  });

  describe('pi running the agent_settled handlers of a run no send opened', () => {
    const shown: AgentWindDown = { phase: 'settle', events: ['agent_settled'], extensions: [] };
    const attachment = { id: 't1', kind: 'terminal' as const, source: 'command' as const, commandLine: 'npm test', exitCode: 1, terminalTitle: 'pwsh', lineCount: 1, omittedLines: 0, preview: 'FAIL' };
    const SENT = '<terminal_output>FAIL</terminal_output>\n\nwhat failed?';
    const broadcast = { content: 'what failed?', contentBlocks: [{ type: 'text' as const, text: 'what failed?' }], terminalAttachments: [attachment] };

    /** A cancel note's run, stopped while the held agent_settled handler runs. */
    async function stoppedNoteRun(responses: string[]): Promise<{ held: HeldSettleSession; release: () => void; emitted: ExtensionToWebviewMessage[]; panel: PiSession }> {
      const held = await sessions.boot(responses.map((text) => fauxAssistantMessage(text)), { store: onFile(), mainChat: true });
      const settle = held.hold();
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = boundPanel(held, emitted);
      deliverNote(panel, held.session, 'note');
      await within(settle.waiting, 10_000, 'the agent_settled handler');
      await panel.interrupt();
      return { held, release: settle.release, emitted, panel };
    }

    it('holds a send until pi settles that run, then sends it as a run of its own with its sidecar, checkpoint baseline and memory candidate', async () => {
      const { held, release, emitted, panel } = await stoppedNoteRun(['Noted.', 'It failed.']);
      const sessionId = held.session.sessionId;
      const startTurn = vi.fn();
      (panel as unknown as { checkpointService: unknown }).checkpointService = { sessionId, startTurn };
      const enqueueTurnCandidate = vi.fn();
      (panel as unknown as { options: { memoryService?: unknown } }).options.memoryService = { enqueueTurnCandidate };
      const dispositions = dispositionsOf(held.session);

      let outcome: SendOutcome | undefined;
      const send = panel.sendMessage(SENT, sessionId, 'c2', broadcast).then((settled) => (outcome = settled));
      await sleep(WIND_DOWN_NOTICE_MS - 1_000);
      expect(outcome).toBeUndefined();
      await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown]), { timeout: 3_000 });
      expect(outcome).toBeUndefined();
      expect(dispositions).toEqual([]);
      expect(userMessageSent(emitted, 'c2')).toBe(false);
      expect(userTextsInFile(held.session)).toEqual(['note']);

      release();
      expect(await within(send, 10_000, 'the waiting send')).toBe('sent');
      expect(dispositions).toEqual([`${SENT}: started`]);
      expect(userTextsInFile(held.session)).toEqual(['note', SENT]);
      const entryId = userEntryIdInFile(held.session, SENT);
      expect(entryId).toBeDefined();
      expect(customEntriesInFile(held.session, DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY)).toEqual([{ userEntryId: entryId, count: 1 }]);
      expect(startTurn).toHaveBeenCalledTimes(1);
      expect(startTurn).toHaveBeenCalledWith(held.session.sessionManager, entryId, SENT);
      expect(enqueueTurnCandidate).toHaveBeenCalledTimes(1);
      expect(enqueueTurnCandidate).toHaveBeenCalledWith(expect.objectContaining({ sessionId, assistantText: 'It failed.' }));
      expect(emitted.filter((m) => m.type === 'userMessage' && m.correlationId === 'c2')).toHaveLength(1);
      expect(emitted.some((m) => m.type === 'interruptRecovery' || m.type === 'promptReturned')).toBe(false);
      expect(shownWindDowns(emitted)).toEqual([shown, null]);
    }, 30_000);

    it('a Stop during that wait gives the message back with its attachments, and pi never sends it', async () => {
      const { held, release, emitted, panel } = await stoppedNoteRun(['Noted.', 'Unused.']);
      const withdrawn = vi.fn();
      const send = panel.sendMessage(SENT, held.session.sessionId, 'c2', broadcast, withdrawn);
      await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown]), { timeout: WIND_DOWN_NOTICE_MS + 2_000 });

      await panel.interrupt();
      expect(withdrawn).toHaveBeenCalledTimes(1);
      expect(emitted).toContainEqual({ type: 'interruptRecovery', correlationId: 'c2', promptContent: broadcast.content, contentBlocks: broadcast.contentBlocks });

      release();
      expect(await within(send, 10_000, 'the withdrawn send')).toBe('withdrawn');
      await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown, null]));
      await held.session.waitForIdle();
      expect(userMessageSent(emitted, 'c2')).toBe(false);
      expect(userTextsInFile(held.session)).toEqual(['note']);
      expect(customEntriesInFile(held.session, DAMOCLES_TERMINAL_ATTACHMENTS_ENTRY)).toEqual([]);
    }, 30_000);

    it('starts a compaction asked for meanwhile only once pi has settled that run', async () => {
      const { held, release, emitted, panel } = await stoppedNoteRun(['Noted.']);
      const order: string[] = [];
      held.session.subscribe((event) => {
        if (event.type === 'agent_settled' || event.type === 'compaction_start') order.push(event.type);
      });
      const accepted = vi.fn();
      const compaction = panel.compact(undefined, accepted, held.session.sessionId);
      await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown]), { timeout: WIND_DOWN_NOTICE_MS + 2_000 });
      expect(order).toEqual([]);
      expect(accepted).not.toHaveBeenCalled();

      release();
      await within(compaction, 10_000, 'the compaction');
      expect(order).toEqual(['agent_settled', 'compaction_start']);
      expect(accepted).toHaveBeenCalledTimes(1);
    }, 30_000);

    it('reports a settling run to every reader of the shared run phase, and none before or after it', async () => {
      const held = await sessions.boot([fauxAssistantMessage('First.')], { store: onFile(), mainChat: true, beforeSettle: true });
      const beforeSettle = held.holdBeforeSettle();
      const settle = held.hold();
      const panel = boundPanel(held, []);
      const run = (panel as unknown as { runLifecycle: RunLifecycle }).runLifecycle;
      expect(run.untilSettled()).toBeNull();

      const first = panel.sendMessage('first', held.session.sessionId, 'c1', { content: 'first' });
      await within(beforeSettle.waiting, 10_000, 'the agent_before_settle handler');
      expect(run.untilSettled()).toBeNull();
      beforeSettle.release();
      await within(settle.waiting, 10_000, 'the agent_settled handler');
      const settling = run.untilSettled();
      expect(settling).not.toBeNull();
      const stop = new AbortController();
      const stopped = run.untilSettled(stop.signal);
      stop.abort();
      await within(stopped!, 1_000, 'the wait its signal ended');

      settle.release();
      await within(settling!, 10_000, 'the settling run');
      expect(run.untilSettled()).toBeNull();
      expect(await within(first, 10_000, 'the send')).toBe('sent');
    }, 30_000);
  });

  describe('a re-steer pass while pi runs the agent_settled handlers of the run its messages were queued in', () => {
    it('waits for pi to settle that run and opens one run with every queued message as one batch, written once', async () => {
      const held = await sessions.boot(['First.', 'Batch.', 'Extra.', 'Extra.'].map((text) => fauxAssistantMessage(text)), {
        store: onFile(), mainChat: true, beforeSettle: true, input: true,
      });
      const beforeSettle = held.holdBeforeSettle();
      const settle = held.hold();
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = boundPanel(held, emitted);
      const target = held.session.sessionId;
      const inner = panel as unknown as { queuedInputs: unknown[]; screeningInputs: unknown[]; resteerRunning: boolean };

      const first = panel.sendMessage('first', target, 'c1', { content: 'first' });
      await within(beforeSettle.waiting, 10_000, 'the agent_before_settle handler');
      // The run still streams, so both are queued; the input handler holds the first one's screening.
      const input = held.holdInput();
      expect(panel.queueInput('q1', 'q1', 'q1', target)).toBe('queued');
      expect(panel.queueInput('q2', 'q2', 'q2', target)).toBe('queued');
      await within(input.waiting, 10_000, 'the input handler screening q1');
      beforeSettle.release();
      await within(settle.waiting, 10_000, 'the agent_settled handler');

      input.release();
      await vi.waitFor(() => expect(inner.screeningInputs).toEqual([]));
      expect(inner.queuedInputs).toHaveLength(2);
      settle.release();
      expect(await within(first, 10_000, 'the first send')).toBe('sent');
      await vi.waitFor(() => expect(inner.resteerRunning).toBe(false), { timeout: 10_000 });
      await held.session.waitForIdle();

      const batch = 'q1\n\nq2';
      expect(userTextsInFile(held.session)).toEqual(['first', batch]);
      // The user's own queued text, with nothing merged into it and no operator steer marker.
      expect(userTextsInFile(held.session).filter((text) => text.split('\n')[0] === STEER_INSTRUCTION_PREFIX)).toEqual([]);
      expect(emitted).toContainEqual({ type: 'queueBatchProcessed', messageIds: ['q1', 'q2'], combinedContent: batch });
      expect(emitted.some((m) => m.type === 'queueCancelled')).toBe(false);
      expect(inner.queuedInputs).toEqual([]);
    }, 30_000);
  });

  describe('a webview reload', () => {
    it('hears the wind-down again while it lasts, and the clear once it ends', async () => {
      const held = await sessions.boot([fauxAssistantMessage('First.'), fauxAssistantMessage('Second.')], { store: onFile(), mainChat: true });
      const settle = held.hold();
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = boundPanel(held, emitted);
      const target = held.session.sessionId;

      const first = panel.sendMessage('first', target, 'c1', { content: 'first' });
      await within(settle.waiting, 10_000, 'the agent_settled handler');
      await panel.interrupt();
      const shown: AgentWindDown = { phase: 'settle', events: ['agent_settled'], extensions: [] };
      await vi.waitFor(() => expect(shownWindDowns(emitted)).toEqual([shown]), { timeout: WIND_DOWN_NOTICE_MS + 2_000 });

      const sinceReload = emitted.length;
      panel.onWebviewReady();
      expect(windDowns(emitted.slice(sinceReload))).toEqual([shown]);

      settle.release();
      await within(first, 10_000, 'the stopped send');
      await vi.waitFor(() => expect(windDowns(emitted.slice(sinceReload))).toEqual([shown, null]));
    }, 30_000);

    it('hears no wind-down once the wait ended', async () => {
      const held = await sessions.boot([fauxAssistantMessage('First.')], { store: onFile(), mainChat: true });
      const settle = held.hold();
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = boundPanel(held, emitted);

      const first = panel.sendMessage('first', held.session.sessionId, 'c1', { content: 'first' });
      await within(settle.waiting, 10_000, 'the agent_settled handler');
      await panel.interrupt();
      await vi.waitFor(() => expect(shownWindDowns(emitted)).toHaveLength(1), { timeout: WIND_DOWN_NOTICE_MS + 2_000 });
      settle.release();
      await within(first, 10_000, 'the stopped send');
      await vi.waitFor(() => expect(windDowns(emitted).at(-1)).toBeNull());

      const sinceReload = emitted.length;
      panel.onWebviewReady();
      expect(windDowns(emitted.slice(sinceReload))).toEqual([null]);
    }, 30_000);

    it("replays the live subagents only after a replay of the conversation they run in", async () => {
      const held = await sessions.boot([], { mainChat: true });
      const panel = boundPanel(held, []);
      const replayLive = vi.fn();
      (panel as unknown as { subagentManager: { replayLive: () => void } }).subagentManager = { replayLive };

      panel.replayLiveAgents('another-conversation');
      expect(replayLive).not.toHaveBeenCalled();
      panel.replayLiveAgents(held.session.sessionId);
      expect(replayLive).toHaveBeenCalledTimes(1);
    });
  });

  describe('a message queued while pi runs the agent_settled handlers of the run it was typed in', () => {
    it('is held until pi settles that run and the send it was typed in ends, then goes out as a send of its own, never refused', async () => {
      const held = await sessions.boot([fauxAssistantMessage('First.'), fauxAssistantMessage('Queued.')], { store: onFile(), mainChat: true });
      const settle = held.hold();
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = boundPanel(held, emitted);
      const enqueueTurnCandidate = vi.fn();
      (panel as unknown as { options: { memoryService?: unknown } }).options.memoryService = { enqueueTurnCandidate };
      const target = held.session.sessionId;
      const dispositions = dispositionsOf(held.session);

      const first = panel.sendMessage('first', target, 'c1', { content: 'first' });
      await within(settle.waiting, 10_000, 'the agent_settled handler');
      expect(panel.queueInput('q1', 'q1', 'q1', target)).toBe('queued');
      await sleep(500);
      expect(dispositions).toEqual(['first: started']);
      expect(userTextsInFile(held.session)).toEqual(['first']);

      settle.release();
      expect(await within(first, 10_000, 'the first send')).toBe('sent');
      await vi.waitFor(() => expect(userTextsInFile(held.session)).toEqual(['first', 'q1']), { timeout: 10_000 });
      await vi.waitFor(() => expect(enqueueTurnCandidate).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      expect(dispositions).toEqual(['first: started', 'q1: started']);
      // A send of its own: its chip gives way to its echo, it takes the next prompt index, and nothing marks it mid-stream.
      expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q1' });
      expect(emitted).toContainEqual(expect.objectContaining({ type: 'userMessage', content: 'q1', promptIndex: 1 }));
      expect(emitted.some((m) => m.type === 'queueBatchProcessed')).toBe(false);
      expect(customEntriesInFile(held.session, DAMOCLES_MID_STREAM_ENTRY)).toEqual([]);
      expect(nextPromptIndex(held.session.sessionManager.getBranch())).toBe(2);
      expect(enqueueTurnCandidate).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: target, assistantText: 'Queued.' }));
    }, 30_000);

    it('goes back to the composer with a Stop during that wait, and pi never sends it', async () => {
      const held = await sessions.boot([fauxAssistantMessage('First.'), fauxAssistantMessage('Unused.')], { store: onFile(), mainChat: true });
      const settle = held.hold();
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = boundPanel(held, emitted);
      const target = held.session.sessionId;

      const first = panel.sendMessage('first', target, 'c1', { content: 'first' });
      await within(settle.waiting, 10_000, 'the agent_settled handler');
      expect(panel.queueInput('q1', 'q1', 'q1', target)).toBe('queued');
      await panel.interrupt();
      expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q1', returnToInput: true });

      settle.release();
      await within(first, 10_000, 'the stopped send');
      await held.session.waitForIdle();
      expect(userTextsInFile(held.session)).toEqual(['first']);
      expect(emitted.some((m) => m.type === 'queueBatchProcessed')).toBe(false);
    }, 30_000);
  });

  it("waits again before prompt() when a run that streamed at the send's settle wait reaches its agent_settled handlers meanwhile", async () => {
    const held = await sessions.boot([fauxAssistantMessage('Noted.'), fauxAssistantMessage('Second.')], { store: onFile(), mainChat: true, beforeSettle: true });
    const beforeSettle = held.holdBeforeSettle();
    const settle = held.hold();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = boundPanel(held, emitted);
    deliverNote(panel, held.session, 'note');
    await within(beforeSettle.waiting, 10_000, "the note run's agent_before_settle handler");
    // A pre-dispatch step the send awaits after its settle wait, held so the note's run can reach its settle meanwhile.
    let releaseStep!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    (panel as unknown as { deliverWorkingFolderNote: () => Promise<void> }).deliverWorkingFolderNote = () => {
      markEntered();
      return new Promise<void>((resolve) => { releaseStep = resolve; });
    };
    const dispositions = dispositionsOf(held.session);

    let outcome: SendOutcome | undefined;
    const send = panel.sendMessage('second', held.session.sessionId, 'c2', { content: 'second' }).then((settled) => (outcome = settled));
    await within(entered, 10_000, 'the held pre-dispatch step');
    beforeSettle.release();
    await within(settle.waiting, 10_000, "the note run's agent_settled handler");
    releaseStep();
    await sleep(300);
    expect(outcome).toBeUndefined();
    expect(dispositions).toEqual([]);

    settle.release();
    expect(await within(send, 10_000, 'the send')).toBe('sent');
    expect(dispositions).toEqual(['second: started']);
    expect(userTextsInFile(held.session)).toEqual(['note', 'second']);
  }, 30_000);

  it('refuses a compaction while a run no send opened streams, instead of letting pi abort that run', async () => {
    const held = await sessions.boot([fauxAssistantMessage('Noted.')], { store: onFile(), mainChat: true, beforeSettle: true });
    const beforeSettle = held.holdBeforeSettle();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = boundPanel(held, emitted);
    const started: string[] = [];
    held.session.subscribe((event) => {
      if (event.type === 'compaction_start') started.push(event.type);
    });
    deliverNote(panel, held.session, 'note');
    await within(beforeSettle.waiting, 10_000, "the note run's agent_before_settle handler");

    const accepted = vi.fn();
    await within(panel.compact(undefined, accepted, held.session.sessionId), 10_000, 'the refused compaction');
    expect(emitted).toContainEqual({ type: 'notification', message: 'Finish or stop the current turn before compacting.', notificationType: 'warning' });
    expect(accepted).not.toHaveBeenCalled();

    beforeSettle.release();
    await held.session.waitForIdle();
    expect(started).toEqual([]);
    const last = held.session.messages.at(-1) as { role: string; stopReason?: string };
    expect(last).toMatchObject({ role: 'assistant', stopReason: 'stop' });
  }, 30_000);

  it("counts the session busy for a runtime reload while pi runs a run's agent_settled handlers", async () => {
    const held = await sessions.boot([fauxAssistantMessage('First.')], { store: onFile(), mainChat: true });
    const settle = held.hold();
    const panel = boundPanel(held, []);
    const busy = (): boolean => (panel as unknown as { isSessionBusy: (s: AgentSession) => boolean }).isSessionBusy(held.session);
    expect(busy()).toBe(false);

    const first = held.session.prompt('first');
    await within(settle.waiting, 10_000, 'the agent_settled handler');
    expect(busy()).toBe(true);

    settle.release();
    await within(first, 10_000, 'the prompt');
    expect(busy()).toBe(false);
  }, 30_000);

  describe("a Stop while a compaction waits for pi to settle a run", () => {
    it('cancels the compaction before pi starts it, and says so as a stopped compaction', async () => {
      const held = await sessions.boot([fauxAssistantMessage('Noted.'), fauxAssistantMessage('Next.')], { store: onFile(), mainChat: true });
      const settle = held.hold();
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = boundPanel(held, emitted);
      deliverNote(panel, held.session, 'note');
      await within(settle.waiting, 10_000, 'the agent_settled handler');
      const started: string[] = [];
      held.session.subscribe((event) => {
        if (event.type === 'compaction_start') started.push(event.type);
      });
      const accepted = vi.fn();
      const compaction = panel.compact(undefined, accepted, held.session.sessionId);
      await sleep(200);

      await panel.interrupt();
      // The Stop ends the wait itself, while pi still runs the handlers.
      await within(compaction, 2_000, 'the stopped compaction');
      settle.release();
      await held.session.waitForIdle();
      expect(started).toEqual([]);
      expect(accepted).not.toHaveBeenCalled();
      expect(emitted).toContainEqual(expect.objectContaining({ type: 'compactionAborted', trigger: 'manual', willRetry: false }));
      // The chat is free for the next request.
      expect(await within(panel.sendMessage('next', held.session.sessionId, 'c2', { content: 'next' }), 10_000, 'the next send')).toBe('sent');
    }, 30_000);
  });
});
