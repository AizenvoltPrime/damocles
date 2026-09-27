import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Agent } from '@earendil-works/pi-agent-core';
import type { AgentSession, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { BUDGET_STOP_HOOK, installTurnDecider } from '../finish-turn';
import { registerConfiguredHooks } from '../hooks';
import type { PiSession } from '../pi-session';
import { bindPanel, blockingShell, callPowerShell, panelSession, realPiSessions, wire } from './real-pi-fixtures';

/** Queued typed input and cancel notes against pi's real queue and agent loop, with a scripted model. */

const PROMPT = 'Run Start-Sleep -Seconds 60; echo done in PowerShell.';
const NOTE = 'skip it';
const QUEUED = 'also check the logs';

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
