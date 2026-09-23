import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { AgentManager, isSubagentId, type SubagentEngine, type SpawnRequest } from '../agent-manager';
import { AgentRegistry } from '../agent-types';
import { STEER_INSTRUCTION_PREFIX, buildResumePrompt, wrapSteerMessage } from '../../../../shared/steer';
import { BROWSER_PI_TOOL_NAMES } from '../../tools/browser-tools';
import { COMPASS_PI_TOOL_NAMES } from '../../tools/compass-tools';
import { COMPASS_AGENT_PROMPT, COMPASS_SYSTEM_PROMPT } from '../../../compass/system-prompt';
import { buildAgentPrompt } from '../prompts';
import { createSubagentExtensionFactory, type SubagentGateContext } from '../subagent-extension-factory';
import { buildNestedMcpToolset, type NestedMcpToolset } from '../../tools/mcp-tools';
import { fullActiveToolNames } from '../../tool-status';
import { TOOL_TOOL_SEARCH, TEAM_CREATE_TOOL } from '../../../../shared/tool-names';
import type { McpToolDescriptor } from '../../mcp/types';
import type { McpClientManager } from '../../mcp/mcp-client-manager';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentInvocationData } from '../../agent-records';
import type { PiCreateSubagentSessionOptions } from '../../pi-runtime';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import * as fsp from 'node:fs/promises';
import { buildSubagentTools } from '../../tools/subagent-tools';
import { backgroundResultsDetails } from '../background-results';
import { SubagentStreamBridge } from '../subagent-stream-bridge';
import { DAMOCLES_AGENT_STATUS_ENTRY } from '../../session-store/constants';

// Pass-through spies so a test can prove a rejected resume id never reached the filesystem.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile) };
});

function invocationEntry(data: AgentInvocationData): SessionEntry {
  return { type: 'custom', customType: 'damocles-agent-invocation', data, id: `e${branch.length}`, parentId: null, timestamp: new Date().toISOString() } as SessionEntry;
}

/** `defineTool` is the only `pi` member `buildMcpPiTool` touches; the definitions produced are real. */
const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

// Intercept at the real call site so the assertions run against the context `AgentManager` actually
// builds. Hand-constructing a `SubagentGateContext` in the test would assert only the test's own
// arithmetic — which is exactly how a universe-widening mutation at agent-manager.ts:376 survived.
vi.mock('../subagent-extension-factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../subagent-extension-factory')>();
  return { ...actual, createSubagentExtensionFactory: vi.fn(actual.createSubagentExtensionFactory) };
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Gate {
  resolve: () => void;
}

/** Every `buildAgentToolset` input the manager passed, so a spawn's MCP context is observable. */
const buildAgentToolsetCalls: Array<{ agentId: string; agentName: string; mcpDisallowed: ReadonlySet<string> }> = [];

/** Every agentId whose panel dialogs the manager withdrew at teardown (Slice 2 criterion 5). */
const cancelledDialogs: string[] = [];

/** Custom entries appended to any nested session, in order. */
const customEntries: Array<{ customType: string; data: unknown }> = [];

/** Parent invocation entries the manager recorded, in order. */
const invocations: AgentInvocationData[] = [];

/** The parent branch the manager reads; recorded invocations are appended to it. */
const branch: SessionEntry[] = [];

/** Every `createSession` call's options, in order. */
const sessionOpts: PiCreateSubagentSessionOptions[] = [];

/** Every prompt a nested session was given, in order. */
const prompts: string[] = [];

/** A fake engine whose subagent sessions block on a per-spawn gate the test resolves to control timing. */
function makeEngine(): { engine: SubagentEngine; gates: Gate[] } {
  const gates: Gate[] = [];
  buildAgentToolsetCalls.length = 0;
  cancelledDialogs.length = 0;
  customEntries.length = 0;
  invocations.length = 0;
  branch.length = 0;
  sessionOpts.length = 0;
  prompts.length = 0;
  const engine: SubagentEngine = {
    cwd: '/ws',
    registry: new AgentRegistry(),
    createSession: async (opts) => {
      sessionOpts.push(opts);
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      gates.push({ resolve });
      const session = {
        subscribe: () => () => {},
        prompt: (text: string) => {
          prompts.push(text);
          return promise;
        },
        messages: [],
        getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
        getLastAssistantText: () => '',
        setSessionName: () => {},
        setAutoCompactionEnabled: () => {},
        steer: async () => {},
        abort: async () => {},
        dispose: () => {},
        sessionId: 'sid',
        sessionManager: {
          appendCustomEntry: (customType: string, data: unknown) => void customEntries.push({ customType, data }),
          getSessionFile: () => `/store/${customEntries.length}.jsonl`,
        },
      };
      return session as unknown as AgentSession;
    },
    forgetSession: () => {},
    permissionHandler: {} as never,
    isPlanMode: () => false,
    postMessage: () => {},
    getParentSystemPrompt: () => '',
    getParentSessionId: () => 'parent-sid',
    subagentStoreDir: () => '/store',
    recordInvocation: (data) => {
      invocations.push(data);
      branch.push(invocationEntry(data));
    },
    parentBranch: () => branch,
    assertResumableModel: () => {},
    parentFullToolNames: () => ['read'],
    // The default engine has no MCP manager, which is the no-MCP workspace: the real builder returns
    // the real empty snapshot rather than a hand-written stand-in, so `mcp.names`/`mcp.tools` are the
    // production values and every `tools:`/`customTools` assertion below stays honest.
    buildAgentToolset: (input) => {
      buildAgentToolsetCalls.push(input);
      return { customTools: [], mcp: buildNestedMcpToolset(piStub, null, { eligible: new Set() }) };
    },
    disposeBrowserScope: () => {},
    // Slice 2: the subagent's MCP tools are handed an attributed dialog bridge, so teardown must
    // withdraw its dialogs the same way it drops its browser scope. Recorded, not swallowed — a fake
    // that quietly no-ops here would let the teardown call be deleted with every test still green.
    cancelAgentDialogs: (agentId: string) => cancelledDialogs.push(agentId),
    resolveModel: () => ({}),
    onSubagentCost: () => {},
  };
  return { engine, gates };
}

/** The i-th nested session's gate, failing loudly rather than reading `undefined` off the array. */
function gateAt(gates: readonly Gate[], i: number): Gate {
  const g = gates[i];
  if (!g) throw new Error(`no nested session #${i} was created (only ${gates.length} so far)`);
  return g;
}

function spec(i: number): SpawnRequest {
  return { kind: 'spawn', type: 'general-purpose', prompt: `task ${i}`, description: `d${i}`, toolCallId: `tc${i}`, runInBackground: true };
}

describe('AgentManager concurrency', () => {
  it('runs up to maxConcurrent background agents and queues the overflow, draining as slots free', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);

    const ids = [mgr.spawn(spec(0)), mgr.spawn(spec(1)), mgr.spawn(spec(2)), mgr.spawn(spec(3))] as const;

    // First two start running immediately; the rest queue (checked synchronously).
    expect(mgr.getRecord(ids[0])!.status).toBe('running');
    expect(mgr.getRecord(ids[1])!.status).toBe('running');
    expect(mgr.getRecord(ids[2])!.status).toBe('queued');
    expect(mgr.getRecord(ids[3])!.status).toBe('queued');

    await flush(); // let the two running agents create their sessions
    expect(gates).toHaveLength(2);

    // Finish the first agent → a queued one drains into the freed slot.
    gateAt(gates, 0).resolve();
    await flush();
    expect(mgr.getRecord(ids[0])!.status).toBe('completed');
    expect(mgr.getRecord(ids[2])!.status).toBe('running');
    expect(mgr.getRecord(ids[3])!.status).toBe('queued');
    await flush();
    expect(gates).toHaveLength(3);

    // Drain the rest.
    gateAt(gates, 1).resolve();
    await flush();
    gateAt(gates, 2).resolve();
    await flush();
    await flush();
    if (gates[3]) gates[3].resolve();
    await flush();
    expect(mgr.hasRunning()).toBe(false);
    mgr.dispose();
  });

  it('foreground spawns honor the shared concurrency cap, queueing the overflow', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const fg = (i: number): SpawnRequest => ({ ...spec(i), runInBackground: false });

    const p0 = mgr.spawnAndWait(fg(0));
    const p1 = mgr.spawnAndWait(fg(1));
    const p2 = mgr.spawnAndWait(fg(2)); // over the cap → must wait for a slot, not launch immediately

    await flush();
    expect(gates).toHaveLength(2); // only two nested sessions launched; the third is queued

    gateAt(gates, 0).resolve();
    await flush();
    await flush();
    expect(gates).toHaveLength(3); // the freed slot drains the queued foreground spawn

    gateAt(gates, 1).resolve();
    gateAt(gates, 2).resolve();
    await flush();
    await flush();
    const records = await Promise.all([p0, p1, p2]);
    expect(records.map((r) => r.status)).toEqual(['completed', 'completed', 'completed']);
    mgr.dispose();
  });

  it('a queued spawn resolves its lifetime promise only after it drains and completes', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    mgr.spawn(spec(0));
    const b = mgr.spawn(spec(1)); // queued (cap = 1)
    expect(mgr.getRecord(b)!.status).toBe('queued');

    let resolved = false;
    void mgr.getRecord(b)!.promise!.then(() => { resolved = true; });

    await flush();
    expect(resolved).toBe(false); // must NOT resolve while still queued (the High-severity bug)

    gateAt(gates, 0).resolve(); // first agent completes → b drains into the freed slot
    await flush();
    await flush();
    expect(mgr.getRecord(b)!.status).toBe('running');
    expect(resolved).toBe(false);

    gateAt(gates, 1).resolve(); // b completes
    await flush();
    await flush();
    expect(resolved).toBe(true);
    mgr.dispose();
  });

  it('aborting a queued spawn settles its lifetime promise', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    mgr.spawn(spec(0));
    const b = mgr.spawn(spec(1));
    await flush();

    let settled = false;
    void mgr.getRecord(b)!.promise!.then(() => { settled = true; });
    mgr.abort(b, 'user');
    await flush();

    expect(settled).toBe(true);
    expect(mgr.getRecord(b)!.status).toBe('stopped');
    mgr.dispose();
  });

  it('rejects an unknown subagent type with a distinct error instead of silently running general-purpose', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const rec = await mgr.spawnAndWait({ ...spec(0), type: 'does-not-exist', runInBackground: false });
    expect(rec.status).toBe('error');
    expect(rec.error).toContain('Unknown or disabled');
    expect(gates).toHaveLength(0); // no nested session was ever created
    mgr.dispose();
  });

  it('rejects an explicitly disabled agent type', async () => {
    const { engine, gates } = makeEngine();
    engine.registry.register(
      new Map([
        ['Disabled', { name: 'Disabled', description: 'd', extensions: true, skills: true, systemPrompt: '', promptMode: 'append' as const, enabled: false }],
      ]),
    );
    const mgr = new AgentManager(engine, 2);
    const rec = await mgr.spawnAndWait({ ...spec(0), type: 'Disabled', runInBackground: false });
    expect(rec.status).toBe('error');
    expect(rec.error).toContain('Unknown or disabled');
    expect(gates).toHaveLength(0);
    mgr.dispose();
  });

  it('abortAll stops running and queued agents', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    const a = mgr.spawn(spec(0));
    const b = mgr.spawn(spec(1));
    await flush();
    const count = mgr.abortAll('user');
    expect(count).toBe(2);
    expect(mgr.getRecord(a)!.status).toBe('stopped');
    expect(mgr.getRecord(b)!.status).toBe('stopped');
    mgr.dispose();
  });

  it('abortAll marks the records it kills consumed, so the NEXT turn does not pay to synthesise "(no output)"', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    const running = mgr.spawn(spec(0)); // background, starts immediately
    const queued = mgr.spawn(spec(1));  // background, waits behind the concurrency cap
    await flush();

    mgr.abortAll('user');

    // A killed agent has no result to incorporate. Leaving these unconsumed made the parent's
    // keep-alive drain them at the next settle and continue the run for one more paid round-trip.
    expect(mgr.getRecord(running)!.resultConsumed).toBe(true);
    expect(mgr.getRecord(queued)!.resultConsumed).toBe(true);
    expect(mgr.hasUnconsumedBackground()).toBe(false);
    expect(mgr.takeCompletedBackgroundResults()).toHaveLength(0);
    // Consumed gates keep-alive injection ONLY: the records stay readable for the UI and for
    // GetSubagentResult, which is what makes fixing this at the root safe.
    expect(mgr.getRecord(running)!.status).toBe('stopped');
    expect(mgr.getRecord(queued)!.status).toBe('stopped');
    mgr.dispose();
  });

  it('whenRunsSettled waits for runs abortAll stopped until their status is written, even after clearCompleted', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    mgr.spawn(spec(0));
    await flush();
    mgr.abortAll('reset');
    const settled = mgr.whenRunsSettled();
    mgr.clearCompleted();
    let done = false;
    void settled.then(() => { done = true; });

    await flush();
    expect(done).toBe(false);

    gateAt(gates, 0).resolve();
    await settled;
    expect(customEntries.some((e) => e.customType === DAMOCLES_AGENT_STATUS_ENTRY)).toBe(true);
    mgr.dispose();
  });

  it('clearCompleted drops finished records but keeps running ones', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    const a = mgr.spawn(spec(0));
    await flush();
    gateAt(gates, 0).resolve();
    await flush();
    expect(mgr.getRecord(a)!.status).toBe('completed');
    mgr.clearCompleted();
    expect(mgr.getRecord(a)).toBeUndefined();
    mgr.dispose();
  });
});

describe('AgentManager background keep-alive', () => {
  it('tracks pending background work and waitForBackground resolves once they finish', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    const id = mgr.spawn(spec(0)); // background
    await flush();
    expect(mgr.hasPendingBackground()).toBe(true);

    let waited = false;
    void mgr.waitForBackground().then(() => { waited = true; });
    await flush();
    expect(waited).toBe(false); // still running

    gateAt(gates, 0).resolve();
    await flush();
    await flush();
    expect(waited).toBe(true);
    expect(mgr.hasPendingBackground()).toBe(false);
    expect(mgr.getRecord(id)!.status).toBe('completed');
    mgr.dispose();
  });

  it('takeCompletedBackgroundResults returns finished background records exactly once', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    mgr.spawn(spec(0));
    await flush();
    expect(mgr.takeCompletedBackgroundResults()).toHaveLength(0); // still running
    gateAt(gates, 0).resolve();
    await flush();
    await flush();
    const first = mgr.takeCompletedBackgroundResults();
    expect(first).toHaveLength(1);
    expect(mgr.takeCompletedBackgroundResults()).toHaveLength(0); // consumed — never re-injected
    mgr.dispose();
  });

  it('emits backgroundTaskStarted on start and backgroundTaskCompleted on finish', async () => {
    const { engine, gates } = makeEngine();
    const msgs: { type: string }[] = [];
    engine.postMessage = (m) => msgs.push(m as { type: string });
    const mgr = new AgentManager(engine, 4);
    mgr.spawn(spec(0));
    await flush();
    expect(msgs.some((m) => m.type === 'backgroundTaskStarted')).toBe(true);
    expect(msgs.some((m) => m.type === 'backgroundTaskCompleted')).toBe(false);
    gateAt(gates, 0).resolve();
    await flush();
    await flush();
    expect(msgs.some((m) => m.type === 'backgroundTaskCompleted')).toBe(true);
    mgr.dispose();
  });

  it('aborting a running background subagent emits exactly one stopped completion (US-009 stopTask)', async () => {
    const { engine, gates } = makeEngine();
    const msgs: { type: string; status?: string }[] = [];
    engine.postMessage = (m) => msgs.push(m as { type: string; status?: string });
    const mgr = new AgentManager(engine, 4);
    const id = mgr.spawn(spec(0));
    await flush();
    expect(mgr.getRecord(id)!.status).toBe('running');

    // The Background Tasks "stop" button routes stopBackgroundTask → PiSession.stopTask → abort.
    expect(mgr.abort(id, 'user')).toBe(true);
    expect(mgr.getRecord(id)!.status).toBe('stopped');

    gateAt(gates, 0).resolve(); // the aborted run settles (real pi: prompt rejects on the abort signal)
    await flush();
    await flush();

    const completions = msgs.filter((m) => m.type === 'backgroundTaskCompleted');
    expect(completions).toHaveLength(1); // exactly one — the handler no longer optimistically posts
    expect(completions[0]!.status).toBe('stopped');
    mgr.dispose();
  });

  it('foreground spawns are not counted as pending background', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    void mgr.spawnAndWait({ ...spec(0), runInBackground: false });
    await flush();
    expect(mgr.hasPendingBackground()).toBe(false);
    expect(mgr.hasUnconsumedBackground()).toBe(false);
    gates[0]?.resolve();
    await flush();
    mgr.dispose();
  });

  it('hasUnconsumedBackground stays true for an agent that finished mid-turn but was never fetched', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    const id = mgr.spawn(spec(0)); // background
    await flush();
    gateAt(gates, 0).resolve(); // completes during the turn, before the settle
    await flush();
    await flush();
    expect(mgr.getRecord(id)!.status).toBe('completed');
    // The old gate (hasPendingBackground) is false here — this is exactly the dropped-result bug.
    expect(mgr.hasPendingBackground()).toBe(false);
    // The keep-alive gate must still report work to incorporate.
    expect(mgr.hasUnconsumedBackground()).toBe(true);
    mgr.takeCompletedBackgroundResults(); // parent injects it once
    expect(mgr.hasUnconsumedBackground()).toBe(false);
    mgr.dispose();
  });

  it('hasUnconsumedBackground is false once a result was already fetched via GetSubagentResult', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 4);
    const id = mgr.spawn(spec(0));
    await flush();
    gateAt(gates, 0).resolve();
    await flush();
    await flush();
    mgr.getRecord(id)!.resultConsumed = true; // GetSubagentResult marks this on read
    expect(mgr.hasUnconsumedBackground()).toBe(false);
    mgr.dispose();
  });
});

describe('AgentManager steer', () => {
  it('reports "failed" (not "steered") when delivery throws', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const id = mgr.spawn(spec(0));
    await flush(); // session created → record.session set
    const record = mgr.getRecord(id)!;
    (record.session as unknown as { steer: () => Promise<void> }).steer = () => Promise.reject(new Error('mid-shutdown'));
    expect(await mgr.steer(id, 'hello')).toBe('failed');
    mgr.dispose();
  });

  it('reports "steered" on successful delivery', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const id = mgr.spawn(spec(0));
    await flush();
    expect(await mgr.steer(id, 'hello')).toBe('steered');
    mgr.dispose();
  });

  it('injects the message tagged with the absolute-priority marker', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const id = mgr.spawn(spec(0));
    await flush(); // session created → record.session set
    const record = mgr.getRecord(id)!;
    const delivered: string[] = [];
    (record.session as unknown as { steer: (m: string) => Promise<void> }).steer = async (m) => { delivered.push(m); };
    expect(await mgr.steer(id, 'focus on tests')).toBe('steered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.startsWith(STEER_INSTRUCTION_PREFIX)).toBe(true);
    expect(delivered[0]).toContain('focus on tests');
    mgr.dispose();
  });

  it('buffers a queued steer already tagged with the priority marker', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    mgr.spawn(spec(0)); // fills the single concurrency slot
    const queued = mgr.spawn(spec(1)); // over the cap → queued
    expect(mgr.getRecord(queued)!.status).toBe('queued');
    expect(await mgr.steer(queued, 'do X')).toBe('queued');
    const buffered = mgr.getRecord(queued)!.pendingSteers!;
    expect(buffered).toHaveLength(1);
    expect(buffered[0]!.startsWith(STEER_INSTRUCTION_PREFIX)).toBe(true);
    expect(buffered[0]).toContain('do X');
    mgr.dispose();
  });

  it('reports "finished" (not "steered") when the run settles while steer() is in flight', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const id = mgr.spawn(spec(0));
    await flush(); // session created → record.session set
    const record = mgr.getRecord(id)!;
    // Simulate the completion path settling the record during the steer await (steer/finish race).
    (record.session as unknown as { steer: () => Promise<void> }).steer = async () => { record.status = 'completed'; };
    expect(await mgr.steer(id, 'too late')).toBe('finished');
    mgr.dispose();
  });

  it('drops the undelivered steer buffer and parent-awareness note when a queued agent is aborted', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    mgr.spawn(spec(0)); // fills the slot
    const queued = mgr.spawn(spec(1)); // queued
    await mgr.steer(queued, 'do X'); // buffers a pending steer
    const record = mgr.getRecord(queued)!;
    record.userSteers = ['do X']; // PiSession records the parent-awareness note on a queued steer
    expect(mgr.abort(queued, 'user')).toBe(true);
    expect(record.status).toBe('stopped');
    expect(record.pendingSteers).toBeUndefined();
    expect(record.userSteers).toBeUndefined();
    mgr.dispose();
  });
});

describe('AgentManager thinkingLevel precedence', () => {
  /** Engine variant that captures each createSession call's options so the test can assert the
   *  thinkingLevel actually passed to session creation. */
  function makeCapturingEngine(): { engine: SubagentEngine; gates: Gate[]; captured: Array<Record<string, unknown>> } {
    const { engine, gates } = makeEngine();
    const captured: Array<Record<string, unknown>> = [];
    engine.createSession = async (opts) => {
      captured.push(opts as unknown as Record<string, unknown>);
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      gates.push({ resolve });
      const session = {
        subscribe: () => () => {},
        prompt: () => promise,
        messages: [],
        getSessionStats: () => ({ cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }),
        getLastAssistantText: () => '',
        setSessionName: () => {},
        setAutoCompactionEnabled: () => {},
        steer: async () => {},
        abort: async () => {},
        dispose: () => {},
        sessionId: 'sid',
        sessionManager: { appendCustomEntry: () => 'e', getSessionFile: () => '/store/x.jsonl' },
      };
      return session as unknown as AgentSession;
    };
    return { engine, gates, captured };
  }

  it('enforceThinking beats a per-spawn spec.thinking', async () => {
    const { engine, gates, captured } = makeCapturingEngine();
    engine.resolveModel = () => ({ thinkingLevel: 'high', enforceThinking: true });
    const mgr = new AgentManager(engine, 2);
    mgr.spawn({ ...spec(0), thinking: 'low' });
    await flush();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.thinkingLevel).toBe('high');
    gateAt(gates, 0).resolve();
    await flush();
    mgr.dispose();
  });

  it('without enforceThinking, spec.thinking wins over resolved.thinkingLevel', async () => {
    const { engine, gates, captured } = makeCapturingEngine();
    engine.resolveModel = () => ({ thinkingLevel: 'high' });
    const mgr = new AgentManager(engine, 2);
    mgr.spawn({ ...spec(0), thinking: 'low' });
    await flush();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.thinkingLevel).toBe('low');
    gateAt(gates, 0).resolve();
    await flush();
    mgr.dispose();
  });

  it('passes no thinkingLevel when neither spec.thinking nor resolved.thinkingLevel is set', async () => {
    const { engine, gates, captured } = makeCapturingEngine();
    engine.resolveModel = () => ({});
    const mgr = new AgentManager(engine, 2);
    mgr.spawn(spec(0));
    await flush();
    expect(captured[0]).not.toHaveProperty('thinkingLevel');
    gateAt(gates, 0).resolve();
    await flush();
    mgr.dispose();
  });
});

describe('AgentManager resolveRunInBackground', () => {
  it('honors an explicit param over the template default, both directions', () => {
    const { engine } = makeEngine();
    engine.registry.register(
      new Map([
        ['bg-default', { name: 'bg-default', description: 'd', extensions: true, skills: true, systemPrompt: '', promptMode: 'append' as const, runInBackground: true }],
      ]),
    );
    const mgr = new AgentManager(engine, 2);
    // Explicit param wins in both directions.
    expect(mgr.resolveRunInBackground('bg-default', false)).toBe(false);
    expect(mgr.resolveRunInBackground('general-purpose', true)).toBe(true);
    mgr.dispose();
  });

  it('falls back to the template frontmatter default when the param is omitted', () => {
    const { engine } = makeEngine();
    engine.registry.register(
      new Map([
        ['bg-default', { name: 'bg-default', description: 'd', extensions: true, skills: true, systemPrompt: '', promptMode: 'append' as const, runInBackground: true }],
      ]),
    );
    const mgr = new AgentManager(engine, 2);
    expect(mgr.resolveRunInBackground('bg-default', undefined)).toBe(true); // template default
    expect(mgr.resolveRunInBackground('general-purpose', undefined)).toBe(false); // no default → foreground
    expect(mgr.resolveRunInBackground('does-not-exist', undefined)).toBe(false); // unknown → foreground
    mgr.dispose();
  });
});

describe('AgentManager listActive', () => {
  it('returns only running + queued records with the exact subagent steer-target shape', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);

    // A background spawn that completes → terminal 'completed', must be excluded.
    const doneId = mgr.spawn(spec(0));
    await flush();
    gateAt(gates, 0).resolve();
    await flush();
    await flush();
    expect(mgr.getRecord(doneId)!.status).toBe('completed');

    // A background spawn that is aborted → terminal 'stopped', must be excluded.
    const stoppedId = mgr.spawn(spec(1));
    await flush();
    expect(mgr.abort(stoppedId, 'user')).toBe(true);
    gateAt(gates, 1).resolve(); // let the aborted run settle so its slot frees
    await flush();
    await flush();
    expect(mgr.getRecord(stoppedId)!.status).toBe('stopped');

    // Now build the active set: a background running, a foreground running, and a queued (cap = 2).
    const bgRunningId = mgr.spawn(spec(2)); // background → isBackground true
    const fgRunningId = mgr.spawn({ ...spec(3), runInBackground: false }); // foreground → isBackground false
    const queuedId = mgr.spawn(spec(4)); // over the cap → queued
    await flush();
    expect(mgr.getRecord(bgRunningId)!.status).toBe('running');
    expect(mgr.getRecord(fgRunningId)!.status).toBe('running');
    expect(mgr.getRecord(queuedId)!.status).toBe('queued');

    const active = mgr.listActive();

    // Only the three active records are returned — completed + stopped are excluded.
    expect(active.map((a) => a.id).sort()).toEqual([bgRunningId, fgRunningId, queuedId].sort());

    // Each item has exactly the subagent steer-target keys.
    for (const item of active) {
      expect(Object.keys(item).sort()).toEqual(['agentType', 'description', 'id', 'isBackground', 'kind', 'status']);
    }

    const byId = new Map(active.map((a) => [a.id, a]));
    // agentType mirrors record.type; description mirrors record.description.
    expect(byId.get(bgRunningId)).toEqual({ kind: 'subagent', id: bgRunningId, agentType: 'general-purpose', description: 'd2', status: 'running', isBackground: true });
    expect(byId.get(fgRunningId)).toEqual({ kind: 'subagent', id: fgRunningId, agentType: 'general-purpose', description: 'd3', status: 'running', isBackground: false });
    expect(byId.get(queuedId)).toEqual({ kind: 'subagent', id: queuedId, agentType: 'general-purpose', description: 'd4', status: 'queued', isBackground: true });

    mgr.dispose();
  });
});

describe('AgentManager — per-subagent browser scope', () => {
  it('binds the subagent browser tools to its OWN scope (record id) at build time', async () => {
    const { engine, gates } = makeEngine();
    const builtWith: string[] = [];
    engine.buildAgentToolset = (input) => {
      builtWith.push(input.agentId);
      return { customTools: [], mcp: buildNestedMcpToolset(piStub, null, { eligible: new Set() }) };
    };
    const mgr = new AgentManager(engine, 2);

    const id = mgr.spawn(spec(0));
    await flush(); // run() builds customTools before creating the session

    expect(builtWith).toEqual([id]); // the scope key is the subagent's own record id
    gates[0]?.resolve();
    await flush();
    mgr.dispose();
  });

  it('closes the tab(s) on SUCCESS (disposeBrowserScope closeTabs=true)', async () => {
    const { engine, gates } = makeEngine();
    const calls: Array<[string, boolean]> = [];
    engine.disposeBrowserScope = (agentId, closeTabs) => calls.push([agentId, closeTabs]);
    const mgr = new AgentManager(engine, 2);

    const id = mgr.spawn(spec(0));
    await flush();
    gates[0]!.resolve(); // completes successfully
    await flush();

    expect(mgr.getRecord(id)!.status).toBe('completed');
    expect(calls).toEqual([[id, true]]);
    mgr.dispose();
  });

  it('KEEPS the tab(s) open on a manual stop (disposeBrowserScope closeTabs=false)', async () => {
    const { engine, gates } = makeEngine();
    const calls: Array<[string, boolean]> = [];
    engine.disposeBrowserScope = (agentId, closeTabs) => calls.push([agentId, closeTabs]);
    const mgr = new AgentManager(engine, 2);

    const id = mgr.spawn(spec(0));
    await flush();
    mgr.abort(id, 'user'); // manual stop → status 'stopped'
    gates[0]!.resolve(); // let the nested run settle so afterComplete fires
    await flush();

    expect(mgr.getRecord(id)!.status).toBe('stopped');
    expect(calls).toEqual([[id, false]]); // tab kept for inspection, registry entry still dropped
    mgr.dispose();
  });

  it('disposes the scope only AFTER the session is forgotten, so no in-flight tool can revive it', async () => {
    const { engine, gates } = makeEngine();
    const order: string[] = [];
    engine.forgetSession = () => order.push('forgetSession');
    engine.disposeBrowserScope = () => order.push('disposeBrowserScope');
    const mgr = new AgentManager(engine, 2);

    mgr.spawn(spec(0));
    await flush();
    gates[0]!.resolve();
    await flush();

    // An aborted turn resolves its tool call while the underlying browser work keeps running; disposing
    // before teardown lets that straggler re-create the scope it just deleted.
    expect(order).toEqual(['forgetSession', 'disposeBrowserScope']);
    mgr.dispose();
  });

  it('drops the scope with closeTabs=false when a spawn fails before running', async () => {
    const { engine } = makeEngine();
    const calls: Array<[string, boolean]> = [];
    engine.disposeBrowserScope = (agentId, closeTabs) => calls.push([agentId, closeTabs]);
    const mgr = new AgentManager(engine, 2);

    // An unknown/disabled type fails in startRecord → finalizeError (no tab was ever opened).
    const id = mgr.spawn({ ...spec(0), type: 'does-not-exist' as never });
    await flush();

    expect(mgr.getRecord(id)!.status).toBe('error');
    expect(calls).toEqual([[id, false]]);
    mgr.dispose();
  });
});

/**
 * Slice 2 — a subagent's MCP tools elicit on the PARENT panel, so the spawn must say who is asking and
 * the teardown must withdraw whatever is still on screen. Both are asserted against the real
 * `AgentManager`; the engine seam records rather than swallows, so deleting either call fails here.
 */
describe('AgentManager → nested MCP dialogs: attribution at spawn, withdrawal at teardown', () => {
  it('passes the spawn`s agent NAME to buildAgentToolset, not just its id', async () => {
    // The id is a record uuid — useless in a dialog. The name is what the attribution line shows, so it
    // has to travel with the id from the one place that knows it.
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);

    const id = mgr.spawn(spec(0)); // type 'general-purpose', no registered config
    await flush();

    expect(buildAgentToolsetCalls).toEqual([{ agentId: id, agentName: 'general-purpose', mcpDisallowed: expect.any(Set) }]);
    gates[0]?.resolve();
    await flush();
    mgr.dispose();
  });

  it('uses the registered config`s canonical name, not the caller`s spelling of the type', async () => {
    const { engine, gates } = makeEngine();
    engine.registry.register(
      new Map([
        ['ci-agent', { name: 'CI Reviewer', description: 'd', extensions: true, skills: true, systemPrompt: '', promptMode: 'append' as const }],
      ]),
    );
    const mgr = new AgentManager(engine, 2);

    mgr.spawn({ ...spec(0), type: 'CI-AGENT' as never }); // resolved case-insensitively
    await flush();

    expect(buildAgentToolsetCalls.at(-1)?.agentName).toBe('CI Reviewer');
    gates[0]?.resolve();
    await flush();
    mgr.dispose();
  });

  it('withdraws the subagent`s panel dialogs when it completes', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);

    const id = mgr.spawn(spec(0));
    await flush();
    expect(cancelledDialogs, 'a running subagent`s dialogs must stay open').toEqual([]);
    gates[0]!.resolve();
    await flush();

    expect(cancelledDialogs).toEqual([id]);
    mgr.dispose();
  });

  it('withdraws them on a manual stop too — the case most likely to leave a prompt on screen', async () => {
    // Unlike a browser tab, there is no "keep it open for inspection" reading of a modal that names a
    // dead agent: nobody can answer it and the call behind it is already gone.
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);

    const id = mgr.spawn(spec(0));
    await flush();
    mgr.abort(id, 'user');
    gates[0]!.resolve();
    await flush();

    expect(mgr.getRecord(id)!.status).toBe('stopped');
    expect(cancelledDialogs).toEqual([id]);
    mgr.dispose();
  });

  it('does not withdraw for a spawn that failed before it ever ran', async () => {
    // `finalizeError` is only reachable before `run()`, so no toolset was built and no dialog can
    // exist. A cancel there would be a call with nothing to cancel — noise that hides the real one.
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 2);

    mgr.spawn({ ...spec(0), type: 'does-not-exist' as never });
    await flush();

    expect(cancelledDialogs).toEqual([]);
    mgr.dispose();
  });
});

describe('AgentManager → subagent gate context', () => {
  const gateContexts = (): SubagentGateContext[] =>
    vi.mocked(createSubagentExtensionFactory).mock.calls.map(([ctx]) => ctx);

  it('scopes the deferrable universe to the agent OWN toolset, not the parent full set', async () => {
    // The gate must be configured from the RESOLVED toolset. Widening it to the parent's names would
    // let an Explore agent activate the compass tools its own toolset deliberately excludes — the gate
    // configured from one set while the agent runs with another.
    vi.mocked(createSubagentExtensionFactory).mockClear();
    const { engine } = makeEngine();
    // Parent has both subsystems; Explore's toolset does not include the compass tools.
    engine.parentFullToolNames = () => ['Read', 'Bash', 'Grep', ...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES, 'ToolSearch'];
    const mgr = new AgentManager(engine, 2);

    mgr.spawn({ ...spec(0), type: 'Explore' });
    await flush();

    const ctx = gateContexts().at(-1)!;
    for (const name of COMPASS_PI_TOOL_NAMES) expect(ctx.deferrableToolNames, name).not.toContain(name);
    mgr.dispose();
  });

  it('marks a read-only agent readOnlyShell, so no write tool means no writes via the shell either', async () => {
    vi.mocked(createSubagentExtensionFactory).mockClear();
    const { engine } = makeEngine();
    engine.parentFullToolNames = () => ['Read', 'Bash', 'Grep', 'Write', 'Edit', 'ToolSearch'];
    const mgr = new AgentManager(engine, 2);

    mgr.spawn({ ...spec(0), type: 'Explore' });
    await flush();

    expect(gateContexts().at(-1)!.readOnlyShell).toBe(true);
    mgr.dispose();
  });
});

describe('AgentManager → capability-gated prompt blocks', () => {
  /**
   * Spawn `type` against a parent panel holding `parentFullToolNames` and return the system prompt
   * `AgentManager` actually handed to `createSession`.
   *
   * Deliberately driven through the REAL `AgentRegistry` (which loads the real `DEFAULT_AGENTS`) and
   * the REAL `resolveAgentToolset` — a hand-copied toolset fixture would assert the test's own idea of
   * what Explore holds, which is precisely the thing that must not drift.
   */
  async function capturePrompt(type: string, parentFullToolNames: string[], parentSystemPrompt = ''): Promise<string> {
    const { engine } = makeEngine();
    engine.parentFullToolNames = () => parentFullToolNames;
    engine.getParentSystemPrompt = () => parentSystemPrompt;
    const createSession = engine.createSession;
    let captured: string | undefined;
    engine.createSession = (opts) => {
      captured = opts.systemPrompt;
      return createSession(opts);
    };
    const mgr = new AgentManager(engine, 2);
    mgr.spawn({ ...spec(0), type });
    await flush();
    mgr.dispose();
    // A silently-never-created session would make every `not.toContain` below vacuously true.
    expect(captured, 'createSession was never called').toBeTypeOf('string');
    return captured!;
  }

  const PARENT_WITH_COMPASS = ['read', 'bash', 'grep', 'find', 'ls', 'Write', ...COMPASS_PI_TOOL_NAMES, 'ToolSearch'];

  it('briefs a `tools: *` agent that INHERITED the Compass tools on how to use them', async () => {
    // `general-purpose` omits `builtinToolNames`, so it mirrors the parent's full set; `resolveAgentToolset`
    // strips only `mcp__…` names, so the eight Compass tools come along. Before this wiring the agent
    // held them with no guidance at all — including no word that they are deferred and need loading.
    const prompt = await capturePrompt('general-purpose', PARENT_WITH_COMPASS);
    expect(prompt).toContain(COMPASS_AGENT_PROMPT);
  });

  it('does NOT brief Explore, whose allowlist excludes Compass even when the panel has it enabled', async () => {
    // The gate is CAPABILITY, not a workspace flag: the parent here has Compass enabled and Explore
    // still must not be briefed, because Explore's own `tools:` list never admits a Compass name.
    const prompt = await capturePrompt('Explore', PARENT_WITH_COMPASS);
    expect(prompt).not.toContain(COMPASS_AGENT_PROMPT);
    for (const name of COMPASS_PI_TOOL_NAMES) expect(prompt, name).not.toContain(name);
    // Prove the spawn was real and the toolset resolution ran, so the negatives above mean something.
    expect(prompt).toContain('read-only exploration');
  });

  it('briefs an append-mode agent exactly ONCE when the inherited parent prompt already has Compass', async () => {
    // The production shape, and the one the empty-parent cases above cannot reach: `general-purpose`
    // is `promptMode: 'append'`, so it inherits the panel's WHOLE system prompt — which carries
    // `COMPASS_SYSTEM_PROMPT` whenever Compass is enabled. Appending the agent variant on top briefed
    // the model twice, in two voices, on one subsystem (observed live: a general-purpose spawn quoted
    // two `<compass>` blocks). The inherited section wins; the agent variant is dropped.
    const prompt = await capturePrompt('general-purpose', PARENT_WITH_COMPASS, COMPASS_SYSTEM_PROMPT);
    expect(prompt.match(/<compass>/g) ?? [], 'exactly one <compass> section').toHaveLength(1);
    expect(prompt).toContain(COMPASS_SYSTEM_PROMPT);
    expect(prompt).not.toContain(COMPASS_AGENT_PROMPT);
  });

  it('still briefs a replace-mode agent even when the parent prompt has Compass', async () => {
    // Replace mode inherits NOTHING, so the parent's section never reaches this agent and the block is
    // its only Compass guidance. Without this case the de-duplication above could be over-broad — a
    // plain "parent has it, so skip" rule would silently strip the block from every replace-mode agent.
    const config = {
      name: 'compass-replace',
      displayName: 'compass-replace',
      description: 'read-only replace-mode agent',
      promptMode: 'replace' as const,
      systemPrompt: 'You are a replace-mode agent.',
      extensions: false as const,
      skills: false as const,
    };
    const prompt = buildAgentPrompt(
      config,
      'c:/tmp',
      { isGitRepo: false, branch: '', platform: 'win32' },
      COMPASS_SYSTEM_PROMPT,
      { compassBlock: COMPASS_AGENT_PROMPT },
    );
    expect(prompt).toContain(COMPASS_AGENT_PROMPT);
    expect(prompt).not.toContain(COMPASS_SYSTEM_PROMPT);
  });

  it('does NOT brief a `tools: *` agent when the panel has no Compass tools', async () => {
    // Same agent as the positive case — only the resolved capability differs. This is what makes the
    // predicate a capability test rather than an agent-name test.
    const prompt = await capturePrompt('general-purpose', ['read', 'bash', 'grep', 'Write', 'ToolSearch']);
    expect(prompt).not.toContain(COMPASS_AGENT_PROMPT);
    expect(prompt).not.toContain('CompassSearch');
  });

  // The Plan agent's draft is where each slice first gets a delivery mechanism, and its prompt is
  // `replace`, so the block is the only guidance it has. The team rung is gated on the PARENT's
  // `create_team`, because the parent is what executes the plan; no subagent can call it.
  const PARENT_READONLY = ['read', 'bash', 'grep', 'find', 'ls', 'Write'];

  it('gives the Plan agent all three mechanisms when the parent can start teams', async () => {
    const prompt = await capturePrompt('Plan', [...PARENT_READONLY, TEAM_CREATE_TOOL, 'get_team_status']);
    expect(prompt).toContain('# Delivery mechanisms');
    expect(prompt).toContain('One specialist subagent');
    expect(prompt).toContain('A team (`create_team`');
    expect(prompt).toContain('the assignments are a recommendation');
  });

  it('drops the team rung for the Plan agent when the parent cannot start teams', async () => {
    const prompt = await capturePrompt('Plan', PARENT_READONLY);
    expect(prompt).toContain('# Delivery mechanisms');
    expect(prompt).toContain('One specialist subagent');
    expect(prompt).not.toContain(TEAM_CREATE_TOOL);
  });

  // `AgentRegistry` resolves a spawn case-insensitively, so a user `plan.md` registers as `plan`, takes
  // over the planning role and must take the block with it.
  it('gives the block to a user planning agent registered in another case', async () => {
    const { engine } = makeEngine();
    engine.registry.register(
      new Map([
        ['plan', { name: 'plan', description: 'user planner', extensions: true, skills: true, systemPrompt: 'PLAN BODY', promptMode: 'replace' as const }],
      ]),
    );
    engine.parentFullToolNames = () => [...PARENT_READONLY, TEAM_CREATE_TOOL];
    let captured: string | undefined;
    const createSession = engine.createSession;
    engine.createSession = (opts) => {
      captured = opts.systemPrompt;
      return createSession(opts);
    };
    const mgr = new AgentManager(engine, 2);
    mgr.spawn({ ...spec(0), type: 'plan' });
    await flush();
    mgr.dispose();
    expect(captured).toContain('PLAN BODY');
    expect(captured).toContain('# Delivery mechanisms');
    expect(captured).toContain('A team (`create_team`');
  });

  it('gives no mechanism block to an agent that does not plan', async () => {
    for (const type of ['Explore', 'general-purpose']) {
      for (const parent of [PARENT_READONLY, [...PARENT_READONLY, TEAM_CREATE_TOOL]]) {
        expect(await capturePrompt(type, parent), type).not.toContain('# Delivery mechanisms');
      }
    }
  });
});

/**
 * Slice 1 (nested MCP) — the `Agent`-tool subagent path, driven through the REAL `AgentManager.run()`.
 *
 * Constraint §4.9 governs this whole block. A fake engine that DISCARDS what the manager hands it is
 * how a widening mutation once compiled and passed every test in this repo, so the engine below CAPTURES
 * `createSession`'s options and builds its MCP snapshot with the REAL `buildNestedMcpToolset` over a
 * real-shaped `McpClientManager`. Capturing alone is still not enough for the central claim, so the
 * captured `mcp__*` definition is also EXECUTED: a name in `tools:` with no working definition behind it
 * is precisely the silent failure this slice exists to remove.
 */

function mcpDescriptor(over: Partial<McpToolDescriptor> & Pick<McpToolDescriptor, 'piName'>): McpToolDescriptor {
  return {
    serverName: 'git',
    kind: 'tool',
    originalName: over.piName.split('__').slice(2).join('__'),
    description: `desc of ${over.piName}`,
    inputSchema: { type: 'object', properties: {} },
    readOnly: false,
    ...over,
  };
}

const GIT_STATUS = mcpDescriptor({ piName: 'mcp__git__status', readOnly: true });
const GIT_COMMIT = mcpDescriptor({ piName: 'mcp__git__commit' });
const CTX_QUERY = mcpDescriptor({ piName: 'mcp__ctx7__query_docs', serverName: 'ctx7' });

/** A mutable stand-in for the process-shared `McpClientManager` — mutable because "frozen at spawn"
 *  can only be proven by changing the source of truth AFTER a spawn and re-reading. */
function mcpPanel(initial: McpToolDescriptor[]) {
  let descriptors = [...initial];
  const callTool = vi.fn(async (piName: string, _args: Record<string, unknown>, _opts?: { signal?: AbortSignal }) => {
    if (!descriptors.some((d) => d.piName === piName)) throw new Error(`MCP tool "${piName}" is no longer available`);
    return { content: [{ type: 'text' as const, text: `result of ${piName}` }], isError: false };
  });
  const manager = {
    getAllToolDescriptors: () => [...descriptors],
    getToolDescriptor: (piName: string) => descriptors.find((d) => d.piName === piName),
    allToolNames: () => descriptors.map((d) => d.piName),
    callTool,
  } as unknown as McpClientManager;
  return {
    manager,
    callTool,
    add: (d: McpToolDescriptor) => { descriptors = [...descriptors, d]; },
    remove: (piName: string) => { descriptors = descriptors.filter((d) => d.piName !== piName); },
  };
}

/** The panel-eligibility deps `fullActiveToolNames` reads — the SINGLE gate production relies on. */
function toolStatusDeps(over: { mcpEnabled?: boolean; mcpToolNames?: string[]; disabled?: Set<string> } = {}) {
  return {
    webEnabled: false,
    teamAvailable: false,
    teamEnabled: false,
    browserAvailable: false,
    browserEnabled: false,
    mcpEnabled: over.mcpEnabled ?? true,
    mcpToolNames: over.mcpToolNames ?? [],
    disabled: over.disabled ?? new Set<string>(),
  };
}

interface CapturedSpawn {
  tools: string[];
  customTools: ToolDefinition[];
  systemPrompt: string;
}

/**
 * An engine that captures every `createSession` call AND derives its MCP snapshot the way `PiSession`
 * does: `eligible = new Set(fullActiveToolNames(deps))`, then the real `buildNestedMcpToolset`. Nothing
 * about MCP is stubbed — the deps object is the only knob, which is exactly what makes criterion 15
 * drive through the production gate rather than around it.
 */
function makeMcpEngine(opts: {
  panel: ReturnType<typeof mcpPanel>;
  deps: ReturnType<typeof toolStatusDeps>;
  parentTools?: string[];
}): { engine: SubagentEngine; gates: Gate[]; captured: CapturedSpawn[]; snapshots: NestedMcpToolset[] } {
  const { engine, gates } = makeEngine();
  const captured: CapturedSpawn[] = [];
  const snapshots: NestedMcpToolset[] = [];
  const base = engine.createSession;
  engine.parentFullToolNames = () => [
    ...(opts.parentTools ?? ['read', 'bash', 'grep', 'find', 'ls', 'Edit', 'write', TOOL_TOOL_SEARCH]),
    // The panel's eligible MCP names, through the SAME gate `PiSession.fullActiveToolNames()` uses.
    ...fullActiveToolNames({ ...opts.deps, mcpToolNames: opts.panel.manager.allToolNames() } as never).filter((n) => n.startsWith('mcp__')),
  ];
  engine.buildAgentToolset = (input) => {
    // The production derivation, verbatim in shape: ONE eligibility read, ONE snapshot, definitions
    // appended to the agent's customTools exactly as `PiSession.buildSubagentEngine` does.
    const eligible = new Set(fullActiveToolNames({ ...opts.deps, mcpToolNames: opts.panel.manager.allToolNames() } as never));
    const mcp = buildNestedMcpToolset(piStub, opts.panel.manager, { eligible, disallowed: input.mcpDisallowed });
    snapshots.push(mcp);
    return { customTools: [...mcp.tools], mcp };
  };
  engine.createSession = (o) => {
    captured.push({
      tools: [...(o.tools ?? [])],
      customTools: [...(o.customTools ?? [])],

      systemPrompt: o.systemPrompt,
    });
    return base(o);
  };
  return { engine, gates, captured, snapshots };
}

/** Spawn `type` through the REAL `run()` and return what reached `createSession`. */
async function spawnAndCapture(
  mgr: AgentManager,
  captured: CapturedSpawn[],
  gates: Gate[],
  type: string,
): Promise<CapturedSpawn> {
  const before = captured.length;
  mgr.spawn({ ...spec(0), type });
  await flush();
  expect(captured.length, `createSession was never called for ${type}`).toBe(before + 1);
  gates.at(-1)?.resolve();
  await flush();
  return captured.at(-1)!;
}

const mcpNamesIn = (names: readonly string[]): string[] => names.filter((n) => n.startsWith('mcp__')).sort();

describe('AgentManager → nested MCP: names, definitions and execution (criterion 1)', () => {
  it('the mcp__* names in `tools:` are SET-EQUAL to those in `customTools`', async () => {
    // §8's first bullet: forgetting `mcp.names` in `tools:` makes pi drop the definitions SILENTLY —
    // no error, no warning, no log — and the set-equality test is the only thing that catches it. Both
    // directions, because either one alone is satisfied by a different bug.
    const panel = mcpPanel([GIT_STATUS, GIT_COMMIT, CTX_QUERY]);
    const { engine, gates, captured } = makeMcpEngine({ panel, deps: toolStatusDeps() });
    const mgr = new AgentManager(engine, 2);

    const spawn = await spawnAndCapture(mgr, captured, gates, 'general-purpose');

    const inTools = mcpNamesIn(spawn.tools);
    const inCustom = mcpNamesIn(spawn.customTools.map((t) => t.name));
    expect(inTools).toEqual(['mcp__ctx7__query_docs', 'mcp__git__commit', 'mcp__git__status']);
    expect(new Set(inTools)).toEqual(new Set(inCustom));
    expect(inTools).toEqual(inCustom);
    // The deferred baseline's input is no longer a third derivation to keep in sync: it is filtered
    // out of `tools:` inside `createSubagentSession`, so this array is the single statement of the set.
    mgr.dispose();
  });

  it('the agent`s non-MCP tools are untouched, and no name appears twice', async () => {
    // `tools:` is `[...toolset.names, ...mcp.names]`; a duplicate would make pi push two definitions for
    // one name and the provider reject the whole request ("Tool names must be unique").
    const panel = mcpPanel([GIT_STATUS, GIT_COMMIT]);
    const { engine, gates, captured } = makeMcpEngine({ panel, deps: toolStatusDeps() });
    const mgr = new AgentManager(engine, 2);

    const spawn = await spawnAndCapture(mgr, captured, gates, 'general-purpose');

    expect(spawn.tools).toHaveLength(new Set(spawn.tools).size);
    for (const n of ['read', 'bash', 'grep', TOOL_TOOL_SEARCH]) expect(spawn.tools, n).toContain(n);
    mgr.dispose();
  });

  it('a captured mcp__* definition EXECUTES and reaches the manager with that piName', async () => {
    // Capturing proves a name was passed; only executing proves a CALLABLE tool was delivered. Without
    // this the suite would still pass against a builder that emitted correctly-named empty shells.
    const panel = mcpPanel([GIT_STATUS, GIT_COMMIT]);
    const { engine, gates, captured } = makeMcpEngine({ panel, deps: toolStatusDeps() });
    const mgr = new AgentManager(engine, 2);

    const spawn = await spawnAndCapture(mgr, captured, gates, 'general-purpose');

    const definition = spawn.customTools.find((t) => t.name === 'mcp__git__commit');
    expect(definition, 'the spawn must carry a real definition for every mcp__ name').toBeDefined();
    const controller = new AbortController();
    const result = (await definition!.execute('tc-1', { message: 'ship it' }, controller.signal, undefined, {} as never)) as unknown as {
      content: Array<{ type: string; text?: string }>;
    };

    expect(panel.callTool).toHaveBeenCalledTimes(1);
    const [piName, args, callOpts] = panel.callTool.mock.calls[0]!;
    expect(piName).toBe('mcp__git__commit');
    expect(args).toEqual({ message: 'ship it' });
    expect((callOpts as { signal?: AbortSignal }).signal).toBe(controller.signal);
    expect(result.content).toEqual([{ type: 'text', text: 'result of mcp__git__commit' }]);
    mgr.dispose();
  });

  it('the gate context carries the frozen classifier and the MCP blurbs from the SAME snapshot', async () => {
    // Intercepted at the real call site (the module mock at the top of this file), so this asserts the
    // context `AgentManager` actually builds. A hand-constructed context here would assert the test's
    // own arithmetic — which is exactly how a universe-widening mutation once survived.
    vi.mocked(createSubagentExtensionFactory).mockClear();
    const panel = mcpPanel([GIT_STATUS, GIT_COMMIT]);
    const { engine, gates, captured, snapshots } = makeMcpEngine({ panel, deps: toolStatusDeps() });
    const mgr = new AgentManager(engine, 2);

    await spawnAndCapture(mgr, captured, gates, 'general-purpose');

    const ctx = vi.mocked(createSubagentExtensionFactory).mock.calls.at(-1)![0];
    const mcp = snapshots.at(-1)!;
    // Deferrable set genuinely includes MCP — `deferredToolNames(names, mcp.names)`, never `[]`.
    for (const n of mcp.names) expect(ctx.deferrableToolNames, n).toContain(n);
    expect(ctx.isMcpReadOnly).toBeDefined();
    expect(ctx.isMcpReadOnly!('mcp__git__status')).toBe(true);   // annotated
    expect(ctx.isMcpReadOnly!('mcp__git__commit')).toBe(false);  // not annotated
    expect(ctx.mcpDescriptions?.get('mcp__git__status')).toBe('desc of mcp__git__status');
    mgr.dispose();
  });
});

describe('AgentManager → nested MCP: FROZEN at spawn (criterion 12)', () => {
  it('a descriptor added AFTER a spawn is absent from that agent, and reaches the NEXT one', async () => {
    // "Frozen at spawn" (§3.3) as behaviour. Both halves matter: absence alone would also be satisfied
    // by a snapshot that never updates at all, which would make a newly-configured server permanently
    // unreachable rather than merely one-spawn-late.
    const panel = mcpPanel([GIT_STATUS]);
    const { engine, gates, captured } = makeMcpEngine({ panel, deps: toolStatusDeps() });
    const mgr = new AgentManager(engine, 2);

    const first = await spawnAndCapture(mgr, captured, gates, 'general-purpose');
    expect(mcpNamesIn(first.tools)).toEqual(['mcp__git__status']);

    panel.add(GIT_COMMIT); // a server advertises a new tool mid-run

    expect(mcpNamesIn(first.tools)).toEqual(['mcp__git__status']); // the running agent is unaffected
    expect(first.customTools.map((t) => t.name)).not.toContain('mcp__git__commit');

    const second = await spawnAndCapture(mgr, captured, gates, 'general-purpose');
    expect(mcpNamesIn(second.tools)).toEqual(['mcp__git__commit', 'mcp__git__status']);
    expect(second.customTools.map((t) => t.name)).toContain('mcp__git__commit');
    mgr.dispose();
  });

  it('a descriptor REMOVED after a spawn fails with a permanent message that does NOT invite a retry', async () => {
    // The cost of the freeze, stated honestly to the model. A nested agent's tool set never refreshes,
    // so a vanished tool can never come back to it — and a retry loop against a permanently-absent tool
    // is the worst outcome the freeze decision can produce. Asserted on the TEXT, because the text is
    // the entire mitigation.
    const panel = mcpPanel([GIT_STATUS, GIT_COMMIT]);
    const { engine, gates, captured } = makeMcpEngine({ panel, deps: toolStatusDeps() });
    const mgr = new AgentManager(engine, 2);

    const spawn = await spawnAndCapture(mgr, captured, gates, 'general-purpose');
    const definition = spawn.customTools.find((t) => t.name === 'mcp__git__commit')!;

    panel.remove('mcp__git__commit'); // the server stops advertising it

    const result = (await definition.execute('tc-1', {}, undefined, undefined, {} as never)) as unknown as {
      content: Array<{ type: string; text?: string }>;
      details?: { isError?: boolean };
    };

    const text = result.content[0]!.text!;
    expect(result.details?.isError).toBe(true);
    expect(text).toContain('mcp__git__commit');
    expect(text).toContain('is no longer available');
    expect(text).toContain('permanent for the rest of this agent');
    expect(text).toContain('retrying it will fail the same way');
    // The failure must never read as transient. These are the phrasings a model acts on by retrying.
    expect(text).not.toMatch(/try again|in a moment|retry it|please retry|still connecting/i);
    mgr.dispose();
  });

  it('a SURVIVING sibling still works after another tool vanished — the freeze is per-tool, not per-agent', async () => {
    const panel = mcpPanel([GIT_STATUS, GIT_COMMIT]);
    const { engine, gates, captured } = makeMcpEngine({ panel, deps: toolStatusDeps() });
    const mgr = new AgentManager(engine, 2);

    const spawn = await spawnAndCapture(mgr, captured, gates, 'general-purpose');
    panel.remove('mcp__git__commit');

    const survivor = spawn.customTools.find((t) => t.name === 'mcp__git__status')!;
    const result = (await survivor.execute('tc-2', {}, undefined, undefined, {} as never)) as unknown as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(result.content[0]!.text).toBe('result of mcp__git__status');
    mgr.dispose();
  });
});

describe('AgentManager → nested MCP: the grant is UNIFORM (criterion 8) and opt-out-only (criterion 9)', () => {
  const CUSTOM_AGENTS = new Map([
    ['readonly-user', {
      name: 'readonly-user', description: 'a read-only user agent', extensions: true, skills: true,
      systemPrompt: 'ro', promptMode: 'replace' as const, builtinToolNames: ['read', 'grep'],
    }],
    ['mcp-denier', {
      name: 'mcp-denier', description: 'denies one MCP tool', extensions: true, skills: true,
      systemPrompt: 'd', promptMode: 'replace' as const, disallowedTools: ['mcp__git__commit'],
    }],
    ['wrong-case-denier', {
      name: 'wrong-case-denier', description: 'denies with the wrong case', extensions: true, skills: true,
      systemPrompt: 'd', promptMode: 'replace' as const, disallowedTools: ['MCP__GIT__COMMIT'],
    }],
  ]);

  it('Explore (explicit list, no write tool) and general-purpose (`tools: *`) get the IDENTICAL MCP set', async () => {
    // §3.4's settled decision, driven end-to-end. Explore's `tools:` names 25 browser tools and could
    // never name an MCP tool, so an implementation that intersected the grant with `tools:` would give
    // it none — and the two agents would differ here. `readOnly` is asserted too, so this is genuinely
    // the read-only-agent case rather than two `tools: *` agents wearing different names.
    const panel = mcpPanel([GIT_STATUS, GIT_COMMIT, CTX_QUERY]);
    const { engine, gates, captured } = makeMcpEngine({ panel, deps: toolStatusDeps() });
    const mgr = new AgentManager(engine, 2);

    const explore = await spawnAndCapture(mgr, captured, gates, 'Explore');
    const general = await spawnAndCapture(mgr, captured, gates, 'general-purpose');
    const readonlyUser = (engine.registry.register(CUSTOM_AGENTS), await spawnAndCapture(mgr, captured, gates, 'readonly-user'));

    const expected = ['mcp__ctx7__query_docs', 'mcp__git__commit', 'mcp__git__status'];
    expect(mcpNamesIn(explore.tools)).toEqual(expected);
    expect(mcpNamesIn(general.tools)).toEqual(expected);
    expect(mcpNamesIn(readonlyUser.tools)).toEqual(expected);
    // …and identically in the definitions, so all three can actually call them.
    for (const spawn of [explore, general, readonlyUser]) {
      expect(mcpNamesIn(spawn.customTools.map((t) => t.name))).toEqual(expected);
    }
    // The precondition that makes this the read-only case: Explore holds no write tool.
    expect(explore.tools).not.toContain('Edit');
    expect(explore.tools).not.toContain('write');
    expect(general.tools).toContain('Edit');
    mgr.dispose();
  });

  it('an agent whose disallowed_tools names an MCP tool does not receive it — every other agent still does', async () => {
    const panel = mcpPanel([GIT_STATUS, GIT_COMMIT]);
    const { engine, gates, captured } = makeMcpEngine({ panel, deps: toolStatusDeps() });
    engine.registry.register(CUSTOM_AGENTS);
    const mgr = new AgentManager(engine, 2);

    const denier = await spawnAndCapture(mgr, captured, gates, 'mcp-denier');
    const other = await spawnAndCapture(mgr, captured, gates, 'general-purpose');

    expect(mcpNamesIn(denier.tools)).toEqual(['mcp__git__status']);
    expect(denier.customTools.map((t) => t.name)).not.toContain('mcp__git__commit');
    // The denial is agent-scoped, never panel-scoped: the very next spawn still gets the whole set.
    expect(mcpNamesIn(other.tools)).toEqual(['mcp__git__commit', 'mcp__git__status']);
    mgr.dispose();
  });

  it('a WRONGLY-CASED disallowed_tools entry denies nothing — the opt-out is exact (G1, end to end)', async () => {
    // The G1 pin's consequence at the spawn level. If `mapName` were ever "fixed" to lowercase, this
    // agent would start losing `mcp__git__commit` (and every correctly-cased denial would break the
    // other way). Both halves are asserted in the same suite so neither can drift alone.
    const panel = mcpPanel([GIT_STATUS, GIT_COMMIT]);
    const { engine, gates, captured } = makeMcpEngine({ panel, deps: toolStatusDeps() });
    engine.registry.register(CUSTOM_AGENTS);
    const mgr = new AgentManager(engine, 2);

    const spawn = await spawnAndCapture(mgr, captured, gates, 'wrong-case-denier');

    expect(mcpNamesIn(spawn.tools)).toEqual(['mcp__git__commit', 'mcp__git__status']);
    mgr.dispose();
  });
});

describe('AgentManager → nested MCP: the panel switches apply (criterion 15)', () => {
  it('`damocles.mcp.enabled = false` removes every MCP tool — through fullActiveToolNames, not a bypass', async () => {
    // Driven through the REAL `fullActiveToolNames` (`tool-status.ts:65`), which already does
    // `...(mcpEnabled ? mcpToolNames : [])`. That single read is the whole gate production relies on —
    // `buildNestedMcp` deliberately adds NO second `isMcpEnabled()` check, because a duplicated gate is
    // a gate that drifts. Testing this through a bypass would prove the bypass, not the gate.
    const panel = mcpPanel([GIT_STATUS, GIT_COMMIT]);
    const deps = toolStatusDeps({ mcpEnabled: false });
    const { engine, gates, captured } = makeMcpEngine({ panel, deps });
    const mgr = new AgentManager(engine, 2);

    const spawn = await spawnAndCapture(mgr, captured, gates, 'general-purpose');

    expect(mcpNamesIn(spawn.tools)).toEqual([]);
    expect(mcpNamesIn(spawn.customTools.map((t) => t.name))).toEqual([]);
    // Not vacuous: the same panel with the switch ON hands over both.
    const on = makeMcpEngine({ panel, deps: toolStatusDeps({ mcpEnabled: true }) });
    const mgr2 = new AgentManager(on.engine, 2);
    const enabled = await spawnAndCapture(mgr2, on.captured, on.gates, 'general-purpose');
    expect(mcpNamesIn(enabled.tools)).toEqual(['mcp__git__commit', 'mcp__git__status']);
    mgr.dispose();
    mgr2.dispose();
  });

  it('a name in `damocles.tools.disabled` is removed from the nested agent too', async () => {
    // Same single read: `fullActiveToolNames` subtracts the disabled set, so a per-tool toggle reaches
    // nested agents with no extra plumbing. A nested agent keeping a tool the panel dropped is exactly
    // the divergence this slice removes.
    const panel = mcpPanel([GIT_STATUS, GIT_COMMIT]);
    const deps = toolStatusDeps({ disabled: new Set(['mcp__git__commit']) });
    const { engine, gates, captured } = makeMcpEngine({ panel, deps });
    const mgr = new AgentManager(engine, 2);

    const spawn = await spawnAndCapture(mgr, captured, gates, 'general-purpose');

    expect(mcpNamesIn(spawn.tools)).toEqual(['mcp__git__status']);
    expect(spawn.customTools.map((t) => t.name)).not.toContain('mcp__git__commit');
    mgr.dispose();
  });

  it('ONE engine, TWO spawns across an MCP-config change: the second gets the NEWER snapshot (§4.6)', async () => {
    // The load-bearing detail of constraint §4.6: the derivation lives INSIDE the per-spawn arrow. An
    // implementation that hoisted `buildAgentToolset`'s snapshot to engine-construction time would pass
    // every single-spawn test above and fail only this one — which is why it is written as one engine
    // spanning a change, the only shape that can tell the two apart.
    const panel = mcpPanel([GIT_STATUS]);
    const deps = toolStatusDeps({ mcpEnabled: true });
    const { engine, gates, captured } = makeMcpEngine({ panel, deps });
    const mgr = new AgentManager(engine, 2); // ONE engine, built before either change

    const first = await spawnAndCapture(mgr, captured, gates, 'general-purpose');
    expect(mcpNamesIn(first.tools)).toEqual(['mcp__git__status']);

    panel.add(GIT_COMMIT);          // a server advertises a new tool
    deps.disabled.add('mcp__git__status'); // and the user disables the old one

    const second = await spawnAndCapture(mgr, captured, gates, 'general-purpose');

    expect(mcpNamesIn(second.tools)).toEqual(['mcp__git__commit']);
    expect(second.customTools.map((t) => t.name)).toEqual(['mcp__git__commit']);
    // The first agent still holds its own frozen set — the change reached the NEXT spawn, not this one.
    expect(mcpNamesIn(first.tools)).toEqual(['mcp__git__status']);
    mgr.dispose();
  });

  it('the deferrable set tracks the live snapshot too, spawn over spawn', async () => {
    vi.mocked(createSubagentExtensionFactory).mockClear();
    const panel = mcpPanel([GIT_STATUS]);
    const { engine, gates, captured } = makeMcpEngine({ panel, deps: toolStatusDeps() });
    const mgr = new AgentManager(engine, 2);

    await spawnAndCapture(mgr, captured, gates, 'general-purpose');
    panel.add(CTX_QUERY);
    await spawnAndCapture(mgr, captured, gates, 'general-purpose');

    const contexts = vi.mocked(createSubagentExtensionFactory).mock.calls.map(([ctx]) => ctx);
    expect(contexts[0]!.deferrableToolNames).not.toContain('mcp__ctx7__query_docs');
    expect(contexts.at(-1)!.deferrableToolNames).toContain('mcp__ctx7__query_docs');
    mgr.dispose();
  });
});

describe('AgentManager agent records', () => {
  const statusEntries = () => customEntries.filter((e) => e.customType === 'damocles-agent-status').map((e) => e.data);

  it('indexes the invocation on the parent before the agent starts, then files the agent under the store dir', async () => {
    const { engine, gates } = makeEngine();
    const stores: unknown[] = [];
    const create = engine.createSession;
    engine.createSession = (opts) => {
      stores.push(opts.store);
      return create(opts);
    };
    const mgr = new AgentManager(engine, 2);
    let startedAfterInvocation = false;
    const record = engine.recordInvocation;
    engine.recordInvocation = (data) => {
      startedAfterInvocation = stores.length === 0;
      record(data);
    };

    const id = mgr.spawn({ ...spec(0), thinking: 'low' });
    expect(invocations).toEqual([{ kind: 'subagent', id, toolCallId: 'tc0', resume: false }]);
    expect(startedAfterInvocation).toBe(true);
    await flush();

    expect(stores).toEqual([{ kind: 'file', dir: '/store', id }]);
    expect(customEntries[0]).toEqual({
      customType: 'damocles-agent-launch',
      data: {
        agentId: id,
        kind: 'subagent',
        agentType: 'general-purpose',
        description: 'd0',
        prompt: 'task 0',
        background: true,
        thinkingOverride: 'low',
      },
    });
    expect(mgr.getRecord(id)!.outputFile).toBe('/store/1.jsonl');

    gateAt(gates, 0).resolve();
    await flush();
    await flush();
    expect(statusEntries()).toEqual([{ status: 'completed', result: '' }]);
    mgr.dispose();
    expect(statusEntries()).toHaveLength(1);
  });

  it.each([
    ['user', 'STOPPED BY THE USER'],
    ['budget', 'stopped by the budget limit'],
    ['reset', 'because the conversation was cleared'],
  ] as const)('abortAll(%s) records the stop reason in the status entry', async (reason, note) => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    const id = mgr.spawn(spec(0));
    await flush();

    mgr.abortAll(reason);
    expect(mgr.getRecord(id)!.stopReason).toBe(reason);
    gateAt(gates, 0).resolve();
    await flush();
    await flush();

    expect(statusEntries()).toEqual([{ status: 'stopped', stopReason: reason, result: expect.stringContaining(note) }]);
    mgr.dispose();
  });

  it('dispose records a shutdown stop at once, without waiting for the aborted run to settle', async () => {
    const { engine } = makeEngine();
    const mgr = new AgentManager(engine, 2);
    mgr.spawn(spec(0));
    await flush();

    mgr.dispose();

    expect(statusEntries()).toEqual([{ status: 'stopped', stopReason: 'shutdown', result: expect.any(String) }]);
  });

  it('the stop button records a user stop; a queued agent never had a session, so it writes nothing', async () => {
    const { engine, gates } = makeEngine();
    const mgr = new AgentManager(engine, 1);
    const running = mgr.spawn(spec(0));
    const queued = mgr.spawn(spec(1));
    await flush();

    mgr.abort(queued, 'user');
    mgr.abort(running, 'user');
    expect(mgr.getRecord(queued)!.stopReason).toBe('user');
    gateAt(gates, 0).resolve();
    await flush();
    await flush();

    expect(statusEntries()).toEqual([{ status: 'stopped', stopReason: 'user', result: expect.any(String) }]);
    mgr.dispose();
  });
});

describe('AgentManager resume', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** An engine whose subagent files live in a real temp folder. */
  function resumeEngine(): { engine: SubagentEngine; gates: Gate[]; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-resume-'));
    made.push(dir);
    const { engine, gates } = makeEngine();
    engine.subagentStoreDir = () => dir;
    return { engine, gates, dir };
  }

  const AGENT = '0a1b2c3d-4e5f-4a0';
  const settle = async (): Promise<void> => {
    await flush();
    await flush();
  };

  function assistantMessage(text: string) {
    return {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    } as unknown as Parameters<SessionManager['appendMessage']>[0];
  }

  /** Write the agent's pi session file the way a run does, ending in `status` when given. */
  function writeAgentFile(
    dir: string,
    opts: { agentType?: string; background?: boolean; status?: { status: string; stopReason?: string } },
  ): string {
    const sm = SessionManager.create(dir, dir, { id: AGENT });
    sm.appendCustomEntry('damocles-agent-launch', {
      agentId: AGENT,
      kind: 'subagent',
      agentType: opts.agentType ?? 'general-purpose',
      description: 'dig in',
      prompt: 'find the bug',
      background: opts.background ?? false,
      modelLabel: 'haiku',
    });
    sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'find the bug' }], timestamp: Date.now() });
    sm.appendMessage(assistantMessage('looking'));
    if (opts.status) sm.appendCustomEntry('damocles-agent-status', { ...opts.status, result: 'partial' });
    return sm.getSessionFile()!;
  }

  /** The parent branch's spawn of `AGENT`: its `Agent` call, invocation entry and, optionally, result. */
  function spawnOnBranch(args: Record<string, unknown>, details?: Record<string, unknown>): void {
    const at = new Date().toISOString();
    branch.push({
      type: 'message', id: 'm1', parentId: null, timestamp: at,
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-spawn', name: 'Agent', arguments: args }] },
    } as unknown as SessionEntry);
    branch.push(invocationEntry({ kind: 'subagent', id: AGENT, toolCallId: 'tc-spawn', resume: false }));
    if (details) {
      branch.push({
        type: 'message', id: 'm2', parentId: null, timestamp: at,
        message: { role: 'toolResult', toolCallId: 'tc-spawn', toolName: 'Agent', content: [], details, isError: false },
      } as unknown as SessionEntry);
    }
  }

  const spawnArgs = { description: 'dig in', prompt: 'find the bug', subagent_type: 'general-purpose' };
  const resumeReq = (toolCallId: string, message?: string) => ({
    kind: 'resume' as const,
    agentId: AGENT,
    toolCallId,
    ...(message !== undefined ? { message } : {}),
  });

  it('the id validator matches exactly what the generator produces', () => {
    const mgr = new AgentManager(makeEngine().engine);
    const id = mgr.spawn(spec(0));
    expect(isSubagentId(id)).toBe(true);
    expect(isSubagentId(AGENT)).toBe(true);
    mgr.dispose();
  });

  it.each(['../x', '..\\x', 'x/../../y', '0a1b2c3d-4e5f-4a0/..', '0A1B2C3D-4E5F-4A0', '0a1b2c3d-4e5f-4a01', '0a1b2c3d-4e5f-3a0', ''])(
    'a malformed id %j is rejected before any branch read or file access',
    async (bad) => {
      const { engine } = resumeEngine();
      const storeDir = vi.fn(engine.subagentStoreDir);
      const parentBranch = vi.fn(engine.parentBranch);
      engine.subagentStoreDir = storeDir;
      engine.parentBranch = parentBranch;
      const mgr = new AgentManager(engine);

      await expect(mgr.resume({ kind: 'resume', agentId: bad, toolCallId: 'tc-r' })).rejects.toThrow(`"${bad}" is not a valid subagent id.`);
      expect(storeDir).not.toHaveBeenCalled();
      expect(parentBranch).not.toHaveBeenCalled();
      expect(invocations).toEqual([]);
    },
  );

  it('an id this branch never invoked is unknown, even when its file exists', async () => {
    const { engine, dir } = resumeEngine();
    writeAgentFile(dir, { status: { status: 'stopped', stopReason: 'user' } });
    const mgr = new AgentManager(engine);

    await expect(mgr.resume(resumeReq('tc-r'))).rejects.toThrow(`No interrupted subagent "${AGENT}" in this conversation.`);
    expect(invocations).toEqual([]);
  });

  it('a running or queued agent is still active', async () => {
    const { engine } = resumeEngine();
    const mgr = new AgentManager(engine, 1);
    const running = mgr.spawn(spec(0));
    const queued = mgr.spawn(spec(1));

    await expect(mgr.resume({ kind: 'resume', agentId: running, toolCallId: 'tc-r' })).rejects.toThrow(
      `Subagent "${running}" is still running; steer it with SteerSubagent or read it with GetSubagentResult.`,
    );
    await expect(mgr.resume({ kind: 'resume', agentId: queued, toolCallId: 'tc-r' })).rejects.toThrow(`Subagent "${queued}" is still queued;`);
    mgr.dispose();
  });

  it('of two parallel resumes of one id only the first starts; the second is told to wait for the first', async () => {
    const { engine, dir } = resumeEngine();
    writeAgentFile(dir, { status: { status: 'stopped', stopReason: 'user' } });
    spawnOnBranch(spawnArgs, { agentId: AGENT, status: 'stopped', stopReason: 'user' });
    const mgr = new AgentManager(engine);

    const first = mgr.resume(resumeReq('tc-r1'));
    const second = mgr.resume(resumeReq('tc-r2'));

    await expect(second).rejects.toThrow(`Subagent "${AGENT}" is already being resumed by another Agent call; wait for that call's result.`);
    const record = await first;
    expect(record.status).toBe('running');
    await settle();
    expect(sessionOpts).toHaveLength(1);
    expect(invocations.filter((i) => i.resume)).toEqual([{ kind: 'subagent', id: AGENT, toolCallId: 'tc-r1', resume: true }]);
    mgr.dispose();
  });

  it.each([
    ['completed', undefined, `Subagent "${AGENT}" finished with status "completed"; only interrupted agents can be resumed.`],
    ['error', undefined, `Subagent "${AGENT}" finished with status "error"; only interrupted agents can be resumed.`],
    ['aborted', undefined, `Subagent "${AGENT}" finished with status "aborted"; only interrupted agents can be resumed.`],
    ['stopped', 'reset', `Subagent "${AGENT}" was stopped when its conversation was cleared and cannot be resumed.`],
    ['stopped', 'budget', `Subagent "${AGENT}" was stopped by the budget limit and cannot be resumed.`],
  ])('an agent whose file says %s (%s) cannot be resumed', async (status, stopReason, error) => {
    const { engine, dir } = resumeEngine();
    writeAgentFile(dir, { status: { status, ...(stopReason ? { stopReason } : {}) } });
    spawnOnBranch(spawnArgs);
    const mgr = new AgentManager(engine);

    await expect(mgr.resume(resumeReq('tc-r'))).rejects.toThrow(error);
    expect(invocations).toEqual([]);
  });

  it('an agent whose type is gone cannot be resumed', async () => {
    const { engine, dir } = resumeEngine();
    writeAgentFile(dir, { agentType: 'retired-agent', status: { status: 'stopped', stopReason: 'user' } });
    spawnOnBranch(spawnArgs);
    const mgr = new AgentManager(engine);

    await expect(mgr.resume(resumeReq('tc-r'))).rejects.toThrow(`Subagent "${AGENT}" was a "retired-agent" agent, which is no longer available.`);
  });

  it('an unavailable model rejects the resume verbatim and releases the claim', async () => {
    const { engine, dir } = resumeEngine();
    const file = writeAgentFile(dir, { status: { status: 'stopped', stopReason: 'user' } });
    spawnOnBranch(spawnArgs);
    const error = `Cannot resume "${AGENT}": its model anthropic/claude is not configured or not signed in.`;
    let signedIn = false;
    const checked: string[] = [];
    engine.assertResumableModel = (p) => {
      checked.push(p);
      if (!signedIn) throw new Error(error);
    };
    const mgr = new AgentManager(engine);

    await expect(mgr.resume(resumeReq('tc-r1'))).rejects.toThrow(error);
    expect(checked).toEqual([file]);
    expect(invocations).toEqual([]);

    signedIn = true;
    await expect(mgr.resume(resumeReq('tc-r2'))).resolves.toMatchObject({ status: 'running' });
    mgr.dispose();
  });

  it('a foreground resume reopens the file, opens a segment, prompts to continue and returns the result', async () => {
    const { engine, gates, dir } = resumeEngine();
    const file = writeAgentFile(dir, { status: { status: 'stopped', stopReason: 'user' } });
    spawnOnBranch(spawnArgs, { agentId: AGENT, status: 'stopped', stopReason: 'user' });
    const mgr = new AgentManager(engine);
    const parent = new AbortController();

    const record = await mgr.resume({ ...resumeReq('tc-r', 'check the tests too'), signal: parent.signal });
    expect(record).toMatchObject({ id: AGENT, toolCallId: 'tc-r', background: false, description: 'dig in', type: 'general-purpose' });
    await settle();

    expect(sessionOpts[0]!.store).toEqual({ kind: 'reopen', path: file, agentId: AGENT });
    expect(sessionOpts[0]!.model).toBeUndefined();
    expect(sessionOpts[0]!.thinkingLevel).toBeUndefined();
    expect(customEntries).toEqual([{ customType: 'damocles-agent-segment', data: { toolCallId: 'tc-r', message: 'check the tests too' } }]);
    expect(prompts).toEqual([buildResumePrompt('check the tests too')]);
    expect(prompts[0]!.startsWith(STEER_INSTRUCTION_PREFIX)).toBe(true);

    gateAt(gates, 0).resolve();
    await record.promise;
    expect(record.status).toBe('completed');
    expect(mgr.hasUnconsumedBackground()).toBe(false);
    mgr.dispose();
  });

  it('a foreground resume is stopped with the parent turn', async () => {
    const { engine, gates, dir } = resumeEngine();
    writeAgentFile(dir, { status: { status: 'stopped', stopReason: 'user' } });
    spawnOnBranch(spawnArgs);
    const mgr = new AgentManager(engine);
    const parent = new AbortController();

    const record = await mgr.resume({ ...resumeReq('tc-r'), signal: parent.signal });
    await settle();
    parent.abort();
    gateAt(gates, 0).resolve();
    await record.promise;

    expect(record).toMatchObject({ status: 'stopped', stopReason: 'user' });
    mgr.dispose();
  });

  it('a foreground resume whose parent turn already aborted finishes stopped without opening a session', async () => {
    const { engine, dir } = resumeEngine();
    writeAgentFile(dir, { status: { status: 'stopped', stopReason: 'user' } });
    spawnOnBranch(spawnArgs);
    const posted: ExtensionToWebviewMessage[] = [];
    engine.postMessage = (m) => void posted.push(m);
    const mgr = new AgentManager(engine);

    const record = await mgr.resume({ ...resumeReq('tc-r'), signal: AbortSignal.abort() });
    await record.promise;

    expect(record).toMatchObject({ status: 'stopped', stopReason: 'user' });
    expect(sessionOpts).toEqual([]);
    expect(prompts).toEqual([]);
    const done = posted.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'toolCompleted' }> => m.type === 'toolCompleted');
    expect(done).toMatchObject({ toolUseId: 'tc-r', toolName: 'Agent', result: expect.stringContaining('STOPPED BY THE USER') });
    expect(mgr.hasRunning()).toBe(false);
    await expect(mgr.resume(resumeReq('tc-r2'))).resolves.toMatchObject({ status: 'running' });
    mgr.dispose();
  });

  // pi's session.abort() does nothing before prompt(), so only the manager can keep this run from starting.
  it('a stop while the resumed session is being opened never prompts it, records the stop, and frees the id', async () => {
    const { engine, dir } = resumeEngine();
    writeAgentFile(dir, { status: { status: 'stopped', stopReason: 'user' } });
    spawnOnBranch(spawnArgs);
    let release!: () => void;
    const opening = new Promise<void>((r) => (release = r));
    let creating = 0;
    const create = engine.createSession;
    engine.createSession = async (opts) => {
      if (++creating === 1) await opening;
      return create(opts);
    };
    const mgr = new AgentManager(engine);
    const parent = new AbortController();

    const first = await mgr.resume({ ...resumeReq('tc-r1'), signal: parent.signal });
    await vi.waitFor(() => expect(creating).toBe(1));
    parent.abort();
    release();
    await vi.waitFor(() => expect(customEntries.map((e) => e.customType)).toContain('damocles-agent-segment'));

    expect(prompts).toEqual([]);
    await first.promise;
    expect(first).toMatchObject({ status: 'stopped', stopReason: 'user' });
    expect(customEntries).toEqual([
      { customType: 'damocles-agent-segment', data: { toolCallId: 'tc-r1' } },
      { customType: DAMOCLES_AGENT_STATUS_ENTRY, data: { status: 'stopped', stopReason: 'user', result: expect.stringContaining('STOPPED BY THE USER') } },
    ]);
    await expect(mgr.resume(resumeReq('tc-r2'))).resolves.toMatchObject({ status: 'running' });
    mgr.dispose();
  });

  it('a resume called right after a stop waits for the stopped run to finish before reading its file', async () => {
    const { engine, gates } = resumeEngine();
    const mgr = new AgentManager(engine);
    const id = mgr.spawn(spec(0));
    branch.unshift({
      type: 'message', id: 'm0', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc0', name: 'Agent', arguments: { description: 'd0', prompt: 'task 0', subagent_type: 'general-purpose' } }] },
    } as unknown as SessionEntry);
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const stopped = mgr.getRecord(id)!;
    const order: string[] = [];
    void stopped.promise!.then(() => order.push('stopped run settled'));
    const storeDir = engine.subagentStoreDir;
    engine.subagentStoreDir = () => (order.push('file lookup'), storeDir());

    mgr.abort(id, 'user');
    const resumed = mgr.resume({ kind: 'resume', agentId: id, toolCallId: 'tc-r' });
    expect(order).toEqual([]);

    gateAt(gates, 0).resolve();
    const record = await resumed;
    expect(order.slice(0, 2)).toEqual(['stopped run settled', 'file lookup']);
    expect(record).not.toBe(stopped);
    expect(record.status).toBe('running');
    mgr.dispose();
  });

  it('a background resume keeps its mode and reports through the keep-alive under the resume call', async () => {
    const { engine, gates, dir } = resumeEngine();
    writeAgentFile(dir, { background: true, status: { status: 'stopped', stopReason: 'shutdown' } });
    spawnOnBranch({ ...spawnArgs, run_in_background: true }, { agentId: AGENT, status: 'async_launched' });
    const mgr = new AgentManager(engine);

    const record = await mgr.resume({ ...resumeReq('tc-r'), signal: AbortSignal.abort() });
    expect(record.background).toBe(true);
    await settle();
    expect(prompts).toEqual([buildResumePrompt()]);
    // A background agent is not bound to the parent turn's signal, even an aborted one.
    expect(record.status).toBe('running');
    expect(mgr.hasUnconsumedBackground()).toBe(true);

    gateAt(gates, 0).resolve();
    await mgr.waitForBackground();
    const [done] = mgr.takeCompletedBackgroundResults();
    expect(done).toMatchObject({ id: AGENT, toolCallId: 'tc-r', status: 'completed' });
    mgr.dispose();
  });

  it('an agent with no file re-runs fresh under its id from the spawning call\'s arguments', async () => {
    const { engine, dir } = resumeEngine();
    spawnOnBranch({ ...spawnArgs, thinking: 'low', run_in_background: false }, { agentId: AGENT, status: 'async_launched' });
    const mgr = new AgentManager(engine);

    const record = await mgr.resume(resumeReq('tc-r', 'be quick'));
    await settle();

    expect(record.background).toBe(true);
    expect(sessionOpts[0]!.store).toEqual({ kind: 'file', dir, id: AGENT });
    expect(sessionOpts[0]!.thinkingLevel).toBe('low');
    expect(customEntries).toEqual([
      {
        customType: 'damocles-agent-launch',
        data: { agentId: AGENT, kind: 'subagent', agentType: 'general-purpose', description: 'dig in', prompt: 'find the bug', background: true, thinkingOverride: 'low' },
      },
      { customType: 'damocles-agent-segment', data: { toolCallId: 'tc-r', message: 'be quick' } },
    ]);
    // The marker must open the message: the steering protocol honours it only on the first line.
    expect(prompts).toEqual([wrapSteerMessage('be quick\n\nYour original task:\nfind the bug')]);
    expect(prompts[0]!.split('\n')[0]).toBe(STEER_INSTRUCTION_PREFIX);
    mgr.dispose();
  });

  it('a second ESC during a resume leaves the agent resumable', async () => {
    const { engine, gates, dir } = resumeEngine();
    writeAgentFile(dir, { status: { status: 'stopped', stopReason: 'user' } });
    spawnOnBranch(spawnArgs);
    const mgr = new AgentManager(engine);

    const first = await mgr.resume(resumeReq('tc-r1'));
    await settle();
    mgr.abortAll('user');
    gateAt(gates, 0).resolve();
    await first.promise;
    expect(first).toMatchObject({ status: 'stopped', stopReason: 'user' });

    const second = await mgr.resume(resumeReq('tc-r2'));
    expect(second).not.toBe(first);
    expect(second.status).toBe('running');
    mgr.dispose();
  });

  it.each([
    ['user', true],
    ['shutdown', true],
    ['budget', false],
    ['reset', false],
  ] as const)('a live agent stopped for %s is resumable: %s', async (reason, resumable) => {
    const { engine, gates } = resumeEngine();
    const mgr = new AgentManager(engine);
    const id = mgr.spawn(spec(0));
    branch.unshift({
      type: 'message', id: 'm0', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc0', name: 'Agent', arguments: { description: 'd0', prompt: 'task 0', subagent_type: 'general-purpose' } }] },
    } as unknown as SessionEntry);
    await flush();
    mgr.abortAll(reason);
    gateAt(gates, 0).resolve();
    await mgr.getRecord(id)!.promise;

    const attempt = mgr.resume({ kind: 'resume', agentId: id, toolCallId: 'tc-r' });
    if (resumable) await expect(attempt).resolves.toMatchObject({ status: 'running' });
    else await expect(attempt).rejects.toThrow(reason === 'budget' ? 'budget limit' : 'when its conversation was cleared');
    mgr.dispose();
  });

  it('the budget meter counts only spend after the session reopened', async () => {
    const { engine, gates, dir } = resumeEngine();
    writeAgentFile(dir, { status: { status: 'stopped', stopReason: 'user' } });
    spawnOnBranch(spawnArgs);
    let cost = 0.5;
    const create = engine.createSession;
    engine.createSession = async (opts) => {
      const session = await create(opts);
      (session as unknown as { getSessionStats: () => { cost: number } }).getSessionStats = () => ({ cost });
      return session;
    };
    const charged: number[] = [];
    engine.onSubagentCost = (delta) => charged.push(delta);
    const mgr = new AgentManager(engine);

    const record = await mgr.resume(resumeReq('tc-r'));
    await settle();
    cost = 0.75;
    gateAt(gates, 0).resolve();
    await record.promise;

    expect(charged.reduce((a, b) => a + b, 0)).toBeCloseTo(0.25);
    expect(record.costUsd).toBeCloseTo(0.25);
    mgr.dispose();
  });

  type Exec = (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
  const agentExecute = (mgr: AgentManager): Exec => (buildSubagentTools(piStub, mgr)[0] as unknown as { execute: Exec }).execute;
  /** The model-visible text inside a foreground `Agent` result. */
  const resultText = (result: { content: Array<{ text: string }> }): string =>
    (JSON.parse(result.content[0]!.text) as { content: Array<{ text: string }> }).content[0]!.text;

  /** Append a resume segment to an agent file, as a resumed run does, ending in `status` when given. */
  function appendSegment(file: string, toolCallId: string, status?: { status: string; stopReason?: string }): void {
    const sm = SessionManager.open(file);
    sm.appendCustomEntry('damocles-agent-segment', { toolCallId });
    sm.appendMessage(assistantMessage('more'));
    if (status) sm.appendCustomEntry('damocles-agent-status', { ...status, result: 'partial' });
  }

  // The branch entry is forged: it guards the id check itself, not the branch reader's own id filter.
  it.each(['../x', 'a/b', '..\\x', '/etc/passwd', 'C:\\Windows\\win.ini', '\\\\server\\share\\x'])(
    'the Agent tool rejects the path-shaped id %j before any filesystem access',
    async (bad) => {
      const { engine } = resumeEngine();
      const storeDir = vi.fn(engine.subagentStoreDir);
      engine.subagentStoreDir = storeDir;
      branch.push({
        type: 'custom', customType: 'damocles-agent-invocation', id: 'forged', parentId: null, timestamp: new Date().toISOString(),
        data: { kind: 'subagent', id: bad, toolCallId: 'tc-forged', resume: false },
      } as SessionEntry);
      const mgr = new AgentManager(engine);
      vi.mocked(fsp.readdir).mockClear();
      vi.mocked(fsp.readFile).mockClear();

      await expect(agentExecute(mgr)('tc-r', { resume: bad })).rejects.toMatchObject({ message: `"${bad}" is not a valid subagent id.` });
      expect(fsp.readdir).not.toHaveBeenCalled();
      expect(fsp.readFile).not.toHaveBeenCalled();
      expect(storeDir).not.toHaveBeenCalled();
      expect(invocations).toEqual([]);
    },
  );

  it('the filesystem spies observe the file lookup of a well-formed resume', async () => {
    const { engine, dir } = resumeEngine();
    spawnOnBranch(spawnArgs);
    const mgr = new AgentManager(engine);
    vi.mocked(fsp.readdir).mockClear();

    await mgr.resume(resumeReq('tc-r'));

    expect(fsp.readdir).toHaveBeenCalledWith(dir);
    mgr.dispose();
  });

  const MODEL_ERROR = `Cannot resume "${AGENT}": its model anthropic/claude is not configured or not signed in.`;
  const stoppedByUser = { status: { status: 'stopped', stopReason: 'user' } };
  it.each<[string, (dir: string, engine: SubagentEngine) => void, string]>([
    ['an id only another conversation invoked', (dir) => void writeAgentFile(dir, stoppedByUser), `No interrupted subagent "${AGENT}" in this conversation.`],
    [
      'a finished agent',
      (dir) => (writeAgentFile(dir, { status: { status: 'completed' } }), spawnOnBranch(spawnArgs)),
      `Subagent "${AGENT}" finished with status "completed"; only interrupted agents can be resumed.`,
    ],
    [
      'a budget-stopped agent',
      (dir) => (writeAgentFile(dir, { status: { status: 'stopped', stopReason: 'budget' } }), spawnOnBranch(spawnArgs)),
      `Subagent "${AGENT}" was stopped by the budget limit and cannot be resumed.`,
    ],
    [
      'an agent whose type is gone',
      (dir) => (writeAgentFile(dir, { agentType: 'retired-agent', ...stoppedByUser }), spawnOnBranch(spawnArgs)),
      `Subagent "${AGENT}" was a "retired-agent" agent, which is no longer available.`,
    ],
    [
      'an agent whose model is unavailable',
      (dir, engine) => {
        writeAgentFile(dir, stoppedByUser);
        spawnOnBranch(spawnArgs);
        engine.assertResumableModel = () => {
          throw new Error(MODEL_ERROR);
        };
      },
      MODEL_ERROR,
    ],
  ])('the Agent tool rejects resuming %s with the exact refusal text and starts nothing', async (_label, setup, error) => {
    const { engine, dir } = resumeEngine();
    setup(dir, engine);
    const mgr = new AgentManager(engine);

    await expect(agentExecute(mgr)('tc-r', { resume: AGENT })).rejects.toMatchObject({ message: error });
    expect(invocations).toEqual([]);
    expect(sessionOpts).toEqual([]);
    mgr.dispose();
  });

  it('the Agent tool reports a running, queued or resuming agent as still active, and one resume of two parallel ones starts', async () => {
    const { engine, dir } = resumeEngine();
    writeAgentFile(dir, stoppedByUser);
    spawnOnBranch(spawnArgs);
    const mgr = new AgentManager(engine, 1);
    const execute = agentExecute(mgr);
    const bg = { description: 'd', prompt: 'p', subagent_type: 'general-purpose', run_in_background: true };
    const idOf = (r: { details: unknown }) => (r.details as { agentId: string }).agentId;
    const running = idOf(await execute('tc-a', bg));
    const queued = idOf(await execute('tc-b', bg));
    const still = (id: string, status: string) =>
      `Subagent "${id}" is still ${status}; steer it with SteerSubagent or read it with GetSubagentResult.`;

    await expect(execute('tc-r0', { resume: running })).rejects.toMatchObject({ message: still(running, 'running') });
    await expect(execute('tc-r0', { resume: queued })).rejects.toMatchObject({ message: still(queued, 'queued') });

    const first = execute('tc-r1', { resume: AGENT });
    const second = execute('tc-r2', { resume: AGENT });
    await expect(second).rejects.toMatchObject({
      message: `Subagent "${AGENT}" is already being resumed by another Agent call; wait for that call's result.`,
    });
    await vi.waitFor(() => expect(invocations.filter((i) => i.resume)).toEqual([{ kind: 'subagent', id: AGENT, toolCallId: 'tc-r1', resume: true }]));
    await expect(execute('tc-r3', { resume: AGENT })).rejects.toMatchObject({ message: still(AGENT, 'queued') });

    mgr.dispose();
    await first;
  });

  // Checked against a running agent: the branch lookup must come before the live "still running" check.
  it('an agent whose invocation was rewound off the branch is unknown, even while it runs', async () => {
    const { engine, gates } = resumeEngine();
    const mgr = new AgentManager(engine, 2);
    const running = mgr.spawn(spec(0));
    const stopped = mgr.spawn(spec(1));
    await vi.waitFor(() => expect(gates.length).toBe(2));
    mgr.abort(stopped, 'user');
    gateAt(gates, 1).resolve();
    await mgr.getRecord(stopped)!.promise;
    branch.length = 0;
    const execute = agentExecute(mgr);

    for (const id of [running, stopped]) {
      await expect(execute('tc-r', { resume: id })).rejects.toMatchObject({ message: `No interrupted subagent "${id}" in this conversation.` });
    }
    expect(invocations.filter((i) => i.resume)).toEqual([]);
    mgr.dispose();
  });

  it('after a reload, an agent stopped again during its resume resumes a third time from the same file', async () => {
    const { engine, dir } = resumeEngine();
    const file = writeAgentFile(dir, stoppedByUser);
    appendSegment(file, 'tc-r1', { status: 'stopped', stopReason: 'user' });
    spawnOnBranch(spawnArgs);
    branch.push(invocationEntry({ kind: 'subagent', id: AGENT, toolCallId: 'tc-r1', resume: true }));
    const mgr = new AgentManager(engine);

    const record = await mgr.resume(resumeReq('tc-r2'));
    await settle();

    expect(record.status).toBe('running');
    expect(sessionOpts.map((o) => o.store)).toEqual([{ kind: 'reopen', path: file, agentId: AGENT }]);
    expect(customEntries).toEqual([{ customType: 'damocles-agent-segment', data: { toolCallId: 'tc-r2' } }]);
    mgr.dispose();
  });

  it('after a reload, the latest resume segment decides the status, not the launch segment', async () => {
    const { engine, dir } = resumeEngine();
    const file = writeAgentFile(dir, stoppedByUser);
    appendSegment(file, 'tc-r1', { status: 'completed' });
    spawnOnBranch(spawnArgs);
    branch.push(invocationEntry({ kind: 'subagent', id: AGENT, toolCallId: 'tc-r1', resume: true }));
    const mgr = new AgentManager(engine);

    await expect(mgr.resume(resumeReq('tc-r2'))).rejects.toMatchObject({
      message: `Subagent "${AGENT}" finished with status "completed"; only interrupted agents can be resumed.`,
    });
  });

  it('a foreground resume through the Agent tool returns the resumed run as its tool result', async () => {
    const { engine, gates, dir } = resumeEngine();
    writeAgentFile(dir, stoppedByUser);
    spawnOnBranch(spawnArgs, { agentId: AGENT, status: 'stopped', stopReason: 'user' });
    const create = engine.createSession;
    engine.createSession = async (opts) => {
      const session = await create(opts);
      (session as unknown as { messages: unknown[] }).messages = [{ role: 'assistant', content: [{ type: 'text', text: 'fixed the bug' }] }];
      return session;
    };
    const mgr = new AgentManager(engine);

    const pending = agentExecute(mgr)('tc-r', { resume: AGENT }, new AbortController().signal);
    // Validation reads real files, so the session appears after an unknown number of ticks.
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gateAt(gates, 0).resolve();
    const result = await pending;

    expect(resultText(result)).toBe('fixed the bug');
    expect(result.details).toEqual({ agentId: AGENT, status: 'completed' });
    expect(invocations).toEqual([{ kind: 'subagent', id: AGENT, toolCallId: 'tc-r', resume: true }]);
    mgr.dispose();
  });

  it('a background resume through the Agent tool acknowledges, then injects its result under the resume call', async () => {
    const { engine, gates, dir } = resumeEngine();
    writeAgentFile(dir, { background: true, status: { status: 'stopped', stopReason: 'shutdown' } });
    spawnOnBranch({ ...spawnArgs, run_in_background: true }, { agentId: AGENT, status: 'async_launched' });
    const mgr = new AgentManager(engine);

    const result = await agentExecute(mgr)('tc-r', { resume: AGENT });
    expect(result.details).toEqual({ agentId: AGENT, status: 'async_launched' });
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gateAt(gates, 0).resolve();
    await mgr.waitForBackground();

    expect(backgroundResultsDetails(mgr.takeCompletedBackgroundResults())).toEqual({
      agents: [{ agentId: AGENT, toolCallId: 'tc-r', status: 'completed', result: '' }],
    });
    mgr.dispose();
  });

  it('a background resume still validating when the panel is disposed never starts', async () => {
    const { engine, dir } = resumeEngine();
    writeAgentFile(dir, { background: true, status: { status: 'stopped', stopReason: 'shutdown' } });
    spawnOnBranch({ ...spawnArgs, run_in_background: true }, { agentId: AGENT, status: 'async_launched' });
    const mgr = new AgentManager(engine);

    const pending = mgr.resume({ ...resumeReq('tc-r'), signal: AbortSignal.abort() });
    mgr.dispose();
    await pending.catch(() => undefined);
    await settle();

    expect(sessionOpts).toEqual([]);
    expect(mgr.hasRunning()).toBe(false);
  });

  it('an ESC while a resume validates stops it before it starts, and the agent stays resumable', async () => {
    const { engine, gates, dir } = resumeEngine();
    writeAgentFile(dir, { background: true, status: { status: 'stopped', stopReason: 'user' } });
    spawnOnBranch({ ...spawnArgs, run_in_background: true }, { agentId: AGENT, status: 'async_launched' });
    const mgr = new AgentManager(engine);

    const first = mgr.resume(resumeReq('tc-r1'));
    mgr.abortAll('user');
    await expect(first).rejects.toThrow(`The resume of subagent "${AGENT}" was stopped before it started; it can still be resumed.`);
    expect(sessionOpts).toEqual([]);
    expect(invocations).toEqual([]);

    const second = await mgr.resume(resumeReq('tc-r2'));
    expect(second.status).toBe('running');
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gateAt(gates, 0).resolve();
    await mgr.waitForBackground();
    mgr.dispose();
  });

  it('a budget-stopped foreground agent tells the parent it cannot be resumed, and a resume of it is refused', async () => {
    const { engine, gates } = resumeEngine();
    const mgr = new AgentManager(engine);
    const execute = agentExecute(mgr);

    const pending = execute('tc-b', { description: 'd', prompt: 'p', subagent_type: 'general-purpose' });
    await settle();
    mgr.abortAll('budget');
    gateAt(gates, 0).resolve();
    const result = await pending;
    const id = (result.details as { agentId: string }).agentId;

    expect(result.details).toEqual({ agentId: id, status: 'stopped', stopReason: 'budget' });
    expect(resultText(result)).toBe(' (stopped by the budget limit before completion; output is partial and it cannot be resumed)');
    await expect(execute('tc-r', { resume: id })).rejects.toMatchObject({
      message: `Subagent "${id}" was stopped by the budget limit and cannot be resumed.`,
    });
    mgr.dispose();
  });
});

describe('AgentManager Agent result JSON', () => {
  type Completed = Extract<ExtensionToWebviewMessage, { type: 'toolCompleted' }>;

  function cardResult(posted: ExtensionToWebviewMessage[], toolUseId: string): Record<string, unknown> {
    const done = posted.find((m): m is Completed => m.type === 'toolCompleted' && m.toolUseId === toolUseId);
    if (!done) throw new Error(`no toolCompleted for ${toolUseId}`);
    return JSON.parse(done.result) as Record<string, unknown>;
  }

  it('carries a stopped background agent\'s status on its card completion', async () => {
    const { engine, gates } = makeEngine();
    const posted: ExtensionToWebviewMessage[] = [];
    engine.postMessage = (m) => void posted.push(m);
    const mgr = new AgentManager(engine, 4);
    const id = mgr.spawn(spec(0));
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    mgr.abort(id, 'user');
    gateAt(gates, 0).resolve();
    await mgr.getRecord(id)!.promise;

    expect(cardResult(posted, 'tc0')).toMatchObject({ agentId: id, agentStatus: 'stopped' });
    mgr.dispose();
  });

  it('carries a completed background agent\'s status on its card completion', async () => {
    const { engine, gates } = makeEngine();
    const posted: ExtensionToWebviewMessage[] = [];
    engine.postMessage = (m) => void posted.push(m);
    const mgr = new AgentManager(engine, 4);
    const id = mgr.spawn(spec(0));
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    gateAt(gates, 0).resolve();
    await mgr.getRecord(id)!.promise;

    expect(cardResult(posted, 'tc0')).toMatchObject({ agentId: id, agentStatus: 'completed' });
    mgr.dispose();
  });

  // An errored card resolves through toolFailed, so the built JSON is only visible at `finish`.
  it.each([
    ['a run that threw', (engine: SubagentEngine) => { engine.createSession = async () => { throw new Error('boom'); }; }, 'general-purpose'],
    ['a spawn refused before running', () => {}, 'does-not-exist'],
  ])('carries the error status for %s', async (_label, breakEngine, type) => {
    const { engine } = makeEngine();
    breakEngine(engine);
    const finish = vi.spyOn(SubagentStreamBridge.prototype, 'finish');
    try {
      const mgr = new AgentManager(engine, 4);
      const id = mgr.spawn({ ...spec(0), type });
      await mgr.getRecord(id)!.promise;

      expect(finish).toHaveBeenCalledTimes(1);
      const opts = finish.mock.calls[0]![0];
      expect(opts.isError).toBe(true);
      expect(JSON.parse(opts.resultJson)).toMatchObject({ agentId: id, agentStatus: 'error' });
      mgr.dispose();
    } finally {
      finish.mockRestore();
    }
  });
});
