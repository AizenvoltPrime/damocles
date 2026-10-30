import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Agent } from '@earendil-works/pi-agent-core';
import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { BUDGET_STOP_HOOK, installTurnDecider } from '../finish-turn';
import { registerConfiguredHooks } from '../hooks';
import { PiRuntime } from '../pi-runtime';
import { workingFolderNote, type PiSession } from '../pi-session';
import { DAMOCLES_AGENT_INVOCATION_ENTRY, DAMOCLES_INTERRUPTION_NOTICE, DAMOCLES_MID_STREAM_ENTRY } from '../session-store/constants';
import { SUBAGENT_RESULTS_CUSTOM_TYPE } from '../subagents/background-results';
import { bindPanel, blockingShell, callPowerShell, panelSession, realPiSessions, wire } from './real-pi-fixtures';
import { englishText } from '../../../shared/localized-text';

/** Queued typed input and cancel notes against pi's real queue and agent loop, with a scripted model. */

const PROMPT = 'Run Start-Sleep -Seconds 60; echo done in PowerShell.';
const NOTE = 'skip it';
const QUEUED = 'also check the logs';
const LOOK = 'what is in this screenshot?';
const PNG_DATA = 'iVBORw0KGgo=';
const SCREENSHOT = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: PNG_DATA } };

interface Internals {
  processingFlag: boolean;
  _budgetStopRequested: boolean;
  stopForBudget: () => void;
  startPromise: Promise<void> | null;
  titleGenerationAttempted: boolean;
  budgetLimitForEnforcement: () => number | null;
  adapter: { subscribe: (session: AgentSession) => () => void };
}

const internals = (panel: PiSession): Internals => panel as unknown as Internals;

/** Lets the panel send a prompt without `start()`, a title sub-call or a budget. */
function readyToSend(panel: PiSession): void {
  const inner = internals(panel);
  inner.startPromise = Promise.resolve();
  inner.titleGenerationAttempted = true;
  inner.budgetLimitForEnforcement = () => null;
}

/** The content of the user entry whose text is `text`. */
const userContent = (session: AgentSession, text: string): unknown =>
  session.sessionManager.getBranch().flatMap((e) => (e.type === 'message' && e.message.role === 'user' ? [e.message.content] : []))
    .find((content) => Array.isArray(content) && content.some((p) => p.type === 'text' && p.text === text));

const notices = (emitted: readonly ExtensionToWebviewMessage[]): string[] =>
  emitted.flatMap((m) => (m.type === 'notification' ? [englishText(m.message)] : []));

const userTexts = (session: AgentSession): string[] =>
  session.sessionManager.getBranch().flatMap((e) => {
    if (e.type !== 'message' || e.message.role !== 'user') return [];
    const content = e.message.content;
    return [typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join('')];
  });

/** `userTexts` without the note pi's run start appends for an image it cannot resize, which `PNG_DATA` is. */
const typedTexts = (session: AgentSession): string[] => userTexts(session).map((text) => text.replace(/\n\n\[Image omitted: [^\]]*\]$/, ''));

describe('the mid-run queue against pi', () => {
  const { boot, dispose } = realPiSessions();

  afterEach(() => dispose());

  it('ESC returns a queued message to the input and drops a held note, so neither reaches the next run', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const bound: { session?: AgentSession } = {};
    const { tool, store } = wire(shell, () => bound.session, panel);
    const replies = ['First.', 'Second.', 'Third.'].map((text) => fauxAssistantMessage(text));
    const { session, contexts } = await boot(tool, [callPowerShell, ...replies]);
    bound.session = session;
    bindPanel(panel, session);

    const run = session.prompt(PROMPT).catch(() => undefined);
    await shell.started;
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    expect(store.cancel('call-1', NOTE)).toBe(true);
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual([NOTE, QUEUED]));

    const stopped = panel.interrupt();
    shell.release();
    await stopped;
    await run;
    expect(session.pendingMessageCount).toBe(0);

    await session.prompt('Start over.');

    expect(contexts.at(-1)?.at(-1)).toBe('user: Start over.');
    expect(contexts.flat()).not.toContain(`user: ${QUEUED}`);
    expect(contexts.flat()).not.toContain(`user: ${NOTE}`);
    expect(userTexts(session)).toEqual([PROMPT, 'Start over.']);
    expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q1', returnToInput: true });
    // The note was echoed as told to the agent, so its drop is reported rather than left standing.
    expect(notices(emitted).some((text) => text.includes('discarded your cancel note'))).toBe(true);
  });

  it('holds one batch in pi however long an input handler keeps a re-steer in flight', async () => {
    const shell = blockingShell();
    const panel = panelSession([]);
    const hooks: Array<() => void> = [];
    // Another loaded pi extension, which sees every re-steer as input from an extension.
    const slowInputHook = (pi: ExtensionAPI): void => {
      pi.on('input', async (event) => {
        if (event.source === 'extension') await new Promise<void>((resolve) => hooks.push(resolve));
        return undefined;
      });
    };
    const { tool, store } = wire(shell, () => undefined, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Done.'), fauxAssistantMessage('Again.')], slowInputHook);
    bindPanel(panel, session);

    const run = session.prompt(PROMPT);
    await shell.started;
    expect(panel.queueInput('first', 'q1')).toBe('queued');
    expect(panel.queueInput('second', 'q2')).toBe('queued');
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(hooks.length).toBeGreaterThan(0));
      hooks.shift()!();
    }
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual(['first\n\nsecond']));
    expect(hooks).toHaveLength(0);
    store.cancel('call-1');
    shell.release();
    await run;

    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.slice(-2)).toEqual(['toolResult: call-1', 'user: first\n\nsecond']);
  });

  it("sends and stops a batch ESC overtook in pi's hands when another extension's input handler returns after the run has ended", async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const hooks: Array<() => void> = [];
    // A repository `.pi/` extension that knows nothing of the withdrawal and passes the batch on.
    const slowInputHook = (pi: ExtensionAPI): void => {
      pi.on('input', async (event) => {
        if (event.source === 'extension') await new Promise<void>((resolve) => hooks.push(resolve));
        return undefined;
      });
    };
    const { tool } = wire(shell, () => undefined, panel);
    const replies = ['First.', 'Second.'].map((text) => fauxAssistantMessage(text));
    const { session, contexts } = await boot(tool, [callPowerShell, ...replies], slowInputHook);
    bindPanel(panel, session);
    readyToSend(panel);

    const run = session.prompt(PROMPT).catch(() => undefined);
    await shell.started;
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect(hooks).toHaveLength(1));
    const stopped = panel.interrupt();
    shell.release();
    await stopped;
    await run;
    expect(session.isStreaming).toBe(false);
    // pi holds the batch with no verdict yet, so the Stop gives it to neither the composer nor the transcript.
    expect(emitted.filter((m) => m.type === 'queueCancelled' || m.type === 'queueBatchProcessed')).toEqual([]);

    hooks.shift()!();
    await vi.waitFor(() => expect((panel as unknown as { resteerRunning: boolean }).resteerRunning).toBe(false));
    await session.waitForIdle();

    // pi opened a run with the batch, and the run stopped at its start: the batch is a sent, stopped turn.
    expect(session.isStreaming).toBe(false);
    expect(session.pendingMessageCount).toBe(0);
    expect(contexts).toHaveLength(1);
    expect(contexts.flat()).not.toContain(`user: ${QUEUED}`);
    expect(userTexts(session)).toEqual([PROMPT, QUEUED]);
    expect(emitted).toContainEqual({ type: 'queueBatchProcessed', messageIds: ['q1'], combinedContent: QUEUED });
    expect(emitted.some((m) => m.type === 'queueCancelled')).toBe(false);
    // A reload shows it as the queued batch it was live, not as a prompt of its own.
    const branch = session.sessionManager.getBranch();
    const batchEntry = branch.find((e) => e.type === 'message' && e.message.role === 'user' && userContent(session, QUEUED) === e.message.content);
    expect(branch.some((e) => e.type === 'custom' && e.customType === DAMOCLES_MID_STREAM_ENTRY && (e.data as { userEntryId: string }).userEntryId === batchEntry?.id)).toBe(true);

    expect(await panel.sendMessage('Start over.', undefined, 'c1', { content: 'Start over.' })).toBe('sent');
    expect(contexts).toHaveLength(2);
    expect(contexts.at(-1)?.at(-1)).toBe('user: Start over.');
  });

  it('stops the run a withdrawn batch opens, before any request, when ESC lands after every input handler returned', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const inputGate: Array<() => void> = [];
    const startGate: Array<() => void> = [];
    const slowExtension = (pi: ExtensionAPI): void => {
      pi.on('input', async (event) => {
        if (event.source === 'extension') await new Promise<void>((resolve) => inputGate.push(resolve));
        return undefined;
      });
      pi.on('before_agent_start', async (event) => {
        if (event.messageType === 'user' && event.prompt === QUEUED) await new Promise<void>((resolve) => startGate.push(resolve));
        return undefined;
      });
    };
    const { tool, store } = wire(shell, () => undefined, panel);
    const replies = ['First.', 'Second.'].map((text) => fauxAssistantMessage(text));
    const { session, contexts } = await boot(tool, [callPowerShell, ...replies], slowExtension);
    bindPanel(panel, session);
    readyToSend(panel);

    const run = session.prompt(PROMPT);
    await shell.started;
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect(inputGate).toHaveLength(1));
    store.cancel('call-1');
    shell.release();
    await run;
    // The run ended on its own, so pi now prepares a run of the batch's own.
    inputGate.shift()!();
    await vi.waitFor(() => expect(startGate).toHaveLength(1));
    // pi's abort() waits for the starting run, so the handler is released after ESC lands and before the wait.
    const stopped = panel.interrupt();
    startGate.shift()!();
    await stopped;
    await vi.waitFor(() => expect((panel as unknown as { resteerRunning: boolean }).resteerRunning).toBe(false));

    // pi aborts the run at `agent_start`, so the batch is a sent, stopped turn that reached no model.
    expect(session.isStreaming).toBe(false);
    expect(contexts).toHaveLength(2);
    expect(contexts.flat()).not.toContain(`user: ${QUEUED}`);
    expect(userTexts(session)).toEqual([PROMPT, QUEUED]);
    expect(emitted).toContainEqual({ type: 'queueBatchProcessed', messageIds: ['q1'], combinedContent: QUEUED });
    expect(emitted.some((m) => m.type === 'queueCancelled')).toBe(false);

    expect(await panel.sendMessage('Start over.', undefined, 'c1', { content: 'Start over.' })).toBe('sent');
    expect(contexts).toHaveLength(3);
    expect(contexts.at(-1)?.at(-1)).toBe('user: Start over.');
  });

  it('a batch another extension\'s input handler consumes loses its chip and leaves nothing held for a later re-steer', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    // Screening runs the handlers as interactive input; the re-steer reaches them as input from an extension.
    const consumer = (pi: ExtensionAPI): void => {
      pi.on('input', async (event) => (event.source === 'extension' && event.text === QUEUED ? { action: 'handled' } : undefined));
    };
    const { tool, store } = wire(shell, () => undefined, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Done.')], consumer);
    bindPanel(panel, session);

    const run = session.prompt(PROMPT);
    await shell.started;
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q1' }));
    store.cancel('call-1');
    shell.release();
    await run;

    expect((panel as unknown as { queuedInputs: unknown[] }).queuedInputs).toEqual([]);
    expect(session.pendingMessageCount).toBe(0);
    expect(contexts.flat()).not.toContain(`user: ${QUEUED}`);
  });

  it('a batch that opens a run of its own opens a turn, so the session reads as working while it streams', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const inputGate: Array<() => void> = [];
    const slowInputHook = (pi: ExtensionAPI): void => {
      pi.on('input', async (event) => {
        if (event.source === 'extension') await new Promise<void>((resolve) => inputGate.push(resolve));
        return undefined;
      });
    };
    const { tool, store } = wire(shell, () => undefined, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('First.'), fauxAssistantMessage('Second.')], slowInputHook);
    bindPanel(panel, session);

    const run = session.prompt(PROMPT);
    await shell.started;
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect(inputGate).toHaveLength(1));
    store.cancel('call-1');
    shell.release();
    await run;
    const opened = emitted.length;
    inputGate.shift()!();
    await vi.waitFor(() => expect((panel as unknown as { resteerRunning: boolean }).resteerRunning).toBe(false));

    expect(contexts.at(-1)?.at(-1)).toBe(`user: ${QUEUED}`);
    expect(emitted.slice(opened)).toContainEqual({ type: 'processing', isProcessing: true });
  });

  it('a cancel note another extension\'s input handler consumes is never echoed, so a later stop reports no discarded note', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const bound: { session?: AgentSession } = {};
    const consumer = (pi: ExtensionAPI): void => {
      pi.on('input', async (event) => (event.text === NOTE ? { action: 'handled' } : undefined));
    };
    const { tool, store } = wire(shell, () => bound.session, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Done.')], consumer);
    bound.session = session;
    bindPanel(panel, session);

    const run = session.prompt(PROMPT).catch(() => undefined);
    await shell.started;
    expect(store.cancel('call-1', NOTE)).toBe(true);
    await vi.waitFor(() => expect((panel as unknown as { injectedNotes: unknown[] }).injectedNotes).toEqual([]));
    const stopped = panel.interrupt();
    shell.release();
    await stopped;
    await run;

    expect(emitted.filter((m) => m.type === 'userMessage')).toEqual([]);
    expect(notices(emitted).some((text) => text.includes('discarded your cancel note'))).toBe(false);
    expect(contexts.flat()).not.toContain(`user: ${NOTE}`);
  });

  it('returns queued messages to the input on a budget stop, as ESC does, and none reaches the model', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const { tool, store } = wire(shell, () => undefined, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Skipped.')]);
    bindPanel(panel, session);
    installTurnDecider(session.agent as unknown as Agent, BUDGET_STOP_HOOK, () =>
      internals(panel)._budgetStopRequested ? { action: 'end' } : undefined);

    const run = session.prompt(PROMPT);
    await shell.started;
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual([QUEUED]));
    internals(panel).processingFlag = true;
    internals(panel).stopForBudget();
    store.cancel('call-1');
    shell.release();
    await run;

    expect(contexts).toHaveLength(1);
    expect(userTexts(session)).toEqual([PROMPT]);
    expect(emitted.filter((m) => m.type === 'queueCancelled')).toEqual([{ type: 'queueCancelled', messageId: 'q1', returnToInput: true }]);
  });

  it('runs a UserPromptSubmit hook once per queued message and steers only the ones it allowed', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const bound: { session?: AgentSession } = {};
    const judgedLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-hook-')), 'judged.jsonl');
    const hookScript = [
      "let s = '';",
      "process.stdin.on('data', (d) => { s += d; }).on('end', () => {",
      '  const prompt = JSON.parse(s).prompt;',
      `  require('fs').appendFileSync(${JSON.stringify(judgedLog)}, JSON.stringify(prompt) + '\\n');`,
      "  if (prompt.includes('forbidden')) process.stdout.write(JSON.stringify({ decision: 'block', reason: 'no forbidden words' }));",
      '});',
    ].join('\n');
    const entries = { input: [{ command: [process.execPath, '-e', hookScript] }] } as Record<string, unknown[]>;
    const dispatch = {
      config: { getEntries: (key: string) => entries[key] ?? [], hasEntries: (key: string) => (entries[key] ?? []).length > 0 } as never,
      workspaceRoot: process.cwd(),
      userHome: os.homedir(),
    };
    // Loaded as the folder's Damocles extension loads it, so a hook pi's input handlers ran would be judged twice.
    const configuredHooks = (pi: ExtensionAPI): void =>
      registerConfiguredHooks(pi, { dispatch, registry: { get: () => ({ postMessage: (message) => emitted.push(message) }) } });
    const { tool, store } = wire(shell, () => bound.session, panel);
    const replies = ['Noted.', 'Checked.'].map((text) => fauxAssistantMessage(text));
    const { session, contexts } = await boot(tool, [callPowerShell, ...replies], configuredHooks);
    bound.session = session;
    bindPanel(panel, session);
    internals(panel).adapter.subscribe(session);
    readyToSend(panel);
    Object.assign(panel, { folder: { getHooksDispatchDeps: () => dispatch, services: { settingsManager: session.settingsManager } } });

    const run = panel.sendMessage(PROMPT, undefined, 'c0', { content: PROMPT });
    await shell.started;
    for (const [text, id] of [['allowed one', 'q1'], ['forbidden two', 'q2'], ['allowed three', 'q3']] as const) {
      expect(panel.queueInput(text, id)).toBe('queued');
    }
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual(['allowed one\n\nallowed three']), { timeout: 20_000 });
    // A cancel note re-steers the batch behind it, and neither may reach the hook again.
    expect(store.cancel('call-1', NOTE)).toBe(true);
    shell.release();
    await run;

    const judged = fs.readFileSync(judgedLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string);
    fs.rmSync(path.dirname(judgedLog), { recursive: true, force: true });
    expect(judged).toEqual([PROMPT, 'allowed one', 'forbidden two', 'allowed three']);
    expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q2' });
    expect(notices(emitted)).toContain('no forbidden words');
    expect(emitted).toContainEqual(expect.objectContaining({ type: 'queueBatchProcessed', messageIds: ['q1', 'q3'] }));
    expect(contexts.at(-1)?.slice(-1)).toEqual(['user: allowed one\n\nallowed three']);
    expect(contexts.flat().some((line) => line.includes('forbidden two'))).toBe(false);
  }, 30_000);

  it('refuses a note after the budget stop, so the stopped run bills no continuation and nothing claims delivery', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const bound: { session?: AgentSession } = {};
    const { tool, store } = wire(shell, () => bound.session, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Skipped.')]);
    bound.session = session;
    bindPanel(panel, session);
    // Installed by `bindSession`, which this harness skips.
    installTurnDecider(session.agent as unknown as Agent, BUDGET_STOP_HOOK, () =>
      internals(panel)._budgetStopRequested ? { action: 'end' } : undefined);

    const run = session.prompt(PROMPT);
    await shell.started;
    internals(panel).processingFlag = true;
    internals(panel).stopForBudget();
    expect(store.cancel('call-1', NOTE)).toBe(true);
    shell.release();
    await run;

    expect(contexts).toHaveLength(1);
    expect(userTexts(session)).toEqual([PROMPT]);
    expect(emitted.filter((m) => m.type === 'userMessage')).toEqual([]);
    expect(notices(emitted).some((text) => text.includes('cancel note was not sent'))).toBe(true);
  });

  it("re-queues a prompt pi queued with an image with that image when a queued message re-steers pi's queue", async () => {
    const shell = blockingShell();
    const panel = panelSession([]);
    const { tool, store } = wire(shell, () => undefined, panel);
    const { session } = await boot(tool, [callPowerShell, fauxAssistantMessage('Noted.'), fauxAssistantMessage('Looked.')]);
    bindPanel(panel, session);
    readyToSend(panel);

    const run = session.prompt(PROMPT);
    await shell.started;
    expect(await panel.sendMessage([{ type: 'text', text: LOOK }, SCREENSHOT], undefined, 'c1', { content: LOOK })).toBe('sent');
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual([QUEUED]));
    await vi.waitFor(() => expect([...session.getFollowUpMessages()]).toEqual([LOOK]));
    store.cancel('call-1');
    shell.release();
    await run;

    expect(userTexts(session)).toEqual([PROMPT, QUEUED, LOOK]);
    expect(userContent(session, LOOK)).toEqual([{ type: 'text', text: LOOK }, { type: 'image', data: PNG_DATA, mimeType: 'image/png' }]);
  });

  it('ESC returns a prompt pi queued into the running run to the input, so it reaches neither this run nor the next', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const { tool } = wire(shell, () => undefined, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Again.')]);
    bindPanel(panel, session);
    readyToSend(panel);
    const withdrawn = vi.fn();

    const run = session.prompt(PROMPT).catch(() => undefined);
    await shell.started;
    expect(await panel.sendMessage([{ type: 'text', text: LOOK }, SCREENSHOT], undefined, 'c1', { content: LOOK }, withdrawn)).toBe('sent');
    expect([...session.getFollowUpMessages()]).toEqual([LOOK]);
    const stopped = panel.interrupt();
    shell.release();
    await stopped;
    await run;
    await session.prompt('Start over.');

    expect(withdrawn).toHaveBeenCalledOnce();
    expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'c1', returnToInput: true });
    expect(userTexts(session)).toEqual([PROMPT, 'Start over.']);
    expect(contexts.flat()).not.toContain(`user: ${LOOK}`);
  });

  it('keeps a queued prompt the budget stop returned out of the stopped run when its re-queue lands after the stop', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const hooks = new Map<string, () => void>();
    // Another loaded pi extension, which holds every re-queue and re-steer while the stop lands.
    const slowInputHook = (pi: ExtensionAPI): void => {
      pi.on('input', async (event) => {
        if (event.source === 'extension') await new Promise<void>((resolve) => hooks.set(event.text, resolve));
        return undefined;
      });
    };
    const { tool, store } = wire(shell, () => undefined, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Skipped.'), fauxAssistantMessage('Looked.')], slowInputHook);
    bindPanel(panel, session);
    readyToSend(panel);
    installTurnDecider(session.agent as unknown as Agent, BUDGET_STOP_HOOK, () =>
      internals(panel)._budgetStopRequested ? { action: 'end' } : undefined);
    const withdrawn = vi.fn();

    const run = session.prompt(PROMPT);
    await shell.started;
    expect(await panel.sendMessage([{ type: 'text', text: LOOK }, SCREENSHOT], undefined, 'c1', { content: LOOK }, withdrawn)).toBe('sent');
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...hooks.keys()].sort()).toEqual([LOOK, QUEUED].sort()));
    internals(panel).processingFlag = true;
    internals(panel).stopForBudget();
    // The withdrawn re-steer stays held until the run has settled, so only the re-queue can keep its prompt out.
    hooks.get(LOOK)!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.cancel('call-1');
    shell.release();
    await run;
    hooks.get(QUEUED)!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.waitForIdle();

    expect(withdrawn).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(1);
    // The batch the stop left in pi's hands opens a run of its own once the run ended, which stops at its start.
    expect(userTexts(session)).toEqual([PROMPT, QUEUED]);
    expect(emitted).toContainEqual({ type: 'queueBatchProcessed', messageIds: ['q1'], combinedContent: QUEUED });
  });

  it('sends and stops the first of the prompts ESC overtook in pi\'s hands to open a run of its own after the run ended, and returns the one that queues into it', async () => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const hooks = new Map<string, () => void>();
    // The last handlers pi runs before it decides whether a prompt opens a run.
    const reachedStart: string[] = [];
    const slowInputHook = (pi: ExtensionAPI): void => {
      pi.on('input', async (event) => {
        if (event.source === 'extension') await new Promise<void>((resolve) => hooks.set(event.text, resolve));
        return undefined;
      });
      pi.on('before_agent_start', (event) => {
        if (event.messageType === 'user') reachedStart.push(event.prompt);
        return undefined;
      });
    };
    const { tool } = wire(shell, () => undefined, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Looked.')], slowInputHook);
    bindPanel(panel, session);
    readyToSend(panel);
    const withdrawn = vi.fn();

    const run = session.prompt(PROMPT).catch(() => undefined);
    await shell.started;
    expect(await panel.sendMessage([{ type: 'text', text: LOOK }, SCREENSHOT], undefined, 'c1', { content: LOOK }, withdrawn)).toBe('sent');
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...hooks.keys()].sort()).toEqual([LOOK, QUEUED].sort()));
    const stopped = panel.interrupt();
    shell.release();
    await stopped;
    await run;
    // pi holds both with no verdict yet, so the Stop returns neither.
    expect(withdrawn).not.toHaveBeenCalled();
    expect(emitted.filter((m) => m.type === 'queueCancelled')).toEqual([]);
    for (const release of hooks.values()) release();
    // pi counts a starting run as busy, so whichever withdrawn prompt comes second queues into it.
    await vi.waitFor(() => expect(reachedStart.slice(1)).toHaveLength(1));
    const opened = reachedStart[1];
    expect([LOOK, QUEUED]).toContain(opened);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.waitForIdle();

    // The run it opens stops at its start: no request, and the prompt stays as a sent, stopped turn.
    expect(contexts).toHaveLength(1);
    expect(typedTexts(session)).toEqual([PROMPT, opened]);
    // The one that queued into that run goes back to the composer, once; the sent one does not.
    if (opened === LOOK) {
      expect(withdrawn).not.toHaveBeenCalled();
      expect(emitted.filter((m) => m.type === 'queueCancelled')).toEqual([{ type: 'queueCancelled', messageId: 'q1', returnToInput: true }]);
    } else {
      expect(withdrawn).toHaveBeenCalledOnce();
      expect(emitted).toContainEqual({ type: 'queueBatchProcessed', messageIds: ['q1'], combinedContent: QUEUED });
      expect(emitted.filter((m) => m.type === 'queueCancelled')).toEqual([{ type: 'queueCancelled', messageId: 'c1', returnToInput: true }]);
    }
    expect(await panel.sendMessage('Start over.', undefined, 'c2', { content: 'Start over.' })).toBe('sent');
    expect(contexts).toHaveLength(2);
    expect(contexts.at(-1)?.at(-1)).toBe('user: Start over.');
  });

  it("drops all pi holds for a budget-stopped run when a withdrawn re-queue lands in it, another extension's follow-up included", async () => {
    const shell = blockingShell();
    const panel = panelSession([]);
    const EXTRA = 'from another extension';
    const hooks = new Map<string, () => void>();
    const holdLook = (pi: ExtensionAPI): void => {
      pi.on('input', async (event) => {
        if (event.source === 'extension' && event.text === LOOK) await new Promise<void>((resolve) => hooks.set(LOOK, resolve));
        return undefined;
      });
    };
    const { tool, store } = wire(shell, () => undefined, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Skipped.'), fauxAssistantMessage('Extra.')], holdLook);
    bindPanel(panel, session);
    readyToSend(panel);
    installTurnDecider(session.agent as unknown as Agent, BUDGET_STOP_HOOK, () =>
      internals(panel)._budgetStopRequested ? { action: 'end' } : undefined);

    const run = session.prompt(PROMPT);
    await shell.started;
    expect(await panel.sendMessage([{ type: 'text', text: LOOK }, SCREENSHOT], undefined, 'c1', { content: LOOK })).toBe('sent');
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...hooks.keys()]).toEqual([LOOK]));
    internals(panel).processingFlag = true;
    internals(panel).stopForBudget();
    await session.sendUserMessage(EXTRA, { deliverAs: 'followUp' });
    expect([...session.getFollowUpMessages()]).toEqual([EXTRA]);
    hooks.get(LOOK)!();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // pi continues a run on any queued message whatever the decider answers, which would bill past the limit.
    expect(session.pendingMessageCount).toBe(0);
    store.cancel('call-1');
    shell.release();
    await run;
    expect(contexts).toHaveLength(1);
    expect(userTexts(session)).toEqual([PROMPT]);
  });

  describe('a message a Stop withdrew that pi queues into a newer run once the Stop has wound down', () => {
    const NEXT = 'Next task.';
    const OTHER = 'and this one';
    const callAgain = fauxAssistantMessage(
      fauxToolCall('PowerShell', { command: 'Start-Sleep -Seconds 60; echo again' }, { id: 'call-2' }),
      { stopReason: 'toolUse' },
    );

    /** Holds the first extension-source input of each text in `held` until the test releases it. */
    function holding(held: readonly string[]): { hooks: Map<string, () => void>; extend: (pi: ExtensionAPI) => void } {
      const hooks = new Map<string, () => void>();
      const extend = (pi: ExtensionAPI): void => {
        pi.on('input', async (event) => {
          if (event.source === 'extension' && held.includes(event.text) && !hooks.has(event.text)) {
            await new Promise<void>((resolve) => hooks.set(event.text, resolve));
          }
          return undefined;
        });
      };
      return { hooks, extend };
    }

    it("takes only that follow-up out of the newer run, which keeps its own cancel note, queued prompt and image", async () => {
      const first = blockingShell();
      const second = blockingShell();
      let calls = 0;
      const shell = {
        ...first,
        definition: { ...first.definition, execute: (...args: unknown[]) => ((calls++ === 0 ? first : second).definition.execute as (...a: unknown[]) => unknown)(...args) },
      } as ReturnType<typeof blockingShell>;
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = panelSession(emitted);
      const bound: { session?: AgentSession } = {};
      const { hooks, extend } = holding([LOOK]);
      const { tool, store } = wire(shell, () => bound.session, panel);
      const replies = [callPowerShell, callAgain, fauxAssistantMessage('Done.'), fauxAssistantMessage('Answered.'), fauxAssistantMessage('Extra.')];
      const { session, contexts } = await boot(tool, replies, extend);
      bound.session = session;
      bindPanel(panel, session);
      readyToSend(panel);
      const withdrawn = vi.fn();
      const kept = vi.fn();

      const run = session.prompt(PROMPT).catch(() => undefined);
      await first.started;
      expect(await panel.sendMessage([{ type: 'text', text: LOOK }, SCREENSHOT], undefined, 'c1', { content: LOOK }, withdrawn)).toBe('sent');
      // The chip re-steers pi's queue, which re-queues the follow-up through the held input handler.
      expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
      await vi.waitFor(() => expect([...hooks.keys()]).toEqual([LOOK]));
      const stopped = panel.interrupt();
      first.release();
      await stopped;
      await run;
      // pi holds its re-queue with no verdict yet, which decides whether it went back.
      expect(withdrawn).not.toHaveBeenCalled();

      const next = session.prompt(NEXT);
      await second.started;
      expect(await panel.sendMessage([{ type: 'text', text: OTHER }, SCREENSHOT], undefined, 'c2', { content: OTHER }, kept)).toBe('sent');
      expect(store.cancel('call-2', NOTE)).toBe(true);
      await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual([NOTE]));
      hooks.get(LOOK)!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await vi.waitFor(() => expect([...session.getFollowUpMessages()]).toEqual([OTHER]));
      await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual([NOTE]));
      second.release();
      await next;

      expect(userTexts(session)).toEqual([PROMPT, NEXT, NOTE, OTHER]);
      expect(contexts[2]?.slice(-2)).toEqual(['toolResult: call-2', `user: ${NOTE}`]);
      expect(contexts.flat()).not.toContain(`user: ${LOOK}`);
      expect(userContent(session, OTHER)).toEqual([{ type: 'text', text: OTHER }, { type: 'image', data: PNG_DATA, mimeType: 'image/png' }]);
      expect(kept).not.toHaveBeenCalled();
      expect(withdrawn).toHaveBeenCalledOnce();
    });

    it('takes a prompt sent before the Stop out of the newer run, which keeps its own prompt of the same text, and returns it once', async () => {
      const first = blockingShell();
      const second = blockingShell();
      let calls = 0;
      const shell = {
        ...first,
        definition: { ...first.definition, execute: (...args: unknown[]) => ((calls++ === 0 ? first : second).definition.execute as (...a: unknown[]) => unknown)(...args) },
      } as ReturnType<typeof blockingShell>;
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = panelSession(emitted);
      const hooks = new Map<string, () => void>();
      // Another loaded pi extension, which holds the typed prompt while the Stop lands and winds down.
      const holdTyped = (pi: ExtensionAPI): void => {
        pi.on('input', async (event) => {
          if (event.source === 'interactive' && event.text === LOOK && !hooks.has(LOOK)) await new Promise<void>((resolve) => hooks.set(LOOK, resolve));
          return undefined;
        });
      };
      const { tool, store } = wire(shell, () => undefined, panel);
      const replies = [callPowerShell, callAgain, fauxAssistantMessage('Done.'), fauxAssistantMessage('Looked.')];
      const { session, contexts } = await boot(tool, replies, holdTyped);
      bindPanel(panel, session);
      readyToSend(panel);
      const withdrawn = vi.fn();
      const kept = vi.fn();

      const run = session.prompt(PROMPT).catch(() => undefined);
      await first.started;
      const sending = panel.sendMessage([{ type: 'text', text: LOOK }, SCREENSHOT], undefined, 'c1', { content: LOOK }, withdrawn);
      await vi.waitFor(() => expect([...hooks.keys()]).toEqual([LOOK]));
      const stopped = panel.interrupt();
      first.release();
      await stopped;
      await run;

      const next = session.prompt(NEXT);
      await second.started;
      expect(await panel.sendMessage([{ type: 'text', text: LOOK }, SCREENSHOT], undefined, 'c2', { content: LOOK }, kept)).toBe('sent');
      hooks.get(LOOK)!();
      expect(await sending).toBe('withdrawn');
      await vi.waitFor(() => expect([...session.getFollowUpMessages()]).toEqual([LOOK]));
      store.cancel('call-2');
      second.release();
      await next;

      expect(userTexts(session)).toEqual([PROMPT, NEXT, LOOK]);
      expect(contexts.at(-1)?.filter((line) => line === `user: ${LOOK}`)).toHaveLength(1);
      expect(userContent(session, LOOK)).toEqual([{ type: 'text', text: LOOK }, { type: 'image', data: PNG_DATA, mimeType: 'image/png' }]);
      expect(withdrawn).toHaveBeenCalledOnce();
      expect(kept).not.toHaveBeenCalled();
      expect(emitted.filter((m) => m.type === 'queueCancelled')).toEqual([{ type: 'queueCancelled', messageId: 'c1', returnToInput: true }]);
    });

    it('takes only that batch out of the newer run, which keeps its own queued prompt', async () => {
      const shell = blockingShell();
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = panelSession(emitted);
      const { hooks, extend } = holding([QUEUED]);
      const { tool, store } = wire(shell, () => undefined, panel);
      const replies = [callPowerShell, callAgain, fauxAssistantMessage('Done.'), fauxAssistantMessage('Answered.'), fauxAssistantMessage('Extra.')];
      const { session, contexts } = await boot(tool, replies, extend);
      bindPanel(panel, session);
      readyToSend(panel);

      const run = session.prompt(PROMPT).catch(() => undefined);
      await shell.started;
      expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
      await vi.waitFor(() => expect([...hooks.keys()]).toEqual([QUEUED]));
      const stopped = panel.interrupt();
      shell.release();
      await stopped;
      await run;

      const next = session.prompt(NEXT);
      await vi.waitFor(() => expect(contexts).toHaveLength(2));
      expect(await panel.sendMessage(OTHER, undefined, 'c2', { content: OTHER })).toBe('sent');
      hooks.get(QUEUED)!();
      await vi.waitFor(() => expect((panel as unknown as { resteerRunning: boolean }).resteerRunning).toBe(false));
      await vi.waitFor(() => expect([...session.getFollowUpMessages()]).toEqual([OTHER]));
      expect([...session.getSteeringMessages()]).toEqual([]);
      store.cancel('call-2');
      await next;

      expect(userTexts(session)).toEqual([PROMPT, NEXT, OTHER]);
      expect(contexts.flat()).not.toContain(`user: ${QUEUED}`);
      expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q1', returnToInput: true });
    });
  });

  it.each([
    ['reaches no model in the run pi still opens with it', false],
    ['never reaches the running run', true],
  ])("a folder switch returns a typed prompt pi's input handlers hold to the input once, with its text, image and chips, and it %s", async (_what, running) => {
    const shell = blockingShell();
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const hooks = new Map<string, () => void>();
    // Another loaded pi extension, which holds the typed prompt while the session is disposed.
    const holdTyped = (pi: ExtensionAPI): void => {
      pi.on('input', async (event) => {
        if (event.source === 'interactive' && event.text === LOOK) await new Promise<void>((resolve) => hooks.set(LOOK, resolve));
        return undefined;
      });
    };
    const { tool } = wire(shell, () => undefined, panel);
    const { session, contexts } = await boot(tool, [callPowerShell, fauxAssistantMessage('Looked.')], holdTyped);
    bindPanel(panel, session);
    readyToSend(panel);
    // The panel's disposal tears pi's session down, as the runtime does (agent-session-runtime.js:102-113).
    (panel as unknown as { runtime: { dispose: () => Promise<void> } }).runtime.dispose = async () => session.dispose();
    const withdrawn = vi.fn();
    const typed = [{ type: 'text' as const, text: LOOK }, SCREENSHOT];
    const returned = () => emitted.filter((m) => m.type === 'interruptRecovery' || m.type === 'queueCancelled');

    const run = running ? session.prompt(PROMPT).catch(() => undefined) : undefined;
    if (running) await shell.started;
    const sending = panel.sendMessage(typed, undefined, 'c1', { content: LOOK, contentBlocks: typed }, withdrawn);
    await vi.waitFor(() => expect([...hooks.keys()]).toEqual([LOOK]));
    const disposed = panel.dispose();

    expect(returned()).toEqual([{ type: 'interruptRecovery', correlationId: 'c1', promptContent: LOOK, contentBlocks: typed }]);
    expect(withdrawn).toHaveBeenCalledOnce();
    hooks.get(LOOK)!();
    shell.release();
    expect(await sending).toBe('withdrawn');
    await disposed;
    await run;

    expect(withdrawn).toHaveBeenCalledOnce();
    expect(returned()).toHaveLength(1);
    expect(session.pendingMessageCount).toBe(0);
    expect(contexts.flat()).not.toContain(`user: ${LOOK}`);
    // pi still opens a run with it on the disposed session, which reaches no model and, disconnected, records nothing.
    expect(typedTexts(session)).toEqual(running ? [PROMPT] : []);
    expect(contexts).toHaveLength(running ? 1 : 0);
  });

  describe('while a before_agent_start handler holds a prompt, which pi already counts as busy', () => {
    const FIRST = 'Look at the logs.';
    const SECOND = 'Try again.';
    const THIRD = 'One more thing.';
    const replies = () => ['First.', 'Second.', 'Third.'].map((text) => fauxAssistantMessage(text));

    /** Holds the run each user prompt in `held` starts until the test releases it. */
    function holdingStart(held: readonly string[]): { gate: Array<() => void>; extend: (pi: ExtensionAPI) => void } {
      const gate: Array<() => void> = [];
      const extend = (pi: ExtensionAPI): void => {
        pi.on('before_agent_start', async (event) => {
          if (event.messageType === 'user' && held.includes(event.prompt)) await new Promise<void>((resolve) => gate.push(resolve));
          return undefined;
        });
      };
      return { gate, extend };
    }

    /** How many custom messages of `customType` the branch holds and the agent's context carries. */
    const customCount = (session: AgentSession, customType: string): { branch: number; context: number } => ({
      branch: session.sessionManager.getBranch().filter((e) => e.type === 'custom_message' && e.customType === customType).length,
      context: session.agent.state.messages.filter((m) => m.role === 'custom' && m.customType === customType).length,
    });

    it('a Stop stops the run before any request, the prompt stays sent and is not returned, and the next send runs to completion', async () => {
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = panelSession(emitted);
      const { gate, extend } = holdingStart([FIRST]);
      const { session, contexts } = await boot(blockingShell().definition, replies(), extend);
      bindPanel(panel, session);
      readyToSend(panel);

      const sending = panel.sendMessage(FIRST, undefined, 'c1', { content: FIRST });
      await vi.waitFor(() => expect(gate).toHaveLength(1));
      const stopped = panel.interrupt();
      gate.shift()!();
      expect(await sending).toBe('sent');
      await stopped;
      expect(session.isIdle).toBe(true);
      expect(contexts).toHaveLength(0);
      expect(userTexts(session)).toEqual([FIRST]);
      expect(emitted.some((m) => m.type === 'interruptRecovery' || m.type === 'queueCancelled')).toBe(false);
      expect(emitted).toContainEqual(expect.objectContaining({ type: 'userMessage', correlationId: 'c1', content: FIRST }));
      expect(await panel.sendMessage(SECOND, undefined, 'c2', { content: SECOND })).toBe('sent');

      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.at(-1)).toBe(`user: ${SECOND}`);
      expect(userTexts(session)).toEqual([FIRST, SECOND]);
      expect(session.isIdle).toBe(true);
    });

    it("a send right after a Stop that caught a prompt in pi's input handlers waits for that prompt's stopped run, then runs", async () => {
      const emitted: ExtensionToWebviewMessage[] = [];
      const panel = panelSession(emitted);
      const hooks: Array<() => void> = [];
      // A UserPromptSubmit-like handler that holds the first prompt before pi opens its run.
      const holdFirst = (pi: ExtensionAPI): void => {
        pi.on('input', async (event) => {
          if (event.text === FIRST) await new Promise<void>((resolve) => hooks.push(resolve));
          return undefined;
        });
      };
      const { session, contexts } = await boot(blockingShell().definition, replies(), holdFirst);
      bindPanel(panel, session);
      readyToSend(panel);

      const first = panel.sendMessage(FIRST, undefined, 'c1', { content: FIRST });
      await vi.waitFor(() => expect(hooks).toHaveLength(1));
      await panel.interrupt();
      const second = panel.sendMessage(SECOND, undefined, 'c2', { content: SECOND });
      hooks.shift()!();

      expect(await first).toBe('sent');
      expect(await second).toBe('sent');
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.at(-1)).toBe(`user: ${SECOND}`);
      expect(userTexts(session)).toEqual([FIRST, SECOND]);
      expect(emitted.some((m) => m.type === 'error' || m.type === 'interruptRecovery')).toBe(false);
      expect(session.isIdle).toBe(true);
    });

    it('a message queued meanwhile steers into the run the held prompt opens', async () => {
      const panel = panelSession([]);
      const { gate, extend } = holdingStart([FIRST]);
      const { session, contexts } = await boot(blockingShell().definition, replies(), extend);
      bindPanel(panel, session);
      readyToSend(panel);

      const sending = panel.sendMessage(FIRST, undefined, 'c1', { content: FIRST });
      await vi.waitFor(() => expect(gate).toHaveLength(1));
      expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
      await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual([QUEUED]));
      gate.shift()!();
      expect(await sending).toBe('sent');

      expect(userTexts(session)).toEqual([FIRST, QUEUED]);
      expect(contexts.at(-1)?.at(-1)).toBe(`user: ${QUEUED}`);
      expect(session.isIdle).toBe(true);
    });

    it('background results no turn delivered reach the model once when a send arrives while another run starts', async () => {
      const panel = panelSession([]);
      const { gate, extend } = holdingStart([FIRST]);
      const { session } = await boot(blockingShell().definition, replies(), extend);
      bindPanel(panel, session);
      readyToSend(panel);
      const finished = { id: 'agent-1', toolCallId: 'tc-1', type: 'Explore', description: 'look around', status: 'completed', result: 'found it' };
      (panel as unknown as { subagentManager: unknown }).subagentManager = {
        deliverableLive: () => [finished],
        getRecord: () => undefined,
        liveStatus: () => undefined,
      };

      const run = session.prompt(FIRST);
      await vi.waitFor(() => expect(gate).toHaveLength(1));
      expect(await panel.sendMessage(SECOND, undefined, 'c1', { content: SECOND })).toBe('sent');
      gate.shift()!();
      await run;
      expect(await panel.sendMessage(THIRD, undefined, 'c2', { content: THIRD })).toBe('sent');

      expect(userTexts(session)).toEqual([FIRST, SECOND, THIRD]);
      expect(customCount(session, SUBAGENT_RESULTS_CUSTOM_TYPE)).toEqual({ branch: 1, context: 1 });
    });

    it('the interruption notice reaches the model once when a send arrives while another run starts', async () => {
      const panel = panelSession([]);
      const { gate, extend } = holdingStart([FIRST]);
      const { session } = await boot(blockingShell().definition, replies(), extend);
      bindPanel(panel, session);
      readyToSend(panel);
      session.sessionManager.appendCustomEntry(DAMOCLES_AGENT_INVOCATION_ENTRY, { kind: 'subagent', id: 'agent-1', toolCallId: 'tc-1', resume: false });
      (panel as unknown as { interruptionCheckPending: boolean }).interruptionCheckPending = true;

      const run = session.prompt(FIRST);
      await vi.waitFor(() => expect(gate).toHaveLength(1));
      expect(await panel.sendMessage(SECOND, undefined, 'c1', { content: SECOND })).toBe('sent');
      gate.shift()!();
      await run;
      (panel as unknown as { interruptionCheckPending: boolean }).interruptionCheckPending = true;
      expect(await panel.sendMessage(THIRD, undefined, 'c2', { content: THIRD })).toBe('sent');

      expect(userTexts(session)).toEqual([FIRST, SECOND, THIRD]);
      expect(customCount(session, DAMOCLES_INTERRUPTION_NOTICE)).toEqual({ branch: 1, context: 1 });
    });

    it('the working-folder note reaches the model once when it lands while a run starts', async () => {
      const panel = panelSession([]);
      const { gate, extend } = holdingStart([FIRST]);
      const { session } = await boot(blockingShell().definition, replies(), extend);
      bindPanel(panel, session);
      readyToSend(panel);
      const note = workingFolderNote('/elsewhere');
      const noteCount = () => session.sessionManager.getBranch().filter((e) => e.type === 'custom_message' && e.content === note).length;

      const run = session.prompt(FIRST);
      await vi.waitFor(() => expect(gate).toHaveLength(1));
      panel.noteWorkingFolder('/elsewhere');
      gate.shift()!();
      await run;
      expect(await panel.sendMessage(SECOND, undefined, 'c1', { content: SECOND })).toBe('sent');

      expect(userTexts(session)).toEqual([FIRST, SECOND]);
      expect(noteCount()).toBe(1);
      expect(session.agent.state.messages.filter((m) => m.role === 'custom' && m.content === note)).toHaveLength(1);
    });
  });

  it('names each prompt by its own user entry, not the one before it', async () => {
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const { session } = await boot(blockingShell().definition, [fauxAssistantMessage('One.'), fauxAssistantMessage('Two.')]);
    bindPanel(panel, session);
    const inner = internals(panel);
    inner.startPromise = Promise.resolve();
    inner.titleGenerationAttempted = true;
    inner.budgetLimitForEnforcement = () => null;
    inner.adapter.subscribe(session);

    await panel.sendMessage('first', undefined, 'c1', { content: 'first' });
    await panel.sendMessage('second', undefined, 'c2', { content: 'second' });

    const ids = session.sessionManager.getBranch().flatMap((e) => (e.type === 'message' && e.message.role === 'user' ? [e.id] : []));
    expect(ids).toHaveLength(2);
    expect(emitted.filter((m) => m.type === 'userMessageIdAssigned')).toEqual([
      { type: 'userMessageIdAssigned', correlationId: 'c1', sdkMessageId: ids[0] },
      { type: 'userMessageIdAssigned', correlationId: 'c2', sdkMessageId: ids[1] },
    ]);
  });

  // Guards that the fixture's seated PiRuntime leaves the model check on: pi's own auth refusal would return `promptRejected`.
  it('refuses a send once the model pi is seated on has lost its credential, before pi sees it', async () => {
    // pi also reads Anthropic credentials from these variables, which would keep the model signed in.
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN']) vi.stubEnv(name, undefined);
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const { session, contexts } = await boot(blockingShell().definition, [fauxAssistantMessage('Unused.')]);
    bindPanel(panel, session);
    readyToSend(panel);
    await PiRuntime.get().modelRuntime!.removeRuntimeApiKey('anthropic');

    expect(await panel.sendMessage('first', undefined, 'c1', { content: 'first' })).toBe('unsent');

    expect(emitted.filter((m) => m.type === 'promptReturned')).toEqual([
      { type: 'promptReturned', content: [{ type: 'text', text: 'first' }], reason: 'modelSignInRequired', account: 'anthropic', correlationId: 'c1' },
    ]);
    expect(contexts).toEqual([]);
    expect(userTexts(session)).toEqual([]);
  });
});
