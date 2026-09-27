import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { sessionNoteDelivery } from '../note-delivery';
import { watchPromptEntry } from '../prompt-entry';
import { reconstructMessages } from '../session-store/history-loader';
import { withPerCallCancel } from '../tools/cancellable-shell';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import { bindPanel, blockingShell, callPowerShell, describeMessage, panelSession, realPiSessions, wire } from './real-pi-fixtures';

/**
 * Cancel-note timing against pi's real queue and agent loop, with a scripted provider in place of the
 * model. The shell stays alive after the abort until the test releases it, as a real process does
 * until it exits, so every note and queued message is in pi's queue before the tool boundary.
 */

const PROMPT = 'Run Start-Sleep -Seconds 60; echo done in PowerShell.';
const NOTE = 'skip it';
const QUEUED = 'also check the logs';

describe('a cancel note against pi', () => {
  const { boot, dispose } = realPiSessions();

  afterEach(() => dispose());

  it('reaches the model call right after the cancelled result, in the same run, together with a message queued after it', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const bound: { session?: AgentSession } = {};
    const { tool, store } = wire(shell, () => bound.session, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Skipped. The logs are clean.')]);
    bound.session = session;
    bindPanel(panel, session);

    const run = session.prompt(PROMPT);
    await shell.started;
    expect(store.cancel('call-1', NOTE)).toBe(true);
    // A re-steer clears pi's whole steering queue, so the note has to be put back ahead of the batch.
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual([NOTE, QUEUED]));
    shell.release();
    await run;

    expect(contexts).toEqual([
      [`user: ${PROMPT}`],
      [`user: ${PROMPT}`, 'assistant', 'toolResult: call-1', `user: ${NOTE}`, `user: ${QUEUED}`],
    ]);
    expect(emitted.filter((m) => m.type === 'userMessage')).toMatchObject([{ content: NOTE, isInjected: true }]);
  });

  it('shares one model call and one reply with a message queued before the Stop click, and goes first', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const bound: { session?: AgentSession } = {};
    const { tool, store } = wire(shell, () => bound.session, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Skipped. Hi.')]);
    bound.session = session;
    bindPanel(panel, session);
    (panel as unknown as { adapter: { subscribe: (s: AgentSession) => () => void } }).adapter.subscribe(session);

    const run = session.prompt(PROMPT);
    await shell.started;
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual([QUEUED]));
    expect(store.cancel('call-1', NOTE)).toBe(true);
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual([NOTE, QUEUED]));
    shell.release();
    await run;

    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.slice(-3)).toEqual(['toolResult: call-1', `user: ${NOTE}`, `user: ${QUEUED}`]);

    // Live: the note's echo, then the chip collapsing into its row, both before the one reply.
    const rows = emitted.flatMap((m) =>
      m.type === 'userMessage' ? [`note: ${m.content}`]
      : m.type === 'queueBatchProcessed' ? [`batch: ${m.messageIds.join(',')}`]
      : m.type === 'assistant' ? ['assistant']
      : []);
    expect(rows.slice(-3)).toEqual([`note: ${NOTE}`, 'batch: q1', 'assistant']);
    expect(emitted.some((m) => m.type === 'queueCancelled')).toBe(false);

    // Reload: both entries carry the mid-stream marker, so neither counts as a prompt.
    const replayed = reconstructMessages(session.sessionManager.getBranch()).messages.flatMap((m) =>
      m.kind === 'user' ? [`${m.content}|${m.isMidStream ? 'mid-stream' : `prompt ${m.promptIndex}`}`] : m.kind === 'assistant' ? ['assistant'] : []);
    expect(replayed).toEqual([`${PROMPT}|prompt 0`, 'assistant', `${NOTE}|mid-stream`, `${QUEUED}|mid-stream`, 'assistant']);
  });

  it('starts a run of its own, echoed and opened as a turn before the model is called, when no run is in progress', async () => {
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const bound: { session?: AgentSession } = {};
    const { tool } = wire(blockingShell(), () => bound.session, panel);
    let seenAtCall: string[] = [];
    const { session, contexts } = await boot(tool, [
      () => {
        seenAtCall = emitted.map((m) => m.type);
        return fauxAssistantMessage('Skipped.');
      },
    ]);
    bound.session = session;
    bindPanel(panel, session);

    (panel as unknown as { noteDeliveryForMain: (s: () => AgentSession) => (text: string) => void }).noteDeliveryForMain(() => session)(NOTE);
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    await vi.waitFor(() => expect(session.isStreaming).toBe(false));

    expect(contexts[0]).toEqual([`user: ${NOTE}`]);
    expect(seenAtCall).toContain('userMessage');
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'processing', isProcessing: true }));
    // Listed before pi delivered it, so the run's opening user message is reported as the note it is.
    expect(panel.onQueuedInputsDelivered(NOTE)).toBe(true);
  });

  it('commits after the prompt it annotates, which the prompt call still names as its own entry', async () => {
    const shell = blockingShell();
    const bound: { session?: AgentSession } = {};
    const store = new ShellCancelStore();
    const deliver = sessionNoteDelivery(() => bound.session);
    const tool = withPerCallCancel(shell.definition, store.forContext((text) => void deliver(text, () => undefined)));
    const { session } = await boot(tool, [callPowerShell, fauxAssistantMessage('Skipped.')]);
    bound.session = session;

    const watch = watchPromptEntry(session);
    const run = session.prompt(PROMPT, { preflightResult: watch.preflightResult });
    await shell.started;
    store.cancel('call-1', NOTE);
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual([NOTE]));
    shell.release();
    await run;
    watch.dispose();

    const users = session.sessionManager.getBranch().flatMap((e) =>
      e.type === 'message' && e.message.role === 'user' ? [{ id: e.id, text: describeMessage(e.message) }] : []);
    expect(users.map((u) => u.text)).toEqual([`user: ${PROMPT}`, `user: ${NOTE}`]);
    expect(watch.entry()).toEqual({ id: users[0]!.id, text: PROMPT });
  });
});
