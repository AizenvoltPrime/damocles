import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Agent } from '@earendil-works/pi-agent-core';
import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { BUDGET_STOP_HOOK, installTurnDecider } from '../finish-turn';
import { registerConfiguredHooks } from '../hooks';
import type { PiSession } from '../pi-session';
import { bindPanel, blockingShell, callPowerShell, panelSession, realPiSessions, wire } from './real-pi-fixtures';

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
  emitted.flatMap((m) => (m.type === 'notification' ? [m.message] : []));

const userTexts = (session: AgentSession): string[] =>
  session.sessionManager.getBranch().flatMap((e) => {
    if (e.type !== 'message' || e.message.role !== 'user') return [];
    const content = e.message.content;
    return [typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join('')];
  });

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

  it('keeps a batch ESC withdrew out of pi when another extension\'s input handler returns after the run has ended', async () => {
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

    const run = session.prompt(PROMPT).catch(() => undefined);
    await shell.started;
    expect(panel.queueInput(QUEUED, 'q1')).toBe('queued');
    await vi.waitFor(() => expect(hooks).toHaveLength(1));
    const stopped = panel.interrupt();
    shell.release();
    await stopped;
    await run;
    expect(session.isStreaming).toBe(false);

    hooks.shift()!();
    await vi.waitFor(() => expect((panel as unknown as { resteerRunning: boolean }).resteerRunning).toBe(false));

    // Without the check, pi would find no run streaming and start one with the withdrawn batch.
    expect(session.isStreaming).toBe(false);
    expect(session.pendingMessageCount).toBe(0);
    expect(contexts.flat()).not.toContain(`user: ${QUEUED}`);
    expect(userTexts(session)).toEqual([PROMPT]);
    expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q1', returnToInput: true });
  });

  it('refuses the run a withdrawn batch would open, even when ESC lands after every input handler returned', async () => {
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
        if (event.prompt === QUEUED) await new Promise<void>((resolve) => startGate.push(resolve));
        return undefined;
      });
    };
    const { tool, store } = wire(shell, () => undefined, panel);
    const replies = ['First.', 'Second.'].map((text) => fauxAssistantMessage(text));
    const { session, contexts } = await boot(tool, [callPowerShell, ...replies], slowExtension);
    bindPanel(panel, session);

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
    await panel.interrupt();
    startGate.shift()!();
    await vi.waitFor(() => expect((panel as unknown as { resteerRunning: boolean }).resteerRunning).toBe(false));

    expect(session.isStreaming).toBe(false);
    expect(contexts).toHaveLength(2);
    expect(contexts.flat()).not.toContain(`user: ${QUEUED}`);
    expect(userTexts(session)).toEqual([PROMPT]);
    expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q1', returnToInput: true });
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
    const configuredHooks = (pi: ExtensionAPI): void =>
      registerConfiguredHooks(pi, {
        dispatch: {
          config: { getEntries: (key: string) => entries[key] ?? [], hasEntries: (key: string) => (entries[key] ?? []).length > 0 } as never,
          workspaceRoot: process.cwd(),
          userHome: os.homedir(),
        },
        registry: { get: () => ({ postMessage: (message) => emitted.push(message) }) },
        renameSession: async () => {},
      });
    const { tool, store } = wire(shell, () => bound.session, panel);
    const replies = ['Noted.', 'Checked.'].map((text) => fauxAssistantMessage(text));
    const { session, contexts } = await boot(tool, [callPowerShell, ...replies], configuredHooks);
    bound.session = session;
    bindPanel(panel, session);
    internals(panel).adapter.subscribe(session);

    const run = session.prompt(PROMPT);
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

    expect(withdrawn).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(1);
    expect(userTexts(session)).toEqual([PROMPT]);
  });

  it('keeps a queued prompt ESC returned from opening a run of its own when its re-queue lands after the run ended', async () => {
    const shell = blockingShell();
    const panel = panelSession([]);
    const hooks = new Map<string, () => void>();
    // The last handlers pi runs before it decides whether a prompt opens a run.
    const reachedStart: string[] = [];
    const slowInputHook = (pi: ExtensionAPI): void => {
      pi.on('input', async (event) => {
        if (event.source === 'extension') await new Promise<void>((resolve) => hooks.set(event.text, resolve));
        return undefined;
      });
      pi.on('before_agent_start', (event) => {
        reachedStart.push(event.prompt);
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
    for (const release of hooks.values()) release();
    await vi.waitFor(() => expect(reachedStart).toEqual(expect.arrayContaining([LOOK, QUEUED])));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await session.waitForIdle();

    expect(withdrawn).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(1);
    expect(userTexts(session)).toEqual([PROMPT]);
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
      expect(withdrawn).toHaveBeenCalledOnce();

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
    ['opens no run of its own', false],
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
    expect(userTexts(session)).toEqual(running ? [PROMPT] : []);
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
});
