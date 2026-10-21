import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// Point the Damocles home dir at a throwaway temp dir so every log, checkpoint, member file and lease stays out of ~/.damocles.
vi.mock('../../paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return { DAMOCLES_HOME_DIR: mkdtempSync(joinPath(tmpdir(), 'damocles-member-owner-')), findSessionPlanFiles: async () => [] };
});

import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai';
import type { AgentSession, SessionEntry, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { DAMOCLES_HOME_DIR } from '../../paths';
import { TeamService } from '../index';
import { teamAgentToolset } from './team-mcp-fixture';
import type { TeamEngine, TeamSessionOptions } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { AgentWindDown } from '../../../shared/types/wind-down';
import type { AgentInvocationData } from '../../pi-session/agent-records';
import * as lockfile from 'proper-lockfile';
import { agentFileSessionId, listTeamCheckpoints, teamCheckpointsDir, teamMembersDir, teamsDir } from '../../pi-session/agent-records';
import { SESSION_LEASE_DIR, sessionLeasePath } from '../../pi-session/session-store/session-lease';
import { piSessionDir } from '../../pi-session/session-store';
import { deletePiSession } from '../../pi-session/session-store/mutations';
import { initPiLoader } from '../../pi-session/pi-loader';
import { DAMOCLES_AGENT_INVOCATION_ENTRY, DAMOCLES_AGENT_SEGMENT_ENTRY } from '../../pi-session/session-store/constants';
import { HELD_DRAFT_ENTRY, heldSettleSessions, type HeldSettleSession } from '../../pi-session/__tests__/held-settle-fixture';

/**
 * A team member's session file has one writer. A Stop whose wind-down a user pi extension's `agent_before_settle` handler holds
 * outlasts the team's drain, so the team ends while the old member session can still append to its file. Real `TeamService`,
 * real runner and real pi sessions on real files.
 */

beforeAll(async () => {
  await initPiLoader();
});

const sessions = heldSettleSessions();
afterEach(() => {
  vi.useRealTimers();
  sessions.dispose();
});
afterAll(() => fs.rmSync(DAMOCLES_HOME_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const SESSION = 'parent-session';
const LEAD_ONLY = { title: 'held team', brief: 'the brief', agents: [{ name: 'Lead', role: 'lead' as const }] };
const SPECIALIST_DRAIN_MS = 30_000;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))]);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A tool that runs until its call is aborted. */
function untilAborted(): { definition: ToolDefinition; started: Promise<void> } {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const definition = {
    name: 'wait_for_stop',
    label: 'wait_for_stop',
    description: 'Waits until the run is stopped',
    parameters: Type.Object({}),
    execute: async (_id: string, _params: unknown, signal: AbortSignal | undefined) => {
      markStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { content: [{ type: 'text', text: 'stopped' }], details: {} };
    },
  } as unknown as ToolDefinition;
  return { definition, started };
}

interface Opened {
  store: TeamSessionOptions['store'];
  booted: HeldSettleSession;
  forgotten: Promise<void>;
}

interface Panel {
  service: TeamService;
  cwd: string;
  invocations: AgentInvocationData[];
  opened: Opened[];
  events: string[];
  webview: ExtensionToWebviewMessage[];
}

/**
 * A panel's `TeamService` whose engine boots a real pi session per member launch on the file the runner names. Each launch
 * takes the next `scripts` entry: its model responses, and whether its `agent_before_settle` handler is held.
 */
function panel(scripts: Array<{ responses: FauxResponseStep[]; holdBeforeSettle?: boolean; customTools?: ToolDefinition[] }>): Panel & { held: Array<ReturnType<HeldSettleSession['holdBeforeSettle']>> } {
  const cwd = path.join(DAMOCLES_HOME_DIR, crypto.randomUUID().slice(0, 8));
  const p = { cwd, invocations: [], opened: [], events: [], webview: [], held: [] } as unknown as Panel & { held: Array<ReturnType<HeldSettleSession['holdBeforeSettle']>> };
  const forgets = new Map<AgentSession, () => void>();
  const engine = {
    createSession: async (opts: TeamSessionOptions) => {
      const script = scripts[p.opened.length];
      if (!script) throw new Error('no script for this launch');
      const store = opts.store;
      if (store.kind === 'memory') throw new Error('a member session is always on a file');
      p.events.push(`open:${store.kind}`);
      const booted = await sessions.boot(script.responses, {
        store: store.kind === 'file' ? store : { kind: 'reopen', path: store.path },
        beforeSettle: true,
        ...(script.customTools ? { customTools: script.customTools } : {}),
      });
      if (script.holdBeforeSettle) p.held.push(booted.holdBeforeSettle());
      let markForgotten!: () => void;
      const forgotten = new Promise<void>((resolve) => { markForgotten = resolve; });
      forgets.set(booted.session, markForgotten);
      p.opened.push({ store, booted, forgotten });
      return booted.session;
    },
    forgetSession: (session: AgentSession) => {
      session.dispose();
      forgets.get(session)?.();
    },
    buildAgentToolset: () => teamAgentToolset(),
    buildExtensionFactory: () => (() => undefined) as never,
    onAgentCost: () => undefined,
    disposeBrowserScope: () => undefined,
    cancelAgentDialogs: () => undefined,
  } as unknown as TeamEngine;
  p.service = new TeamService({
    cwd,
    onMessage: (m) => { p.webview.push(m); },
    getSessionId: () => SESSION,
    getPermissionMode: () => 'default',
    resolveRoleModel: () => ({ modelLabel: 'model', dollarBilled: false }),
    buildEngine: () => engine,
    recordInvocation: (data) => { p.invocations.push(data); },
    parentBranch: () => p.invocations.map((data, i) => ({
      type: 'custom', id: `e${i}`, parentId: null, timestamp: new Date().toISOString(), customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data,
    }) as unknown as SessionEntry),
    assertResumableModel: () => undefined,
    requestInterruptionCheck: () => undefined,
  });
  return p;
}

interface FileEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  customType?: string;
  message?: { role?: string; content?: unknown };
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

function windDowns(messages: readonly ExtensionToWebviewMessage[], agentId: string): Array<AgentWindDown | null> {
  return messages.flatMap((m) => (m.type === 'statusUpdate' && m.status === 'windingDown' && m.parentToolUseId === agentId ? [m.windDown] : []));
}

function leadAgentId(p: Panel): string {
  const spawned = p.webview.find((m) => m.type === 'teamAgentStatusUpdate');
  if (spawned?.type !== 'teamAgentStatusUpdate') throw new Error('the lead was never reported');
  return spawned.agentId;
}

/**
 * Start a lead-only team whose lead's first turn ends into a held `agent_before_settle` handler, stop it, and let the team's
 * drain time out with fake timers, the way the neighbouring team tests shorten it.
 */
async function stoppedWhileHeld(p: Panel & { held: Array<ReturnType<HeldSettleSession['holdBeforeSettle']>> }): Promise<{ teamId: string; memberFile: string; createText: string }> {
  p.service.setPendingToolUseId('tc-create');
  const created = p.service.createTeam(LEAD_ONLY);
  await vi.waitFor(() => expect(p.held.length).toBe(1), { timeout: 10_000 });
  await within(p.held[0]!.waiting, 10_000, 'the held agent_before_settle handler');
  const teamId = p.invocations.at(-1)!.id;
  const memberFile = p.opened[0]!.booted.session.sessionManager.getSessionFile()!;
  expect(fs.existsSync(memberFile)).toBe(true);

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  expect(p.service.stopTeam(teamId)).toBe(true);
  await vi.advanceTimersByTimeAsync(SPECIALIST_DRAIN_MS + 3_000);
  vi.useRealTimers();
  const createText = await within(created, 10_000, 'the stopped team');
  return { teamId, memberFile, createText };
}

describe("a team member's session file while a pi extension holds its stopped run", () => {
  it('a team resume opens the member file only after the old session let go, so its late draft never follows the new run', async () => {
    const p = panel([
      { responses: [fauxAssistantMessage('On it.')], holdBeforeSettle: true },
      { responses: [fauxAssistantMessage('Resumed and done.'), fauxAssistantMessage('Still done.')] },
    ]);
    const { teamId, memberFile, createText } = await stoppedWhileHeld(p);
    expect(createText).toContain('TEAM STOPPED BY THE USER');
    const leadId = leadAgentId(p);

    const sinceResume = p.webview.length;
    const resumed = p.service.resumeTeam(teamId, undefined, 'tc-resume');
    // Long enough for an unguarded resume to open the file and run its whole turn.
    await sleep(2_000);
    // The waiting card shows what the old run still waits for, which only its owner can read.
    const shown = { phase: 'settle', events: ['agent_before_settle', 'agent_settled'], extensions: [p.opened[0]!.booted.extensionPath] };
    expect(windDowns(p.webview.slice(sinceResume), leadId)).toEqual([shown]);
    // A user's message to the waiting member is kept for the session it opens.
    expect(p.service.steerMember(leadId, 'focus on the parser')?.status).toBe('steered');
    p.events.push('released');
    p.held[0]!.release();
    await within(p.opened[0]!.forgotten, 10_000, 'the old member session');
    await within(resumed, 20_000, 'the resumed team');

    const entries = entriesOf(memberFile);
    const draft = entries.findIndex((e) => e.customType === HELD_DRAFT_ENTRY);
    const segment = entries.findIndex((e) => e.customType === DAMOCLES_AGENT_SEGMENT_ENTRY);
    expect(draft).toBeGreaterThan(0);
    expect(parentChainBreaks(entries)).toEqual([]);
    expect(segment).toBeGreaterThan(draft);
    expect(p.events).toEqual(['open:file', 'released', 'open:reopen']);
    expect(windDowns(p.webview.slice(sinceResume), leadId)).toEqual([shown, null]);
    const steered = entries.findIndex((e) => e.message?.role === 'user' && JSON.stringify(e.message.content).includes('focus on the parser'));
    expect(steered).toBeGreaterThan(segment);
  }, 60_000);

  it("a Stop while a resumed member waits for its file ends the wait at once, and the file keeps only the old run's writes", async () => {
    const p = panel([
      { responses: [fauxAssistantMessage('On it.')], holdBeforeSettle: true },
      { responses: [fauxAssistantMessage('Resumed and done.')] },
    ]);
    const { teamId, memberFile } = await stoppedWhileHeld(p);
    const leadId = leadAgentId(p);

    const sinceResume = p.webview.length;
    const resumed = p.service.resumeTeam(teamId, undefined, 'tc-resume');
    await vi.waitFor(() => expect(windDowns(p.webview.slice(sinceResume), leadId)).toHaveLength(1), { timeout: 5_000 });
    const stoppedAt = Date.now();
    expect(p.service.stopTeam(teamId)).toBe(true);
    expect(await within(resumed, 5_000, 'the resumed team')).toContain('TEAM STOPPED BY THE USER');
    expect(Date.now() - stoppedAt).toBeLessThan(3_000);
    expect(windDowns(p.webview.slice(sinceResume), leadId).at(-1)).toBeNull();
    // A stop before the session opened, not a start failure.
    const statuses = p.webview.slice(sinceResume).flatMap((m) => (m.type === 'teamAgentStatusUpdate' && m.agentId === leadId ? [m.status] : []));
    expect(statuses.at(-1)).toBe('cancelled');
    expect(statuses).not.toContain('failed');

    p.held[0]!.release();
    await within(p.opened[0]!.forgotten, 10_000, 'the old member session');
    expect(p.events).toEqual(['open:file']);
    const entries = entriesOf(memberFile);
    expect(entries.at(-1)!.customType).toBe(HELD_DRAFT_ENTRY);
    expect(entries.some((e) => e.customType === DAMOCLES_AGENT_SEGMENT_ENTRY)).toBe(false);
    expect(parentChainBreaks(entries)).toEqual([]);
  }, 60_000);

  it('deleting the parent conversation while the member is held leaves nothing appended to the deleted member file', async () => {
    const p = panel([{ responses: [fauxAssistantMessage('On it.')], holdBeforeSettle: true }]);
    const { memberFile } = await stoppedWhileHeld(p);

    await deletePiSession(p.cwd, SESSION, { forget: () => undefined });
    expect(fs.existsSync(memberFile)).toBe(false);
    p.held[0]!.release();
    await within(p.opened[0]!.forgotten, 10_000, 'the old member session');

    expect(fs.existsSync(memberFile)).toBe(false);
    expect(fs.existsSync(teamMembersDir(piSessionDir(p.cwd), SESSION, p.invocations[0]!.id))).toBe(false);
  }, 60_000);

  it('a delete whose folder removal fails part way still lets the held member recreate nothing', async () => {
    const p = panel([{ responses: [fauxAssistantMessage('On it.')], holdBeforeSettle: true }]);
    const { memberFile } = await stoppedWhileHeld(p);
    const teams = teamsDir(piSessionDir(p.cwd), SESSION);
    const realRm = fs.promises.rm.bind(fs.promises);
    // Windows can fail a recursive removal part way, as when another process has a file in the folder open.
    const rm = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) !== path.resolve(teams)) return realRm(target, options);
      await realRm(memberFile, { force: true });
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    try {
      await deletePiSession(p.cwd, SESSION, { forget: () => undefined });
    } finally {
      rm.mockRestore();
    }
    expect(fs.existsSync(memberFile)).toBe(false);
    expect(fs.existsSync(path.dirname(memberFile))).toBe(true);

    p.held[0]!.release();
    await within(p.opened[0]!.forgotten, 10_000, 'the old member session');
    expect(fs.existsSync(memberFile)).toBe(false);
  }, 60_000);

  it('a team resume whose member file another Damocles window holds is refused before it writes anything, and stays resumable', async () => {
    const tool = untilAborted();
    const p = panel([
      { responses: [fauxAssistantMessage(fauxToolCall('wait_for_stop', {}, { id: 'w1' }), { stopReason: 'toolUse' })], customTools: [tool.definition] },
      { responses: [fauxAssistantMessage('Resumed and done.')] },
    ]);
    p.service.setPendingToolUseId('tc-create');
    const created = p.service.createTeam(LEAD_ONLY);
    await within(tool.started, 10_000, 'the lead tool call');
    const teamId = p.invocations.at(-1)!.id;
    expect(p.service.stopTeam(teamId)).toBe(true);
    await within(created, 5_000, 'the stopped team');
    await within(p.opened[0]!.forgotten, 1_000, 'the old member session');

    // Another process's lease is the lock file alone, which this process does not hold.
    const lock = sessionLeasePath(agentFileSessionId(p.opened[0]!.booted.session.sessionManager.getSessionFile()!));
    fs.mkdirSync(SESSION_LEASE_DIR, { recursive: true });
    const unlock = lockfile.lockSync(lock, { lockfilePath: lock, realpath: false, stale: 20_000, update: 2_000 });
    const checkpoints = await listTeamCheckpoints(teamCheckpointsDir(piSessionDir(p.cwd), SESSION, teamId));
    try {
      await expect(p.service.resumeTeam(teamId, undefined, 'tc-resume')).rejects.toThrow(
        `Team "${teamId}" cannot resume yet: the session file of "Lead" is still open in another Damocles window, whose stopped run has not finished. Wait for that run to stop or close that window, then resume the team again.`,
      );
    } finally {
      unlock();
    }
    expect(p.events).toEqual(['open:file']);
    expect(await listTeamCheckpoints(teamCheckpointsDir(piSessionDir(p.cwd), SESSION, teamId))).toEqual(checkpoints);

    expect(await within(p.service.resumeTeam(teamId, undefined, 'tc-resume-2'), 5_000, 'the resumed team')).toContain('Resumed and done.');
    expect(p.events).toEqual(['open:file', 'open:reopen']);
  }, 30_000);

  it('a Stop nothing holds ends at once and its resume opens the file with no wait', async () => {
    const tool = untilAborted();
    const p = panel([
      { responses: [fauxAssistantMessage(fauxToolCall('wait_for_stop', {}, { id: 'w1' }), { stopReason: 'toolUse' })], customTools: [tool.definition] },
      { responses: [fauxAssistantMessage('Resumed and done.')] },
    ]);
    p.service.setPendingToolUseId('tc-create');
    const created = p.service.createTeam(LEAD_ONLY);
    await within(tool.started, 10_000, 'the lead tool call');
    const teamId = p.invocations.at(-1)!.id;

    const stoppedAt = Date.now();
    expect(p.service.stopTeam(teamId)).toBe(true);
    expect(await within(created, 5_000, 'the stopped team')).toContain('TEAM STOPPED BY THE USER');
    expect(Date.now() - stoppedAt).toBeLessThan(3_000);
    await within(p.opened[0]!.forgotten, 1_000, 'the old member session');

    const resumedAt = Date.now();
    const text = await within(p.service.resumeTeam(teamId, undefined, 'tc-resume'), 5_000, 'the resumed team');
    expect(text).toContain('Resumed and done.');
    expect(Date.now() - resumedAt).toBeLessThan(3_000);
    expect(p.events).toEqual(['open:file', 'open:reopen']);
    expect(parentChainBreaks(entriesOf(p.opened[0]!.booted.session.sessionManager.getSessionFile()!))).toEqual([]);
  }, 30_000);
});

describe("a reloaded webview's team card while a member's stopped run winds down", () => {
  it("is sent the member's own wind-down with the team, and the clear once the run settles", async () => {
    const p = panel([{ responses: [fauxAssistantMessage('On it.')], holdBeforeSettle: true }]);
    p.service.setPendingToolUseId('tc-create');
    const created = p.service.createTeam(LEAD_ONLY);
    await vi.waitFor(() => expect(p.held.length).toBe(1), { timeout: 10_000 });
    await within(p.held[0]!.waiting, 10_000, 'the held agent_before_settle handler');
    const teamId = p.invocations.at(-1)!.id;
    const leadId = leadAgentId(p);
    expect(p.service.liveTeamState(teamId)?.windDowns).toBeUndefined();

    expect(p.service.stopTeam(teamId)).toBe(true);
    const shown = { phase: 'settle', events: ['agent_before_settle', 'agent_settled'], extensions: [p.opened[0]!.booted.extensionPath] };
    await vi.waitFor(() => expect(windDowns(p.webview, leadId)).toEqual([shown]), { timeout: 6_000 });
    // What `requestTeamData` answers a reloaded webview with while the team runs.
    expect(p.service.liveTeamState(teamId)?.windDowns).toEqual({ [leadId]: shown });

    p.held[0]!.release();
    await vi.waitFor(() => expect(windDowns(p.webview, leadId)).toEqual([shown, null]), { timeout: 10_000 });
    expect(p.service.liveTeamState(teamId)?.windDowns).toBeUndefined();
    await within(created, 10_000, 'the stopped team');
    expect(p.service.liveTeamState(teamId)).toBeNull();
  }, 60_000);

  it('is sent the wind-down a resumed member shows while it waits for its file, and none once the wait ended', async () => {
    const p = panel([
      { responses: [fauxAssistantMessage('On it.')], holdBeforeSettle: true },
      { responses: [fauxAssistantMessage('Resumed and done.'), fauxAssistantMessage('Still done.')], holdBeforeSettle: true },
    ]);
    const { teamId } = await stoppedWhileHeld(p);
    const leadId = leadAgentId(p);

    const sinceResume = p.webview.length;
    const resumed = p.service.resumeTeam(teamId, undefined, 'tc-resume');
    const shown = { phase: 'settle', events: ['agent_before_settle', 'agent_settled'], extensions: [p.opened[0]!.booted.extensionPath] };
    await vi.waitFor(() => expect(windDowns(p.webview.slice(sinceResume), leadId)).toEqual([shown]), { timeout: 5_000 });
    expect(p.service.liveTeamState(teamId)?.windDowns).toEqual({ [leadId]: shown });

    p.held[0]!.release();
    // The resumed run's own turn ends into its held handler, so the team still runs after the wait ended.
    await vi.waitFor(() => expect(p.held.length).toBe(2), { timeout: 10_000 });
    await within(p.held[1]!.waiting, 10_000, 'the resumed run');
    expect(windDowns(p.webview.slice(sinceResume), leadId)).toEqual([shown, null]);
    expect(p.service.liveTeamState(teamId)?.windDowns).toBeUndefined();
    p.held[1]!.release();
    await within(resumed, 20_000, 'the resumed team');
  }, 60_000);
});
