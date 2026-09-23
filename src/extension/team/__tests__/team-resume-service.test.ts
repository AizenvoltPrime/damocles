import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';

// Point the Damocles home dir at a throwaway temp dir so every log, checkpoint and member file stays
// out of the real ~/.damocles tree.
vi.mock('../../paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return { DAMOCLES_HOME_DIR: mkdtempSync(joinPath(tmpdir(), 'damocles-team-service-')) };
});

import { DAMOCLES_HOME_DIR } from '../../paths';
import { TeamService, isValidTeamId, newTeamId, teamCancelledHeader } from '../index';
import { FakeSession } from './fake-session';
import { teamAgentToolset } from './team-mcp-fixture';
import type { TeamEngine } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { TeamState as WebviewTeamState } from '../../../shared/types/team';
import type { AgentInvocationData } from '../../pi-session/agent-records';
import { listTeamCheckpoints, teamCheckpointPath, teamCheckpointsDir, teamEventLogPath } from '../../pi-session/agent-records';
import { piSessionDir } from '../../pi-session/session-store';
import { initPiLoader } from '../../pi-session/pi-loader';
import { TeamPersistence } from '../persistence';
import { copyForkAgentData } from '../../pi-session/fork-agent-data';
import { DAMOCLES_AGENT_INVOCATION_ENTRY, DAMOCLES_AGENT_LAUNCH_ENTRY } from '../../pi-session/session-store/constants';
import { buildResumePrompt, formatTeamUserSteerPrefix } from '../../../shared/steer';

// The first pi import takes about a second, which under a loaded machine overruns a test's timeout.
beforeAll(async () => {
  await initPiLoader();
});

afterAll(() => fs.rmSync(DAMOCLES_HOME_DIR, { recursive: true, force: true }));

const SESSION = 'parent-session';
const LEAD_ONLY = { title: 'resumable team', brief: 'the brief', agents: [{ name: 'Lead', role: 'lead' as const }] };

type Behaviour = (text: string, session: FakeSession) => void;
const endTurn: Behaviour = (_t, s) => s.emit({ type: 'turn_end' });
const holdTurn: Behaviour = () => undefined;

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

interface Panel {
  service: TeamService;
  cwd: string;
  invocations: AgentInvocationData[];
  /** What `parentBranch` returns; defaults to the invocations this panel recorded. */
  branch: { override: AgentInvocationData[] | null };
  sessions: FakeSession[];
  stores: Array<Record<string, unknown>>;
  order: string[];
  /** Called synchronously at each recorded step, so a test can act inside the resume. */
  hook: ((step: string) => void) | null;
  webview: ExtensionToWebviewMessage[];
  resumableChecks: Array<[string, string]>;
  interruptionChecks: number;
  parentBranch: ReturnType<typeof vi.fn>;
  behave: { lead: Behaviour };
}

/**
 * A panel's TeamService with the real TeamRunner and AgentRunner. The engine hands out FakeSessions and,
 * for a new member file, writes a real pi session file the way pi does after a first response, so the
 * resume path finds and reopens it.
 */
function panel(cwd = path.join(DAMOCLES_HOME_DIR, crypto.randomUUID().slice(0, 8)), sessionId = SESSION): Panel {
  const p = {
    cwd, invocations: [], branch: { override: null }, sessions: [], stores: [], order: [], webview: [],
    resumableChecks: [], interruptionChecks: 0, behave: { lead: endTurn }, hook: null,
  } as unknown as Panel;
  const engine = {
    createSession: async (opts: { store: Record<string, unknown> }) => {
      const store = opts.store;
      p.stores.push(store);
      p.order.push('session');
      p.hook?.('session');
      const session = new FakeSession({ onPrompt: (t, s) => p.behave.lead(t, s) });
      if (store['kind'] === 'file') {
        const real = SessionManager.create(cwd, String(store['dir']), { id: String(store['id']) });
        session.sessionManager.appendCustomEntry = (customType: string, data: unknown) => {
          session.customEntries.push({ customType, data });
          const id = real.appendCustomEntry(customType, data);
          if (customType === DAMOCLES_AGENT_LAUNCH_ENTRY) {
            real.appendMessage({ role: 'user', content: [{ type: 'text', text: 'task' }], timestamp: Date.now() });
            real.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'on it' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude', usage, stopReason: 'stop', timestamp: Date.now() } as never);
          }
          return id;
        };
        session.sessionFile = real.getSessionFile();
      } else {
        session.sessionFile = String(store['path']);
      }
      p.sessions.push(session);
      return session as never;
    },
    forgetSession: () => undefined,
    buildAgentToolset: () => teamAgentToolset(),
    buildExtensionFactory: () => (() => undefined) as never,
    onAgentCost: () => undefined,
    disposeBrowserScope: () => undefined,
    cancelAgentDialogs: () => undefined,
  } as unknown as TeamEngine;
  p.parentBranch = vi.fn((): SessionEntry[] => (p.branch.override ?? p.invocations).map((data, i) => ({
    type: 'custom', id: `e${i}`, parentId: null, timestamp: new Date().toISOString(), customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data,
  }) as unknown as SessionEntry));
  p.service = new TeamService({
    cwd,
    onMessage: (m) => { p.webview.push(m); p.hook?.(`webview:${m.type}`); },
    getSessionId: () => sessionId,
    getPermissionMode: () => 'default',
    resolveRoleModel: () => ({ modelLabel: 'model', dollarBilled: false }),
    buildEngine: () => engine,
    recordInvocation: (data) => { p.order.push(`record:${data.resume ? 'resume' : 'create'}`); p.invocations.push(data); p.hook?.(`record:${data.resume ? 'resume' : 'create'}`); },
    parentBranch: p.parentBranch as unknown as () => readonly SessionEntry[],
    assertResumableModel: (file, agentId) => { p.resumableChecks.push([file, agentId]); p.hook?.('assert'); },
    requestInterruptionCheck: () => { p.interruptionChecks++; },
  });
  return p;
}

/** Start a lead-only team whose lead stays mid-turn, and resolve once it is working. */
async function runningTeam(p: Panel, toolCallId = 'tc-create'): Promise<{ teamId: string; result: Promise<string> }> {
  p.behave.lead = holdTurn;
  p.service.setPendingToolUseId(toolCallId);
  const before = p.sessions.length;
  const result = p.service.createTeam(LEAD_ONLY);
  await vi.waitFor(() => expect(p.sessions.length).toBe(before + 1));
  await p.sessions.at(-1)!.whenPrompted(1);
  return { teamId: p.invocations.at(-1)!.id, result };
}

/** The cancel times of the team's checkpoints, oldest first. */
const checkpointsOf = (p: Panel, teamId: string): Promise<number[]> => listTeamCheckpoints(teamCheckpointsDir(piSessionDir(p.cwd), SESSION, teamId));
const checkpointFile = (p: Panel, teamId: string, cancelledAt: number): string => teamCheckpointPath(piSessionDir(p.cwd), SESSION, teamId, cancelledAt);
const resumable = (p: Panel, teamId: string, sessionId = SESSION): Promise<boolean> => new TeamPersistence(p.cwd, sessionId).isResumable(teamId);

/** Copy `from`'s agent data into the fork session `to` the way a fork at `forkPointMs` does, over a branch holding `invocations`. */
async function forkAt(cwd: string, from: string, to: string, forkPointMs: number, invocations: AgentInvocationData[]): Promise<void> {
  const branch = invocations.map((data, i) => ({
    type: 'custom', id: `f${i}`, parentId: null, timestamp: new Date(forkPointMs).toISOString(), customType: DAMOCLES_AGENT_INVOCATION_ENTRY, data,
  }) as unknown as SessionEntry);
  expect(await copyForkAgentData({ SessionManager, sessionDir: piSessionDir(cwd), sourceSessionId: from, targetSessionId: to, branch, forkPointMs })).toEqual([]);
}

/** A fork point strictly between what was written so far and what is written next. */
async function forkPointNow(): Promise<number> {
  const at = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  return at;
}

function logEntries(p: Panel, teamId: string): Array<Record<string, unknown>> {
  return fs.readFileSync(teamEventLogPath(piSessionDir(p.cwd), SESSION, teamId), 'utf-8')
    .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A team the user cancelled: its log, member file and checkpoint are on disk. */
async function cancelledTeam(p: Panel): Promise<string> {
  const { teamId, result } = await runningTeam(p);
  p.service.cancelTeam(teamId);
  await result;
  return teamId;
}

describe('team ids', () => {
  it('the validator accepts exactly what the generator produces', () => {
    for (let i = 0; i < 50; i++) expect(isValidTeamId(newTeamId())).toBe(true);
  });

  it.each([
    '', '../x', '..\\x', 'team-1',
    '3F2B8C1E-9D4A-4E6B-8A1C-2B3D4E5F6A7B',
    '3f2b8c1e-9d4a-1e6b-8a1c-2b3d4e5f6a7b',
    '3f2b8c1e-9d4a-4e6b-7a1c-2b3d4e5f6a7b',
    '3f2b8c1e-9d4a-4e6b-8a1c-2b3d4e5f6a7b ',
    '3f2b8c1e9d4a4e6b8a1c2b3d4e5f6a7b',
  ])('rejects %j', (bad) => {
    expect(isValidTeamId(bad)).toBe(false);
  });
});

describe('a cancelled team result says whether the team can be resumed', () => {
  it('a cancelled create_team result and the cancel_team result name the team and resume_team', async () => {
    const p = panel();
    const { teamId, result } = await runningTeam(p);

    const cancelText = p.service.cancelTeam(teamId);
    const createText = await result;

    const header = teamCancelledHeader(teamId, true);
    expect(header).toBe(`(TEAM CANCELLED before completion; results are partial. Resume it with resume_team({team_id:"${teamId}"}) if the user asks to continue.)\n\n`);
    expect(cancelText).toBe(`${header}Team "${teamId}" cancelled.`);
    expect(createText.startsWith(header)).toBe(true);
    expect(createText).toContain('## Partial Team Results');
    expect(p.interruptionChecks).toBeGreaterThan(0);
  });

  it('cancel_team on a team that is not running throws', async () => {
    const p = panel();
    const id = newTeamId();
    expect(() => p.service.cancelTeam(id)).toThrow(`Team "${id}" is not running.`);
  });

  it('a completed create_team result carries no header', async () => {
    const p = panel();
    p.service.setPendingToolUseId('tc-create');
    const text = await p.service.createTeam(LEAD_ONLY);
    expect(text).not.toContain('TEAM CANCELLED');
  });

  it('puts the header before the operator steer prefix', async () => {
    const p = panel();
    const { teamId, result } = await runningTeam(p);
    const leadId = p.service.listSteerTargets()[0]!.id;
    expect(p.service.steerMember(leadId, 'go faster')?.status).toBe('steered');

    p.service.cancelTeam(teamId);

    expect(await result).toMatch(new RegExp(`^${escape(teamCancelledHeader(teamId, true))}${escape(formatTeamUserSteerPrefix([{ memberName: 'Lead', message: 'go faster' }]))}`));
  });

  it('a cancel whose checkpoint write failed does not offer resume_team', async () => {
    const p = panel();
    const { teamId, result } = await runningTeam(p);
    const write = vi.spyOn(TeamPersistence.prototype, 'writeCheckpoint').mockReturnValue(false);
    try {
      const cancelText = p.service.cancelTeam(teamId);
      const createText = await result;

      const header = teamCancelledHeader(teamId, false);
      expect(header).toBe('(TEAM CANCELLED before completion; results are partial. Its resume state was not saved, so it cannot be resumed.)\n\n');
      expect(cancelText).toBe(`${header}Team "${teamId}" cancelled.`);
      expect(createText.startsWith(header)).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  it('a reset, which writes no checkpoint, does not offer resume_team', async () => {
    const p = panel();
    const { teamId, result } = await runningTeam(p);

    p.service.cancelActiveTeam('reset');

    expect((await result).startsWith(teamCancelledHeader(teamId, false))).toBe(true);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('TeamService.resumeTeam', () => {
  it('reopens the lead, marks the checkpoint used before launching, and returns the synthesis', async () => {
    const p = panel();
    const teamId = await cancelledTeam(p);
    const [cancelledAt] = await checkpointsOf(p, teamId);
    expect(cancelledAt).toEqual(expect.any(Number));
    const firstFile = p.sessions[0]!.sessionFile!;
    let usedAtLaunch: boolean | null = null;
    p.behave.lead = (text, s) => {
      usedAtLaunch ??= logEntries(p, teamId).some((e) => e['type'] === 'team-resumed' && e['checkpoint'] === cancelledAt);
      endTurn(text, s);
    };
    p.order.length = 0;

    const text = await p.service.resumeTeam(teamId, 'carry on', 'tc-resume');

    expect(usedAtLaunch).toBe(true);
    expect(await checkpointsOf(p, teamId)).toEqual([cancelledAt]);
    expect(await resumable(p, teamId)).toBe(false);
    expect(p.stores.at(-1)).toEqual({ kind: 'reopen', path: firstFile, agentId: expect.any(String) });
    expect(p.resumableChecks).toEqual([[firstFile, (p.stores.at(-1) as { agentId: string }).agentId]]);
    expect(p.sessions.at(-1)!.prompts[0]).toBe(buildResumePrompt('carry on'));
    expect(p.invocations.at(-1)).toEqual({ kind: 'team', id: teamId, toolCallId: 'tc-resume', resume: true });
    expect(p.order.indexOf('record:resume')).toBeLessThan(p.order.indexOf('session'));
    expect(text).not.toContain('TEAM CANCELLED');
    const started = p.webview.filter((m) => m.type === 'teamStarted');
    expect(started.at(-1)).toMatchObject({ team: { teamId, status: 'running' } });
  });

  it('a resumed team cancelled again leaves a second checkpoint, which the next resume continues from', async () => {
    const p = panel();
    const teamId = await cancelledTeam(p);
    p.behave.lead = holdTurn;

    const second = p.service.resumeTeam(teamId, undefined, 'tc-resume-1');
    await vi.waitFor(() => expect(p.sessions).toHaveLength(2));
    await p.sessions[1]!.whenPrompted(1);
    p.service.cancelTeam(teamId);

    expect((await second).startsWith(teamCancelledHeader(teamId, true))).toBe(true);
    const times = await checkpointsOf(p, teamId);
    expect(times).toHaveLength(2);
    p.behave.lead = endTurn;
    await expect(p.service.resumeTeam(teamId, undefined, 'tc-resume-2')).resolves.not.toContain('TEAM CANCELLED');
    expect(logEntries(p, teamId).filter((e) => e['type'] === 'team-resumed').map((e) => e['checkpoint'])).toEqual(times);
  });

  it('after a reload (dispose) the team resumes in a new panel', async () => {
    const before = panel();
    const { teamId, result } = await runningTeam(before);

    before.service.dispose();

    expect((await result).startsWith(teamCancelledHeader(teamId, true))).toBe(true);
    expect(await resumable(before, teamId)).toBe(true);
    const after = panel(before.cwd);
    after.branch.override = before.invocations;
    await expect(after.service.resumeTeam(teamId, undefined, 'tc-resume')).resolves.toEqual(expect.any(String));
    expect(after.sessions[0]!.prompts[0]).toBe(buildResumePrompt());
  });

  it('after a reload, a new panel is refused a resume while the old run still drains, and resumes once it settles', async () => {
    const before = panel();
    const { teamId, result } = await runningTeam(before);
    const lead = before.sessions.at(-1)!;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const abort = lead.abort.bind(lead);
    lead.abort = async () => {
      await released;
      await abort();
    };

    before.service.dispose();
    const after = panel(before.cwd);
    after.branch.override = before.invocations;
    after.behave.lead = endTurn;

    await expect(after.service.resumeTeam(teamId, undefined, 'tc-early')).rejects.toThrow(
      `Team "${teamId}" is still running in another panel or shutting down; try again shortly.`,
    );
    expect(after.sessions).toEqual([]);

    release();
    expect((await result).startsWith(teamCancelledHeader(teamId, true))).toBe(true);
    await expect(after.service.resumeTeam(teamId, undefined, 'tc-later')).resolves.not.toContain('TEAM CANCELLED');
  });
});

describe('the card of a team', () => {
  it('comes from the runner while the team runs here, since its event log has no end yet', async () => {
    const p = panel();
    const { teamId, result } = await runningTeam(p);

    expect(p.service.liveTeamState(teamId)).toMatchObject({ teamId, status: 'running' });
    expect(await new TeamPersistence(p.cwd, SESSION).loadTeamState(teamId)).toMatchObject({ status: 'cancelled' });

    p.service.cancelTeam(teamId);
    await result;
    expect(p.service.liveTeamState(teamId)).toBeNull();
  });
});

describe('the runs of a team', () => {
  /** One lead turn that calls `tools` tools and spends `tokens` and `cost`, then ends or holds the turn. */
  const work = (tools: number, tokens: number, cost: number, end: boolean): Behaviour => (_t, s) => {
    s.cost += cost;
    const content = Array.from({ length: tools }, (_, i) => ({ type: 'toolCall', id: `tool-${i}`, name: 'read', arguments: {} }));
    s.emit({ type: 'message_end', message: { role: 'assistant', content, usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    if (end) s.emit({ type: 'turn_end' });
  };

  /** Wrapped, since an async function returning the run's promise would wait for the run to end. */
  async function held(p: Panel, start: () => Promise<string>): Promise<{ result: Promise<string> }> {
    const before = p.sessions.length;
    const result = start();
    await vi.waitFor(() => expect(p.sessions).toHaveLength(before + 1));
    await p.sessions.at(-1)!.whenPrompted(1);
    return { result };
  }

  it('are the same from the live runner and from the event log, through cancels, a reload that cut a run short, and a completion', async () => {
    const p = panel();
    p.behave.lead = work(3, 100, 0.25, false);
    p.service.setPendingToolUseId('tc-create');
    const created = await held(p, () => p.service.createTeam(LEAD_ONLY));
    const teamId = p.invocations[0]!.id;
    p.service.cancelTeam(teamId);
    await created.result;

    p.behave.lead = work(2, 50, 0.5, false);
    const cut = await held(p, () => p.service.resumeTeam(teamId, undefined, 'tc-cut'));
    const atReload = p.service.liveTeamState(teamId)!.runs.at(-1)!;
    // A reload keeps only what the cancel wrote synchronously; the drain after it never reaches the log.
    const logPath = teamEventLogPath(piSessionDir(p.cwd), SESSION, teamId);
    p.service.dispose();
    const leftByReload = fs.readFileSync(logPath, 'utf-8');
    await cut.result;
    fs.writeFileSync(logPath, leftByReload);

    const q = panel(p.cwd);
    q.branch.override = p.invocations;
    q.behave.lead = work(1, 10, 0.125, false);
    const third = await held(q, () => q.service.resumeTeam(teamId, undefined, 'tc-resume'));
    q.service.cancelTeam(teamId);
    await third.result;

    q.behave.lead = work(4, 20, 0.0625, true);
    let liveAtEnd: WebviewTeamState | null = null;
    q.hook = (step) => { if (step === 'webview:teamCompleted') liveAtEnd = q.service.liveTeamState(teamId); };
    await q.service.resumeTeam(teamId, undefined, 'tc-last');

    const loaded = (await new TeamPersistence(p.cwd, SESSION).loadTeamState(teamId))!;
    expect(loaded.runs.map((r) => [r.toolUseId, r.status, r.toolCount, r.tokens, r.costUsd])).toEqual([
      ['tc-create', 'cancelled', 3, 100, 0.25],
      ['tc-cut', 'cancelled', 2, 50, 0.5],
      ['tc-resume', 'cancelled', 1, 10, 0.125],
      ['tc-last', 'completed', 4, 20, 0.0625],
    ]);
    expect(liveAtEnd!.runs).toEqual(loaded.runs);
    expect(loaded.runs[1]).toEqual({ ...atReload, status: 'cancelled', endTime: expect.any(Number) });
    const ended = [...p.webview, ...q.webview].flatMap((m) => (m.type === 'teamCompleted' && m.run.toolUseId !== 'tc-cut' ? [m.run] : []));
    expect(ended).toEqual(loaded.runs.filter((r) => r.toolUseId !== 'tc-cut'));
    for (const r of loaded.runs) expect(r.endTime).toBeGreaterThanOrEqual(r.startTime);
  });
});

describe('a fork of a session with a team', () => {
  const FORK = 'fork-session';
  const FORK_OF_FORK = 'fork-of-fork-session';

  it('taken between a cancel and its resume can resume the team, and so can its own fork, whatever the parent does later', async () => {
    const parent = panel();
    const teamId = await cancelledTeam(parent);
    const created = [...parent.invocations];
    const forkPoint = await forkPointNow();
    parent.behave.lead = endTurn;
    await expect(parent.service.resumeTeam(teamId, undefined, 'tc-parent-resume')).resolves.not.toContain('TEAM CANCELLED');

    await forkAt(parent.cwd, SESSION, FORK, forkPoint, created);
    await forkAt(parent.cwd, FORK, FORK_OF_FORK, await forkPointNow(), created);

    const fork = panel(parent.cwd, FORK);
    fork.branch.override = created;
    fork.behave.lead = endTurn;
    expect(await resumable(fork, teamId, FORK)).toBe(true);
    await expect(fork.service.resumeTeam(teamId, 'fork direction', 'tc-fork-resume')).resolves.not.toContain('TEAM CANCELLED');
    expect(fork.sessions[0]!.prompts[0]).toBe(buildResumePrompt('fork direction'));

    const grandchild = panel(parent.cwd, FORK_OF_FORK);
    grandchild.branch.override = created;
    grandchild.behave.lead = endTurn;
    expect(await resumable(grandchild, teamId, FORK_OF_FORK)).toBe(true);
    await expect(grandchild.service.resumeTeam(teamId, undefined, 'tc-grandchild-resume')).resolves.not.toContain('TEAM CANCELLED');

    await expect(parent.service.resumeTeam(teamId, undefined, 'tc-parent-again')).rejects.toThrow(`Team "${teamId}" completed and cannot be resumed.`);
  });

  it('taken while the team still ran has no checkpoint: its card shows it cancelled and resume_team says it cannot be resumed', async () => {
    const parent = panel();
    const { teamId, result } = await runningTeam(parent);
    const created = [...parent.invocations];
    const forkPoint = await forkPointNow();
    parent.service.cancelTeam(teamId);
    await result;

    await forkAt(parent.cwd, SESSION, FORK, forkPoint, created);

    const fork = panel(parent.cwd, FORK);
    fork.branch.override = created;
    expect(await resumable(fork, teamId, FORK)).toBe(false);
    expect(await new TeamPersistence(fork.cwd, FORK).loadTeamState(teamId)).toMatchObject({ status: 'cancelled' });
    await expect(fork.service.resumeTeam(teamId, undefined, 'tc-r')).rejects.toThrow(
      `Team "${teamId}" did not end in a user cancel (or its resume state is missing) and cannot be resumed; start a new team.`,
    );
    expect(await resumable(parent, teamId)).toBe(true);
  });
});

describe('TeamService.resumeTeam refuses a team it cannot continue, with a message naming why', () => {
  it.each(['../x', 'TEAM', '3F2B8C1E-9D4A-4E6B-8A1C-2B3D4E5F6A7B', ''])('a malformed id %j is rejected before any branch read', async (bad) => {
    const p = panel();
    await expect(p.service.resumeTeam(bad, undefined, 'tc-r')).rejects.toThrow(`"${bad}" is not a valid team id.`);
    expect(p.parentBranch).not.toHaveBeenCalled();
    expect(p.sessions).toEqual([]);
  });

  it('an id this branch never invoked is unknown', async () => {
    const p = panel();
    const id = newTeamId();
    await expect(p.service.resumeTeam(id, undefined, 'tc-r')).rejects.toThrow(`No team "${id}" in this conversation.`);
  });

  it('a team invoked only on another branch is unknown, although its files exist', async () => {
    const p = panel();
    const teamId = await cancelledTeam(p);
    p.behave.lead = endTurn;
    p.branch.override = [];

    await expect(p.service.resumeTeam(teamId, undefined, 'tc-r')).rejects.toThrow(`No team "${teamId}" in this conversation.`);
    expect(await resumable(p, teamId)).toBe(true);
  });

  it('a running team is still running', async () => {
    const p = panel();
    const { teamId, result } = await runningTeam(p);

    await expect(p.service.resumeTeam(teamId, undefined, 'tc-r')).rejects.toThrow(`Team "${teamId}" is still running.`);

    p.service.cancelTeam(teamId);
    await result;
  });

  it('another running team blocks the resume', async () => {
    const p = panel();
    const first = await cancelledTeam(p);
    const { teamId: other, result } = await runningTeam(p, 'tc-create-2');

    await expect(p.service.resumeTeam(first, undefined, 'tc-r')).rejects.toThrow(
      `Another team is running in this panel; wait for it or cancel it before resuming "${first}".`,
    );

    p.service.cancelTeam(other);
    await result;
  });

  it('a completed team cannot be resumed', async () => {
    const p = panel();
    p.service.setPendingToolUseId('tc-create');
    await p.service.createTeam(LEAD_ONLY);
    const teamId = p.invocations[0]!.id;

    await expect(p.service.resumeTeam(teamId, undefined, 'tc-r')).rejects.toThrow(`Team "${teamId}" completed and cannot be resumed.`);
  });

  it.each([
    ['missing', (file: string) => fs.rmSync(file)],
    ['malformed', (file: string) => fs.writeFileSync(file, '{"version":1')],
  ])('a cancelled team whose checkpoint is %s cannot be resumed, and the claim is released', async (_label, breakCheckpoint) => {
    const p = panel();
    const teamId = await cancelledTeam(p);
    breakCheckpoint(checkpointFile(p, teamId, (await checkpointsOf(p, teamId)).at(-1)!));

    await expect(p.service.resumeTeam(teamId, undefined, 'tc-r')).rejects.toThrow(
      `Team "${teamId}" did not end in a user cancel (or its resume state is missing) and cannot be resumed; start a new team.`,
    );
    expect(p.invocations.filter((i) => i.resume)).toEqual([]);
    p.behave.lead = endTurn;
    p.service.setPendingToolUseId('tc-next');
    await expect(p.service.createTeam(LEAD_ONLY)).resolves.toEqual(expect.any(String));
  });

  it('a team whose event log is gone cannot be resumed, with the resume-state-missing text', async () => {
    const p = panel();
    const teamId = await cancelledTeam(p);
    p.behave.lead = endTurn;
    fs.rmSync(teamEventLogPath(piSessionDir(p.cwd), SESSION, teamId));

    await expect(p.service.resumeTeam(teamId, undefined, 'tc-r')).rejects.toThrow(
      `Team "${teamId}" did not end in a user cancel (or its resume state is missing) and cannot be resumed; start a new team.`,
    );
  });

  it('a team stopped by a conversation reset leaves no checkpoint and cannot be resumed', async () => {
    const p = panel();
    const { teamId, result } = await runningTeam(p);

    p.service.cancelActiveTeam('reset');
    await result;

    expect(await checkpointsOf(p, teamId)).toEqual([]);
    p.behave.lead = endTurn;
    await expect(p.service.resumeTeam(teamId, undefined, 'tc-r')).rejects.toThrow(
      `Team "${teamId}" did not end in a user cancel (or its resume state is missing) and cannot be resumed; start a new team.`,
    );
  });

  it('of two parallel resumes of one team only the first starts; the second is told it is running', async () => {
    const p = panel();
    const teamId = await cancelledTeam(p);
    p.behave.lead = endTurn;
    const sessionsBefore = p.sessions.length;

    const first = p.service.resumeTeam(teamId, undefined, 'tc-r1');
    const second = p.service.resumeTeam(teamId, undefined, 'tc-r2');

    await expect(second).rejects.toThrow(`Team "${teamId}" is still running.`);
    await first;
    expect(p.sessions.length - sessionsBefore).toBe(1);
    expect(p.invocations.filter((i) => i.resume)).toEqual([{ kind: 'team', id: teamId, toolCallId: 'tc-r1', resume: true }]);
  });

  it.each([
    ['ESC', (p: Panel) => p.service.cancelActiveTeam()],
    ['a reload', (p: Panel) => p.service.dispose()],
  ])('%s while the resume validates stops it before any member launches, keeping it resumable', async (_label, stop) => {
    const p = panel();
    const teamId = await cancelledTeam(p);
    // A resume that wrongly launches then completes, so the assertion fails rather than the test timing out.
    p.behave.lead = endTurn;
    const sessionsBefore = p.sessions.length;

    const resuming = p.service.resumeTeam(teamId, undefined, 'tc-r');
    stop(p);

    await expect(resuming).rejects.toThrow(`The resume of team "${teamId}" was stopped before it started; it can still be resumed.`);
    expect(p.sessions).toHaveLength(sessionsBefore);
    expect(await resumable(p, teamId)).toBe(true);
    expect(p.invocations.filter((i) => i.resume)).toEqual([]);
  });

  it.each([
    ['as the resumed team is announced', 'webview:teamStarted'],
    ['as the first member session opens', 'session'],
  ])('ESC %s settles the resume and leaves a checkpoint', async (_label, step) => {
    const p = panel();
    const teamId = await cancelledTeam(p);
    p.behave.lead = holdTurn;
    let stopped = false;
    p.hook = (at) => {
      if (stopped || at !== step || !p.invocations.some((i) => i.resume)) return;
      stopped = true;
      p.service.cancelActiveTeam();
    };

    const text = await p.service.resumeTeam(teamId, undefined, 'tc-r');

    expect(stopped).toBe(true);
    expect(text.startsWith(teamCancelledHeader(teamId, true))).toBe(true);
    expect(await resumable(p, teamId)).toBe(true);
    p.hook = null;
    p.behave.lead = endTurn;
    await expect(p.service.resumeTeam(teamId, undefined, 'tc-r2')).resolves.toEqual(expect.any(String));
  });

  it('ESC in the first microtask after validation passes still cancels the resumed team', async () => {
    const p = panel();
    const teamId = await cancelledTeam(p);
    // Ends at once if the ESC is lost, so a lost cancel fails the header assertion instead of timing out.
    p.behave.lead = endTurn;
    // The last synchronous step before the launch; any await between it and the launch lets this ESC slip past.
    p.hook = (at) => {
      if (at !== 'assert') return;
      p.hook = null;
      queueMicrotask(() => p.service.cancelActiveTeam());
    };

    const text = await p.service.resumeTeam(teamId, undefined, 'tc-r');

    expect(text.startsWith(teamCancelledHeader(teamId, true))).toBe(true);
    expect(await resumable(p, teamId)).toBe(true);
  });

  it('a new team cannot start while a resume is validating', async () => {
    const p = panel();
    const teamId = await cancelledTeam(p);
    p.behave.lead = endTurn;

    const resuming = p.service.resumeTeam(teamId, undefined, 'tc-r1');
    await expect(p.service.createTeam(LEAD_ONLY)).rejects.toThrow('A team is already running in this panel');
    await resuming;
  });
});
