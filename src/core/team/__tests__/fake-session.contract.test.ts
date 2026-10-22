import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { Agent } from '@earendil-works/pi-agent-core';
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type AssistantMessage, type FauxResponseFactory } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { withSettingsPolicy } from '../../pi-session/settings-policy';
import { installTurnDecider } from '../../pi-session/finish-turn';
import { abortRunAtStart } from '../../pi-session/abort-run-at-start';
import { createSubagentExtensionFactory } from '../../pi-session/subagents/subagent-extension-factory';
import { ShellCancelStore } from '../../pi-session/tools/shell-cancel-registry';
import { installPlanModeChangeNotice, planModeNoticeAtPromptStart } from '../../pi-session/plan-mode-change';
import type { GatePermissionContext } from '../../pi-session/permission-gate';
import type { HooksConfigService } from '../../pi-session/hooks/config';
import { buildUserDenyResult } from '../../permission-handler/utils';
import { teamPlanModeStatement } from '../prompts';
import { BUSY_PROMPT_ERROR, FakeSession } from './fake-session';

/**
 * Holds `FakeSession` to pi 1.4.0: each scenario runs against a real `AgentSession` on pi-ai's faux provider and
 * against the fake, and the two must report the same events, busy state and resolutions. The real session is built
 * the way `FolderRuntime.createSubagentSession` builds a team specialist's (steering drained whole, compaction off),
 * loading the extension `PiSession.buildTeamEngine` hands it: `createSubagentExtensionFactory` with hooks dispatch
 * and no hook configured, and the plan-mode notice, out of plan mode. Its gate's permission handler allows every
 * call and answers a call to `denied` as a user's deny without feedback.
 */

// Assembled from parts so the file holds no literal matching a secret scanner's token pattern.
const STUB_CREDENTIAL = ['sk', 'ant', 'oat01', 'stub'].join('-');
const MAX_RETRIES = 1;
const DECIDER = Symbol('contract.decider');

interface SessionUnderTest {
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp'; preflightResult?: (disposition: string) => void }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  readonly sessionManager: { getBranch(): unknown[] };
  waitForIdle(): Promise<void>;
  readonly isStreaming: boolean;
  readonly isIdle: boolean;
  subscribe(listener: (event: unknown) => void): () => void;
  readonly pendingMessageCount: number;
  getSteeringMessages(): readonly string[];
  getFollowUpMessages(): readonly string[];
  clearQueue(): { steering: string[]; followUp: string[] };
  readonly agent: unknown;
}

/** A session and its model: each live request stays open until the scenario answers it. */
interface Subject {
  session: SessionUnderTest;
  /** Resolves once the model has been asked `n` times under a live signal. */
  called(n: number): Promise<void>;
  requests(): number;
  reply(text: string): void;
  callTool(id: string): void;
  /** Answers with a call to a tool that runs until the run is aborted. */
  runTool(id: string): void;
  /** Answers with a call to `denied`, which the gate blocks as a user's deny without feedback. */
  denyTool(id: string): void;
  /** Runs `hook` once, right after a settling run's last queue check. */
  atLastQueueCheck(hook: () => void): void;
  /** Holds the `input` handler of the prompt of `text` until released (needs `SubjectOptions.input`). */
  holdInput(text: string): Hold;
  /** Holds the next `agent_before_settle` boundary until released (needs `SubjectOptions.beforeSettle`). */
  holdBeforeSettle(): Hold;
  fail(errorMessage: string): void;
}

/** Extension handlers a scenario adds to the session. */
interface SubjectOptions {
  input?: boolean;
  beforeSettle?: boolean;
}

interface Hold {
  /** Resolves once the handler holds. */
  entered: Promise<void>;
  release: () => void;
}

function makeHold(): Hold & { wait: () => Promise<void> } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release: () => release(), wait: async () => { enter(); await released; } };
}

/** One-shot holds keyed by what they hold, taken by the handler they hold. */
function holdRegistry(): { arm: (key: string) => Hold; take: (key: string) => Promise<void> } {
  const armed = new Map<string, () => Promise<void>>();
  return {
    arm: (key) => {
      const hold = makeHold();
      armed.set(key, hold.wait);
      return hold;
    },
    take: async (key) => {
      const wait = armed.get(key);
      armed.delete(key);
      await wait?.();
    },
  };
}

const BEFORE_SETTLE = 'agent_before_settle';

function requestCounter(): { count: () => number; bump: () => void; called: (n: number) => Promise<void> } {
  let calls = 0;
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  return {
    count: () => calls,
    bump: () => {
      calls++;
      for (const w of waiters.filter((x) => calls >= x.n)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    },
    called: (n) => (calls >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ n, resolve }))),
  };
}

const made: string[] = [];
const sessions: AgentSession[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

const noopTool = {
  name: 'noop',
  label: 'noop',
  description: 'Does nothing',
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
} as unknown as ToolDefinition;

const blockingTool = {
  name: 'block',
  label: 'block',
  description: 'Runs until aborted',
  parameters: Type.Object({}),
  execute: async (_id: string, _params: unknown, signal?: AbortSignal) => {
    await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('Operation aborted');
  },
} as unknown as ToolDefinition;

const deniedTool = { ...noopTool, name: 'denied', label: 'denied' } as unknown as ToolDefinition;

/** The extension a team specialist's session loads, as `PiSession.buildTeamEngine` composes it. */
function teamMemberExtension(cwd: string): ExtensionFactory {
  const statement = teamPlanModeStatement('specialist');
  const gate = createSubagentExtensionFactory({
    permissionHandler: {
      matchRule: async () => null,
      decide: () => 'ask',
      isPlanFile: () => false,
      canUseTool: async (name: string, input: Record<string, unknown>) =>
        (name === 'denied' ? buildUserDenyResult(undefined, 'The user rejected this call.') : { behavior: 'allow', updatedInput: input }),
    } as unknown as GatePermissionContext['permissionHandler'],
    isPlanMode: () => false,
    shellCancel: new ShellCancelStore().forContext(() => undefined),
    worktreeIsolation: () => undefined,
    readOnlyShell: false,
    parentToolUseId: 'member-1',
    stopSignal: new AbortController().signal,
    deferrableToolNames: [],
    hooks: { config: { hasEntries: () => false, getEntries: () => [] } as unknown as HooksConfigService, workspaceRoot: cwd, userHome: os.homedir() },
  });
  return async (pi) => {
    await gate(pi);
    pi.on('before_agent_start', (event, ctx) => {
      const message = planModeNoticeAtPromptStart(ctx.sessionManager.buildSessionProjection().messages, event.systemPromptOptions, false, statement);
      return message ? { message } : undefined;
    });
  };
}

async function realSubject(options: SubjectOptions): Promise<Subject> {
  const cwd = tempDir('dam-contract-cwd-');
  const agentDir = tempDir('dam-contract-agent-');
  const requests = requestCounter();
  let open: ((message: AssistantMessage) => void) | null = null;
  const step: FauxResponseFactory = (_context, options) => {
    // A request under an aborted signal still reaches the provider, whose stream then ends it aborted.
    if (options?.signal?.aborted) return fauxAssistantMessage('');
    return new Promise<AssistantMessage>((resolve) => {
      open = resolve;
      options?.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('')), { once: true });
      requests.bump();
    });
  };
  const faux = createFauxCore({ api: 'anthropic-messages', provider: 'anthropic', models: [{ id: 'claude-opus-5-5' }] });
  faux.setResponses(Array.from({ length: 32 }, () => step));
  const answer = (message: AssistantMessage): void => {
    const resolve = open;
    open = null;
    if (!resolve) throw new Error('no model call is open');
    resolve(message);
  };
  const fauxProvider = (pi: ExtensionAPI): void => {
    pi.registerProvider('anthropic', { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', streamSimple: faux.streamSimple } as never);
  };
  const inputHolds = holdRegistry();
  const beforeSettleHolds = holdRegistry();
  const scenarioHandlers = (pi: ExtensionAPI): void => {
    if (options.input) {
      pi.on('input', async (event) => {
        await inputHolds.take(event.text);
        return { action: 'continue' };
      });
    }
    if (options.beforeSettle) pi.on('agent_before_settle', async () => { await beforeSettleHolds.take(BEFORE_SETTLE); });
  };
  const settingsManager = withSettingsPolicy(SettingsManager.inMemory(
    { compaction: { enabled: false }, retry: { enabled: true, maxRetries: MAX_RETRIES, baseDelayMs: 1 }, cacheWarming: 'off' },
    { projectTrusted: true },
  ));
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey('anthropic', STUB_CREDENTIAL);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      extensionFactories: [fauxProvider, teamMemberExtension(cwd), scenarioHandlers],
      systemPromptOverride: () => 'You are a team specialist.',
      appendSystemPromptOverride: () => [],
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model: modelRuntime.getModel('anthropic', 'claude-opus-5-5')!,
    thinkingLevel: 'off',
    tools: ['noop', 'block', 'denied'],
    customTools: [noopTool, blockingTool, deniedTool],
  });
  sessions.push(session);
  // pi opens the session without the handlers of a factory that throws, reporting it only in the loader's errors.
  const loadErrors = services.resourceLoader.getExtensions().errors;
  if (loadErrors.length > 0 || !session.extensionRunner.hasHandlers('agent_settled')) {
    throw new Error(`the team extension did not load: ${JSON.stringify(loadErrors)}`);
  }
  session.setActiveToolsByName(['noop', 'block', 'denied']);
  session.setAutoCompactionEnabled(false);
  installPlanModeChangeNotice(session.agent, () => false, teamPlanModeStatement('specialist'));
  let lastQueueCheck: (() => void) | null = null;
  const internals = session as unknown as { _runBeforeSettleBoundary: () => Promise<boolean> };
  const runBeforeSettleBoundary = internals._runBeforeSettleBoundary.bind(session);
  internals._runBeforeSettleBoundary = async () => {
    const queued = await runBeforeSettleBoundary();
    const hook = lastQueueCheck;
    lastQueueCheck = null;
    if (!queued) hook?.();
    return queued;
  };
  return {
    session: session as unknown as SessionUnderTest,
    called: requests.called,
    requests: requests.count,
    reply: (text) => answer(fauxAssistantMessage(text)),
    callTool: (id) => answer(fauxAssistantMessage(fauxToolCall('noop', {}, { id }), { stopReason: 'toolUse' })),
    runTool: (id) => answer(fauxAssistantMessage(fauxToolCall('block', {}, { id }), { stopReason: 'toolUse' })),
    denyTool: (id) => answer(fauxAssistantMessage(fauxToolCall('denied', {}, { id }), { stopReason: 'toolUse' })),
    atLastQueueCheck: (hook) => { lastQueueCheck = hook; },
    holdInput: (text) => inputHolds.arm(text),
    holdBeforeSettle: () => beforeSettleHolds.arm(BEFORE_SETTLE),
    fail: (errorMessage) => answer(fauxAssistantMessage([], { stopReason: 'error', errorMessage })),
  };
}

function fakeSubject(options: SubjectOptions): Promise<Subject> {
  const requests = requestCounter();
  const fake = new FakeSession({ maxRetries: MAX_RETRIES, onModelCall: () => requests.bump() });
  const inputHolds = holdRegistry();
  const beforeSettleHolds = holdRegistry();
  if (options.input) fake.inputHandler = (text) => inputHolds.take(text);
  if (options.beforeSettle) fake.beforeSettle = () => beforeSettleHolds.take(BEFORE_SETTLE);
  return Promise.resolve({
    session: fake,
    called: requests.called,
    requests: requests.count,
    reply: (text) => void fake.endTurn(text),
    callTool: (id) => void fake.callTools([{ id, name: 'noop' }]),
    runTool: (id) => {
      fake.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
      fake.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'block', arguments: {} }], stopReason: 'toolUse' } });
      fake.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'block', args: {} });
    },
    denyTool: (id) => void fake.callTools([{ id, name: 'denied', isError: true, terminate: true }]),
    atLastQueueCheck: (hook) => {
      fake.atLastQueueCheck = () => {
        fake.atLastQueueCheck = null;
        hook();
      };
    },
    holdInput: (text) => inputHolds.arm(text),
    holdBeforeSettle: () => beforeSettleHolds.arm(BEFORE_SETTLE),
    fail: (errorMessage) => fake.failCall(errorMessage),
  });
}

type Event = { type: string; message?: { role: string; content?: unknown; stopReason?: string; errorMessage?: string }; [key: string]: unknown };

const textOf = (content: unknown): string =>
  (Array.isArray(content) ? content : []).map((p: { type?: string; text?: string }) => (p.type === 'text' ? p.text ?? '' : '')).join('');

/** One line per event a team agent's run can observe, with the busy state at that event. */
function describeEvent(e: Event, s: SessionUnderTest): string | null {
  const state = s.isStreaming ? 'busy' : 'idle';
  if (s.isIdle === s.isStreaming) throw new Error('isIdle must be the negation of isStreaming');
  switch (e.type) {
    case 'agent_start':
    case 'turn_start':
    case 'tool_execution_start':
    case 'tool_execution_end':
      return `${e.type} ${state}`;
    case 'message_start':
    case 'message_end': {
      const role = e.message?.role;
      if (role === 'system') return null;
      if (role === 'user') return `${e.type} user "${textOf(e.message?.content)}" ${state}`;
      if (role === 'assistant' && e.type === 'message_end') {
        const error = e.message?.errorMessage ? ` "${e.message.errorMessage}"` : '';
        return `message_end assistant ${e.message?.stopReason}${error} ${state}`;
      }
      return `${e.type} ${role} ${state}`;
    }
    case 'turn_end':
      return `turn_end ${e.message?.stopReason} ${state}`;
    case 'agent_end':
      return `agent_end willRetry=${String(e['willRetry'])} ${state}`;
    case 'agent_settled':
      return `agent_settled aborted=${String(e['aborted'])} ${state}`;
    case 'queue_update':
      return `queue_update steering=${JSON.stringify(e['steering'])} followUp=${JSON.stringify(e['followUp'])}`;
    case 'auto_retry_start':
      return `auto_retry_start ${String(e['attempt'])}/${String(e['maxAttempts'])}`;
    case 'auto_retry_end':
      return `auto_retry_end success=${String(e['success'])} attempt=${String(e['attempt'])}`;
    default:
      return null;
  }
}

/** Logs what the session's agent reports, which a disposed session no longer relays to its own listeners. */
function logAgentEvents(s: SessionUnderTest, log: string[]): void {
  (s.agent as Agent).subscribe((e) => {
    const line = describeEvent(e as Event, s);
    if (line) log.push(`agent ${line}`);
  });
}

/** The text of each user message the session persisted. */
const userTexts = (s: SessionUnderTest): string[] =>
  s.sessionManager.getBranch().flatMap((entry) => {
    const { type, message } = entry as { type?: string; message?: { role?: string; content?: unknown } };
    return type === 'message' && message?.role === 'user' ? [textOf(message.content)] : [];
  });

interface Script {
  subject: Subject;
  s: SessionUnderTest;
  log: string[];
  /** Records a checkpoint of the scenario in the event log. */
  mark: (label: string) => void;
  queue: () => string;
}

type Scenario = (script: Script) => Promise<void>;

async function runScenario(make: (options: SubjectOptions) => Promise<Subject>, scenario: Scenario, options: SubjectOptions): Promise<string[]> {
  const subject = await make(options);
  const s = subject.session;
  const log: string[] = [];
  s.subscribe(((e: Event) => {
    const line = describeEvent(e, s);
    if (line) log.push(line);
  }) as never);
  const mark = (label: string): void => { log.push(`# ${label} ${s.isStreaming ? 'busy' : 'idle'}`); };
  const queue = (): string =>
    `pending=${s.pendingMessageCount} steering=${JSON.stringify(s.getSteeringMessages())} followUp=${JSON.stringify(s.getFollowUpMessages())} ` +
    `peek=${(s.agent as Agent).peekQueuedMessages().length}`;
  await scenario({ subject, s, log, mark, queue });
  return log;
}

/** Runs `scenario` on real pi and on the fake, and returns real pi's log once the fake's matches it. */
async function contract(scenario: Scenario, options: SubjectOptions = {}): Promise<string[]> {
  const real = await runScenario(realSubject, scenario, options);
  const fake = await runScenario(fakeSubject, scenario, options);
  expect(fake).toEqual(real);
  return real;
}

const steer = { streamingBehavior: 'steer' } as const;
const followUp = { streamingBehavior: 'followUp' } as const;

describe('FakeSession matches pi 1.4.0', () => {
  it('runs an idle prompt busy from its start until agent_settled, and resolves prompt() after agent_settled', async () => {
    const log = await contract(async ({ subject, s, mark }) => {
      let resolved = false;
      s.subscribe(((e: Event) => { if (e.type === 'turn_end' || e.type === 'agent_end' || e.type === 'agent_settled') mark(`${e.type} prompt resolved=${resolved}`); }) as never);
      const run = s.prompt('hello').then(() => { resolved = true; });
      mark('prompt called');
      await subject.called(1);
      mark('model asked');
      subject.reply('hi');
      await run;
      mark('prompt resolved');
    });

    expect(log).toEqual([
      '# prompt called idle',
      'agent_start busy',
      'turn_start busy',
      'message_start user "hello" busy',
      'message_end user "hello" busy',
      '# model asked busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      '# turn_end prompt resolved=false busy',
      'agent_end willRetry=false busy',
      '# agent_end prompt resolved=false busy',
      'agent_settled aborted=false idle',
      '# agent_settled prompt resolved=false idle',
      '# prompt resolved idle',
    ]);
  });

  it('refuses a plain prompt while a run is busy, and leaves the run untouched', async () => {
    const errors: string[] = [];
    const log = await contract(async ({ subject, s, mark, queue }) => {
      const run = s.prompt('first');
      await subject.called(1);
      await s.prompt('second').catch((err: Error) => { errors.push(err.message); });
      mark(`refused ${queue()}`);
      subject.reply('done');
      await run;
    });

    expect(errors).toEqual([BUSY_PROMPT_ERROR, BUSY_PROMPT_ERROR]);
    expect(log.filter((l) => l.includes('"second"'))).toEqual([]);
    expect(log).toContain('# refused pending=0 steering=[] followUp=[] peek=0 busy');
  });

  it('holds steers until the open call ends, then delivers them all before the next call', async () => {
    const log = await contract(async ({ subject, s, mark, queue }) => {
      s.subscribe(((e: Event) => { if (e.type === 'message_start' && e.message?.role === 'user') mark(`at message_start ${queue()}`); }) as never);
      const run = s.prompt('task');
      await subject.called(1);
      await s.prompt('steer A', steer);
      await s.prompt('steer B', steer);
      mark(`queued ${queue()}`);
      subject.reply('first');
      await subject.called(2);
      mark(`second call ${queue()}`);
      subject.reply('second');
      await run;
    });

    expect(log.filter((l) => !l.startsWith('queue_update') && !l.startsWith('# at'))).toEqual([
      'agent_start busy',
      'turn_start busy',
      'message_start user "task" busy',
      'message_end user "task" busy',
      '# queued pending=2 steering=["steer A","steer B"] followUp=[] peek=2 busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'turn_start busy',
      'message_start user "steer A" busy',
      'message_end user "steer A" busy',
      'message_start user "steer B" busy',
      'message_end user "steer B" busy',
      '# second call pending=0 steering=[] followUp=[] peek=0 busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
    ]);
  });

  it('delivers a steer sent at agent_start right after the prompt, before the first call', async () => {
    const log = await contract(async ({ subject, s }) => {
      let sent = false;
      s.subscribe(((e: Event) => {
        if (e.type !== 'agent_start' || sent) return;
        sent = true;
        void s.prompt('early', steer);
      }) as never);
      const run = s.prompt('task');
      await subject.called(1);
      subject.reply('done');
      await run;
    });

    expect(log.filter((l) => l.startsWith('message_end'))).toEqual([
      'message_end user "task" busy',
      'message_end user "early" busy',
      'message_end assistant stop busy',
    ]);
  });

  it('delivers every waiting follow-up in one turn, after every steer', async () => {
    const log = await contract(async ({ subject, s }) => {
      const run = s.prompt('task');
      await subject.called(1);
      await s.prompt('follow 1', followUp);
      await s.prompt('follow 2', followUp);
      await s.prompt('steer', steer);
      for (let n = 1; n <= 2; n++) {
        subject.reply(`answer ${n}`);
        await subject.called(n + 1);
      }
      subject.reply('answer 3');
      await run;
    });

    expect(log.filter((l) => l.startsWith('message_end user'))).toEqual([
      'message_end user "task" busy',
      'message_end user "steer" busy',
      'message_end user "follow 1" busy',
      'message_end user "follow 2" busy',
    ]);
  });

  it('settles an abort during a call with agent_settled { aborted: true } before abort() resolves, keeping the queued steer', async () => {
    const log = await contract(async ({ subject, s, mark, queue }) => {
      let abortResolved = false;
      s.subscribe(((e: Event) => { if (e.type === 'agent_settled') mark(`abort resolved=${abortResolved}`); }) as never);
      const run = s.prompt('task');
      await subject.called(1);
      await s.prompt('steer', steer);
      const aborting = s.abort().then(() => { abortResolved = true; });
      mark('abort called');
      await aborting;
      mark(`abort resolved ${queue()}`);
      await run;
      mark('prompt resolved');
      // The steer the aborted run left queued opens the next run.
      const next = s.prompt('again');
      await subject.called(2);
      subject.reply('done');
      await next;
    });

    expect(log.filter((l) => !l.startsWith('queue_update'))).toEqual([
      'agent_start busy',
      'turn_start busy',
      'message_start user "task" busy',
      'message_end user "task" busy',
      '# abort called busy',
      'message_start assistant busy',
      'message_end assistant aborted "Request was aborted" busy',
      'turn_end aborted busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=true idle',
      '# abort resolved=false idle',
      '# abort resolved pending=1 steering=["steer"] followUp=[] peek=1 idle',
      '# prompt resolved idle',
      'agent_start busy',
      'turn_start busy',
      'message_start user "again" busy',
      'message_end user "again" busy',
      'message_start user "steer" busy',
      'message_end user "steer" busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
      '# abort resolved=true idle',
    ]);
  });

  it('aborts a run that is still starting at its agent_start, whose request then fails on the aborted signal', async () => {
    const log = await contract(async ({ subject, s, mark }) => {
      let started = false;
      s.subscribe(((e: Event) => { if (e.type === 'agent_start') started = true; }) as never);
      const run = s.prompt('task');
      for (let tick = 0; tick < 100 && !s.isStreaming; tick++) await Promise.resolve();
      if (!s.isStreaming) throw new Error('the prompt never made the session busy');
      mark(`starting agent_start=${started}`);
      await s.abort();
      await run;
      mark(`settled requests=${subject.requests()}`);
    });

    expect(log).toEqual([
      '# starting agent_start=false busy',
      'agent_start busy',
      'turn_start busy',
      'message_start user "task" busy',
      'message_end user "task" busy',
      'message_start assistant busy',
      'message_end assistant error "This operation was aborted" busy',
      'turn_end error busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=true idle',
      '# settled requests=0 idle',
    ]);
  });

  it('runs a tool call and asks the model again before it ends the run', async () => {
    const log = await contract(async ({ subject, s }) => {
      const run = s.prompt('task');
      await subject.called(1);
      subject.callTool('t1');
      await subject.called(2);
      subject.reply('done');
      await run;
    });

    expect(log).toEqual([
      'agent_start busy',
      'turn_start busy',
      'message_start user "task" busy',
      'message_end user "task" busy',
      'message_start assistant busy',
      'message_end assistant toolUse busy',
      'tool_execution_start busy',
      'tool_execution_end busy',
      'message_start toolResult busy',
      'message_end toolResult busy',
      'turn_end toolUse busy',
      'turn_start busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
    ]);
  });

  it('ends a tool an abort cuts short, delivers the queued steer, and fails the next request on the aborted signal', async () => {
    const log = await contract(async ({ subject, s }) => {
      const toolStarted = new Promise<void>((resolve) => {
        s.subscribe(((e: Event) => { if (e.type === 'tool_execution_start') resolve(); }) as never);
      });
      const run = s.prompt('task');
      await subject.called(1);
      subject.runTool('t1');
      await toolStarted;
      await s.prompt('steer', steer);
      await s.abort();
      await run;
    });

    expect(log.filter((l) => !l.startsWith('queue_update')).slice(4)).toEqual([
      'message_start assistant busy',
      'message_end assistant toolUse busy',
      'tool_execution_start busy',
      'tool_execution_end busy',
      'message_start toolResult busy',
      'message_end toolResult busy',
      'turn_end toolUse busy',
      'turn_start busy',
      'message_start user "steer" busy',
      'message_end user "steer" busy',
      'message_start assistant busy',
      'message_end assistant error "This operation was aborted" busy',
      'turn_end error busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=true idle',
    ]);
  });

  it('ends a tool turn on a finishTurn end, then continues the run for a message queued during it', async () => {
    const log = await contract(async ({ subject, s }) => {
      installTurnDecider(s.agent as Agent, DECIDER, (turn) => (turn.toolResults.length > 0 ? { action: 'end' } : undefined));
      const run = s.prompt('task');
      await subject.called(1);
      await s.prompt('steer', steer);
      subject.callTool('t1');
      await subject.called(2);
      subject.reply('done');
      await run;
    });

    expect(log.filter((l) => !l.startsWith('queue_update') && !l.startsWith('tool_') && !l.includes('toolResult'))).toEqual([
      'agent_start busy',
      'turn_start busy',
      'message_start user "task" busy',
      'message_end user "task" busy',
      'message_start assistant busy',
      'message_end assistant toolUse busy',
      'turn_end toolUse busy',
      'agent_end willRetry=false busy',
      'agent_start busy',
      'turn_start busy',
      'message_start user "steer" busy',
      'message_end user "steer" busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
    ]);
  });

  it('clears both queues and delivers neither', async () => {
    const cleared: unknown[] = [];
    const log = await contract(async ({ subject, s, mark, queue }) => {
      const run = s.prompt('task');
      await subject.called(1);
      await s.prompt('steer', steer);
      await s.prompt('follow', followUp);
      cleared.push(s.clearQueue());
      mark(`cleared ${queue()}`);
      subject.reply('done');
      await run;
    });

    expect(cleared).toEqual([{ steering: ['steer'], followUp: ['follow'] }, { steering: ['steer'], followUp: ['follow'] }]);
    expect(log).toContain('# cleared pending=0 steering=[] followUp=[] peek=0 busy');
    expect(log.filter((l) => l.startsWith('message_end user'))).toEqual(['message_end user "task" busy']);
  });

  it('leaves a steer it accepts after a settling run last checked its queue undelivered and queued', async () => {
    const log = await contract(async ({ subject, s, mark, queue }) => {
      subject.atLastQueueCheck(() => { void s.prompt('late', steer); });
      const run = s.prompt('task');
      await subject.called(1);
      subject.reply('done');
      await run;
      mark(`settled ${queue()}`);
    });

    expect(log.filter((l) => l.startsWith('message_end user'))).toEqual(['message_end user "task" busy']);
    expect(log.at(-1)).toBe('# settled pending=1 steering=["late"] followUp=[] peek=1 idle');
  });

  it('turns a steer whose check lands after the settling run cleared busy into a run of its own, still busy when the first prompt resolves', async () => {
    const log = await contract(async ({ subject, s, mark }) => {
      let late: Promise<void> | null = null;
      let settles = 0;
      s.subscribe(((e: Event) => { if (e.type === 'agent_settled') settles++; }) as never);
      subject.atLastQueueCheck(() => queueMicrotask(() => { late = s.prompt('late', steer); }));
      const run = s.prompt('task');
      await subject.called(1);
      let settlesAtIdle = -1;
      const idle = s.waitForIdle().then(() => { settlesAtIdle = settles; });
      subject.reply('done');
      await run;
      // Where this lands among the second run's first events is a microtask count, so it is logged at the end.
      const busyAtFirst = s.isStreaming;
      await subject.called(2);
      subject.reply('late reply');
      await late;
      await idle;
      mark(`late prompt resolved; first prompt resolved busy=${busyAtFirst}; idle after settle ${settlesAtIdle}`);
    });

    expect(log).toEqual([
      'agent_start busy',
      'turn_start busy',
      'message_start user "task" busy',
      'message_end user "task" busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false busy',
      'agent_start busy',
      'turn_start busy',
      'message_start user "late" busy',
      'message_end user "late" busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
      '# late prompt resolved; first prompt resolved busy=true; idle after settle 2 idle',
    ]);
  });

  it('starts a run for a steer sent while idle, resolving at its settle', async () => {
    await contract(async ({ subject, s, mark }) => {
      const run = s.prompt('idle steer', steer);
      await subject.called(1);
      mark('asked');
      subject.reply('done');
      await run;
      mark('resolved');
    });
  });

  it('retries a retryable failure inside the same prompt, and settles once', async () => {
    const log = await contract(async ({ subject, s }) => {
      const run = s.prompt('task');
      await subject.called(1);
      subject.fail('529 overloaded_error');
      await subject.called(2);
      subject.reply('done');
      await run;
    });

    expect(log.slice(4)).toEqual([
      'message_start assistant busy',
      'message_end assistant error "529 overloaded_error" busy',
      'turn_end error busy',
      'agent_end willRetry=true busy',
      `auto_retry_start 1/${MAX_RETRIES}`,
      'agent_start busy',
      'turn_start busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'auto_retry_end success=true attempt=1',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
    ]);
  });

  it('gives up after the last retry and settles with the failure', async () => {
    const log = await contract(async ({ subject, s }) => {
      const run = s.prompt('task');
      await subject.called(1);
      subject.fail('529 overloaded_error');
      await subject.called(2);
      subject.fail('529 overloaded_error');
      await run;
    });

    expect(log.slice(-5)).toEqual([
      'message_end assistant error "529 overloaded_error" busy',
      'turn_end error busy',
      'agent_end willRetry=false busy',
      'auto_retry_end success=false attempt=1',
      'agent_settled aborted=false idle',
    ]);
  });

  it('delivers a steer queued during a call that fails for good in a fresh loop of the same run', async () => {
    const log = await contract(async ({ subject, s }) => {
      const run = s.prompt('task');
      await subject.called(1);
      await s.prompt('steer', steer);
      subject.fail('invalid_request_error: prompt is malformed');
      await subject.called(2);
      subject.reply('done');
      await run;
    });

    expect(log.filter((l) => !l.startsWith('queue_update')).slice(4)).toEqual([
      'message_start assistant busy',
      'message_end assistant error "invalid_request_error: prompt is malformed" busy',
      'turn_end error busy',
      'agent_end willRetry=false busy',
      'agent_start busy',
      'turn_start busy',
      'message_start user "steer" busy',
      'message_end user "steer" busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
    ]);
  });

  it('answers an abort while idle at once, and the next run is not aborted', async () => {
    const log = await contract(async ({ subject, s, mark }) => {
      await s.abort();
      mark('idle abort resolved');
      const run = s.prompt('task');
      await subject.called(1);
      subject.reply('done');
      await run;
    });

    expect(log[0]).toBe('# idle abort resolved idle');
    expect(log.at(-1)).toBe('agent_settled aborted=false idle');
  });

  it('clears busy as it starts settling, and notifies agent_settled once the agent_settled handlers have run', async () => {
    const log = await contract(async ({ subject, s, mark }) => {
      let rounds = 0;
      let clearedAt = -1;
      let settled = false;
      const poll = (): void => {
        rounds++;
        if (clearedAt === -1 && !s.isStreaming) clearedAt = rounds;
        if (!settled) queueMicrotask(poll);
      };
      s.subscribe(((e: Event) => {
        if (e.type === 'agent_end') queueMicrotask(poll);
        if (e.type !== 'agent_settled') return;
        settled = true;
        mark(`${rounds - clearedAt} microtask rounds after busy cleared`);
      }) as never);
      const run = s.prompt('task');
      await subject.called(1);
      subject.reply('done');
      await run;
    });

    // A session without the team's async `agent_settled` handler notifies in the round busy clears.
    expect(log.slice(-2)).toEqual(['agent_settled aborted=false idle', '# 1 microtask rounds after busy cleared idle']);
  });

  it('defers a prompt sent while agent_settled handlers run, and resolves the settling prompt once the run it starts settles', async () => {
    const log = await contract(async ({ subject, s, mark }) => {
      let next: Promise<void> | null = null;
      s.subscribe(((e: Event) => {
        if (e.type !== 'agent_settled' || next) return;
        next = s.prompt('next').then(() => mark('next prompt resolved'));
      }) as never);
      const run = s.prompt('task').then(() => mark('first prompt resolved'));
      await subject.called(1);
      subject.reply('done');
      await subject.called(2);
      subject.reply('done again');
      await run;
      await next;
    });

    expect(log.slice(8)).toEqual([
      'agent_settled aborted=false idle',
      '# next prompt resolved idle',
      'agent_start busy',
      'turn_start busy',
      'message_start user "next" busy',
      'message_end user "next" busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
      '# first prompt resolved idle',
    ]);
  });

  it('starts a run for a steer whose input handler outlasts the run it was sent into, once that run settled', async () => {
    const log = await contract(async ({ subject, s, mark }) => {
      const held = subject.holdInput('late');
      const run = s.prompt('task').then(() => mark('first prompt resolved'));
      await subject.called(1);
      const late = s.prompt('late', steer).then(() => mark('late prompt resolved'));
      await held.entered;
      subject.reply('done');
      await Promise.race([run, subject.called(2)]);
      held.release();
      await subject.called(2);
      subject.reply('late reply');
      await Promise.all([run, late]);
    }, { input: true });

    expect(log.filter((l) => !l.startsWith('queue_update'))).toEqual([
      'agent_start busy',
      'turn_start busy',
      'message_start user "task" busy',
      'message_end user "task" busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
      '# first prompt resolved idle',
      'agent_start busy',
      'turn_start busy',
      'message_start user "late" busy',
      'message_end user "late" busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
      '# late prompt resolved idle',
    ]);
  });

  it('starts a run for a steer its input handler held across an abort and a dispose, which an abort() at its start does not stop', async () => {
    const log = await contract(async ({ subject, s, log, mark }) => {
      const held = subject.holdInput('late');
      const run = s.prompt('task');
      await subject.called(1);
      const late = s.prompt('late', {
        ...steer,
        preflightResult: (disposition) => {
          mark(`late ${disposition}`);
          if (disposition === 'started') void s.abort();
        },
      });
      await held.entered;
      await s.abort();
      await run;
      logAgentEvents(s, log);
      s.dispose();
      held.release();
      await subject.called(2);
      subject.reply('late reply');
      await late;
      mark(`late resolved requests=${subject.requests()} users=${JSON.stringify(userTexts(s))}`);
    }, { input: true });

    expect(log.slice(log.indexOf('# late started busy'))).toEqual([
      '# late started busy',
      'agent agent_start busy',
      'agent turn_start busy',
      'agent message_start user "late" busy',
      'agent message_end user "late" busy',
      'agent message_start assistant busy',
      'agent message_end assistant stop busy',
      'agent turn_end stop busy',
      'agent agent_end willRetry=undefined busy',
      '# late resolved requests=2 users=["task"] idle',
    ]);
  });

  it('stops before any request a run a held steer opens on a disposed session, when its start arms abortRunAtStart', async () => {
    const log = await contract(async ({ subject, s, log, mark }) => {
      const held = subject.holdInput('late');
      const run = s.prompt('task');
      await subject.called(1);
      const late = s.prompt('late', {
        ...steer,
        preflightResult: (disposition) => {
          mark(`late ${disposition}`);
          if (disposition === 'started') void abortRunAtStart(s as unknown as AgentSession);
        },
      });
      await held.entered;
      await s.abort();
      await run;
      logAgentEvents(s, log);
      s.dispose();
      held.release();
      await late;
      mark(`late resolved requests=${subject.requests()} users=${JSON.stringify(userTexts(s))}`);
    }, { input: true });

    expect(log.slice(log.indexOf('# late started busy'))).toEqual([
      '# late started busy',
      'agent agent_start busy',
      'agent turn_start busy',
      'agent message_start user "late" busy',
      'agent message_end user "late" busy',
      'agent message_start assistant busy',
      'agent message_end assistant error "This operation was aborted" busy',
      'agent turn_end error busy',
      'agent agent_end willRetry=undefined busy',
      '# late resolved requests=1 users=["task"] idle',
    ]);
  });

  it('stops before any request the run an idle prompt opens once its input handler returns on a disposed session, when its start arms abortRunAtStart', async () => {
    const log = await contract(async ({ subject, s, log, mark }) => {
      const held = subject.holdInput('task');
      const run = s.prompt('task', {
        preflightResult: (disposition) => {
          mark(`task ${disposition}`);
          if (disposition === 'started') void abortRunAtStart(s as unknown as AgentSession);
        },
      });
      await held.entered;
      await s.abort();
      mark('aborted');
      logAgentEvents(s, log);
      s.dispose();
      held.release();
      await run;
      mark(`task resolved requests=${subject.requests()} users=${JSON.stringify(userTexts(s))}`);
    }, { input: true });

    expect(log).toEqual([
      '# aborted idle',
      '# task started busy',
      'agent agent_start busy',
      'agent turn_start busy',
      'agent message_start user "task" busy',
      'agent message_end user "task" busy',
      'agent message_start assistant busy',
      'agent message_end assistant error "This operation was aborted" busy',
      'agent turn_end error busy',
      'agent agent_end willRetry=undefined busy',
      '# task resolved requests=0 users=[] idle',
    ]);
  });

  it('settles a run an abort lands on while its agent_before_settle handler runs, though a steer is queued', async () => {
    const log = await contract(async ({ subject, s, mark, queue }) => {
      const run = s.prompt('task');
      await subject.called(1);
      const held = subject.holdBeforeSettle();
      subject.reply('done');
      await held.entered;
      await s.prompt('steer', steer);
      mark(`before settle ${queue()}`);
      const aborting = s.abort();
      held.release();
      await aborting;
      await run;
      mark(`settled ${queue()} requests=${subject.requests()}`);
    }, { beforeSettle: true });

    expect(log.filter((l) => !l.startsWith('queue_update')).slice(6)).toEqual([
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      '# before settle pending=1 steering=["steer"] followUp=[] peek=1 busy',
      'agent_settled aborted=true idle',
      '# settled pending=1 steering=["steer"] followUp=[] peek=1 requests=1 idle',
    ]);
  });

  it('ends the run after a tool batch a user deny terminates, without asking the model again', async () => {
    const log = await contract(async ({ subject, s, mark }) => {
      const run = s.prompt('task');
      await subject.called(1);
      subject.denyTool('t1');
      await Promise.race([run, subject.called(2)]);
      mark(`requests=${subject.requests()}`);
      if (subject.requests() === 2) subject.reply('asked again');
      await run;
    });

    expect(log.slice(4)).toEqual([
      'message_start assistant busy',
      'message_end assistant toolUse busy',
      'tool_execution_start busy',
      'tool_execution_end busy',
      'message_start toolResult busy',
      'message_end toolResult busy',
      'turn_end toolUse busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
      '# requests=1 idle',
    ]);
  });

  it('applies a turn decider installed during an agent loop from the next loop on', async () => {
    const log = await contract(async ({ subject, s, mark }) => {
      const run = s.prompt('task');
      await subject.called(1);
      installTurnDecider(s.agent as Agent, DECIDER, (turn) => (turn.toolResults.length > 0 ? { action: 'end' } : undefined));
      subject.callTool('t1');
      await Promise.race([run, subject.called(2)]);
      mark(`after the tool turn requests=${subject.requests()}`);
      if (subject.requests() === 2) subject.reply('done');
      await run;
      const next = s.prompt('again');
      await subject.called(subject.requests() + 1);
      subject.callTool('t2');
      await next;
    });

    expect(log.filter((l) => !l.startsWith('tool_') && !l.includes('toolResult'))).toEqual([
      'agent_start busy',
      'turn_start busy',
      'message_start user "task" busy',
      'message_end user "task" busy',
      'message_start assistant busy',
      'message_end assistant toolUse busy',
      'turn_end toolUse busy',
      'turn_start busy',
      '# after the tool turn requests=2 busy',
      'message_start assistant busy',
      'message_end assistant stop busy',
      'turn_end stop busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
      'agent_start busy',
      'turn_start busy',
      'message_start user "again" busy',
      'message_end user "again" busy',
      'message_start assistant busy',
      'message_end assistant toolUse busy',
      'turn_end toolUse busy',
      'agent_end willRetry=false busy',
      'agent_settled aborted=false idle',
    ]);
  });
});
