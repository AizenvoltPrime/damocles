import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// Point the Damocles home dir at a throwaway temp dir so every log, checkpoint and session path the
// runner derives stays out of the real ~/.damocles tree.
vi.mock('../../paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return { DAMOCLES_HOME_DIR: mkdtempSync(joinPath(tmpdir(), 'damocles-team-resume-')) };
});

import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { DAMOCLES_HOME_DIR } from '../../paths';
import { TeamService } from '../index';
import { buildInterruptedResumePrompt } from '../prompts';
import { TeamRunner } from '../team-runner';
import { TeamPersistence } from '../persistence';
import type { CoverageView, ReviewCoverage } from '../review-coverage';
import { Scratchpad } from '../scratchpad';
import { MessageBus } from '../message-bus';
import { FakeSession, type FakeOpeningTotals } from './fake-session';
import { teamAgentToolset } from './team-mcp-fixture';
import type { AgentMcpContext, AgentResult, AgentRunConfig, TeamAgent, TeamCheckpoint, TeamConfig, TeamEventLog, TeamRole } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ImageBlock } from '../../../shared/types/content';
import { RESUME_NOTE_LABEL, RESUME_NOTE_RULES, STEER_INSTRUCTION_PREFIX, buildResumePrompt, withResumeNote, wrapSteerMessage } from '../../../shared/steer';
import { piSessionDir } from '../../pi-session/session-store';
import { initPiLoader } from '../../pi-session/pi-loader';
import { listTeamCheckpoints, teamCheckpointPath, teamCheckpointsDir, teamEventLogPath, teamMembersDir } from '../../pi-session/agent-records';
import { CheckpointWriter } from '../checkpoint-writer';
import { DAMOCLES_AGENT_INVOCATION_ENTRY, DAMOCLES_AGENT_LAUNCH_ENTRY, DAMOCLES_AGENT_SEGMENT_ENTRY } from '../../pi-session/session-store/constants';

// The first pi import takes about a second, which under a loaded machine overruns a test's timeout.
beforeAll(async () => {
  await initPiLoader();
});

afterAll(() => fs.rmSync(DAMOCLES_HOME_DIR, { recursive: true, force: true }));

const SESSION = 'sess';

/** How a member's model answers each call; `text` is what pi delivered since the previous call, empty after tools. */
type Behaviour = (text: string, session: FakeSession, h: Harness) => void;

interface Opened {
  name: string;
  store: Record<string, unknown>;
  session: FakeSession;
}

interface Harness {
  runner: TeamRunner;
  teamId: string;
  cwd: string;
  opened: Opened[];
  forgotten: FakeSession[];
  scopes: Map<string, string[]>;
  /** The `kind` each launch's toolset was built for, per member. */
  kinds: Map<string, Array<string | undefined>>;
  webview: ExtensionToWebviewMessage[];
  costs: number[];
  agent: (name: string) => TeamAgent;
  session: (name: string) => FakeSession;
  scratchpad: () => Scratchpad;
  bus: () => MessageBus;
}

/** The path pi gives session `id`'s file in `dir`: `<timestamp>_<id>.jsonl`. */
const piNamedFile = (dir: string, id: string): string => path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);

const endTurn: Behaviour = (_t, s) => void s.endTurn();
const holdTurn: Behaviour = () => undefined;

/**
 * A real TeamRunner (real AgentRunner, bus, scratchpad and file persistence) whose engine hands out a
 * FakeSession per launch. Each session prompts through its member's behaviour, looked up by name.
 */
function makeTeam(opts: {
  cwd: string;
  teamId: string;
  specialists: string[];
  behave: Record<string, Behaviour>;
  /** What each member's reopened session file already holds. */
  opening?: Record<string, FakeOpeningTotals>;
  /** Holds a member's session open until the promise settles. */
  gate?: Record<string, Promise<void>>;
  /**
   * Backs each new member session with a real pi session file that receives every entry the session
   * persists, and has each member reply once to its first prompt, since pi writes no file before a reply.
   */
  realFiles?: boolean;
}): Harness {
  const opened: Opened[] = [];
  const forgotten: FakeSession[] = [];
  const scopes = new Map<string, string[]>();
  const kinds = new Map<string, Array<string | undefined>>();
  const webview: ExtensionToWebviewMessage[] = [];
  const costs: number[] = [];
  const h = {} as Harness;

  const config = {
    teamId: opts.teamId,
    toolUseId: 'tc-create',
    title: 'resume suite',
    brief: 'the authoritative spec',
    cwd: opts.cwd,
    persistenceSessionId: SESSION,
    permissionMode: 'default' as const,
    agents: [{ name: 'Lead', role: 'lead' as const }, ...opts.specialists.map((n) => ({ name: n, role: 'specialist' as const }))],
    resolveRoleModel: (role: TeamRole) => ({ modelLabel: role === 'lead' ? 'lead-model' : 'spec-model', dollarBilled: false }),
    engine: {
      createSession: async (sessionOpts: { store: Record<string, unknown> }) => {
        const store = sessionOpts.store;
        const agentId = store['kind'] === 'reopen' ? String(store['agentId']) : String(store['id']).replace(/\.a\d+$/, '');
        const name = h.runner.getMember(agentId)!.name;
        const gate = opts.gate?.[name];
        if (gate) await gate;
        const behaviour = opts.behave[name] ?? endTurn;
        const session = new FakeSession({
          onModelCall: (call, s) => {
            if (opts.realFiles && call.index === 0) s.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `${name} is on it` }], stopReason: 'stop' } });
            behaviour(call.texts.join('\n\n'), s, h);
          },
        });
        session.sessionFile = store['kind'] === 'reopen' ? String(store['path']) : piNamedFile(String(store['dir']), String(store['id']));
        if (opts.realFiles && store['kind'] !== 'reopen') {
          const real = SessionManager.create(opts.cwd, String(store['dir']), { id: String(store['id']) });
          session.mirror = { appendMessage: (m) => real.appendMessage(m as never), appendCustomEntry: (t, d) => real.appendCustomEntry(t, d) };
          session.sessionFile = real.getSessionFile();
        }
        const opening = opts.opening?.[name];
        if (opening) session.seedOpening(opening);
        opened.push({ name, store, session });
        return session as never;
      },
      forgetSession: (s: FakeSession) => { forgotten.push(s); },
      buildAgentToolset: (ctx: AgentMcpContext) => {
        scopes.set(ctx.agentName, [...(scopes.get(ctx.agentName) ?? []), ctx.browserScopeId]);
        kinds.set(ctx.agentName, [...(kinds.get(ctx.agentName) ?? []), ctx.kind]);
        return teamAgentToolset();
      },
      buildExtensionFactory: () => (() => undefined) as never,
      onAgentCost: (d: number) => { costs.push(d); },
      disposeBrowserScope: () => undefined,
      cancelAgentDialogs: () => undefined,
    },
  } as unknown as TeamConfig;

  const runner = new TeamRunner(config, (m) => webview.push(m));
  const priv = runner as unknown as { agents: Map<string, TeamAgent>; scratchpad: Scratchpad; messageBus: MessageBus };
  Object.assign(h, {
    runner, teamId: opts.teamId, cwd: opts.cwd, opened, forgotten, scopes, kinds, webview, costs,
    agent: (name: string) => priv.agents.get(name)!,
    session: (name: string) => {
      const found = opened.filter((o) => o.name === name).at(-1);
      if (!found) throw new Error(`no session opened for ${name}`);
      return found.session;
    },
    scratchpad: () => priv.scratchpad,
    bus: () => priv.messageBus,
  });
  return h;
}

function newCwd(label: string): string {
  return path.join(DAMOCLES_HOME_DIR, `${label}-${crypto.randomUUID().slice(0, 8)}`);
}

const persistenceOf = (h: Harness): TeamPersistence => new TeamPersistence(h.cwd, SESSION);
const checkpointTimes = (h: Harness): Promise<number[]> => listTeamCheckpoints(teamCheckpointsDir(piSessionDir(h.cwd), SESSION, h.teamId));

/** The checkpoint a resume would continue from. */
async function checkpointOf(persistence: TeamPersistence, teamId: string): Promise<TeamCheckpoint | null> {
  return persistence.resumableCheckpoint(await persistence.readEventLog(teamId));
}

async function opened(h: Harness, name: string): Promise<FakeSession> {
  await vi.waitFor(() => expect(h.opened.some((o) => o.name === name)).toBe(true));
  return h.session(name);
}

async function status(h: Harness, name: string, expected: TeamAgent['status']): Promise<void> {
  await vi.waitFor(() => expect(h.agent(name).status).toBe(expected));
}

function statusUpdates(h: Harness, agentId: string): string[] {
  return h.webview.flatMap((m) => (m.type === 'teamAgentStatusUpdate' && m.agentId === agentId ? [m.status] : []));
}

function logEntries(h: Harness): Array<Record<string, unknown>> {
  return fs.readFileSync(teamEventLogPath(piSessionDir(h.cwd), SESSION, h.teamId), 'utf-8')
    .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Drives a team to the state the acceptance scenario cancels in. At cancel:
 * A awaiting-review, B running with undelivered messages, C standby with a held follow-up,
 * D pending, E approved (completed), F running with no session file later, G cancelled, H cancelled
 * while still pending, so the log has no launch of it.
 */
async function interruptedTeam(cwd: string, teamId: string, realFiles = false): Promise<{ h: Harness; files: Map<string, string>; run: Promise<{ status: string; text: string }> }> {
  const h = makeTeam({
    cwd, teamId, realFiles,
    specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    behave: {
      Lead: (_t, s, hh) => {
        if (s.prompts.length === 1) {
          hh.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
          hh.runner.startSpecialist('B', 'Test label', 'task for B, described in full', undefined, 'reviewer', []);
          hh.runner.startSpecialist('C', 'Test label', 'task for C, described in full');
        }
        void s.endTurn();
      },
      A: (_t, s, hh) => {
        hh.scratchpad().set('a-notes', 'A findings', 'A');
        hh.runner.reportComplete('A', 'A signed off');
        void s.endTurn();
      },
      B: holdTurn,
      C: (_t, s, hh) => {
        hh.runner.enterStandby('C');
        void s.endTurn();
      },
      D: holdTurn,
      E: (_t, s, hh) => {
        hh.runner.reportComplete('E', 'E signed off');
        void s.endTurn();
      },
      F: holdTurn,
      G: (_t, s) => s.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'G found half the answer' }] } }),
    },
  });

  const run = h.runner.run();
  await status(h, 'A', 'awaiting-review');
  await status(h, 'C', 'standby');
  await opened(h, 'B');

  h.runner.startSpecialist('E', 'Test label', 'task for E, described in full');
  await status(h, 'E', 'awaiting-review');
  h.runner.approveSpecialist('E');
  await status(h, 'E', 'completed');

  h.runner.startSpecialist('F', 'Test label', 'task for F, described in full');
  h.runner.startSpecialist('G', 'Test label', 'task for G, described in full');
  await opened(h, 'F');
  await opened(h, 'G');
  h.runner.cancelSpecialist('G');
  await status(h, 'G', 'cancelled');
  h.runner.cancelSpecialist('H');
  expect(h.agent('H').status).toBe('cancelled');

  // The lead reads A's section before the cancel; the restored cursor must still say so.
  h.scratchpad().markRead('Lead', 'a-notes');
  // B is mid-call, so the runner steers this one into pi, where it waits with the rest for the call to end.
  h.bus().send('Lead', 'B', 'for B before cancel');
  h.session('B').queueSteer('steer held for B');
  // `followUp()` queues in pi even while C is parked and idle.
  h.session('C').queueFollowUp('[Message from Lead]: follow-up held for C');
  expect(h.runner.steerMember(h.agent('B').agentId, 'focus on the parser')).toBe('steered');
  const lead = h.session('Lead');
  await vi.waitFor(() => expect(h.agent('Lead').status).toBe('monitoring'));
  expect(lead.prompts.some((p) => p.includes('focus on the parser'))).toBe(false);

  const files = new Map<string, string>();
  for (const name of ['Lead', 'A', 'B', 'C', 'E', 'G']) files.set(h.agent(name).agentId, h.session(name).sessionFile!);
  return { h, files, run };
}

describe('TeamRunner checkpoint on cancel', () => {
  it('cancel() records member statuses and review state as they were before the abort and synthesis', async () => {
    const { h, run } = await interruptedTeam(newCwd('cancel-order'), crypto.randomUUID());

    h.runner.cancel('user');
    const result = await run;

    expect(result.status).toBe('cancelled');
    const checkpoint = await checkpointOf(persistenceOf(h), h.teamId);
    expect(checkpoint).not.toBeNull();
    const byName = new Map(checkpoint!.members.map((m) => [m.name, m]));
    expect(Object.fromEntries([...byName].map(([n, m]) => [n, m.status]))).toEqual({
      Lead: 'monitoring', A: 'awaiting-review', B: 'running', C: 'standby', D: 'pending', E: 'completed', F: 'running', G: 'cancelled', H: 'cancelled',
    });
    expect(byName.get('D')!.agentId).toBe(h.agent('D').agentId);
    expect(checkpoint!.review).toMatchObject({
      confirmedComplete: ['A'],
      reviewedSpecialists: ['E'],
      pendingStandby: ['C'],
    });
    expect(new Map(checkpoint!.review.reportedSummaries)).toEqual(new Map([['A', 'A signed off'], ['E', 'E signed off']]));
    expect(checkpoint!.operatorSteers).toEqual([{ memberName: 'B', message: 'focus on the parser', attempt: 0 }]);
    expect(new Map(checkpoint!.readerCursors.find(([r]) => r === 'Lead')![1]).get('a-notes')).toBe(1);
    // After the cancel the live state is gone, which is what makes the ordering matter.
    expect(h.agent('A').status).not.toBe('awaiting-review');
  });

  it('keeps every message not yet delivered: runner-local, pi steering and pi follow-up', async () => {
    const { h, run } = await interruptedTeam(newCwd('cancel-undelivered'), crypto.randomUUID());

    h.runner.cancel('user');
    await run;

    const members = new Map((await checkpointOf(persistenceOf(h), h.teamId))!.members.map((m) => [m.name, m]));
    expect(members.get('B')!.undelivered.map((u) => u.text)).toEqual(expect.arrayContaining([
      '[Message from Lead]: for B before cancel',
      'steer held for B',
      wrapSteerMessage('focus on the parser'),
    ]));
    expect(members.get('C')!.undelivered.map((u) => u.text)).toEqual(['[Message from Lead]: follow-up held for C']);
    expect(members.get('A')!.undelivered).toEqual([]);
  });

  it('keeps one checkpoint per run, sealed by the first stop and again after the drain, and a completed run offers no resume', async () => {
    const seal = vi.spyOn(CheckpointWriter.prototype, 'seal');
    try {
      const { h, run } = await interruptedTeam(newCwd('cancel-once'), crypto.randomUUID());
      const [key] = await checkpointTimes(h);
      h.runner.cancel('user');
      h.runner.cancel('user');
      expect(seal).toHaveBeenCalledTimes(1);
      expect(seal.mock.results[0]!.value).toMatchObject({ cancelledAt: key, stoppedBy: 'user' });
      await run;
      expect(seal).toHaveBeenCalledTimes(2);
      expect(await checkpointTimes(h)).toEqual([key]);

      seal.mockClear();
      const done = makeTeam({ cwd: newCwd('cancel-after-complete'), teamId: crypto.randomUUID(), specialists: [], behave: {} });
      const result = await done.runner.run();
      done.runner.cancel('user');
      expect(result.status).toBe('completed');
      expect(seal).not.toHaveBeenCalled();
      expect(await persistenceOf(done).resumableStop(done.teamId)).toBeNull();
    } finally {
      seal.mockRestore();
    }
  });

  it('round-trips: a restored team cancelled before it resumes seals the checkpoint it read under its own key', async () => {
    const { h, run } = await interruptedTeam(newCwd('round-trip'), crypto.randomUUID());
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);
    const written = (await checkpointOf(persistence, h.teamId))!;

    const restored = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], behave: {} });
    restored.runner.restore(await persistence.readEventLog(h.teamId), written, new Map());
    expect(await restored.runner.persistResumeCheckpoint()).toBe(true);
    restored.runner.cancel('user');
    expect(await restored.runner.flushCheckpoint()).toBe(true);

    const rewritten = (await checkpointOf(persistence, h.teamId))!;
    expect(rewritten.cancelledAt).toBeGreaterThan(written.cancelledAt);
    // The restored bus holds the whole log, so the restored state accounts for every message on it.
    expect(rewritten.messagesThrough).toBe(restored.bus().getAllMessages().at(-1)!.messageId);
    expect({ ...rewritten, cancelledAt: written.cancelledAt, asOf: written.asOf, messagesThrough: written.messagesThrough }).toEqual(written);
  });

  it('restores a steer from a checkpoint that recorded no attempt as the member attempt in that checkpoint', async () => {
    const { h, run } = await interruptedTeam(newCwd('steer-no-attempt'), crypto.randomUUID());
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);
    const written = (await checkpointOf(persistence, h.teamId))!;
    fs.writeFileSync(teamCheckpointPath(piSessionDir(h.cwd), SESSION, h.teamId, written.cancelledAt + 1), JSON.stringify({
      ...written,
      cancelledAt: written.cancelledAt + 1,
      members: written.members.map((m) => (m.name === 'B' ? { ...m, attempt: 2 } : m)),
      operatorSteers: written.operatorSteers.map((s) => ({ memberName: s.memberName, message: s.message })),
    }));
    const older = (await checkpointOf(persistence, h.teamId))!;
    expect(older.operatorSteers).toEqual([{ memberName: 'B', message: 'focus on the parser' }]);

    const restored = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], behave: {} });
    restored.runner.restore(await persistence.readEventLog(h.teamId), older, new Map());

    expect(restored.runner.getOperatorSteers()).toEqual([{ memberName: 'B', message: 'focus on the parser', attempt: 2 }]);
  });
});

describe('the live checkpoint follows a member the runner parks or wakes between turns', () => {
  const memberIn = (c: TeamCheckpoint, name: string) => c.members.find((m) => m.name === name)!;

  /**
   * A's run flushes the checkpoint in an `agent_before_settle` handler, so the snapshot its last turn's boundary takes
   * lands before the run settles and the runner parks A. B keeps working, so A is never stranded. A parks once and
   * holds every later prompt.
   */
  async function parkedTeam(label: string): Promise<{ h: Harness; run: Promise<{ status: string; text: string }> }> {
    const flushedBeforeSettle: boolean[] = [];
    const h = makeTeam({
      cwd: newCwd(label), teamId: crypto.randomUUID(), specialists: ['A', 'B'],
      behave: {
        Lead: (_t, s, hh) => { if (s.prompts.length === 1) hh.runner.startSpecialist('B', 'Test label', 'task for B, described in full'); },
        B: holdTurn,
        A: (_t, s, hh) => {
          if (s.prompts.length > 1) return;
          hh.runner.enterStandby('A');
          s.beforeSettle = async () => {
            s.beforeSettle = null;
            flushedBeforeSettle.push(await hh.runner.flushCheckpoint());
          };
          void s.endTurn();
        },
      },
    });
    const run = h.runner.run();
    await (await opened(h, 'B')).whenPrompted(1);
    h.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
    await status(h, 'A', 'standby');
    expect(flushedBeforeSettle).toEqual([true]);
    return { h, run };
  }

  it('records a member that parked in standby when its run settled, though no entry followed', async () => {
    const { h, run } = await parkedTeam('park-after-turn');

    expect(await h.runner.flushCheckpoint()).toBe(true);
    const live = (await checkpointOf(persistenceOf(h), h.teamId))!;
    expect(live.live).toBe(true);
    expect(memberIn(live, 'A').status).toBe('standby');
    expect(live.review.pendingStandby).toEqual(['A']);

    h.runner.cancel('user');
    await run;
  });

  it('records a standby member a message woke as running, while its woken turn is still in its first call', async () => {
    const { h, run } = await parkedTeam('wake-from-standby');
    const a = h.session('A');

    h.bus().send('Lead', 'A', 'my findings are posted');
    await a.whenPrompted(2);
    expect(h.agent('A').status).toBe('running');

    expect(await h.runner.flushCheckpoint()).toBe(true);
    const live = (await checkpointOf(persistenceOf(h), h.teamId))!;
    expect(memberIn(live, 'A').status).toBe('running');
    expect(live.review.pendingStandby).toEqual([]);

    h.runner.cancel('user');
    await run;
  });
});

describe('a run killed with no team-completed resumes from its live checkpoint', () => {
  const CRASH = 'crash-sess';
  const DELIVERED = 'damocles-team-delivered';
  type CrashBehaviour = (text: string, session: FakeSession, runner: TeamRunner) => void;

  interface CrashPanel {
    service: TeamService;
    opened: Opened[];
    runner: () => TeamRunner;
    /** The newest checkpoint on disk when the resume opened its first member session, before any member could change it. */
    atFirstOpen: TeamCheckpoint | null;
  }

  const deliveredIds = (s: FakeSession): string[] =>
    s.customEntries.flatMap((e) => (e.customType === DELIVERED ? (e.data as { ids: string[] }).ids : []));

  function newestCheckpoint(cwd: string, sessionId: string, teamId: string): TeamCheckpoint {
    const dir = teamCheckpointsDir(piSessionDir(cwd), sessionId, teamId);
    const newest = Math.max(...fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).map((n) => Number(n.slice(0, -'.json'.length))));
    return JSON.parse(fs.readFileSync(path.join(dir, `${newest}.json`), 'utf-8')) as TeamCheckpoint;
  }

  /** The panel of the session the crashed run's files were copied into: a real TeamService whose engine opens FakeSessions by member name. */
  function crashPanel(cwd: string, teamId: string, nameOf: ReadonlyMap<string, string>, behave: Record<string, CrashBehaviour>): CrashPanel {
    const p = { opened: [], atFirstOpen: null } as unknown as CrashPanel;
    const engine = {
      createSession: async (opts: { store: Record<string, unknown> }) => {
        const store = opts.store;
        p.atFirstOpen ??= newestCheckpoint(cwd, CRASH, teamId);
        const agentId = store['kind'] === 'reopen' ? String(store['agentId']) : String(store['id']).replace(/\.a\d+$/, '');
        const name = nameOf.get(agentId)!;
        const behaviour = behave[name] ?? ((_t: string, s: FakeSession) => void s.endTurn());
        const session = new FakeSession({ onModelCall: (call, s) => behaviour(call.texts.join('\n\n'), s, p.runner()) });
        session.sessionFile = store['kind'] === 'reopen' ? String(store['path']) : piNamedFile(String(store['dir']), String(store['id']));
        p.opened.push({ name, store, session });
        return session as never;
      },
      forgetSession: () => undefined,
      buildAgentToolset: () => teamAgentToolset(),
      buildExtensionFactory: () => (() => undefined) as never,
      onAgentCost: () => undefined,
      disposeBrowserScope: () => undefined,
      cancelAgentDialogs: () => undefined,
    };
    const invocation = {
      type: 'custom', id: 'e0', parentId: null, timestamp: new Date().toISOString(), customType: DAMOCLES_AGENT_INVOCATION_ENTRY,
      data: { kind: 'team', id: teamId, toolCallId: 'tc-create', resume: false },
    } as unknown as SessionEntry;
    p.service = new TeamService({
      cwd,
      onMessage: () => undefined,
      getSessionId: () => CRASH,
      getPermissionMode: () => 'default',
      resolveRoleModel: () => ({ modelLabel: 'model', dollarBilled: false }),
      buildEngine: () => engine as never,
      recordInvocation: () => undefined,
      parentBranch: () => [invocation],
      assertResumableModel: () => undefined,
      requestInterruptionCheck: () => undefined,
    });
    p.runner = () => (p.service as unknown as { activeRunner: TeamRunner }).activeRunner;
    return p;
  }

  it('relaunches and parks members as recorded, redelivers only what pi had not delivered, and admits what the log recorded after the snapshot', async () => {
    const cwd = newCwd('crash');
    const teamId = crypto.randomUUID();
    const sessionDir = piSessionDir(cwd);
    const { h, run } = await interruptedTeam(cwd, teamId, true);

    // The snapshot the crash leaves behind: the live checkpoint as the writer last landed it.
    expect(await h.runner.flushCheckpoint()).toBe(true);
    const snapshot = newestCheckpoint(cwd, SESSION, teamId);
    expect(snapshot.live).toBe(true);
    expect(snapshot.stoppedBy).toBeUndefined();
    const snapshotOf = (name: string) => snapshot.members.find((m) => m.name === name)!;
    const steer = wrapSteerMessage('focus on the parser');
    const steerIds = snapshotOf('B').undelivered.find((u) => u.text === steer)?.ids;
    expect(steerIds).toHaveLength(1);
    expect(snapshotOf('D').status).toBe('pending');
    fs.cpSync(teamCheckpointsDir(sessionDir, SESSION, teamId), teamCheckpointsDir(sessionDir, CRASH, teamId), { recursive: true });

    // Everything below reaches the log and the member files but not the copied snapshot, as the writes a crash cuts off.
    // B's call ends, so pi delivers everything queued at the snapshot and holds B's next call; the tail waits behind it.
    const forB = h.bus().getAllMessages().find((m) => m.content === 'for B before cancel')!;
    const b = h.session('B');
    void b.endTurn();
    await b.whenModelCalled(2);
    const tailForB = h.bus().send('Lead', 'B', 'logged after the snapshot');
    const tailForLead = h.bus().send('B', 'Lead', 'tail message for Lead');
    // D has no run yet, so nothing subscribed to this; its restored run must not receive it either.
    const beforeD = h.bus().send('Lead', 'D', 'sent before D was spawned');
    h.runner.startSpecialist('D', 'Test label', 'task for D, described in full');
    h.runner.redispatchSpecialist('G', 'Test label', 'task for G again, described in full');
    await (await opened(h, 'D')).whenPrompted(1);
    await vi.waitFor(() => {
      expect(deliveredIds(b)).toEqual([forB.messageId, ...steerIds!]);
      expect(deliveredIds(h.session('Lead'))).toContain(tailForLead.messageId);
      expect(h.opened.filter((o) => o.name === 'G')).toHaveLength(2);
    });
    await h.session('G').whenPrompted(1);
    const gSecondFile = h.session('G').sessionFile!;

    fs.copyFileSync(teamEventLogPath(sessionDir, SESSION, teamId), teamEventLogPath(sessionDir, CRASH, teamId));
    fs.cpSync(teamMembersDir(sessionDir, SESSION, teamId), teamMembersDir(sessionDir, CRASH, teamId), { recursive: true });
    h.runner.cancel('user');
    await run;

    const nameOf = new Map(['Lead', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((n) => [h.agent(n).agentId, n]));
    const reportOnce = (name: string): CrashBehaviour => (_t, s, runner) => {
      if (s.prompts.length === 1) runner.reportComplete(name, `${name} resumed and done`);
      void s.endTurn();
    };
    const crashed = crashPanel(cwd, teamId, nameOf, {
      Lead: () => undefined, B: reportOnce('B'), C: reportOnce('C'), D: () => undefined, F: () => undefined, G: () => undefined,
    });
    expect(await new TeamPersistence(cwd, CRASH).resumableStop(teamId)).toBe('interrupted');

    const done = crashed.service.resumeTeam(teamId, undefined, 'tc-crash-resume');
    let resumeError: unknown = null;
    done.catch((err: unknown) => { resumeError = err; });
    const crashedSession = async (name: string): Promise<FakeSession> => {
      await vi.waitFor(() => {
        if (resumeError) throw resumeError;
        expect(crashed.opened.some((o) => o.name === name)).toBe(true);
      });
      return crashed.opened.find((o) => o.name === name)!.session;
    };
    const lead = await crashedSession('Lead');
    await lead.whenPrompted(1);
    const resumedB = await crashedSession('B');

    // The restored state, as the resume saved it under its own key before any member ran.
    const restored = crashed.atFirstOpen!;
    expect(restored.cancelledAt).toBeGreaterThan(snapshot.cancelledAt);
    expect(restored.live).toBe(true);
    const restoredOf = (name: string) => restored.members.find((m) => m.name === name)!;
    const bTexts = restoredOf('B').undelivered.map((u) => u.text);
    // pi delivered the snapshot's queue, and B's file records the two deliveries that carried ids; a message pi
    // queued with no ids cannot be proven delivered, so it stays, as does the tail pi still held.
    expect(bTexts).toEqual(expect.arrayContaining([
      'steer held for B',
      `[Message from Lead]: ${tailForB.content}`,
    ]));
    expect(bTexts).not.toContain(steer);
    expect(bTexts).not.toContain('[Message from Lead]: for B before cancel');
    expect(restoredOf('Lead').undelivered.map((u) => u.text)).not.toContain(`[Message from B]: ${tailForLead.content}`);
    expect(restoredOf('C').undelivered.map((u) => u.text)).toEqual(['[Message from Lead]: follow-up held for C']);
    expect(restoredOf('D')).toMatchObject({ status: 'running', attempt: 0, toolCallCount: 0 });
    expect(restoredOf('D').undelivered.map((u) => u.text)).not.toContain(`[Message from Lead]: ${beforeD.content}`);
    expect(restoredOf('D').undelivered).toEqual([]);
    expect(restoredOf('G')).toMatchObject({ status: 'running', attempt: 1, toolCallCount: 0, usage: snapshotOf('G').usage });

    expect(lead.prompts[0]).toBe(buildInterruptedResumePrompt());
    await crashedSession('G');
    const resumedEntries = fs.readFileSync(teamEventLogPath(sessionDir, CRASH, teamId), 'utf-8').trim().split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(resumedEntries.filter((e) => e['type'] === 'team-resumed').map((e) => e['checkpoint'])).toEqual([snapshot.cancelledAt]);
    expect(Object.fromEntries(resumedEntries.filter((e) => e['type'] === 'agent-resumed').map((e) => [e['name'], [e['mode'], e['attempt']]]))).toEqual({
      Lead: ['relaunch', 0], A: ['park', 0], B: ['relaunch', 0], C: ['park', 0], D: ['relaunch', 0], F: ['relaunch', 0], G: ['relaunch', 1],
    });
    expect(crashed.opened.find((o) => o.name === 'G')!.store).toEqual({
      kind: 'reopen', path: path.join(teamMembersDir(sessionDir, CRASH, teamId), path.basename(gSecondFile)), agentId: h.agent('G').agentId,
    });
    const agents = (crashed.runner() as unknown as { agents: Map<string, TeamAgent> }).agents;
    expect(agents.get('D')).toMatchObject({ status: 'running', attempt: 0, toolCallCount: 0, result: null });
    expect(agents.get('A')!.status).toBe('awaiting-review');

    // B gets each message pi had not delivered, and never one its file records as delivered.
    await vi.waitFor(() => {
      const text = resumedB.prompts.join('\n');
      for (const expected of ['steer held for B', `[Message from Lead]: ${tailForB.content}`]) expect(text).toContain(expected);
    });
    expect(resumedB.prompts.filter((p) => p.includes('focus on the parser') || p.includes('for B before cancel'))).toEqual([]);

    crashed.service.stopTeam(teamId);
    await done;
  });
});

describe('TeamRunner checkpoint and restore edge cases', () => {
  it('records a specialist the lead cancelled as cancelled, even when the cancel lands before its run settles', async () => {
    const { h, run } = await interruptedTeam(newCwd('cancel-pending'), crypto.randomUUID());

    h.runner.cancelSpecialist('B');
    h.runner.cancel('user');
    await run;

    const members = new Map((await checkpointOf(persistenceOf(h), h.teamId))!.members.map((m) => [m.name, m.status]));
    expect(members.get('B')).toBe('cancelled');
    expect(members.get('F')).toBe('running');
  });

  it('keeps a finished member result from the event log, and names a member stopped before reporting, in a later partial synthesis', async () => {
    const { h, files, run } = await interruptedTeam(newCwd('last-result'), crypto.randomUUID());
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);

    const after = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], behave: { Lead: holdTurn, B: holdTurn, F: holdTurn } });
    after.runner.restore(await persistence.readEventLog(h.teamId), (await checkpointOf(persistence, h.teamId))!, files);
    const done = after.runner.resume('tc-resume');
    await (await opened(after, 'Lead')).whenPrompted(1);
    after.runner.cancel('user');

    const text = (await done).text;
    expect(text).toContain('### E (specialist, completed)\nE signed off');
    // G narrated, then the lead cancelled it before it reported, so its narration is no outcome.
    expect(text).toContain('### G (specialist, cancelled)\nStopped before reporting.');
    expect(text).not.toContain('G found half the answer');
  });

  it.each([
    ['a member missing', (c: TeamCheckpoint): TeamCheckpoint => ({ ...c, members: c.members.filter((m) => m.name !== 'D') })],
    ['a renamed member', (c: TeamCheckpoint): TeamCheckpoint => ({ ...c, members: c.members.map((m) => (m.name === 'D' ? { ...m, name: 'Z' } : m)) })],
    ['no lead', (c: TeamCheckpoint): TeamCheckpoint => ({ ...c, members: c.members.map((m) => ({ ...m, role: 'specialist' as const })) })],
    ['two leads', (c: TeamCheckpoint): TeamCheckpoint => ({ ...c, members: c.members.map((m) => (m.name === 'D' ? { ...m, role: 'lead' as const } : m)) })],
  ])('refuses a checkpoint with %s', async (_label, corrupt) => {
    const { h, files, run } = await interruptedTeam(newCwd('roster'), crypto.randomUUID());
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);
    const checkpoint = corrupt((await checkpointOf(persistence, h.teamId))!);

    const after = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], behave: {} });

    await expect((async () => after.runner.restore(await persistence.readEventLog(h.teamId), checkpoint, files))()).rejects.toThrow(
      `Team "${h.teamId}" has a resume checkpoint that does not match its roster.`,
    );
    expect(after.opened).toEqual([]);
  });

  it('refuses a member the resume would launch when the log has no launch of it', async () => {
    const { h, files, run } = await interruptedTeam(newCwd('no-launch'), crypto.randomUUID());
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);
    const written = (await checkpointOf(persistence, h.teamId))!;
    const checkpoint = { ...written, members: written.members.map((m) => (m.name === 'H' ? { ...m, status: 'running' as const } : m)) };

    const after = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], behave: {} });

    await expect((async () => after.runner.restore(await persistence.readEventLog(h.teamId), checkpoint, files))()).rejects.toThrow(
      `Team "${h.teamId}" has no launch of "H" in its event log.`,
    );
  });

  it('a live checkpoint names the last message its log holds, so a failed append leaves the team resumable', async () => {
    const h = makeTeam({ cwd: newCwd('lost-append'), teamId: crypto.randomUUID(), specialists: [], behave: { Lead: holdTurn } });
    const run = h.runner.run();
    await (await opened(h, 'Lead')).whenPrompted(1);
    const kept = h.bus().broadcast('system', 'logged');
    const append = vi.spyOn(TeamPersistence.prototype, 'appendTeamEntry').mockImplementationOnce(() => false);
    h.bus().broadcast('system', 'lost to a locked log');
    append.mockRestore();

    expect(await h.runner.flushCheckpoint()).toBe(true);
    const persistence = persistenceOf(h);
    const live = (await checkpointOf(persistence, h.teamId))!;
    expect(live.messagesThrough).toBe(kept.messageId);
    const after = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: [], behave: {} });
    const log = await persistence.readEventLog(h.teamId);
    expect(() => after.runner.restore(log, live, new Map())).not.toThrow();

    h.runner.cancel('user');
    await run;
  });

  it('a lead whose model cannot be resolved stops the run before it writes a log or a checkpoint', async () => {
    const h = makeTeam({ cwd: newCwd('lead-error'), teamId: crypto.randomUUID(), specialists: [], behave: {} });
    const config = (h.runner as unknown as { config: TeamConfig }).config;
    config.resolveRoleModel = (role) => (role === 'lead' ? { error: 'Sign in to Anthropic to use the lead model' } : { modelLabel: 'spec-model' }) as never;

    await expect(h.runner.run()).rejects.toThrow('Sign in to Anthropic to use the lead model');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await checkpointTimes(h)).toEqual([]);
    expect(fs.existsSync(teamEventLogPath(piSessionDir(h.cwd), SESSION, h.teamId))).toBe(false);
    expect(await persistenceOf(h).resumableStop(h.teamId)).toBeNull();
  });

  it("a reset's cancel seals the run's checkpoint as reset, so the old conversation does not offer a resume", async () => {
    const { h, run } = await interruptedTeam(newCwd('reset'), crypto.randomUUID());

    h.runner.cancel('reset');
    await run;

    const [key] = await checkpointTimes(h);
    expect(await persistenceOf(h).readCheckpoint(h.teamId, key!)).toMatchObject({ stoppedBy: 'reset' });
    expect(await checkpointOf(persistenceOf(h), h.teamId)).toBeNull();
    expect(await persistenceOf(h).resumableStop(h.teamId)).toBeNull();
  });
});

describe('TeamRunner steer to a member whose session is still opening', () => {
  it('is taken as a steer, recorded, and kept in the checkpoint when the team is cancelled before the session opens', async () => {
    let open!: () => void;
    const h = makeTeam({
      cwd: newCwd('steer-opening'), teamId: crypto.randomUUID(), specialists: ['A'],
      gate: { A: new Promise<void>((r) => { open = r; }) },
      behave: {
        Lead: (_t, s, hh) => {
          if (s.prompts.length === 1) hh.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
          void s.endTurn();
        },
      },
    });
    const run = h.runner.run();
    await status(h, 'A', 'running');
    expect(h.opened.some((o) => o.name === 'A')).toBe(false);

    expect(h.runner.steerMember(h.agent('A').agentId, 'use the v2 schema')).toBe('steered');
    h.runner.cancel('user');
    open();
    await run;

    const checkpoint = (await checkpointOf(persistenceOf(h), h.teamId))!;
    expect(checkpoint.members.find((m) => m.name === 'A')!.undelivered).toEqual([{ text: wrapSteerMessage('use the v2 schema'), echoed: true, ids: [expect.any(String)] }]);
    expect(checkpoint.operatorSteers).toEqual([{ memberName: 'A', message: 'use the v2 schema', attempt: 0 }]);
  });
});

describe('TeamRunner restore rebuilds the scratchpad and bus from the event log', () => {
  it('equal the live state, with section kinds, owners, cursors and message kinds intact', async () => {
    const { h, run } = await interruptedTeam(newCwd('replay'), crypto.randomUUID());
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);
    const log = await persistence.readEventLog(h.teamId);
    const live = { sections: h.scratchpad().getAll(), messages: h.bus().getAllMessages() };

    const scratchpad = new Scratchpad();
    const bus = new MessageBus(h.teamId);
    const notified: unknown[] = [];
    scratchpad.subscribe((e) => notified.push(e));
    bus.subscribe((m) => notified.push(m));
    scratchpad.restore(log.scratchpad);
    bus.restore(log.messages);

    expect(scratchpad.getAll()).toEqual(live.sections);
    expect(bus.getAllMessages()).toEqual(live.messages);
    expect(live.messages.some((m) => m.kind === 'scratchpad-notice')).toBe(true);
    expect(notified).toEqual([]);
    expect(scratchpad.isImmutable('mission-brief')).toBe(true);
    expect(scratchpad.isAppendOnly('verification')).toBe(true);
    expect(() => scratchpad.set('a-notes', 'hijack', 'B')).toThrow('owned by "A"');
    expect(() => scratchpad.set('mission-brief', 'hijack', 'system')).toThrow('immutable');
  });

  it('a restored runner emits and persists nothing for the restored history', async () => {
    const { h, run } = await interruptedTeam(newCwd('replay-quiet'), crypto.randomUUID());
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);
    const before = logEntries(h).length;

    const restored = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], behave: {} });
    restored.runner.restore(await persistence.readEventLog(h.teamId), (await checkpointOf(persistence, h.teamId))!, new Map());

    expect(logEntries(h)).toHaveLength(before);
    expect(restored.webview.filter((m) => m.type === 'teamMessage' || m.type === 'teamScratchpadUpdate')).toEqual([]);
  });
});

/**
 * A's opening turn is mid-tool when cancelled: still streaming, with every steer left in pi's queue. An abort that
 * lands in a tool lets pi deliver its queue on the way out (`agent-loop.js:191` in pi-agent-core 1.4.0).
 */
function midToolTeam(label: string): Harness {
  return makeTeam({
    cwd: newCwd(label), teamId: crypto.randomUUID(), specialists: ['A'],
    behave: {
      Lead: (_t, s, hh) => {
        if (s.prompts.length === 1) hh.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
        void s.endTurn();
      },
      A: (_t, s) => {
        if (s.prompts.length > 1) return;
        const shell = { type: 'toolCall', id: 'tc-shell', name: 'bash', arguments: { command: 'npm test' } };
        s.emit({ type: 'message_end', message: { role: 'assistant', content: [shell], stopReason: 'toolUse' } });
        s.emit({ type: 'tool_execution_start', toolCallId: 'tc-shell', toolName: 'bash', args: shell.arguments });
      },
    },
  });
}

/** The user messages a session committed after its opening task. */
function deliveredAfterTask(s: FakeSession): string[] {
  return s.branch.flatMap((e) => {
    const entry = e as { type: string; message?: { role: string; content: Array<{ text?: string }> } };
    return entry.type === 'message' && entry.message?.role === 'user' ? [entry.message.content[0]?.text ?? ''] : [];
  }).slice(1);
}

describe('TeamRunner image steer still queued in pi at the cancel', () => {
  it('keeps its images through the checkpoint and prompts the resumed member with them, once', async () => {
    const image: ImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
    const h = midToolTeam('image-steer');
    const run = h.runner.run();
    const a = await opened(h, 'A');
    await a.whenModelCalled(1);

    const steer = wrapSteerMessage('use this layout');
    expect(h.runner.steerMember(h.agent('A').agentId, 'use this layout', [image])).toBe('steered');
    await a.whenPrompted(2);
    expect(a.getSteeringMessages()).toEqual([steer]);
    const files = new Map(['Lead', 'A'].map((n) => [h.agent(n).agentId, h.session(n).sessionFile!]));
    h.runner.cancel('user');
    await run;
    // The checkpoint took the steer, so the aborted run had nothing left to deliver.
    expect(deliveredAfterTask(a)).toEqual([]);

    const persistence = persistenceOf(h);
    const log = await persistence.readEventLog(h.teamId);
    const checkpoint = (await checkpointOf(persistence, h.teamId))!;
    expect(checkpoint.members.find((m) => m.name === 'A')!.undelivered).toEqual([{ text: steer, echoed: true, images: [image], ids: [expect.any(String)] }]);
    expect(checkpoint.operatorSteers).toEqual([{ memberName: 'A', message: 'use this layout', imageCount: 1, attempt: 0 }]);

    const after = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A'], behave: { Lead: holdTurn } });
    after.runner.restore(log, checkpoint, files);
    const done = after.runner.resume('tc-resume');
    const resumedA = await opened(after, 'A');
    await resumedA.whenPrompted(2);

    expect(resumedA.prompts[1]).toBe(steer);
    expect(resumedA.promptOptions[1]?.images).toEqual([{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
    expect(resumedA.promptOptions[1]?.expandPromptTemplates).toBe(false);

    after.runner.cancel('user');
    await done;
  });
});

describe('TeamRunner peer message still queued in pi at the cancel', () => {
  it('is taken by the checkpoint rather than delivered by the aborted run, and prompts the resumed member once', async () => {
    const h = midToolTeam('peer-steer');
    const run = h.runner.run();
    const a = await opened(h, 'A');
    await a.whenModelCalled(1);

    const peer = '[Message from Lead]: check the parser';
    const sent = h.bus().send('Lead', 'A', 'check the parser');
    await a.whenPrompted(2);
    expect(a.getSteeringMessages()).toEqual([peer]);
    const files = new Map(['Lead', 'A'].map((n) => [h.agent(n).agentId, h.session(n).sessionFile!]));
    h.runner.cancel('user');
    await run;
    expect(deliveredAfterTask(a)).toEqual([]);

    const persistence = persistenceOf(h);
    const checkpoint = (await checkpointOf(persistence, h.teamId))!;
    expect(checkpoint.members.find((m) => m.name === 'A')!.undelivered).toEqual([{ text: peer, echoed: true, ids: [sent.messageId] }]);

    const after = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A'], behave: { Lead: holdTurn } });
    after.runner.restore(await persistence.readEventLog(h.teamId), checkpoint, files);
    const done = after.runner.resume('tc-resume');
    const resumedA = await opened(after, 'A');
    await resumedA.whenPrompted(2);
    after.runner.cancel('user');
    await done;

    expect(resumedA.prompts[1]).toBe(peer);
    expect(resumedA.prompts.filter((p) => p.includes('check the parser'))).toHaveLength(1);
  });

  it('hands pi queued messages to the resumed member before the ones the runner still held', async () => {
    const files = new Map<string, string>();
    const h = makeTeam({
      cwd: newCwd('queue-order'), teamId: crypto.randomUUID(), specialists: ['A'],
      behave: {
        Lead: (_t, s, hh) => {
          if (s.prompts.length === 1) hh.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
          void s.endTurn();
        },
        A: (_t, s, hh) => {
          // Both reach pi after its last queue check, so its run settles with them still queued.
          s.atLastQueueCheck = () => {
            s.atLastQueueCheck = null;
            hh.bus().send('Lead', 'A', 'first, steered into pi');
            s.queueFollowUp('[Message from Lead]: second, a pi follow-up');
          };
          // pi has settled but the runner has not seen its prompt return, so it holds the next message itself.
          const off = s.subscribe((e) => {
            if ((e as { type: string }).type !== 'agent_settled') return;
            off();
            hh.bus().send('Lead', 'A', 'third, held by the runner');
            for (const n of ['Lead', 'A']) files.set(hh.agent(n).agentId, hh.session(n).sessionFile!);
            hh.runner.cancel('user');
          });
          void s.endTurn();
        },
      },
    });
    const run = h.runner.run();
    await run;
    const a = h.session('A');
    expect(deliveredAfterTask(a)).toEqual([]);

    const persistence = persistenceOf(h);
    const checkpoint = (await checkpointOf(persistence, h.teamId))!;
    const expected = [
      '[Message from Lead]: first, steered into pi',
      '[Message from Lead]: second, a pi follow-up',
      '[Message from Lead]: third, held by the runner',
    ];
    expect(checkpoint.members.find((m) => m.name === 'A')!.undelivered.map((u) => u.text)).toEqual(expected);

    const after = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A'], behave: { Lead: holdTurn } });
    after.runner.restore(await persistence.readEventLog(h.teamId), checkpoint, files);
    const done = after.runner.resume('tc-resume');
    const resumedA = await opened(after, 'A');
    await resumedA.whenPrompted(4);
    after.runner.cancel('user');
    await done;

    expect(resumedA.prompts.slice(1, 4)).toEqual(expected);
  });
});

describe('TeamRunner.resume relaunches, parks, restarts or leaves each member by its status at the cancel', () => {
  async function resumed(label: string, behave: Record<string, Behaviour> = {}): Promise<{ before: Harness; after: Harness; done: Promise<{ status: string; text: string }>; checkpoint: TeamCheckpoint }> {
    const { h, files, run } = await interruptedTeam(newCwd(label), crypto.randomUUID());
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);
    const log = await persistence.readEventLog(h.teamId);
    const checkpoint = (await checkpointOf(persistence, h.teamId))!;

    const reportOnce: Behaviour = (_t, s, hh) => {
      const name = hh.opened.find((o) => o.session === s)!.name;
      if (s.prompts.length === 1) hh.runner.reportComplete(name, `${name} resumed and done`);
      void s.endTurn();
    };
    const after = makeTeam({
      cwd: h.cwd, teamId: h.teamId,
      specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
      behave: { Lead: holdTurn, A: endTurn, B: reportOnce, C: reportOnce, F: reportOnce, ...behave },
    });
    after.runner.restore(log, checkpoint, files);
    const done = after.runner.resume('tc-resume', 'continue please');
    return { before: h, after, done, checkpoint };
  }

  it('relaunches the lead with the resume prompt and the running specialist with the resume note', async () => {
    const { before, after, done } = await resumed('plan-relaunch');

    const lead = await opened(after, 'Lead');
    const b = await opened(after, 'B');
    await lead.whenPrompted(1);
    await b.whenPrompted(1);

    expect(lead.prompts[0]).toBe(buildResumePrompt('continue please'));
    expect(b.prompts[0]).toContain(buildResumePrompt());
    const reopen = (name: string) => after.opened.find((o) => o.name === name)!.store;
    expect(reopen('Lead')).toEqual({ kind: 'reopen', path: before.session('Lead').sessionFile, agentId: before.agent('Lead').agentId });
    expect(reopen('B')).toEqual({ kind: 'reopen', path: before.session('B').sessionFile, agentId: before.agent('B').agentId });
    expect(lead.customEntries).toContainEqual({ customType: DAMOCLES_AGENT_SEGMENT_ENTRY, data: expect.objectContaining({ toolCallId: 'tc-resume' }) });
    expect(statusUpdates(after, after.agent('B').agentId)).toContain('running');

    after.runner.cancel('user');
    await done;
  });

  it('keeps the attempt, bumps resumeCount and gives each relaunch its own browser scope', async () => {
    const { after, done } = await resumed('plan-scope');
    await (await opened(after, 'B')).whenPrompted(1);
    await opened(after, 'A');

    for (const name of ['Lead', 'A', 'B']) {
      expect(after.agent(name).attempt).toBe(0);
      expect(after.scopes.get(name)).toEqual([`${after.agent(name).agentId}#0.1`]);
    }
    // The spawn entry's kind survives the resume, so a relaunched reviewer keeps its read-only toolset.
    expect(after.kinds.get('B')).toEqual(['reviewer']);
    expect(after.kinds.get('A')).toEqual(['implementor']);
    const resumedEntries = logEntries(after).filter((e) => e['type'] === 'agent-resumed');
    expect(Object.fromEntries(resumedEntries.map((e) => [e['name'], [e['mode'], e['status'], e['attempt'], e['resumeCount']]]))).toEqual({
      Lead: ['relaunch', 'running', 0, 1],
      A: ['park', 'awaiting-review', 0, 1],
      B: ['relaunch', 'running', 0, 1],
      C: ['park', 'running', 0, 1],
      F: ['restart', 'running', 0, 1],
    });
    expect(logEntries(after).filter((e) => e['type'] === 'team-resumed')).toEqual([
      expect.objectContaining({ toolUseId: 'tc-resume', message: 'continue please' }),
    ]);

    after.runner.cancel('user');
    await done;
  });

  it('parks awaiting-review and standby members: session reopened, no prompt, no running status', async () => {
    const { before, after, done } = await resumed('plan-park');
    const a = await opened(after, 'A');
    const aId = after.agent('A').agentId;

    expect(after.opened.find((o) => o.name === 'A')!.store).toEqual({ kind: 'reopen', path: before.session('A').sessionFile, agentId: aId });
    expect(after.agent('A').status).toBe('awaiting-review');
    // The lead already read A's unchanged section before the cancel, so approval needs no re-read.
    after.runner.approveSpecialist('A');
    await vi.waitFor(() => expect(after.forgotten).toContain(a));

    expect(a.prompts).toEqual([]);
    expect(statusUpdates(after, aId)).not.toContain('running');
    expect(after.agent('A').status).toBe('completed');

    after.runner.cancel('user');
    await done;
  });

  it('leaves completed, cancelled and pending members untouched and opens no session for them', async () => {
    const { after, done } = await resumed('plan-unchanged');
    await (await opened(after, 'B')).whenPrompted(1);

    expect(['D', 'E', 'G', 'H'].map((n) => after.agent(n).status)).toEqual(['pending', 'completed', 'cancelled', 'cancelled']);
    expect(after.opened.filter((o) => ['D', 'E', 'G', 'H'].includes(o.name))).toEqual([]);
    for (const n of ['D', 'E', 'G', 'H']) expect(statusUpdates(after, after.agent(n).agentId)).toEqual([]);

    after.runner.cancel('user');
    await done;
  });

  it('starts a member with no session file afresh from its agent-spawned task, as a new file', async () => {
    const { after, done } = await resumed('plan-restart');
    const f = await opened(after, 'F');
    await f.whenPrompted(1);

    expect(f.prompts[0]).toBe('task for F, described in full');
    expect(after.opened.find((o) => o.name === 'F')!.store).toEqual({
      kind: 'file', dir: teamMembersDir(piSessionDir(after.cwd), SESSION, after.teamId), id: `${after.agent('F').agentId}.a0`,
    });
    expect(f.customEntries[0]?.customType).toBe(DAMOCLES_AGENT_LAUNCH_ENTRY);

    after.runner.cancel('user');
    await done;
  });

  it('delivers every message that was undelivered at the cancel, including one to a parked member', async () => {
    const { after, done } = await resumed('plan-redeliver');
    const b = await opened(after, 'B');
    const c = await opened(after, 'C');
    await vi.waitFor(() => expect(b.prompts.join('\n')).toContain('steer held for B'));
    await c.whenPrompted(1);

    const bText = b.prompts.join('\n');
    expect(bText).toContain('[Message from Lead]: for B before cancel');
    expect(bText).toContain(wrapSteerMessage('focus on the parser'));
    // A parked member is woken by its message, never by a resume prompt.
    expect(c.prompts[0]).toBe('[Message from Lead]: follow-up held for C');
    // Woken, it runs, so it can sign off again.
    await status(after, 'C', 'awaiting-review');

    after.runner.cancel('user');
    await done;
  });

  it('steers undelivered messages into a relaunched member whose resume turn keeps working, each on its own, steers first', async () => {
    // Its resume call never ends, so a message the runner held for a settled run would never arrive.
    const { after, done } = await resumed('plan-redeliver-mid-turn', { B: holdTurn });
    const b = await opened(after, 'B');
    await vi.waitFor(() => expect(b.prompts).toHaveLength(4));

    expect(b.prompts).toEqual([
      buildResumePrompt(),
      wrapSteerMessage('focus on the parser'),
      'steer held for B',
      '[Message from Lead]: for B before cancel',
    ]);
    expect(b.promptOptions.slice(1).map((o) => o?.streamingBehavior)).toEqual(['steer', 'steer', 'steer']);
    expect(after.agent('B').status).toBe('running');

    after.runner.cancel('user');
    await done;
  });

  it('carries operator steers into the result and restores review state', async () => {
    const { after, done, checkpoint } = await resumed('plan-steers');
    await (await opened(after, 'B')).whenPrompted(1);

    expect(after.runner.getOperatorSteers()).toEqual([{ memberName: 'B', message: 'focus on the parser', attempt: 0 }]);
    expect(checkpoint.review.reviewedSpecialists).toEqual(['E']);
    expect(after.runner.getUnreviewedSpecialistNames()).toContain('A');
    // B, C and F report after the resume, which opens a review round.
    await vi.waitFor(() => {
      const rrr = after.webview.flatMap((m) =>
        m.type === 'teamMessage' && m.message.recipientName === 'Lead' && m.message.content.includes('[REVIEW ROUND READY]') ? [m.message.content] : []);
      expect(rrr.at(-1)).toContain('  - B: no scratchpad section authored\n    user steer: "focus on the parser"');
    });

    after.runner.cancel('user');
    await done;
  });
});

describe('TeamRunner.resume and the review round', () => {
  const RRR = '[REVIEW ROUND READY]';

  /** A team cancelled while the lead held an open round: A awaiting review, [REVIEW ROUND READY] delivered. */
  async function roundOpenAtCancel(label: string): Promise<{ cwd: string; teamId: string; persistence: TeamPersistence; checkpoint: TeamCheckpoint; files: Map<string, string> }> {
    const cwd = newCwd(label);
    const teamId = crypto.randomUUID();
    const h = makeTeam({
      cwd, teamId, specialists: ['A'],
      behave: {
        Lead: (text, s, hh) => {
          if (s.prompts.length === 1) hh.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
          // The lead keeps working on the round it was handed, so no stall nudge repeats it.
          if (!text.includes(RRR)) void s.endTurn();
        },
        A: (_t, s, hh) => {
          hh.scratchpad().set('a-notes', 'A findings', 'A');
          hh.runner.reportComplete('A', 'A signed off');
          void s.endTurn();
        },
      },
    });
    const run = h.runner.run();
    const lead = await opened(h, 'Lead');
    await vi.waitFor(() => expect(lead.prompts.some((p) => p.includes(RRR))).toBe(true));
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);
    const checkpoint = (await checkpointOf(persistence, teamId))!;
    const files = new Map([[h.agent('Lead').agentId, lead.sessionFile!], [h.agent('A').agentId, h.session('A').sessionFile!]]);
    return { cwd, teamId, persistence, checkpoint, files };
  }

  it('does not re-send a [REVIEW ROUND READY] the lead already holds', async () => {
    const { cwd, teamId, persistence, checkpoint, files } = await roundOpenAtCancel('rrr');
    expect(checkpoint.review.lastReviewRoundNotification).toContain(RRR);

    const after = makeTeam({ cwd, teamId, specialists: ['A'], behave: { Lead: holdTurn } });
    after.runner.restore(await persistence.readEventLog(teamId), checkpoint, files);
    const done = after.runner.resume('tc-resume');
    const newLead = await opened(after, 'Lead');
    await newLead.whenPrompted(1);
    await opened(after, 'A');

    // FIFO bus: once this later message is recorded, an earlier notification would be too.
    after.bus().send('control', 'Lead', 'control');
    const toLead = after.webview.flatMap((m) => (m.type === 'teamMessage' && m.message.recipientName === 'Lead' ? [m.message.content] : []));
    expect(toLead.at(-1)).toBe('control');
    expect(toLead.filter((c) => c.includes(RRR))).toEqual([]);
    expect(newLead.prompts[0]).toBe(buildResumePrompt());

    after.runner.cancel('user');
    await done;
  });

  it('a lead whose stall budget ran out before the cancel is not force-completed on its first resumed turn', async () => {
    const { cwd, teamId, persistence, checkpoint, files } = await roundOpenAtCancel('stalls');
    // Holding the nudged turn keeps later stalls from racing the assertions to a forced end.
    const leadEndsFirstTurn: Behaviour = (_t, s) => { if (s.prompts.length === 1) void s.endTurn(); };
    const after = makeTeam({ cwd, teamId, specialists: ['A'], behave: { Lead: leadEndsFirstTurn } });
    after.runner.restore(await persistence.readEventLog(teamId), { ...checkpoint, review: { ...checkpoint.review, leadReviewStalls: 2 } }, files);
    const done = after.runner.resume('tc-resume');
    const lead = await opened(after, 'Lead');

    // The first turn ends without a review; the next prompt is the round nudge, not the forced end.
    await lead.whenPrompted(2);
    expect(lead.prompts[1]).toContain(RRR);
    expect(after.agent('Lead').status).not.toBe('completed');
    expect(lead.prompts.some((p) => p.includes('[TEAM FORCE-COMPLETED]'))).toBe(false);

    after.runner.cancel('user');
    await done;
  });
});

describe('TeamRunner.resume cost', () => {
  it('reports only spend after the reopen, so earlier spend is not charged twice', async () => {
    const cwd = newCwd('cost');
    const teamId = crypto.randomUUID();
    const h = makeTeam({
      cwd, teamId, specialists: [],
      behave: { Lead: (_t, s) => { s.emitAssistantUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 2); } },
    });
    const run = h.runner.run();
    await (await opened(h, 'Lead')).whenModelCalled(1);
    h.runner.cancel('user');
    await run;
    expect(h.costs.reduce((a, b) => a + b, 0)).toBe(2);
    const persistence = persistenceOf(h);
    const checkpoint = (await checkpointOf(persistence, teamId))!;

    const after = makeTeam({
      cwd, teamId, specialists: [],
      opening: { Lead: { cost: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } },
      behave: { Lead: (_t, s) => { s.emitAssistantUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.5); void s.endTurn(); } },
    });
    after.runner.restore(await persistence.readEventLog(teamId), checkpoint, new Map([[h.agent('Lead').agentId, h.session('Lead').sessionFile!]]));
    const result = await after.runner.resume('tc-resume');

    expect(result.status).toBe('completed');
    expect(after.costs.reduce((a, b) => a + b, 0)).toBeCloseTo(0.5, 10);
    // The card total is the earlier spend carried over plus this run's own.
    expect(after.agent('Lead').costUsd).toBeCloseTo(2.5, 10);
    expect([after.agent('Lead').totalInputTokens, after.agent('Lead').totalOutputTokens]).toEqual([2, 2]);
  });
});

describe('TeamRunner.resume tool count', () => {
  /** A response calling `n` tools, which pi runs; the turn holds until the model answers again. */
  const callTools = (n: number): Behaviour => (_t, s) => {
    const content = Array.from({ length: n }, (_, i) => ({ type: 'toolCall', id: `tc-${s.prompts.length}-${i}`, name: 'read', arguments: {} }));
    s.emit({ type: 'message_end', message: { role: 'assistant', content, stopReason: 'toolUse' } });
    for (const call of content) s.emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: {} });
    for (const call of content) {
      const result = { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [], isError: false };
      s.emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result, isError: false });
      s.emit({ type: 'message_start', message: result });
      s.emit({ type: 'message_end', message: result });
    }
  };

  it("adds the resumed run's tool calls to the attempt's earlier ones, live, in the log and after a reload", async () => {
    const cwd = newCwd('tools');
    const teamId = crypto.randomUUID();
    const h = makeTeam({ cwd, teamId, specialists: [], behave: { Lead: callTools(3) } });
    const run = h.runner.run();
    await (await opened(h, 'Lead')).whenPrompted(1);
    await vi.waitFor(() => expect(h.agent('Lead').toolCallCount).toBe(3));
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);
    const checkpoint = (await checkpointOf(persistence, teamId))!;
    expect(checkpoint.members.find((m) => m.name === 'Lead')!.toolCallCount).toBe(3);

    const after = makeTeam({
      cwd, teamId, specialists: [],
      // The model answers the call after its tools without calling more, which ends the turn.
      behave: { Lead: (t, s, hh) => { if (t) callTools(2)(t, s, hh); void s.endTurn(); } },
    });
    after.runner.restore(await persistence.readEventLog(teamId), checkpoint, new Map([[h.agent('Lead').agentId, h.session('Lead').sessionFile!]]));
    const result = await after.runner.resume('tc-resume');

    expect(result.status).toBe('completed');
    const started = after.webview.find((m) => m.type === 'teamStarted');
    expect(started?.type === 'teamStarted' && started.team.agents.find((a) => a.name === 'Lead')!.toolCount).toBe(3);
    expect(after.agent('Lead').toolCallCount).toBe(5);
    const completed = logEntries(after).filter((e) => e['type'] === 'agent-completed' && e['name'] === 'Lead');
    expect(completed.map((e) => e['toolCallCount'])).toEqual([3, 5]);
    const reloaded = await persistenceOf(after).loadTeamState(teamId);
    expect(reloaded!.agents.find((a) => a.name === 'Lead')!.toolCount).toBe(5);
  });

  it('counts the usage and tool calls of the request in flight at the cancel, live and after a reload alike', async () => {
    const cwd = newCwd('mid-request');
    const teamId = crypto.randomUUID();
    // A message steered into the lead's first request makes pi ask the model again, and that request is in flight at the cancel.
    const h = makeTeam({ cwd, teamId, specialists: [], behave: { Lead: holdTurn } });
    const run = h.runner.run();
    const lead = await opened(h, 'Lead');
    await lead.whenModelCalled(1);
    h.bus().send('system', 'Lead', 'status check');
    await lead.whenPrompted(2);
    lead.emitAssistantUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 1);
    void lead.endTurn();
    await lead.whenModelCalled(2);
    await vi.waitFor(() => expect(h.agent('Lead').totalInputTokens).toBe(10));
    // The in-flight request reports its usage and tool calls only as the abort ends it, after the checkpoint,
    // and the abort cuts its batch after the first call.
    const abort = lead.abort.bind(lead);
    lead.abort = async () => {
      const calls = ['late', 'late-skipped'].map((id) => ({ type: 'toolCall', id, name: 'read', arguments: {} }));
      lead.emit({ type: 'message_end', message: { role: 'assistant', content: calls, stopReason: 'toolUse', usage: { input: 7, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 2 } } } });
      lead.emit({ type: 'tool_execution_start', toolCallId: 'late', toolName: 'read', args: {} });
      await abort();
    };
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);

    const after = makeTeam({
      cwd, teamId, specialists: [],
      opening: { Lead: { cost: lead.cost, tokens: { ...lead.tokens } } },
      behave: { Lead: (_t, s) => { s.emitAssistantUsage({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.5); void s.endTurn(); } },
    });
    after.runner.restore(await persistence.readEventLog(teamId), (await checkpointOf(persistence, teamId))!, new Map([[h.agent('Lead').agentId, lead.sessionFile!]]));
    expect((await after.runner.resume('tc-resume')).status).toBe('completed');

    const live = after.agent('Lead');
    const reloaded = (await persistenceOf(after).loadTeamState(teamId))!.agents.find((a) => a.name === 'Lead')!;
    expect(live).toMatchObject({ totalInputTokens: 19, totalOutputTokens: 10, toolCallCount: 1, costUsd: 3.5 });
    expect([reloaded.totalInputTokens, reloaded.totalOutputTokens, reloaded.toolCount, reloaded.costUsd])
      .toEqual([live.totalInputTokens, live.totalOutputTokens, live.toolCallCount, live.costUsd]);
  });
});

describe('TeamRunner.resume restarts a lead that has no session file', () => {
  async function leadRestart(message: string | undefined): Promise<{ task: string; prompt: string }> {
    const cwd = newCwd('lead-restart');
    const teamId = crypto.randomUUID();
    const h = makeTeam({ cwd, teamId, specialists: [], behave: { Lead: holdTurn } });
    const run = h.runner.run();
    const first = await opened(h, 'Lead');
    await first.whenPrompted(1);
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);

    const after = makeTeam({ cwd, teamId, specialists: [], behave: { Lead: holdTurn } });
    after.runner.restore(await persistence.readEventLog(teamId), (await checkpointOf(persistence, teamId))!, new Map());
    const done = after.runner.resume('tc-resume', message);
    const lead = await opened(after, 'Lead');
    await lead.whenPrompted(1);
    after.runner.cancel('user');
    await done;
    return { task: first.prompts[0]!, prompt: lead.prompts[0]! };
  }

  // A steer would give the model-written note operator authority, so the restart carries it as a resume note.
  it('starts from its original task with the resume message as a quoted note, never as a steer', async () => {
    const { task, prompt } = await leadRestart('  switch to the new parser  ');

    expect(prompt).toBe(withResumeNote(task, 'switch to the new parser'));
    expect(prompt.startsWith(`${task}\n\n${RESUME_NOTE_RULES}`)).toBe(true);
    expect(prompt.endsWith(`${RESUME_NOTE_LABEL}\n> switch to the new parser`)).toBe(true);
    expect(prompt).not.toContain(STEER_INSTRUCTION_PREFIX);
  });

  it('with no message it starts from its task alone', async () => {
    const { task, prompt } = await leadRestart(undefined);

    expect(prompt).toBe(task);
  });
});

describe('TeamRunner.resume active time', () => {
  afterEach(() => vi.useRealTimers());

  it('excludes the time the team was stopped, keeps counting a parked member, and reads the same live, in getTeamStatus and after a reload', async () => {
    // Only Date is faked: the runner drives itself on microtasks and real timers. vi.waitFor advances the
    // fake clock while it polls, so each stopwatch is checked against the spawn time it recorded.
    vi.useFakeTimers({ toFake: ['Date'] });
    const T = Date.parse('2026-10-01T15:00:00.000Z');
    const minutes = (n: number): number => T + n * 60_000;
    vi.setSystemTime(T);
    const cwd = newCwd('stopwatch');
    const teamId = crypto.randomUUID();
    const h = makeTeam({
      cwd, teamId, specialists: ['A'],
      behave: {
        Lead: (_t, s, hh) => { if (s.prompts.length === 1) hh.runner.startSpecialist('A', 'Test label', 'task for A, described in full'); },
        A: (_t, s, hh) => { hh.runner.reportComplete('A', 'A signed off'); void s.endTurn(); },
      },
    });
    const run = h.runner.run();
    await status(h, 'A', 'awaiting-review');
    const firstRun = new Map(['Lead', 'A'].map((n) => [n, minutes(10) - h.agent(n).runningSince!]));
    expect(firstRun.get('Lead')).toBe(600_000);
    vi.setSystemTime(minutes(10));
    h.runner.cancel('user');
    await run;
    for (const name of ['Lead', 'A']) expect(h.agent(name)).toMatchObject({ activeMs: firstRun.get(name), runningSince: null });

    vi.setSystemTime(minutes(89));
    const persistence = persistenceOf(h);
    const after = makeTeam({ cwd, teamId, specialists: ['A'], behave: { Lead: holdTurn } });
    const files = new Map(['Lead', 'A'].map((n) => [h.agent(n).agentId, h.session(n).sessionFile!]));
    after.runner.restore(await persistence.readEventLog(teamId), (await checkpointOf(persistence, teamId))!, files);
    const done = after.runner.resume('tc-resume');
    await opened(after, 'A');
    await (await opened(after, 'Lead')).whenPrompted(1);

    const started = after.webview.find((m) => m.type === 'teamStarted');
    const startedLead = started?.type === 'teamStarted' ? started.team.agents.find((a) => a.name === 'Lead') : undefined;
    expect(startedLead).toMatchObject({ activeMs: 600_000, runningSince: minutes(89) });
    expect(after.agent('A')).toMatchObject({ status: 'awaiting-review', activeMs: firstRun.get('A'), runningSince: minutes(89) });

    vi.setSystemTime(minutes(90));
    const durations = (after.runner.getTeamStatus()['agents'] as Array<{ name: string; durationSec: number }>).map((a) => [a.name, a.durationSec]);
    expect(durations).toEqual([['Lead', 660], ['A', 660]]);

    vi.setSystemTime(minutes(95));
    after.runner.cancel('user');
    await done;
    const reloaded = await persistenceOf(after).loadTeamState(teamId);
    for (const name of ['Lead', 'A']) {
      const live = after.agent(name);
      const stopwatch = { activeMs: firstRun.get(name)! + 360_000, runningSince: null };
      expect(live).toMatchObject(stopwatch);
      const settled = after.webview.filter((m) => m.type === 'teamAgentStatusUpdate' && m.agentId === live.agentId && m.stopwatch).at(-1);
      expect(settled?.type === 'teamAgentStatusUpdate' && settled.stopwatch).toEqual(stopwatch);
      expect(reloaded!.agents.find((a) => a.name === name)).toMatchObject(stopwatch);
    }
  });
});

describe('TeamRunner.resume keeps review coverage', () => {
  const RRR = '[REVIEW ROUND READY]';
  const REASON = 'the finding is a style nit outside the brief';

  it('keeps the pairs, stamps, verdicts and dismissals across a cancel and resume', async () => {
    const cwd = newCwd('coverage');
    const teamId = crypto.randomUUID();
    const h = makeTeam({
      cwd, teamId, specialists: ['backend', 'appsec'],
      behave: {
        Lead: (text, s, hh) => {
          if (s.prompts.length === 1) {
            hh.runner.startSpecialist('backend', 'Test label', 'implement the backend in full');
          } else if (text.includes(RRR) && hh.agent('appsec').status === 'pending') {
            hh.scratchpad().markRead('Lead', 'backend-api');
            hh.runner.startSpecialist('appsec', 'Test label', 'review the backend for defects', undefined, 'reviewer', ['backend']);
          } else if (text.includes('CHANGES REQUESTED')) {
            hh.runner.dismissReview('appsec', 'backend', REASON);
            return;
          }
          void s.endTurn();
        },
        backend: (_t, s, hh) => {
          hh.scratchpad().set('backend-api', 'the api', 'backend');
          hh.runner.reportComplete('backend', 'backend delivered and verified');
          void s.endTurn();
        },
        appsec: (_t, s, hh) => {
          hh.scratchpad().markRead('appsec', 'backend-api');
          hh.runner.reportComplete('appsec', 'reviewed backend in full', [{ implementor: 'backend', verdict: 'changes_requested' }]);
          void s.endTurn();
        },
      },
    });
    const run = h.runner.run();
    await vi.waitFor(() => expect(logEntries(h).some((e) => e['type'] === 'review-dismissed')).toBe(true));
    h.runner.cancel('user');
    const result = await run;
    expect(result.text).toMatch(/^REVIEW DISMISSALS \(recorded by the system\)/);

    const persistence = persistenceOf(h);
    const checkpoint = (await checkpointOf(persistence, teamId))!;
    expect(checkpoint.review.coverage).toEqual({
      landed: [['backend', { attempt: 0, round: 0 }]],
      signoffs: [['appsec', [['backend', { stamp: { attempt: 0, round: 0 }, verdict: 'changes_requested' }]]]],
      dismissals: [['appsec', [['backend', { stamp: { attempt: 0, round: 0 }, reason: REASON, why: 'appsec requested changes on it' }]]]],
      reReviewOwed: [],
    });

    const files = new Map(['Lead', 'backend', 'appsec'].map((n) => [h.agent(n).agentId, h.session(n).sessionFile!]));
    const after = makeTeam({ cwd, teamId, specialists: ['backend', 'appsec'], behave: { Lead: holdTurn } });
    after.runner.restore(await persistence.readEventLog(teamId), checkpoint, files);
    const coverage = (after.runner as unknown as { coverage: ReviewCoverage }).coverage;
    expect(coverage.reviewsOf('appsec')).toEqual(['backend']);
    expect(coverage.serialize()).toEqual(checkpoint.review.coverage);
    expect(coverage.isSatisfied('appsec', 'backend', (after.runner as unknown as { coverageView: CoverageView }).coverageView)).toBe(true);
    expect(after.runner.getUnsatisfiedReviews()).toEqual([]);

    const done = after.runner.resume('tc-resume');
    after.runner.approveSpecialist('backend');
    expect(after.agent('backend').status).toBe('completed');
    after.runner.cancel('user');
    await done;
  });

  it('a team whose log declares no pairs restores with no coverage rule', async () => {
    const cwd = newCwd('no-pairs');
    const teamId = crypto.randomUUID();
    const h = makeTeam({
      cwd, teamId, specialists: ['A'],
      behave: {
        Lead: (text, s, hh) => {
          if (s.prompts.length === 1) hh.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
          if (!text.includes(RRR)) void s.endTurn();
        },
        A: (_t, s, hh) => {
          hh.runner.reportComplete('A', 'A signed off');
          void s.endTurn();
        },
      },
    });
    const run = h.runner.run();
    const lead = await opened(h, 'Lead');
    await vi.waitFor(() => expect(lead.prompts.some((p) => p.includes(RRR))).toBe(true));
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);
    const checkpoint = (await checkpointOf(persistence, teamId))!;
    // A checkpoint written before coverage existed carries none.
    delete checkpoint.review.coverage;

    const after = makeTeam({ cwd, teamId, specialists: ['A'], behave: { Lead: holdTurn } });
    after.runner.restore(await persistence.readEventLog(teamId), checkpoint, new Map([[h.agent('Lead').agentId, lead.sessionFile!], [h.agent('A').agentId, h.session('A').sessionFile!]]));
    expect((after.runner as unknown as { coverage: ReviewCoverage }).coverage.hasPairs()).toBe(false);
    const done = after.runner.resume('tc-resume');
    after.runner.approveSpecialist('A');
    expect(after.agent('A').status).toBe('completed');
    after.runner.cancel('user');
    await done;
  });

  describe('refuses restored review state that does not fit the roster', () => {
    let team: Promise<{ cwd: string; teamId: string }>;
    beforeAll(() => { team = runInterruptedTeam(); });

    /** A fresh read of the one cancelled team, which each test tampers with. */
    async function interrupted(): Promise<{ cwd: string; teamId: string; log: TeamEventLog; checkpoint: TeamCheckpoint }> {
      const { cwd, teamId } = await team;
      const persistence = new TeamPersistence(cwd, SESSION);
      return { cwd, teamId, log: await persistence.readEventLog(teamId), checkpoint: (await checkpointOf(persistence, teamId))! };
    }

    async function runInterruptedTeam(): Promise<{ cwd: string; teamId: string }> {
      const cwd = newCwd('restored-review');
      const teamId = crypto.randomUUID();
      const h = makeTeam({
        cwd, teamId, specialists: ['A', 'R'],
        behave: {
          Lead: (text, s, hh) => {
            if (s.prompts.length === 1) hh.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
            if (!text.includes(RRR)) void s.endTurn();
          },
          A: (_t, s, hh) => {
            hh.runner.reportComplete('A', 'A signed off');
            void s.endTurn();
          },
        },
      });
      const run = h.runner.run();
      const lead = await opened(h, 'Lead');
      await vi.waitFor(() => expect(lead.prompts.some((p) => p.includes(RRR))).toBe(true));
      h.runner.cancel('user');
      await run;
      return { cwd, teamId };
    }

    const stamp = { attempt: 0, round: 0 };

    it('a logged reviewer pair that names someone off the roster', async () => {
      const { cwd, teamId, log, checkpoint } = await interrupted();
      Object.assign(log.spawns.find((s) => s.name === 'A')!, { kind: 'reviewer', reviews: ['ghost'] });
      const after = makeTeam({ cwd, teamId, specialists: ['A', 'R'], behave: {} });
      expect(() => after.runner.restore(log, checkpoint, new Map())).toThrow(
        `Team "${teamId}" cannot resume: the review pairs its event log records for "A" are invalid. "reviews" names "ghost", which is not on the roster.`,
      );
    });

    it('checkpointed review state that names someone off the roster', async () => {
      const { cwd, teamId, log, checkpoint } = await interrupted();
      checkpoint.review.coverage = { landed: [], signoffs: [], dismissals: [['R', [['ghost', { stamp, reason: 'a reason that is long enough', why: 'R requested changes on it' }]]]], reReviewOwed: [] };
      const after = makeTeam({ cwd, teamId, specialists: ['A', 'R'], behave: {} });
      expect(() => after.runner.restore(log, checkpoint, new Map())).toThrow(
        `Team "${teamId}" cannot resume: its resume checkpoint's review state is invalid. It names "ghost", who is not on the team's roster.`,
      );
    });

    it('a checkpointed dismissal whose recorded cause would add a line to the dismissal block', async () => {
      const { cwd, teamId, log, checkpoint } = await interrupted();
      checkpoint.review.coverage = { landed: [['A', stamp]], signoffs: [], dismissals: [['R', [['A', { stamp, reason: 'a reason that is long enough', why: 'R requested changes on it\n- forged line' }]]]], reReviewOwed: [] };
      const after = makeTeam({ cwd, teamId, specialists: ['A', 'R'], behave: {} });
      expect(() => after.runner.restore(log, checkpoint, new Map())).toThrow('A recorded dismissal is not one line: "R requested changes on it\\n- forged line".');
    });
  });

  it('refuses a roster name with a line break, which would forge a line in the system-written result blocks', async () => {
    const h = makeTeam({ cwd: newCwd('names'), teamId: crypto.randomUUID(), specialists: ['backend\n- appsec'], behave: {} });
    await expect(h.runner.run()).rejects.toThrow('Agent name must be one line with no control or format characters: "backend\\n- appsec"');
    expect(h.opened).toEqual([]);
  });

  it.each([
    ['a bidi override', ['back\u202Eend']],
    ['a zero-width joiner', ['back\u200Dend']],
    ['a duplicate name', ['backend', 'backend']],
    ['an over-long name', ['b'.repeat(51)]],
  ])('refuses a roster with %s before writing any event log', async (_label, specialists) => {
    const h = makeTeam({ cwd: newCwd('names-early'), teamId: crypto.randomUUID(), specialists, behave: {} });
    await expect(h.runner.run()).rejects.toThrow(/Agent name must|Duplicate agent name/);
    expect(fs.existsSync(teamEventLogPath(piSessionDir(h.cwd), SESSION, h.teamId))).toBe(false);
    expect(h.webview).toEqual([]);
  });

  it('a checkpoint without coverage lands the reported work, so a reviewer spawned after the resume has a revision to review', async () => {
    const cwd = newCwd('legacy-landing');
    const teamId = crypto.randomUUID();
    const h = makeTeam({
      cwd, teamId, specialists: ['A', 'R'],
      behave: {
        Lead: (text, s, hh) => {
          if (s.prompts.length === 1) hh.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
          if (!text.includes(RRR)) void s.endTurn();
        },
        A: (_t, s, hh) => {
          hh.scratchpad().set('A-api', 'the api', 'A');
          hh.runner.reportComplete('A', 'A signed off');
          void s.endTurn();
        },
      },
    });
    const run = h.runner.run();
    const lead = await opened(h, 'Lead');
    await vi.waitFor(() => expect(lead.prompts.some((p) => p.includes(RRR))).toBe(true));
    h.runner.cancel('user');
    await run;
    const persistence = persistenceOf(h);
    const checkpoint = (await checkpointOf(persistence, teamId))!;
    delete checkpoint.review.coverage;

    const after = makeTeam({ cwd, teamId, specialists: ['A', 'R'], behave: { Lead: holdTurn, R: holdTurn } });
    after.runner.restore(await persistence.readEventLog(teamId), checkpoint, new Map([[h.agent('Lead').agentId, lead.sessionFile!], [h.agent('A').agentId, h.session('A').sessionFile!]]));
    const coverage = (after.runner as unknown as { coverage: ReviewCoverage }).coverage;
    expect(coverage.landedOf('A')).toEqual({ attempt: 0, round: 0 });

    const done = after.runner.resume('tc-resume');
    after.scratchpad().markRead('Lead', 'A-api');
    after.runner.startSpecialist('R', 'Test label', 'review A for defects in full', undefined, 'reviewer', ['A']);
    expect(() => after.runner.approveSpecialist('A')).toThrow('its reviewer "R" has not signed off on A\'s latest revision (revision 0; R covers no revision)');
    after.runner.cancel('user');
    await done;
  });
});

describe('a member card reads the same live and after a reload', () => {
  afterEach(() => vi.useRealTimers());

  const RUN_RESULT: Omit<AgentResult, 'agentId'> = {
    status: 'completed', finalResponse: null, toolCallCount: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
  };

  interface HeldRun {
    resolve: (result: AgentResult) => void;
    reject: (error: unknown) => void;
  }

  /** Replaces the agent runner with runs the test settles by hand, each bound to its note sink like a real run. */
  function holdRuns(h: Harness): Map<string, HeldRun> {
    const runs = new Map<string, HeldRun>();
    (h.runner as unknown as { agentRunner: { startAgent: (cfg: AgentRunConfig) => Promise<AgentResult> } }).agentRunner = {
      startAgent: (cfg) => new Promise<AgentResult>((resolve, reject) => {
        const release = cfg.bindNoteDelivery(() => true);
        runs.set(cfg.name, {
          resolve: (result) => { release(); resolve(result); },
          reject: (error) => { release(); reject(error); },
        });
      }),
    };
    return runs;
  }

  const microtasks = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  function lastStatusUpdate(h: Harness, agentId: string): ExtensionToWebviewMessage | undefined {
    return h.webview.filter((m) => m.type === 'teamAgentStatusUpdate' && m.agentId === agentId && m.stopwatch).at(-1);
  }

  it.each(['Lead', 'A'])('a run of %s that throws is failed with the same active time on both', async (name) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T = Date.parse('2026-10-01T15:00:00.000Z');
    vi.setSystemTime(T);
    const h = makeTeam({ cwd: newCwd('thrown-run'), teamId: crypto.randomUUID(), specialists: ['A'], behave: {} });
    const runs = holdRuns(h);
    const done = h.runner.run();
    h.runner.startSpecialist('A', 'Test label', 'task for A, described in full');

    vi.setSystemTime(T + 7_000);
    runs.get(name)!.reject(new Error('runner crashed'));
    await microtasks();
    // The team ends well after the throw, so a segment left open would close at team-completed instead.
    vi.setSystemTime(T + 60_000);
    if (name === 'A') runs.get('Lead')!.resolve({ ...RUN_RESULT, agentId: h.agent('Lead').agentId });
    else runs.get('A')!.resolve({ ...RUN_RESULT, agentId: h.agent('A').agentId, status: 'cancelled' });
    await done;

    const card = { status: 'failed', activeMs: 7_000, runningSince: null };
    const live = h.agent(name);
    expect(live).toMatchObject(card);
    const update = lastStatusUpdate(h, live.agentId);
    expect(update?.type === 'teamAgentStatusUpdate' && { status: update.status, ...update.stopwatch }).toEqual(card);
    const reloaded = (await persistenceOf(h).loadTeamState(h.teamId))!.agents.find((a) => a.name === name);
    expect(reloaded).toMatchObject(card);
    expect(logEntries(h).filter((e) => e['type'] === 'agent-completed' && e['name'] === name)).toHaveLength(1);
  });

  function lastResultUpdate(h: Harness, agentId: string): Extract<ExtensionToWebviewMessage, { type: 'teamAgentStatusUpdate' }> | undefined {
    return h.webview.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'teamAgentStatusUpdate' }> =>
      m.type === 'teamAgentStatusUpdate' && m.agentId === agentId && m.result !== undefined).at(-1);
  }

  it.each([
    ['completed', { status: 'completed', finalResponse: 'A found the bug' }],
    ['failed', { status: 'failed', error: '529 overloaded_error', finalResponse: '529 overloaded_error\n\nPartial output:\nhalf done' }],
    ['cancelled', { status: 'cancelled', finalResponse: null }],
  ] as const)('a %s member is sent, as it settles, the result its reload shows', async (_status, outcome) => {
    const h = makeTeam({ cwd: newCwd('settled-result'), teamId: crypto.randomUUID(), specialists: ['A'], behave: {} });
    const runs = holdRuns(h);
    const done = h.runner.run();
    h.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
    runs.get('A')!.resolve({ ...RUN_RESULT, ...outcome, agentId: h.agent('A').agentId });
    await microtasks();
    const settled = lastResultUpdate(h, h.agent('A').agentId);
    runs.get('Lead')!.resolve({ ...RUN_RESULT, finalResponse: 'the synthesis', agentId: h.agent('Lead').agentId });
    await done;

    const reloaded = (await persistenceOf(h).loadTeamState(h.teamId))!.agents;
    expect(settled?.result).toBe(outcome.finalResponse);
    expect(reloaded.find((a) => a.name === 'A')!.result).toBe(outcome.finalResponse);
    expect(lastResultUpdate(h, h.agent('Lead').agentId)?.result).toBe('the synthesis');
    expect(reloaded.find((a) => a.name === 'Lead')!.result).toBe('the synthesis');
  });

  it('a resumed team announces each member with the result its reload shows', async () => {
    const cwd = newCwd('resumed-result');
    const teamId = crypto.randomUUID();
    const h = makeTeam({ cwd, teamId, specialists: ['A'], behave: {} });
    const runs = holdRuns(h);
    const done = h.runner.run();
    h.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
    runs.get('A')!.resolve({ ...RUN_RESULT, finalResponse: 'A found the bug', agentId: h.agent('A').agentId });
    await microtasks();
    h.runner.cancel('user');
    runs.get('Lead')!.resolve({ ...RUN_RESULT, status: 'cancelled', agentId: h.agent('Lead').agentId });
    await done;
    const persistence = persistenceOf(h);
    expect((await persistence.loadTeamState(teamId))!.agents.find((a) => a.name === 'A')!.result).toBe('A found the bug');

    const after = makeTeam({ cwd, teamId, specialists: ['A'], behave: {} });
    const afterRuns = holdRuns(after);
    after.runner.restore(await persistence.readEventLog(teamId), (await checkpointOf(persistence, teamId))!, new Map());
    const resumed = after.runner.resume('tc-resume');
    await vi.waitFor(() => expect(after.webview.some((m) => m.type === 'teamStarted')).toBe(true));

    const started = after.webview.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'teamStarted' }> => m.type === 'teamStarted')!;
    expect(started.team.agents.find((a) => a.name === 'A')!.result).toBe('A found the bug');
    after.runner.cancel('user');
    await vi.waitFor(() => expect(afterRuns.has('Lead')).toBe(true));
    afterRuns.get('Lead')!.resolve({ ...RUN_RESULT, status: 'cancelled', agentId: after.agent('Lead').agentId });
    await resumed;
  });

  it('a live spawn and redispatch send the card label, as a resume and a reload show it', async () => {
    const h = makeTeam({ cwd: newCwd('live-label'), teamId: crypto.randomUUID(), specialists: ['A'], behave: {} });
    const runs = holdRuns(h);
    const done = h.runner.run();
    const runningLabels = (agentId: string): unknown[] =>
      h.webview.flatMap((m) => (m.type === 'teamAgentStatusUpdate' && m.agentId === agentId && m.status === 'running' ? [m.description] : []));

    h.runner.startSpecialist('A', 'Fix the parser', 'task for A, described in full');
    runs.get('A')!.resolve({ ...RUN_RESULT, status: 'failed', finalResponse: 'boom', agentId: h.agent('A').agentId });
    await status(h, 'A', 'failed');
    h.runner.redispatchSpecialist('A', 'Retry the parser', 'task for A again, described in full');

    expect(runningLabels(h.agent('A').agentId)).toEqual(['Fix the parser', 'Retry the parser']);
    expect(runningLabels(h.agent('Lead').agentId)[0]).toMatch(/^Lead: /);
    h.runner.cancel('user');
    runs.get('A')!.resolve({ ...RUN_RESULT, status: 'cancelled', agentId: h.agent('A').agentId });
    runs.get('Lead')!.resolve({ ...RUN_RESULT, status: 'cancelled', agentId: h.agent('Lead').agentId });
    await done;
  });

  // The cancelled run's result is narration an earlier build recorded; the relaunched run must not inherit it.
  it('a member a resume relaunches carries no result, live or on reload', async () => {
    const cwd = newCwd('resumed-no-result');
    const teamId = crypto.randomUUID();
    const h = makeTeam({ cwd, teamId, specialists: ['A'], behave: {} });
    const runs = holdRuns(h);
    const done = h.runner.run();
    h.runner.startSpecialist('A', 'Fix the parser', 'task for A, described in full');
    h.runner.cancel('user');
    runs.get('A')!.resolve({ ...RUN_RESULT, status: 'cancelled', finalResponse: 'Now the trust integration test.', agentId: h.agent('A').agentId });
    runs.get('Lead')!.resolve({ ...RUN_RESULT, status: 'cancelled', agentId: h.agent('Lead').agentId });
    await done;
    const persistence = persistenceOf(h);
    expect((await persistence.loadTeamState(teamId))!.agents.find((a) => a.name === 'A')!.result).toBe('Now the trust integration test.');

    const after = makeTeam({ cwd, teamId, specialists: ['A'], behave: {} });
    const afterRuns = holdRuns(after);
    after.runner.restore(await persistence.readEventLog(teamId), (await checkpointOf(persistence, teamId))!, new Map());
    const resumed = after.runner.resume('tc-resume');
    await vi.waitFor(() => expect(after.webview.some((m) => m.type === 'teamStarted')).toBe(true));

    const started = after.webview.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'teamStarted' }> => m.type === 'teamStarted')!;
    expect(started.team.agents.find((a) => a.name === 'A')).toMatchObject({ status: 'running', result: null, description: 'Fix the parser' });
    await vi.waitFor(async () => {
      const reloaded = (await persistence.loadTeamState(teamId))!.agents.find((a) => a.name === 'A');
      expect(reloaded).toMatchObject({ result: null, description: 'Fix the parser' });
    });
    after.runner.cancel('user');
    await vi.waitFor(() => expect(afterRuns.has('Lead')).toBe(true));
    afterRuns.get('A')!.resolve({ ...RUN_RESULT, status: 'cancelled', agentId: after.agent('A').agentId });
    afterRuns.get('Lead')!.resolve({ ...RUN_RESULT, status: 'cancelled', agentId: after.agent('Lead').agentId });
    await resumed;
  });

  it('a member the drain timeout forced terminal reloads with the status the finalize sent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = makeTeam({ cwd: newCwd('drain-forced'), teamId: crypto.randomUUID(), specialists: ['A'], behave: {} });
    const runs = holdRuns(h);
    const done = h.runner.run();
    h.runner.startSpecialist('A', 'Test label', 'task for A, described in full');
    vi.advanceTimersByTime(5_000);
    // A's run never settles, so only the drain timeout and the abort window end the team.
    runs.get('Lead')!.resolve({ ...RUN_RESULT, agentId: h.agent('Lead').agentId });
    await vi.advanceTimersByTimeAsync(33_000);
    await done;

    const live = h.agent('A');
    expect(live.status).toBe('completed');
    const update = lastStatusUpdate(h, live.agentId);
    expect(update?.type === 'teamAgentStatusUpdate' && update.status).toBe('completed');
    const reloaded = (await persistenceOf(h).loadTeamState(h.teamId))!.agents.find((a) => a.name === 'A');
    expect(reloaded).toMatchObject({ status: 'completed', activeMs: live.activeMs, runningSince: null });
  });
});
