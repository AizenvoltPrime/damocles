import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Every lease and agent file stays out of ~/.damocles.
vi.mock('../../../paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return { DAMOCLES_HOME_DIR: mkdtempSync(joinPath(tmpdir(), 'damocles-subagent-owner-')) };
});

import { fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai';
import type { AgentSession, SessionEntry } from '@earendil-works/pi-coding-agent';
import { DAMOCLES_HOME_DIR } from '../../../paths';
import { AgentManager, type SubagentEngine } from '../agent-manager';
import { AgentRegistry } from '../agent-types';
import { buildNestedMcpToolset } from '../../tools/mcp-tools';
import { ShellCancelStore } from '../../tools/shell-cancel-registry';
import type { PiCodingAgentModule } from '../../pi-loader';
import { initPiLoader } from '../../pi-loader';
import type { McpResourceRuleFilter } from '../../../permission-handler/mcp-resource-rule';
import type { ExtensionToWebviewMessage } from '../../../../shared/types/messages';
import type { AgentWindDown } from '../../../../shared/types/wind-down';
import { WIND_DOWN_NOTICE_MS } from '../../wind-down-notice';
import * as lockfile from 'proper-lockfile';
import { agentFileSessionId, type AgentInvocationData } from '../../agent-records';
import { SESSION_LEASE_DIR, sessionLeasePath } from '../../session-store/session-lease';
import { DAMOCLES_AGENT_INVOCATION_ENTRY, DAMOCLES_AGENT_SEGMENT_ENTRY } from '../../session-store/constants';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { HELD_DRAFT_ENTRY, heldSettleSessions, type HeldSettleSession } from '../../__tests__/held-settle-fixture';

/**
 * A subagent's session file has one writer. A session switch retires the bound session's agents and drops their records
 * once its wait times out (`retireAgents`), while a pi extension's `agent_before_settle` handler can still hold a stopped
 * run. Real `AgentManager` and real pi sessions on real files.
 */

beforeAll(async () => {
  await initPiLoader();
});

const sessions = heldSettleSessions();
afterEach(() => sessions.dispose());
afterAll(() => fs.rmSync(DAMOCLES_HOME_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const NO_RESOURCE_RULES = async (): Promise<McpResourceRuleFilter> => ({ serverCovered: () => false, resourceDenied: () => false, resourceDenyRule: () => undefined, contentCovered: () => false });
const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

interface Opened {
  kind: 'file' | 'reopen';
  booted: HeldSettleSession;
  forgotten: Promise<void>;
}

interface Harness {
  engine: SubagentEngine;
  opened: Opened[];
  events: string[];
  held: Array<ReturnType<HeldSettleSession['holdBeforeSettle']>>;
  posted: ExtensionToWebviewMessage[];
}

/** An engine whose sessions are real pi sessions on files in one store dir; each launch takes the next script. */
function harness(scripts: Array<{ responses: FauxResponseStep[]; holdBeforeSettle?: boolean }>): Harness {
  const storeDir = fs.mkdtempSync(path.join(DAMOCLES_HOME_DIR, 'subagents-'));
  const invocations: AgentInvocationData[] = [];
  const forgets = new Map<AgentSession, () => void>();
  const h = { opened: [], events: [], held: [], posted: [] } as unknown as Harness;
  h.engine = {
    cwd: process.cwd(),
    trust: createFakePlatform().trust,
    registry: new AgentRegistry(),
    createSession: async (opts) => {
      const script = scripts[h.opened.length];
      if (!script) throw new Error('no script for this launch');
      const store = opts.store;
      if (store.kind === 'memory') throw new Error('a subagent session is always on a file');
      h.events.push(`open:${store.kind}`);
      const booted = await sessions.boot(script.responses, {
        extensionFactory: opts.extensionFactory,
        store: store.kind === 'file' ? store : { kind: 'reopen', path: store.path },
        beforeSettle: true,
      });
      if (script.holdBeforeSettle) h.held.push(booted.holdBeforeSettle());
      let markForgotten!: () => void;
      const forgotten = new Promise<void>((resolve) => { markForgotten = resolve; });
      forgets.set(booted.session, markForgotten);
      h.opened.push({ kind: store.kind, booted, forgotten });
      return booted.session;
    },
    forgetSession: (session) => {
      session.dispose();
      forgets.get(session)?.();
    },
    permissionHandler: {} as never,
    isPlanMode: () => false,
    shellCancelFor: () => new ShellCancelStore().forContext(() => undefined),
    postMessage: (message) => h.posted.push(message),
    getParentSystemPrompt: () => '',
    getParentSessionId: () => 'parent-sid',
    subagentStoreDir: () => storeDir,
    recordInvocation: (data) => { invocations.push(data); },
    parentBranch: () => invocations.map((data, i) => ({
      type: 'custom', id: `e${i}`, parentId: null, timestamp: new Date().toISOString(), customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data,
    }) as unknown as SessionEntry),
    assertResumableModel: () => {},
    parentFullToolNames: () => [],
    buildAgentToolset: () => ({ customTools: [], mcp: buildNestedMcpToolset(piStub, null, { eligible: new Set(), disabledEntries: [], resourceRuleFilter: NO_RESOURCE_RULES }) }),
    disposeBrowserScope: () => {},
    cancelAgentDialogs: () => {},
    resolveModel: () => ({}),
    modelDollarBilled: () => true,
    onSubagentCost: () => {},
    onRunsChanged: () => {},
  };
  return h;
}

interface FileEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  customType?: string;
  message?: { role?: string };
}

function entriesOf(file: string): FileEntry[] {
  return fs.readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as FileEntry);
}

/** Each entry's parent is the entry before it: one writer appended the file as one chain. */
function parentChainBreaks(entries: readonly FileEntry[]): string[] {
  const breaks: string[] = [];
  for (let i = 2; i < entries.length; i++) {
    if (entries[i]!.parentId !== entries[i - 1]!.id) breaks.push(`${i}:${entries[i]!.type}/${entries[i]!.customType ?? entries[i]!.message?.role ?? ''}`);
  }
  return breaks;
}

function windDowns(posted: readonly ExtensionToWebviewMessage[], toolCallId: string): Array<AgentWindDown | null> {
  return posted.flatMap((m) => (m.type === 'statusUpdate' && m.status === 'windingDown' && m.parentToolUseId === toolCallId ? [m.windDown] : []));
}

const SPAWN = { kind: 'spawn', type: 'general-purpose', prompt: 'do the task', description: 'dig', toolCallId: 'tc-1', runInBackground: true } as const;

describe("a subagent's session file while a pi extension holds its stopped run", () => {
  it('a resume after a session switch dropped its record opens the file only after the old session let go', async () => {
    const h = harness([
      { responses: [fauxAssistantMessage('Halfway.')], holdBeforeSettle: true },
      { responses: [fauxAssistantMessage('Resumed and done.')] },
    ]);
    const manager = new AgentManager(h.engine, 2);
    const id = manager.spawn(SPAWN);
    await vi.waitFor(() => expect(h.held.length).toBe(1), { timeout: 10_000 });
    await within(h.held[0]!.waiting, 10_000, 'the held agent_before_settle handler');
    const agentFile = h.opened[0]!.booted.session.sessionManager.getSessionFile()!;

    // What a session switch's `retireAgents` does once its wait for the stopped runs timed out.
    manager.abortAll('shutdown');
    manager.clear();

    const record = await manager.resume({ kind: 'resume', agentId: id, toolCallId: 'tc-2' });
    // Long enough for an unguarded resume to open the file and run its whole turn.
    await sleep(2_000);
    // The resumed card shows what the old run still waits for once the old run's notice delay passed.
    const shown = { phase: 'settle', events: ['agent_before_settle', 'agent_settled'], extensions: [h.opened[0]!.booted.extensionPath] };
    await vi.waitFor(() => expect(windDowns(h.posted, 'tc-2')).toEqual([shown]), { timeout: WIND_DOWN_NOTICE_MS + 2_000 });
    // A reloaded webview hears the waiting card's relayed wind-down from the record that shows it.
    const sinceReload = h.posted.length;
    manager.replayLive();
    expect(windDowns(h.posted.slice(sinceReload), 'tc-2')).toEqual([shown]);
    h.events.push('released');
    h.held[0]!.release();
    await within(h.opened[0]!.forgotten, 10_000, 'the old subagent session');
    await within(record.promise!, 20_000, 'the resumed subagent');

    const entries = entriesOf(agentFile);
    const draft = entries.findIndex((e) => e.customType === HELD_DRAFT_ENTRY);
    const segment = entries.findIndex((e) => e.customType === DAMOCLES_AGENT_SEGMENT_ENTRY);
    expect(draft).toBeGreaterThan(0);
    expect(parentChainBreaks(entries)).toEqual([]);
    expect(segment).toBeGreaterThan(draft);
    expect(h.events).toEqual(['open:file', 'released', 'open:reopen']);
    expect(windDowns(h.posted, 'tc-2')).toEqual([shown, shown, null]);
    expect(record.status).toBe('completed');
    expect(await record.promise).toContain('Resumed and done.');
    manager.dispose();
  }, 60_000);

  it("a resume from another panel's manager, after the first panel closed while its run was held, waits for that run", async () => {
    const h = harness([
      { responses: [fauxAssistantMessage('Halfway.')], holdBeforeSettle: true },
      { responses: [fauxAssistantMessage('Resumed and done.')] },
    ]);
    const closed = new AgentManager(h.engine, 2);
    const id = closed.spawn(SPAWN);
    await vi.waitFor(() => expect(h.held.length).toBe(1), { timeout: 10_000 });
    await within(h.held[0]!.waiting, 10_000, 'the held agent_before_settle handler');
    const agentFile = h.opened[0]!.booted.session.sessionManager.getSessionFile()!;
    // A panel close disposes the session at once, while pi can still commit the held run's draft.
    closed.dispose();

    const manager = new AgentManager(h.engine, 2);
    const record = await manager.resume({ kind: 'resume', agentId: id, toolCallId: 'tc-2' });
    await sleep(2_000);
    h.events.push('released');
    h.held[0]!.release();
    await within(record.promise!, 20_000, 'the resumed subagent');
    // The disposed session's draft has no event to wait on, so the file is read once it holds it.
    await vi.waitFor(() => expect(entriesOf(agentFile).some((e) => e.customType === HELD_DRAFT_ENTRY)).toBe(true));

    const entries = entriesOf(agentFile);
    const draft = entries.findIndex((e) => e.customType === HELD_DRAFT_ENTRY);
    const segment = entries.findIndex((e) => e.customType === DAMOCLES_AGENT_SEGMENT_ENTRY);
    expect(parentChainBreaks(entries)).toEqual([]);
    expect(segment).toBeGreaterThan(draft);
    expect(h.events).toEqual(['open:file', 'released', 'open:reopen']);
    expect(record.status).toBe('completed');
    manager.dispose();
  }, 60_000);

  it('a resume whose agent file another Damocles window holds is refused before it records anything, and stays resumable', async () => {
    const h = harness([
      { responses: [fauxAssistantMessage('Halfway.')], holdBeforeSettle: true },
      { responses: [fauxAssistantMessage('Resumed and done.')] },
    ]);
    const manager = new AgentManager(h.engine, 2);
    const id = manager.spawn(SPAWN);
    await vi.waitFor(() => expect(h.held.length).toBe(1), { timeout: 10_000 });
    await within(h.held[0]!.waiting, 10_000, 'the held agent_before_settle handler');
    manager.abort(id, 'user');
    h.held[0]!.release();
    await within(manager.getRecord(id)!.promise!, 10_000, 'the stopped subagent');

    // Another process's lease is the lock file alone, which this process does not hold.
    const lock = sessionLeasePath(agentFileSessionId(h.opened[0]!.booted.session.sessionManager.getSessionFile()!));
    fs.mkdirSync(SESSION_LEASE_DIR, { recursive: true });
    const unlock = lockfile.lockSync(lock, { lockfilePath: lock, realpath: false, stale: 20_000, update: 2_000 });
    try {
      await expect(manager.resume({ kind: 'resume', agentId: id, toolCallId: 'tc-2' })).rejects.toThrow(
        `Subagent "${id}" cannot be resumed yet: its session file is still open in another Damocles window, whose stopped run has not finished. Wait for that run to stop or close that window, then resume it again.`,
      );
    } finally {
      unlock();
    }
    expect(h.events).toEqual(['open:file']);

    const record = await manager.resume({ kind: 'resume', agentId: id, toolCallId: 'tc-3' });
    expect(await within(record.promise!, 10_000, 'the resumed subagent')).toContain('Resumed and done.');
    manager.dispose();
  }, 60_000);

  it("a Stop of the resumed subagent while it waits for its file ends the wait, and the file keeps only the old run's writes", async () => {
    const h = harness([{ responses: [fauxAssistantMessage('Halfway.')], holdBeforeSettle: true }]);
    const manager = new AgentManager(h.engine, 2);
    const id = manager.spawn(SPAWN);
    await vi.waitFor(() => expect(h.held.length).toBe(1), { timeout: 10_000 });
    await within(h.held[0]!.waiting, 10_000, 'the held agent_before_settle handler');
    const agentFile = h.opened[0]!.booted.session.sessionManager.getSessionFile()!;
    manager.abortAll('shutdown');
    manager.clear();

    const record = await manager.resume({ kind: 'resume', agentId: id, toolCallId: 'tc-2' });
    await sleep(500);
    expect(manager.abort(id, 'user')).toBe(true);
    await within(record.promise!, 2_000, 'the stopped resume');
    expect(record.status).toBe('stopped');

    h.held[0]!.release();
    await within(h.opened[0]!.forgotten, 10_000, 'the old subagent session');
    expect(h.events).toEqual(['open:file']);
    const entries = entriesOf(agentFile);
    expect(entries.some((e) => e.customType === DAMOCLES_AGENT_SEGMENT_ENTRY)).toBe(false);
    expect(parentChainBreaks(entries)).toEqual([]);
    manager.dispose();
  }, 60_000);
});
