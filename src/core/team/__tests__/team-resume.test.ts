import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
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

import { DAMOCLES_HOME_DIR } from '../../paths';
import { TeamRunner } from '../team-runner';
import { TeamPersistence } from '../persistence';
import { Scratchpad } from '../scratchpad';
import { MessageBus } from '../message-bus';
import { FakeSession, type FakeOpeningTotals } from './fake-session';
import { teamAgentToolset } from './team-mcp-fixture';
import type { AgentMcpContext, TeamAgent, TeamCheckpoint, TeamConfig, TeamRole } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ImageBlock } from '../../../shared/types/content';
import { buildResumePrompt, wrapSteerMessage } from '../../../shared/steer';
import { piSessionDir } from '../../pi-session/session-store';
import { initPiLoader } from '../../pi-session/pi-loader';
import { listTeamCheckpoints, teamCheckpointsDir, teamEventLogPath, teamMembersDir } from '../../pi-session/agent-records';
import { DAMOCLES_AGENT_LAUNCH_ENTRY, DAMOCLES_AGENT_SEGMENT_ENTRY } from '../../pi-session/session-store/constants';

// The first pi import takes about a second, which under a loaded machine overruns a test's timeout.
beforeAll(async () => {
  await initPiLoader();
});

afterAll(() => fs.rmSync(DAMOCLES_HOME_DIR, { recursive: true, force: true }));

const SESSION = 'sess';

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
  webview: ExtensionToWebviewMessage[];
  costs: number[];
  agent: (name: string) => TeamAgent;
  session: (name: string) => FakeSession;
  scratchpad: () => Scratchpad;
  bus: () => MessageBus;
}

const endTurn: Behaviour = (_t, s) => s.emit({ type: 'turn_end' });
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
}): Harness {
  const opened: Opened[] = [];
  const forgotten: FakeSession[] = [];
  const scopes = new Map<string, string[]>();
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
        const session = new FakeSession({ onPrompt: (text, s) => behaviour(text, s, h) });
        session.sessionFile = store['kind'] === 'reopen' ? String(store['path']) : path.join(String(store['dir']), `${String(store['id'])}.jsonl`);
        const opening = opts.opening?.[name];
        if (opening) session.seedOpening(opening);
        opened.push({ name, store, session });
        return session as never;
      },
      forgetSession: (s: FakeSession) => { forgotten.push(s); },
      buildAgentToolset: (ctx: AgentMcpContext) => {
        scopes.set(ctx.agentName, [...(scopes.get(ctx.agentName) ?? []), ctx.browserScopeId]);
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
    runner, teamId: opts.teamId, cwd: opts.cwd, opened, forgotten, scopes, webview, costs,
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
async function interruptedTeam(cwd: string, teamId: string): Promise<{ h: Harness; files: Map<string, string>; run: Promise<{ status: string; text: string }> }> {
  const h = makeTeam({
    cwd, teamId,
    specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    behave: {
      Lead: (_t, s, hh) => {
        if (s.prompts.length === 1) {
          hh.runner.startSpecialist('A', 'task for A, described in full');
          hh.runner.startSpecialist('B', 'task for B, described in full');
          hh.runner.startSpecialist('C', 'task for C, described in full');
        }
        s.emit({ type: 'turn_end' });
      },
      A: (_t, s, hh) => {
        hh.scratchpad().set('a-notes', 'A findings', 'A');
        hh.runner.reportComplete('A', 'A signed off');
        s.emit({ type: 'turn_end' });
      },
      B: holdTurn,
      C: (_t, s, hh) => {
        hh.runner.enterStandby('C');
        s.emit({ type: 'turn_end' });
      },
      E: (_t, s, hh) => {
        hh.runner.reportComplete('E', 'E signed off');
        s.emit({ type: 'turn_end' });
      },
      F: holdTurn,
      G: (_t, s) => s.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'G found half the answer' }] } }),
    },
  });

  const run = h.runner.run();
  await status(h, 'A', 'awaiting-review');
  await status(h, 'C', 'standby');
  await opened(h, 'B');

  h.runner.startSpecialist('E', 'task for E, described in full');
  await status(h, 'E', 'awaiting-review');
  h.runner.approveSpecialist('E');
  await status(h, 'E', 'completed');

  h.runner.startSpecialist('F', 'task for F, described in full');
  h.runner.startSpecialist('G', 'task for G, described in full');
  await opened(h, 'F');
  await opened(h, 'G');
  h.runner.cancelSpecialist('G');
  await status(h, 'G', 'cancelled');
  h.runner.cancelSpecialist('H');
  expect(h.agent('H').status).toBe('cancelled');

  // The lead reads A's section before the cancel; the restored cursor must still say so.
  h.scratchpad().markRead('Lead', 'a-notes');
  // B is mid-turn and not streaming, so the runner holds this one locally.
  h.bus().send('Lead', 'B', 'for B before cancel');
  h.session('B').holdSteeredMessage('steer held for B');
  h.session('C').holdFollowUpMessage('[Message from Lead]: follow-up held for C');
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

    h.runner.cancel();
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

    h.runner.cancel();
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

  it('keeps one checkpoint per run, rewritten only after the drain, and none after the team completed', async () => {
    const write = vi.spyOn(TeamPersistence.prototype, 'writeCheckpoint');
    try {
      const { h, run } = await interruptedTeam(newCwd('cancel-once'), crypto.randomUUID());
      h.runner.cancel();
      h.runner.cancel();
      expect(write).toHaveBeenCalledTimes(1);
      await run;
      expect(write).toHaveBeenCalledTimes(2);
      expect(await checkpointTimes(h)).toEqual([write.mock.calls[0]![0].cancelledAt]);

      write.mockClear();
      const done = makeTeam({ cwd: newCwd('cancel-after-complete'), teamId: crypto.randomUUID(), specialists: [], behave: {} });
      const result = await done.runner.run();
      done.runner.cancel();
      expect(result.status).toBe('completed');
      expect(write).not.toHaveBeenCalled();
      expect(await checkpointTimes(done)).toEqual([]);
    } finally {
      write.mockRestore();
    }
  });

  it('round-trips: a restored team cancelled before it resumes writes the checkpoint it read', async () => {
    const { h, run } = await interruptedTeam(newCwd('round-trip'), crypto.randomUUID());
    h.runner.cancel();
    await run;
    const persistence = persistenceOf(h);
    const written = (await checkpointOf(persistence, h.teamId))!;

    const restored = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], behave: {} });
    restored.runner.restore(await persistence.readEventLog(h.teamId), written, new Map());
    restored.runner.cancel();

    const rewritten = (await checkpointOf(persistence, h.teamId))!;
    expect(rewritten.cancelledAt).toBeGreaterThan(written.cancelledAt);
    expect({ ...rewritten, cancelledAt: written.cancelledAt }).toEqual(written);
  });

  it('restores a steer from a checkpoint that recorded no attempt as the member attempt in that checkpoint', async () => {
    const { h, run } = await interruptedTeam(newCwd('steer-no-attempt'), crypto.randomUUID());
    h.runner.cancel();
    await run;
    const persistence = persistenceOf(h);
    const written = (await checkpointOf(persistence, h.teamId))!;
    expect(persistence.writeCheckpoint({
      ...written,
      cancelledAt: written.cancelledAt + 1,
      members: written.members.map((m) => (m.name === 'B' ? { ...m, attempt: 2 } : m)),
      operatorSteers: written.operatorSteers.map((s) => ({ memberName: s.memberName, message: s.message })),
    })).toBe(true);
    const older = (await checkpointOf(persistence, h.teamId))!;
    expect(older.operatorSteers).toEqual([{ memberName: 'B', message: 'focus on the parser' }]);

    const restored = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], behave: {} });
    restored.runner.restore(await persistence.readEventLog(h.teamId), older, new Map());

    expect(restored.runner.getOperatorSteers()).toEqual([{ memberName: 'B', message: 'focus on the parser', attempt: 2 }]);
  });
});

describe('TeamRunner checkpoint and restore edge cases', () => {
  it('records a specialist the lead cancelled as cancelled, even when the cancel lands before its run settles', async () => {
    const { h, run } = await interruptedTeam(newCwd('cancel-pending'), crypto.randomUUID());

    h.runner.cancelSpecialist('B');
    h.runner.cancel();
    await run;

    const members = new Map((await checkpointOf(persistenceOf(h), h.teamId))!.members.map((m) => [m.name, m.status]));
    expect(members.get('B')).toBe('cancelled');
    expect(members.get('F')).toBe('running');
  });

  it('keeps a finished member result from the event log, so a later partial synthesis still shows it', async () => {
    const { h, files, run } = await interruptedTeam(newCwd('last-result'), crypto.randomUUID());
    h.runner.cancel();
    await run;
    const persistence = persistenceOf(h);

    const after = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], behave: { Lead: holdTurn, B: holdTurn, F: holdTurn } });
    after.runner.restore(await persistence.readEventLog(h.teamId), (await checkpointOf(persistence, h.teamId))!, files);
    const done = after.runner.resume('tc-resume');
    await (await opened(after, 'Lead')).whenPrompted(1);
    after.runner.cancel();

    expect((await done).text).toContain('### G (specialist, cancelled)\nG found half the answer');
  });

  it.each([
    ['a member missing', (c: TeamCheckpoint): TeamCheckpoint => ({ ...c, members: c.members.filter((m) => m.name !== 'D') })],
    ['a renamed member', (c: TeamCheckpoint): TeamCheckpoint => ({ ...c, members: c.members.map((m) => (m.name === 'D' ? { ...m, name: 'Z' } : m)) })],
    ['no lead', (c: TeamCheckpoint): TeamCheckpoint => ({ ...c, members: c.members.map((m) => ({ ...m, role: 'specialist' as const })) })],
    ['two leads', (c: TeamCheckpoint): TeamCheckpoint => ({ ...c, members: c.members.map((m) => (m.name === 'D' ? { ...m, role: 'lead' as const } : m)) })],
  ])('refuses a checkpoint with %s', async (_label, corrupt) => {
    const { h, files, run } = await interruptedTeam(newCwd('roster'), crypto.randomUUID());
    h.runner.cancel();
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
    h.runner.cancel();
    await run;
    const persistence = persistenceOf(h);
    const written = (await checkpointOf(persistence, h.teamId))!;
    const checkpoint = { ...written, members: written.members.map((m) => (m.name === 'H' ? { ...m, status: 'running' as const } : m)) };

    const after = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], behave: {} });

    await expect((async () => after.runner.restore(await persistence.readEventLog(h.teamId), checkpoint, files))()).rejects.toThrow(
      `Team "${h.teamId}" has no launch of "H" in its event log.`,
    );
  });

  it("a reset's cancel writes no checkpoint, so the old conversation does not offer a resume", async () => {
    const { h, run } = await interruptedTeam(newCwd('reset'), crypto.randomUUID());

    h.runner.cancel('reset');
    await run;

    expect(await checkpointTimes(h)).toEqual([]);
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
          if (s.prompts.length === 1) hh.runner.startSpecialist('A', 'task for A, described in full');
          s.emit({ type: 'turn_end' });
        },
      },
    });
    const run = h.runner.run();
    await status(h, 'A', 'running');
    expect(h.opened.some((o) => o.name === 'A')).toBe(false);

    expect(h.runner.steerMember(h.agent('A').agentId, 'use the v2 schema')).toBe('steered');
    h.runner.cancel();
    open();
    await run;

    const checkpoint = (await checkpointOf(persistenceOf(h), h.teamId))!;
    expect(checkpoint.members.find((m) => m.name === 'A')!.undelivered).toEqual([{ text: wrapSteerMessage('use the v2 schema'), echoed: true }]);
    expect(checkpoint.operatorSteers).toEqual([{ memberName: 'A', message: 'use the v2 schema', attempt: 0 }]);
  });
});

describe('TeamRunner restore rebuilds the scratchpad and bus from the event log', () => {
  it('equal the live state, with section kinds, owners, cursors and message kinds intact', async () => {
    const { h, run } = await interruptedTeam(newCwd('replay'), crypto.randomUUID());
    h.runner.cancel();
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
    h.runner.cancel();
    await run;
    const persistence = persistenceOf(h);
    const before = logEntries(h).length;

    const restored = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], behave: {} });
    restored.runner.restore(await persistence.readEventLog(h.teamId), (await checkpointOf(persistence, h.teamId))!, new Map());

    expect(logEntries(h)).toHaveLength(before);
    expect(restored.webview.filter((m) => m.type === 'teamMessage' || m.type === 'teamScratchpadUpdate')).toEqual([]);
  });
});

/** A's opening turn is mid-tool when cancelled: still streaming, with every steer left in pi's queue. */
function midToolTeam(label: string): Harness {
  return makeTeam({
    cwd: newCwd(label), teamId: crypto.randomUUID(), specialists: ['A'],
    behave: {
      Lead: (_t, s, hh) => {
        if (s.prompts.length === 1) hh.runner.startSpecialist('A', 'task for A, described in full');
        s.emit({ type: 'turn_end' });
      },
      A: (_t, s) => {
        if (s.prompts.length === 1) {
          s.startStreaming();
          s.holdSteers = true;
          s.drainOnAbort = true;
        }
      },
    },
  });
}

describe('TeamRunner image steer still queued in pi at the cancel', () => {
  it('keeps its images through the checkpoint and prompts the resumed member with them, once', async () => {
    const image: ImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
    const h = midToolTeam('image-steer');
    const run = h.runner.run();
    const a = await opened(h, 'A');
    await a.whenPrompted(1);

    const steer = wrapSteerMessage('use this layout');
    expect(h.runner.steerMember(h.agent('A').agentId, 'use this layout', [image])).toBe('steered');
    await a.whenPrompted(2);
    expect(a.getSteeringMessages()).toEqual([steer]);
    const files = new Map(['Lead', 'A'].map((n) => [h.agent(n).agentId, h.session(n).sessionFile!]));
    h.runner.cancel();
    await run;
    // The checkpoint took the steer, so the aborted run had nothing left to deliver.
    expect(a.drainedOnAbort).toEqual([]);

    const persistence = persistenceOf(h);
    const log = await persistence.readEventLog(h.teamId);
    const checkpoint = (await checkpointOf(persistence, h.teamId))!;
    expect(checkpoint.members.find((m) => m.name === 'A')!.undelivered).toEqual([{ text: steer, echoed: true, images: [image] }]);
    expect(checkpoint.operatorSteers).toEqual([{ memberName: 'A', message: 'use this layout', imageCount: 1, attempt: 0 }]);

    const after = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A'], behave: { Lead: holdTurn } });
    after.runner.restore(log, checkpoint, files);
    const done = after.runner.resume('tc-resume');
    const resumedA = await opened(after, 'A');
    await resumedA.whenPrompted(2);

    expect(resumedA.prompts[1]).toBe(steer);
    expect(resumedA.promptOptions[1]?.images).toEqual([{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
    expect(resumedA.promptOptions[1]?.expandPromptTemplates).toBe(false);

    after.runner.cancel();
    await done;
  });
});

describe('TeamRunner peer message still queued in pi at the cancel', () => {
  it('is taken by the checkpoint rather than delivered by the aborted run, and prompts the resumed member once', async () => {
    const h = midToolTeam('peer-steer');
    const run = h.runner.run();
    const a = await opened(h, 'A');
    await a.whenPrompted(1);

    const peer = '[Message from Lead]: check the parser';
    h.bus().send('Lead', 'A', 'check the parser');
    await a.whenPrompted(2);
    expect(a.getSteeringMessages()).toEqual([peer]);
    const files = new Map(['Lead', 'A'].map((n) => [h.agent(n).agentId, h.session(n).sessionFile!]));
    h.runner.cancel();
    await run;
    expect(a.drainedOnAbort).toEqual([]);

    const persistence = persistenceOf(h);
    const checkpoint = (await checkpointOf(persistence, h.teamId))!;
    expect(checkpoint.members.find((m) => m.name === 'A')!.undelivered).toEqual([{ text: peer, echoed: true }]);

    const after = makeTeam({ cwd: h.cwd, teamId: h.teamId, specialists: ['A'], behave: { Lead: holdTurn } });
    after.runner.restore(await persistence.readEventLog(h.teamId), checkpoint, files);
    const done = after.runner.resume('tc-resume');
    const resumedA = await opened(after, 'A');
    await resumedA.whenPrompted(2);
    after.runner.cancel();
    await done;

    expect(resumedA.prompts[1]).toBe(peer);
    expect(resumedA.prompts.filter((p) => p.includes('check the parser'))).toHaveLength(1);
  });

  it('hands pi queued messages to the resumed member before the ones the runner still held', async () => {
    const h = midToolTeam('queue-order');
    const run = h.runner.run();
    const a = await opened(h, 'A');
    await a.whenPrompted(1);

    h.bus().send('Lead', 'A', 'first, steered into pi');
    await a.whenPrompted(2);
    a.holdFollowUpMessage('[Message from Lead]: second, a pi follow-up');
    // pi has stopped streaming but its run has not returned, so the runner holds the next message itself.
    a.isStreaming = false;
    h.bus().send('Lead', 'A', 'third, held by the runner');
    const files = new Map(['Lead', 'A'].map((n) => [h.agent(n).agentId, h.session(n).sessionFile!]));
    h.runner.cancel();
    await run;
    expect(a.drainedOnAbort).toEqual([]);

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
    after.runner.cancel();
    await done;

    expect(resumedA.prompts.slice(1, 4)).toEqual(expected);
  });
});

describe('TeamRunner.resume relaunches, parks, restarts or leaves each member by its status at the cancel', () => {
  async function resumed(label: string, behave: Record<string, Behaviour> = {}): Promise<{ before: Harness; after: Harness; done: Promise<{ status: string; text: string }>; checkpoint: TeamCheckpoint }> {
    const { h, files, run } = await interruptedTeam(newCwd(label), crypto.randomUUID());
    h.runner.cancel();
    await run;
    const persistence = persistenceOf(h);
    const log = await persistence.readEventLog(h.teamId);
    const checkpoint = (await checkpointOf(persistence, h.teamId))!;

    const reportOnce: Behaviour = (_t, s, hh) => {
      const name = hh.opened.find((o) => o.session === s)!.name;
      if (s.prompts.length === 1) hh.runner.reportComplete(name, `${name} resumed and done`);
      s.emit({ type: 'turn_end' });
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

    after.runner.cancel();
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

    after.runner.cancel();
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

    after.runner.cancel();
    await done;
  });

  it('leaves completed, cancelled and pending members untouched and opens no session for them', async () => {
    const { after, done } = await resumed('plan-unchanged');
    await (await opened(after, 'B')).whenPrompted(1);

    expect(['D', 'E', 'G', 'H'].map((n) => after.agent(n).status)).toEqual(['pending', 'completed', 'cancelled', 'cancelled']);
    expect(after.opened.filter((o) => ['D', 'E', 'G', 'H'].includes(o.name))).toEqual([]);
    for (const n of ['D', 'E', 'G', 'H']) expect(statusUpdates(after, after.agent(n).agentId)).toEqual([]);

    after.runner.cancel();
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

    after.runner.cancel();
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

    after.runner.cancel();
    await done;
  });

  it('steers undelivered messages into a relaunched member whose resume turn keeps working, each on its own, steers first', async () => {
    // Its resume turn never ends, so a message delivered only at a turn end would never arrive.
    const keepsWorking: Behaviour = (_t, s) => { if (s.prompts.length === 1) s.startStreaming(); };
    const { after, done } = await resumed('plan-redeliver-mid-turn', { B: keepsWorking });
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

    after.runner.cancel();
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

    after.runner.cancel();
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
          if (s.prompts.length === 1) hh.runner.startSpecialist('A', 'task for A, described in full');
          // The lead keeps working on the round it was handed, so no stall nudge repeats it.
          if (!text.includes(RRR)) s.emit({ type: 'turn_end' });
        },
        A: (_t, s, hh) => {
          hh.scratchpad().set('a-notes', 'A findings', 'A');
          hh.runner.reportComplete('A', 'A signed off');
          s.emit({ type: 'turn_end' });
        },
      },
    });
    const run = h.runner.run();
    const lead = await opened(h, 'Lead');
    await vi.waitFor(() => expect(lead.prompts.some((p) => p.includes(RRR))).toBe(true));
    h.runner.cancel();
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

    after.runner.cancel();
    await done;
  });

  it('a lead whose stall budget ran out before the cancel is not force-completed on its first resumed turn', async () => {
    const { cwd, teamId, persistence, checkpoint, files } = await roundOpenAtCancel('stalls');
    // Holding the nudged turn keeps later stalls from racing the assertions to a forced end.
    const leadEndsFirstTurn: Behaviour = (_t, s) => { if (s.prompts.length === 1) s.emit({ type: 'turn_end' }); };
    const after = makeTeam({ cwd, teamId, specialists: ['A'], behave: { Lead: leadEndsFirstTurn } });
    after.runner.restore(await persistence.readEventLog(teamId), { ...checkpoint, review: { ...checkpoint.review, leadReviewStalls: 2 } }, files);
    const done = after.runner.resume('tc-resume');
    const lead = await opened(after, 'Lead');

    // The first turn ends without a review; the next prompt is the round nudge, not the forced end.
    await lead.whenPrompted(2);
    expect(lead.prompts[1]).toContain(RRR);
    expect(after.agent('Lead').status).not.toBe('completed');
    expect(lead.prompts.some((p) => p.includes('[TEAM FORCE-COMPLETED]'))).toBe(false);

    after.runner.cancel();
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
    await (await opened(h, 'Lead')).whenPrompted(1);
    h.runner.cancel();
    await run;
    expect(h.costs.reduce((a, b) => a + b, 0)).toBe(2);
    const persistence = persistenceOf(h);
    const checkpoint = (await checkpointOf(persistence, teamId))!;

    const after = makeTeam({
      cwd, teamId, specialists: [],
      opening: { Lead: { cost: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } },
      behave: { Lead: (_t, s) => { s.emitAssistantUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.5); s.emit({ type: 'turn_end' }); } },
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
  const callTools = (n: number): Behaviour => (_t, s) => {
    const content = Array.from({ length: n }, (_, i) => ({ type: 'toolCall', id: `tc-${s.prompts.length}-${i}`, name: 'read', arguments: {} }));
    s.emit({ type: 'message_end', message: { role: 'assistant', content } });
  };

  it("adds the resumed run's tool calls to the attempt's earlier ones, live, in the log and after a reload", async () => {
    const cwd = newCwd('tools');
    const teamId = crypto.randomUUID();
    const h = makeTeam({ cwd, teamId, specialists: [], behave: { Lead: callTools(3) } });
    const run = h.runner.run();
    await (await opened(h, 'Lead')).whenPrompted(1);
    await vi.waitFor(() => expect(h.agent('Lead').toolCallCount).toBe(3));
    h.runner.cancel();
    await run;
    const persistence = persistenceOf(h);
    const checkpoint = (await checkpointOf(persistence, teamId))!;
    expect(checkpoint.members.find((m) => m.name === 'Lead')!.toolCallCount).toBe(3);

    const after = makeTeam({
      cwd, teamId, specialists: [],
      behave: { Lead: (t, s, hh) => { callTools(2)(t, s, hh); s.emit({ type: 'turn_end' }); } },
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
    const h = makeTeam({
      cwd, teamId, specialists: [],
      behave: { Lead: (_t, s) => { s.emitAssistantUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 1); } },
    });
    const run = h.runner.run();
    const lead = await opened(h, 'Lead');
    await vi.waitFor(() => expect(h.agent('Lead').totalInputTokens).toBe(10));
    // The in-flight request reports its usage and tool call only as the abort ends it, after the checkpoint.
    const abort = lead.abort.bind(lead);
    lead.abort = async () => {
      lead.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'late', name: 'read', arguments: {} }], usage: { input: 7, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 2 } } } });
      await abort();
    };
    h.runner.cancel();
    await run;
    const persistence = persistenceOf(h);

    const after = makeTeam({
      cwd, teamId, specialists: [],
      opening: { Lead: { cost: lead.cost, tokens: { ...lead.tokens } } },
      behave: { Lead: (_t, s) => { s.emitAssistantUsage({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.5); s.emit({ type: 'turn_end' }); } },
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
    h.runner.cancel();
    await run;
    const persistence = persistenceOf(h);

    const after = makeTeam({ cwd, teamId, specialists: [], behave: { Lead: holdTurn } });
    after.runner.restore(await persistence.readEventLog(teamId), (await checkpointOf(persistence, teamId))!, new Map());
    const done = after.runner.resume('tc-resume', message);
    const lead = await opened(after, 'Lead');
    await lead.whenPrompted(1);
    after.runner.cancel();
    await done;
    return { task: first.prompts[0]!, prompt: lead.prompts[0]! };
  }

  it('puts the resume message first, under the steer marker on line one, and the original task after it', async () => {
    const { task, prompt } = await leadRestart('  switch to the new parser  ');

    expect(prompt).toBe(wrapSteerMessage(`switch to the new parser\n\nYour original task:\n${task}`));
  });

  it('with no message it starts from its task alone', async () => {
    const { task, prompt } = await leadRestart(undefined);

    expect(prompt).toBe(task);
  });
});
