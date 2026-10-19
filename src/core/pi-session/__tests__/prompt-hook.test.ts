import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSession, ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { HOOK_CONTEXT_CUSTOM_TYPE, registerConfiguredHooks, type DispatchDeps } from '../hooks';
import type { PiSession } from '../pi-session';
import { bindPanel, blockingShell, callPowerShell, panelSession, realPiSessions, wire } from './real-pi-fixtures';

/** Damocles' UserPromptSubmit hook against pi's real prompt path, with a scripted model and real hook processes. */

const SLOW = 'slow prompt';

const say = (...texts: string[]): FauxResponseStep[] => texts.map((text) => fauxAssistantMessage(text));

interface Internals {
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

const notices = (emitted: readonly ExtensionToWebviewMessage[]): string[] =>
  emitted.flatMap((m) => (m.type === 'notification' ? [m.message] : []));

const userTexts = (session: AgentSession): string[] =>
  session.sessionManager.getBranch().flatMap((e) => {
    if (e.type !== 'message' || e.message.role !== 'user') return [];
    const content = e.message.content;
    return [typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join('')];
  });

const hookContextEntries = (session: AgentSession): unknown[] =>
  session.sessionManager.getBranch().filter((e) => e.type === 'custom_message' && e.customType === HOOK_CONTEXT_CUSTOM_TYPE);

/**
 * A UserPromptSubmit hook that appends each prompt it judges to `judged.jsonl`, then runs `answer` with the prompt in `p`.
 * A prompt containing `SLOW` writes the hook's pid and holds the hook for 30 s before it writes `done`.
 */
function judgingHook(answer: string): { entries: Record<string, unknown[]>; judged: () => string[]; pid: () => number | undefined; finished: () => boolean; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-prompt-hook-'));
  const log = path.join(dir, 'judged.jsonl');
  const pidFile = path.join(dir, 'pid');
  const doneFile = path.join(dir, 'done');
  const script = [
    "const fs = require('fs');",
    "let s = '';",
    "process.stdin.on('data', (d) => { s += d; }).on('end', () => {",
    '  const p = JSON.parse(s).prompt;',
    `  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(p) + '\\n');`,
    `  if (p.includes(${JSON.stringify(SLOW)})) {`,
    `    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `    setTimeout(() => fs.writeFileSync(${JSON.stringify(doneFile)}, 'done'), 30000);`,
    '    return;',
    '  }',
    `  ${answer}`,
    '});',
  ].join('\n');
  return {
    entries: { input: [{ command: [process.execPath, '-e', script] }] },
    judged: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string) : []),
    pid: () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : undefined),
    finished: () => fs.existsSync(doneFile),
    dir,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const HOLD = 'hold me';

/**
 * Two UserPromptSubmit hooks, run in order. The first blocks a prompt containing `forbidden`. On a prompt containing `HOLD`
 * it starts a child of its own, writes both pids, and after 3 s writes `answered` and blocks; the second writes `later` when it
 * runs on such a prompt.
 */
function screeningHooks(): { entries: Record<string, unknown[]>; pids: () => number[] | undefined; answered: () => boolean; laterRan: () => boolean; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-screen-hook-'));
  const pidFile = path.join(dir, 'pids');
  const answeredFile = path.join(dir, 'answered');
  const laterFile = path.join(dir, 'later');
  const read = "let s = ''; process.stdin.on('data', (d) => { s += d; }).on('end', () => { const p = JSON.parse(s).prompt;";
  const first = [
    read,
    `  if (p.includes(${JSON.stringify(HOLD)})) {`,
    "    const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });",
    `    require('fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid);`,
    `    setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(answeredFile)}, 'answered'); process.stdout.write(JSON.stringify({ decision: 'block', reason: 'late verdict' })); process.exit(0); }, 3000);`,
    '    return;',
    '  }',
    "  if (p.includes('forbidden')) process.stdout.write(JSON.stringify({ decision: 'block', reason: 'no forbidden words' }));",
    '});',
  ].join('\n');
  const second = `${read} if (p.includes(${JSON.stringify(HOLD)})) require('fs').writeFileSync(${JSON.stringify(laterFile)}, 'ran'); });`;
  return {
    entries: { input: [{ command: [process.execPath, '-e', first] }, { command: [process.execPath, '-e', second] }] },
    pids: () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').split(' ').map(Number) : undefined),
    answered: () => fs.existsSync(answeredFile),
    laterRan: () => fs.existsSync(laterFile),
    dir,
  };
}

/** A PowerShell tool whose every call waits for `finish()` or its abort, so a test picks the boundary a queued message reaches. */
function steppedShell(): { definition: ToolDefinition; calls: () => number; finish: () => void } {
  const waiting: Array<() => void> = [];
  let calls = 0;
  const definition = {
    name: 'PowerShell',
    label: 'PowerShell',
    description: 'Run a PowerShell command',
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_id: string, _params: unknown, signal?: AbortSignal) => {
      calls++;
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        signal?.addEventListener('abort', () => {
          waiting.splice(waiting.indexOf(resolve), 1);
          resolve();
        }, { once: true });
      });
      return { content: [{ type: 'text', text: 'ok' }], details: undefined };
    },
  } as unknown as ToolDefinition;
  return { definition, calls: () => calls, finish: () => waiting.shift()?.() };
}

const shellCall = (id: string): FauxResponseStep =>
  fauxAssistantMessage(fauxToolCall('PowerShell', { command: 'echo hi' }, { id }), { stopReason: 'toolUse' });

describe('the UserPromptSubmit hook runs before pi', () => {
  const { boot, dispose } = realPiSessions();
  const dirs: string[] = [];

  afterEach(() => {
    dispose();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A panel on a real pi session whose folder has `hook` configured, with the configured-hooks extension loaded as the
   * folder's Damocles extension loads it. `extend` adds another pi extension, and `tool` replaces the blocking shell.
   */
  async function hookedPanel(
    hook: { entries: Record<string, unknown[]>; dir: string },
    responses: FauxResponseStep[],
    extend?: (pi: ExtensionAPI) => void,
    tool?: ToolDefinition,
  ) {
    dirs.push(hook.dir);
    const emitted: ExtensionToWebviewMessage[] = [];
    const panel = panelSession(emitted);
    const dispatch: DispatchDeps = {
      config: { getEntries: (key: string) => hook.entries[key] ?? [], hasEntries: (key: string) => (hook.entries[key] ?? []).length > 0 } as never,
      workspaceRoot: process.cwd(),
      userHome: os.homedir(),
    };
    const shell = blockingShell();
    const wired = wire(shell, () => undefined, panel);
    const configured = (pi: ExtensionAPI): void => {
      registerConfiguredHooks(pi, {
        dispatch,
        registry: { get: () => ({ postMessage: (message) => emitted.push(message) }) },
      });
      extend?.(pi);
    };
    const { session, contexts } = await boot(tool ?? wired.tool, responses, configured);
    bindPanel(panel, session);
    readyToSend(panel);
    Object.assign(panel, { folder: { getHooksDispatchDeps: () => dispatch, services: { settingsManager: session.settingsManager } } });
    return { panel, session, contexts, emitted, shell, store: wired.store };
  }

  it('runs the hook once per sent prompt, and none of pi\'s input handlers runs it again', async () => {
    const hook = judgingHook('');
    const { panel, contexts } = await hookedPanel(hook, say('One.', 'Two.'));

    expect(await panel.sendMessage('first', undefined, 'c1', { content: 'first' })).toBe('sent');
    expect(await panel.sendMessage('second', undefined, 'c2', { content: 'second' })).toBe('sent');

    expect(hook.judged()).toEqual(['first', 'second']);
    expect(contexts.map((context) => context.at(-1))).toEqual(['user: first', 'user: second']);
  });

  it('gives the hook the typed /name args of a skill or template, not the text pi is handed', async () => {
    const hook = judgingHook('');
    const { panel } = await hookedPanel(hook, say('Skill.', 'Template.', 'Plain.'));

    expect(await panel.sendMessage('Execute skill review\nAdditional info: src', undefined, 'c1', { content: '/review src' })).toBe('sent');
    expect(await panel.sendMessage('<terminal_output>FAIL</terminal_output>\nreview prompt body src', undefined, 'c2', { content: '/review src' })).toBe('sent');
    // A prompt with nothing typed behind it, such as a plan's continuation, is judged as sent.
    expect(await panel.sendMessage('continue with the plan')).toBe('sent');

    expect(hook.judged()).toEqual(['/review src', '/review src', 'continue with the plan']);
  });

  it('a block shows its reason, sends nothing, keeps the echo, and the next message runs', async () => {
    const hook = judgingHook("if (p.includes('forbidden')) process.stdout.write(JSON.stringify({ decision: 'block', reason: 'no forbidden words' }));");
    const { panel, session, contexts, emitted } = await hookedPanel(hook, say('Allowed.'));
    const withdrawn = vi.fn();
    const entries = [...session.sessionManager.getEntries()];

    expect(await panel.sendMessage('forbidden one', undefined, 'c1', { content: 'forbidden one' }, withdrawn)).toBe('unsent');

    expect(notices(emitted)).toContain('no forbidden words');
    const echo = emitted.findIndex((m) => m.type === 'userMessage' && m.correlationId === 'c1' && m.content === 'forbidden one');
    expect(echo).toBeGreaterThanOrEqual(0);
    expect(emitted.slice(echo)).toContainEqual({ type: 'processing', isProcessing: false });
    expect(emitted.some((m) => m.type === 'interruptRecovery')).toBe(false);
    expect(withdrawn).not.toHaveBeenCalled();
    expect(contexts).toHaveLength(0);
    expect(session.sessionManager.getEntries()).toEqual(entries);
    expect(panel.processing).toBe(false);

    expect(await panel.sendMessage('allowed', undefined, 'c2', { content: 'allowed' })).toBe('sent');
    expect(contexts.map((context) => context.at(-1))).toEqual(['user: allowed']);
    expect(hook.judged()).toEqual(['forbidden one', 'allowed']);
  });

  it("delivers the hook's context to the run its prompt opens as one hidden message, and to no later run", async () => {
    const hook = judgingHook("if (p === 'one') process.stdout.write('CTX-ONE');");
    const { panel, session, contexts } = await hookedPanel(hook, say('One.', 'Two.'));

    expect(await panel.sendMessage('one', undefined, 'c1', { content: 'one' })).toBe('sent');
    expect(await panel.sendMessage('two', undefined, 'c2', { content: 'two' })).toBe('sent');

    expect(contexts[0]).toContain('user: CTX-ONE');
    expect(contexts[1]?.filter((line) => line === 'user: CTX-ONE')).toHaveLength(1);
    expect(hookContextEntries(session)).toEqual([expect.objectContaining({ customType: HOOK_CONTEXT_CUSTOM_TYPE, content: 'CTX-ONE', display: false })]);
  });

  it('runs no hook for an extension command, which pi runs before its input handlers', async () => {
    const hook = judgingHook('');
    const ran = vi.fn();
    const { panel } = await hookedPanel(hook, [], (pi) => {
      pi.registerCommand('todos', { description: 'List todos', handler: async () => { ran(); } });
    });

    expect(await panel.sendMessage('/todos', undefined, 'c1', { content: '/todos' })).toBe('unsent');

    expect(ran).toHaveBeenCalledOnce();
    expect(hook.judged()).toEqual([]);
  });

  it('a Stop during the hook kills it, returns the message, writes nothing, and the next message runs', async () => {
    const hook = judgingHook('');
    const { panel, session, contexts, emitted } = await hookedPanel(hook, say('Next.'));
    const withdrawn = vi.fn();
    const entries = [...session.sessionManager.getEntries()];

    const sending = panel.sendMessage(SLOW, undefined, 'c1', { content: SLOW }, withdrawn);
    await vi.waitFor(() => expect(hook.pid()).toBeDefined(), { timeout: 10_000 });
    panel.cancel();

    expect(await sending).toBe('withdrawn');
    expect(emitted).toContainEqual({ type: 'interruptRecovery', correlationId: 'c1', promptContent: SLOW });
    expect(withdrawn).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(alive(hook.pid()!)).toBe(false), { timeout: 10_000 });
    expect(hook.finished()).toBe(false);
    expect(contexts).toHaveLength(0);
    expect(session.sessionManager.getEntries()).toEqual(entries);

    expect(await panel.sendMessage('next', undefined, 'c2', { content: 'next' })).toBe('sent');
    expect(contexts.map((context) => context.at(-1))).toEqual(['user: next']);
    expect(userTexts(session)).toEqual(['next']);
  }, 20_000);

  it("drops a queued message's hook context with the message when a Stop returns it, so no later run gets it", async () => {
    const hook = judgingHook("if (p === 'queued') process.stdout.write('CTX-QUEUED');");
    const { panel, session, contexts, shell } = await hookedPanel(hook, [callPowerShell, ...say('Fresh.')]);

    const run = session.prompt('Run Start-Sleep -Seconds 60; echo done in PowerShell.').catch(() => undefined);
    await shell.started;
    expect(panel.queueInput('queued', 'q1')).toBe('queued');
    await vi.waitFor(() => expect(hook.judged()).toContain('queued'), { timeout: 10_000 });
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual(['queued']), { timeout: 10_000 });
    const stopped = panel.interrupt();
    shell.release();
    await stopped;
    await run;

    expect(await panel.sendMessage('fresh', undefined, 'c1', { content: 'fresh' })).toBe('sent');
    expect(contexts.at(-1)?.at(-1)).toBe('user: fresh');
    expect(contexts.flat()).not.toContain('user: CTX-QUEUED');
    expect(hookContextEntries(session)).toEqual([]);
  }, 20_000);

  it('a prompt pi refuses owes its context to no run, and its re-send delivers the context once', async () => {
    const hook = judgingHook("if (p === 'refused') process.stdout.write('CTX-REFUSED');");
    let interlope = true;
    const { panel, session, contexts } = await hookedPanel(hook, say('Interloper.', 'Resent.'), (pi) => {
      let started!: () => void;
      const running = new Promise<void>((resolve) => { started = resolve; });
      pi.on('agent_start', () => started());
      // Another extension opens a run while pi's input handlers hold the prompt, so pi refuses it as already processing.
      pi.on('input', async (event) => {
        if (event.source !== 'interactive' || !interlope) return undefined;
        interlope = false;
        pi.sendUserMessage('interloper');
        await running;
        return undefined;
      });
    });

    expect(await panel.sendMessage('refused', undefined, 'c1', { content: 'refused' })).toBe('unsent');
    await session.waitForIdle();
    expect(await panel.sendMessage('refused', undefined, 'c2', { content: 'refused' })).toBe('sent');

    expect(hook.judged()).toEqual(['refused', 'refused']);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).not.toContain('user: CTX-REFUSED');
    expect(contexts[1]?.filter((line) => line === 'user: CTX-REFUSED')).toHaveLength(1);
    expect(hookContextEntries(session)).toEqual([expect.objectContaining({ content: 'CTX-REFUSED' })]);
  }, 20_000);

  it('a prompt an input handler consumes takes its context with it, so the next run carries none', async () => {
    const hook = judgingHook("if (p === 'consumed') process.stdout.write('CTX-HANDLED');");
    const { panel, session, contexts } = await hookedPanel(hook, say('Next.'), (pi) => {
      pi.on('input', (event) => (event.text === 'consumed' ? { action: 'handled' as const } : undefined));
    });

    expect(await panel.sendMessage('consumed', undefined, 'c1', { content: 'consumed' })).toBe('unsent');
    expect(await panel.sendMessage('next', undefined, 'c2', { content: 'next' })).toBe('sent');

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).not.toContain('user: CTX-HANDLED');
    expect(hookContextEntries(session)).toEqual([]);
  }, 20_000);

  it('a prompt a Stop overtook after pi took it leaves its context to no run, though pi still opens one with it', async () => {
    const hook = judgingHook("if (p === 'held') process.stdout.write('CTX-HELD');");
    const gate: Array<() => void> = [];
    const { panel, session, contexts } = await hookedPanel(hook, say('Next.'), (pi) => {
      pi.on('before_agent_start', async (event) => {
        if (event.messageType === 'user' && event.prompt === 'held') await new Promise<void>((resolve) => gate.push(resolve));
        return undefined;
      });
    });

    const sending = panel.sendMessage('held', undefined, 'c1', { content: 'held' });
    await vi.waitFor(() => expect(gate).toHaveLength(1), { timeout: 10_000 });
    const stopped = panel.interrupt();
    gate.shift()!();
    expect(await sending).toBe('sent');
    await stopped;
    expect(await panel.sendMessage('next', undefined, 'c2', { content: 'next' })).toBe('sent');

    expect(userTexts(session)).toEqual(['held', 'next']);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).not.toContain('user: CTX-HELD');
    expect(hookContextEntries(session)).toEqual([]);
  }, 20_000);

  it("delivers a queued message's context in the request that carries the message, and to no later run", async () => {
    const hook = judgingHook("if (p === 'queued') process.stdout.write('CTX-QUEUED');");
    const shell = steppedShell();
    const { panel, session, contexts } = await hookedPanel(hook, [shellCall('call-1'), ...say('Noted.', 'Fresh.')], undefined, shell.definition);
    internals(panel).adapter.subscribe(session);

    const run = panel.sendMessage('work', undefined, 'c0', { content: 'work' });
    await vi.waitFor(() => expect(shell.calls()).toBe(1));
    expect(panel.queueInput('queued', 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual(['queued']), { timeout: 10_000 });
    shell.finish();
    expect(await run).toBe('sent');
    expect(await panel.sendMessage('fresh', undefined, 'c1', { content: 'fresh' })).toBe('sent');

    expect(contexts).toHaveLength(3);
    expect(contexts[1]?.slice(-3)).toEqual(['toolResult: call-1', 'user: queued', 'user: CTX-QUEUED']);
    expect(contexts[2]?.filter((line) => line === 'user: CTX-QUEUED')).toHaveLength(1);
    expect(hookContextEntries(session)).toEqual([expect.objectContaining({ content: 'CTX-QUEUED', display: false })]);
  }, 20_000);

  it('delivers each queued message its own context once, with the message, at the boundary pi delivers it', async () => {
    const hook = judgingHook("if (p === 'first' || p === 'second') process.stdout.write('CTX-' + p.toUpperCase());");
    const shell = steppedShell();
    const { panel, session, contexts } = await hookedPanel(hook, [shellCall('call-1'), shellCall('call-2'), ...say('Done.')], undefined, shell.definition);
    internals(panel).adapter.subscribe(session);

    const run = panel.sendMessage('work', undefined, 'c0', { content: 'work' });
    await vi.waitFor(() => expect(shell.calls()).toBe(1));
    expect(panel.queueInput('first', 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual(['first']), { timeout: 10_000 });
    shell.finish();
    await vi.waitFor(() => expect(shell.calls()).toBe(2));
    expect(panel.queueInput('second', 'q2')).toBe('queued');
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual(['second']), { timeout: 10_000 });
    shell.finish();
    expect(await run).toBe('sent');

    expect(contexts).toHaveLength(3);
    expect(contexts[1]?.slice(-3)).toEqual(['toolResult: call-1', 'user: first', 'user: CTX-FIRST']);
    expect(contexts[1]).not.toContain('user: CTX-SECOND');
    expect(contexts[2]?.slice(-3)).toEqual(['toolResult: call-2', 'user: second', 'user: CTX-SECOND']);
    expect(contexts[2]?.filter((line) => line === 'user: CTX-FIRST')).toHaveLength(1);
    expect(hookContextEntries(session).map((e) => (e as { content: unknown }).content)).toEqual(['CTX-FIRST', 'CTX-SECOND']);
  }, 20_000);

  it("delivers the context of a prompt pi queues as a follow-up in the request that carries the prompt", async () => {
    const hook = judgingHook("if (p === 'later') process.stdout.write('CTX-LATER');");
    const shell = steppedShell();
    const { panel, session, contexts } = await hookedPanel(hook, [shellCall('call-1'), ...say('Done.', 'Later.')], undefined, shell.definition);

    const run = session.prompt('work');
    await vi.waitFor(() => expect(shell.calls()).toBe(1));
    expect(await panel.sendMessage('later', undefined, 'c1', { content: 'later' })).toBe('sent');
    expect([...session.getFollowUpMessages()]).toEqual(['later']);
    shell.finish();
    await run;

    expect(contexts).toHaveLength(3);
    expect(contexts[2]?.slice(-3)).toEqual(['assistant', 'user: later', 'user: CTX-LATER']);
    expect(hookContextEntries(session)).toEqual([expect.objectContaining({ content: 'CTX-LATER' })]);
  }, 20_000);

  it('a re-steer pass puts back the batch with exactly its own contexts, so each reaches the model once', async () => {
    const hook = judgingHook("if (p === 'a' || p === 'b') process.stdout.write('CTX-' + p.toUpperCase());");
    const shell = steppedShell();
    const { panel, session, contexts } = await hookedPanel(hook, [shellCall('call-1'), ...say('Noted.')], undefined, shell.definition);
    internals(panel).adapter.subscribe(session);

    const run = panel.sendMessage('work', undefined, 'c0', { content: 'work' });
    await vi.waitFor(() => expect(shell.calls()).toBe(1));
    expect(panel.queueInput('a', 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual(['a']), { timeout: 10_000 });
    expect(panel.queueInput('b', 'q2')).toBe('queued');
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual(['a\n\nb']), { timeout: 10_000 });
    shell.finish();
    expect(await run).toBe('sent');

    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.slice(-3)).toEqual(['toolResult: call-1', 'user: a\n\nb', 'user: CTX-A\n\nCTX-B']);
    expect(hookContextEntries(session).map((e) => (e as { content: unknown }).content)).toEqual(['CTX-A\n\nCTX-B']);
  }, 20_000);

  it("puts a follow-up's context back with it when a queued message re-steers pi's queue", async () => {
    const hook = judgingHook("if (p === 'later') process.stdout.write('CTX-LATER');");
    const shell = steppedShell();
    const { panel, session, contexts } = await hookedPanel(hook, [shellCall('call-1'), ...say('Done.', 'Later.')], undefined, shell.definition);

    const run = session.prompt('work');
    await vi.waitFor(() => expect(shell.calls()).toBe(1));
    expect(await panel.sendMessage('later', undefined, 'c1', { content: 'later' })).toBe('sent');
    expect(panel.queueInput('steer', 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual(['steer']), { timeout: 10_000 });
    await vi.waitFor(() => expect([...session.getFollowUpMessages()]).toEqual(['later']), { timeout: 10_000 });
    shell.finish();
    await run;

    expect(contexts).toHaveLength(3);
    expect(contexts[1]?.slice(-2)).toEqual(['toolResult: call-1', 'user: steer']);
    expect(contexts[2]?.slice(-3)).toEqual(['assistant', 'user: later', 'user: CTX-LATER']);
    expect(hookContextEntries(session)).toEqual([expect.objectContaining({ content: 'CTX-LATER' })]);
  }, 20_000);

  it("keeps a prompt's context through a re-steer that lands before its run's first drain, so each context reaches the model once", async () => {
    const hook = judgingHook("if (p === 'sent' || p === 'queued') process.stdout.write('CTX-' + p.toUpperCase());");
    const gate: Array<() => void> = [];
    const { panel, session, contexts } = await hookedPanel(hook, say('Done.'), (pi) => {
      pi.on('agent_start', async () => {
        if (gate.length === 0) await new Promise<void>((resolve) => gate.push(resolve));
      });
    });
    internals(panel).adapter.subscribe(session);

    const sending = panel.sendMessage('sent', undefined, 'c1', { content: 'sent' });
    await vi.waitFor(() => expect(gate).toHaveLength(1), { timeout: 10_000 });
    expect(panel.queueInput('queued', 'q1')).toBe('queued');
    await vi.waitFor(() => expect([...session.getSteeringMessages()]).toEqual(['queued']), { timeout: 10_000 });
    gate[0]!();
    expect(await sending).toBe('sent');

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toEqual(['user: sent', 'user: CTX-SENT', 'user: queued', 'user: CTX-QUEUED']);
    expect(hookContextEntries(session).map((e) => (e as { content: unknown }).content)).toEqual(['CTX-SENT', 'CTX-QUEUED']);
  }, 20_000);

  it("drops a batch's context with the batch when another extension's input handler consumes the re-steer", async () => {
    const hook = judgingHook("if (p === 'queued') process.stdout.write('CTX-QUEUED');");
    const shell = steppedShell();
    const { panel, session, contexts, emitted } = await hookedPanel(hook, [shellCall('call-1'), ...say('Done.')], (pi) => {
      // Screening runs the handlers as interactive input; the re-steer reaches them as input from an extension.
      pi.on('input', (event) => (event.source === 'extension' && event.text === 'queued' ? { action: 'handled' as const } : undefined));
    }, shell.definition);

    const run = panel.sendMessage('work', undefined, 'c0', { content: 'work' });
    await vi.waitFor(() => expect(shell.calls()).toBe(1));
    expect(panel.queueInput('queued', 'q1')).toBe('queued');
    await vi.waitFor(() => expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q1' }), { timeout: 10_000 });
    shell.finish();
    expect(await run).toBe('sent');

    expect(contexts).toHaveLength(2);
    expect(contexts.flat().some((line) => line.includes('queued') || line.includes('CTX-QUEUED'))).toBe(false);
    expect(hookContextEntries(session)).toEqual([]);
  }, 20_000);

  it("leaves a batch's context out of the stopped run pi opens with it after ESC overtook it in pi's hands", async () => {
    const hook = judgingHook("if (p === 'queued') process.stdout.write('CTX-QUEUED');");
    const shell = steppedShell();
    const held: Array<() => void> = [];
    const { panel, session, contexts } = await hookedPanel(hook, [shellCall('call-1'), ...say('Fresh.')], (pi) => {
      pi.on('input', async (event) => {
        if (event.source === 'extension') await new Promise<void>((resolve) => held.push(resolve));
        return undefined;
      });
    }, shell.definition);

    const run = session.prompt('work').catch(() => undefined);
    await vi.waitFor(() => expect(shell.calls()).toBe(1));
    expect(panel.queueInput('queued', 'q1')).toBe('queued');
    await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 10_000 });
    await panel.interrupt();
    await run;
    held.shift()!();
    await vi.waitFor(() => expect((panel as unknown as { resteerRunning: boolean }).resteerRunning).toBe(false));
    await session.waitForIdle();
    expect(userTexts(session)).toEqual(['work', 'queued']);
    expect(await panel.sendMessage('fresh', undefined, 'c1', { content: 'fresh' })).toBe('sent');

    expect(contexts.at(-1)?.at(-1)).toBe('user: fresh');
    expect(contexts.flat()).not.toContain('user: CTX-QUEUED');
    expect(hookContextEntries(session)).toEqual([]);
  }, 20_000);

  it('ESC returns a prompt pi queued as a follow-up together with its context, which no run gets', async () => {
    const hook = judgingHook("if (p === 'later') process.stdout.write('CTX-LATER');");
    const shell = steppedShell();
    const { panel, session, contexts, emitted } = await hookedPanel(hook, [shellCall('call-1'), ...say('Fresh.')], undefined, shell.definition);

    const run = session.prompt('work').catch(() => undefined);
    await vi.waitFor(() => expect(shell.calls()).toBe(1));
    expect(await panel.sendMessage('later', undefined, 'c1', { content: 'later' })).toBe('sent');
    await panel.interrupt();
    await run;
    expect(await panel.sendMessage('fresh', undefined, 'c2', { content: 'fresh' })).toBe('sent');

    expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'c1', returnToInput: true });
    expect(contexts.at(-1)?.at(-1)).toBe('user: fresh');
    expect(contexts.flat()).not.toContain('user: CTX-LATER');
    expect(hookContextEntries(session)).toEqual([]);
  }, 20_000);

  describe('a queued message still being screened', () => {
    it.each([
      ['a Stop', (panel: PiSession) => panel.interrupt()],
      ['a new chat', (panel: PiSession) => panel.reset()],
      ['a resume switch', (panel: PiSession) => panel.setResumeSession('another-conversation')],
      ['disposal', (panel: PiSession) => panel.dispose()],
    ])('%s kills its hook with the hook\'s children, runs no later hook, and lands no verdict', async (_name, stop) => {
      const hooks = screeningHooks();
      const shell = steppedShell();
      const { panel, session, contexts, emitted } = await hookedPanel(hooks, [shellCall('call-1')], undefined, shell.definition);

      const run = session.prompt('work').catch(() => undefined);
      await vi.waitFor(() => expect(shell.calls()).toBe(1));
      expect(panel.queueInput(`${HOLD} forbidden`, 'q1')).toBe('queued');
      await vi.waitFor(() => expect(hooks.pids()).toBeDefined(), { timeout: 10_000 });
      const [parent, child] = hooks.pids()!;
      await stop(panel);
      shell.finish();
      await run;

      await vi.waitFor(() => expect([alive(parent!), alive(child!)]).toEqual([false, false]), { timeout: 10_000 });
      // A hook that ends itself also takes its child with it on Windows, so the tree is gone only because it was killed if it never answered.
      expect(hooks.answered()).toBe(false);
      expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q1', returnToInput: true });
      // Past the moment the hook would have answered.
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      expect(hooks.laterRan()).toBe(false);
      expect(notices(emitted)).not.toContain('late verdict');
      expect(emitted.filter((m) => m.type === 'queueCancelled' && m.messageId === 'q1')).toHaveLength(1);
      expect(contexts.flat().some((line) => line.includes(HOLD))).toBe(false);
    }, 30_000);

    it('a message queued after a Stop killed one is judged as usual', async () => {
      const hooks = screeningHooks();
      const shell = steppedShell();
      const { panel, session, contexts, emitted } = await hookedPanel(hooks, [shellCall('call-1'), shellCall('call-2'), ...say('Done.')], undefined, shell.definition);

      const first = session.prompt('work').catch(() => undefined);
      await vi.waitFor(() => expect(shell.calls()).toBe(1));
      expect(panel.queueInput(HOLD, 'q1')).toBe('queued');
      await vi.waitFor(() => expect(hooks.pids()).toBeDefined(), { timeout: 10_000 });
      const [parent, child] = hooks.pids()!;
      await panel.interrupt();
      await first;
      await vi.waitFor(() => expect([alive(parent!), alive(child!)]).toEqual([false, false]), { timeout: 10_000 });

      const second = session.prompt('again');
      await vi.waitFor(() => expect(shell.calls()).toBe(2));
      expect(panel.queueInput('forbidden after', 'q2')).toBe('queued');
      await vi.waitFor(() => expect(emitted).toContainEqual({ type: 'queueCancelled', messageId: 'q2' }), { timeout: 10_000 });
      shell.finish();
      await second;

      expect(notices(emitted)).toEqual(['no forbidden words']);
      expect(contexts.flat().some((line) => line.includes('forbidden'))).toBe(false);
    }, 30_000);
  });
});
