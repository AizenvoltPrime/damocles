import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setActivePinia, createPinia } from 'pinia';

// Point the Damocles home dir at a throwaway temp dir so the log the runner writes here never touches
// the real ~/.damocles tree. The async factory is hoisted above the persistence import.
vi.mock('../../paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return { DAMOCLES_HOME_DIR: mkdtempSync(joinPath(tmpdir(), 'damocles-redispatch-')) };
});

import { DAMOCLES_HOME_DIR } from '../../paths';
import { TeamRunner } from '../team-runner';
import { AgentRunner } from '../agent-runner';
import { TeamPersistence } from '../persistence';
import { TeamRunLog } from '../runs';
import { teamEventLogPath } from '../../pi-session/agent-records';
import { ensurePiSessionDir } from '../../pi-session/session-store';
import { Scratchpad } from '../scratchpad';
import { MessageBus } from '../message-bus';
import { FakeSession } from './fake-session';
import { initPiLoader } from '../../pi-session/pi-loader';
import { teamAgentToolset } from './team-mcp-fixture';
import type { AgentMcpContext, TeamAgent, TeamConfig, TeamRole } from '../types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { TeamAgent as WebviewTeamAgent, TeamState } from '../../../shared/types/team';
import { useTeamStore } from '@/stores/useTeamStore';
import { createTeamHandlers } from '@/composables/message-handler/handlers/team-handlers';

/**
 * The redispatch seam, from both ends at once. A cancelled specialist that is re-run keeps one card, so
 * the live card and the card a reopened team restores read the same agent from two
 * different sources: a stream of webview messages, and the team log. They disagreed, which is the bug
 * these tests exist to hold shut.
 *
 * Every figure below is the one the observed run recorded for the specialist it cancelled and re-ran.
 */

const TEAM_ID = 'team-1';
const SESSION_ID = 'sess-1';
const TASK = 'read the mission brief and report the outcome';

const ATTEMPT_1 = {
  tools: ['Read', 'Grep', 'Bash', 'Glob', 'Read'],
  usage: { input: 8, output: 665, cacheRead: 56_118, cacheWrite: 19_628 },
  cost: 0.15659350000000002,
};
const ATTEMPT_2 = {
  tools: ['Read', 'Grep', 'Glob', 'Read'],
  usage: { input: 8, output: 1106, cacheRead: 73_473, cacheWrite: 1960 },
  cost: 0.06200525,
};

/** The fields the card shows for an agent, which live and reloaded must agree on to the last cent. */
interface AgentFigures {
  status: string;
  toolCount: number;
  activeMs: number;
  runningSince: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

function figures(agent: WebviewTeamAgent): AgentFigures {
  return {
    status: agent.status,
    toolCount: agent.toolCount,
    activeMs: agent.activeMs,
    runningSince: agent.runningSince,
    totalInputTokens: agent.totalInputTokens,
    totalOutputTokens: agent.totalOutputTokens,
    cacheReadTokens: agent.cacheReadTokens,
    cacheCreationTokens: agent.cacheCreationTokens,
    costUsd: agent.costUsd,
  };
}

function makeAgent(name: string, role: TeamAgent['role']): TeamAgent {
  return {
    agentId: `id-${name}`, teamId: TEAM_ID, name, role, attempt: 0, specialization: '',
    status: 'pending', model: 'test', profileId: null, activeMs: 0, runningSince: null,
    toolCallCount: 0, carriedToolCallCount: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, costUsd: 0,
    carriedUsage: { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
    dollarBilled: false, effort: null, finalResponse: null, result: null, error: null, logFilePath: null,
  };
}

/**
 * A real TeamRunner with its real AgentRunner, real persistence and fake pi sessions, whose webview
 * messages are fed to the real team store through the real handlers. One run therefore produces both
 * surfaces: the store the panel renders from, and the log a reopened team is rebuilt from.
 *
 * `run()` is not called (it needs a live engine and blocks), so the collaborators it builds are injected
 * and the team-created entry is written the way run() writes it.
 */
async function makeHarness(cwd: string) {
  const persistence = new TeamPersistence(cwd, SESSION_ID);
  const handlers = createTeamHandlers() as Record<string, (m: ExtensionToWebviewMessage, ctx: unknown) => void>;
  const pendingSessions: FakeSession[] = [];

  const config = {
    teamId: TEAM_ID,
    toolUseId: 'toolu_1',
    title: 'remediation check',
    brief: 'the authoritative spec',
    cwd,
    persistenceSessionId: SESSION_ID,
    permissionMode: 'default' as const,
    agents: [
      { name: 'lead', role: 'lead' as const },
      { name: 'alpha', role: 'specialist' as const },
    ],
    resolveRoleModel: (role: TeamRole) => ({ modelLabel: role === 'lead' ? 'lead-model' : 'spec-model', dollarBilled: false }),
    engine: {
      createSession: async () => {
        const session = pendingSessions.shift();
        if (!session) throw new Error('queue a FakeSession before spawning');
        return session as never;
      },
      forgetSession: () => undefined,
      buildAgentToolset: () => teamAgentToolset(),
      buildExtensionFactory: () => (() => undefined) as never,
      onAgentCost: () => undefined,
      disposeBrowserScope: () => undefined,
      cancelAgentDialogs: () => undefined,
    },
  } as unknown as TeamConfig;

  const runner = new TeamRunner(config, (m) => handlers[m.type]?.(m, {} as never));
  const target = runner as unknown as Record<string, unknown>;
  target['persistence'] = persistence;
  target['agentRunner'] = new AgentRunner();
  target['messageBus'] = new MessageBus(TEAM_ID);
  target['scratchpad'] = new Scratchpad();
  const agents = target['agents'] as Map<string, TeamAgent>;
  for (const spec of config.agents) agents.set(spec.name, makeAgent(spec.name, spec.role));
  (runner as unknown as { installSubscribers: () => void }).installSubscribers();

  persistence.initTeamFile(TEAM_ID);
  persistence.appendTeamEntry({
    type: 'team-created', teamId: TEAM_ID, toolUseId: 'toolu_1', title: 'remediation check',
    agents: config.agents, timestamp: new Date().toISOString(),
  });
  (runner as unknown as { emitTeamStarted: () => void }).emitTeamStarted();

  /** Flush microtasks and macrotasks so the runner's launches and prompt loops settle. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (let j = 0; j < 4; j++) await Promise.resolve();
    }
  };

  /** A session that parks in its turn, so the test decides when the turn ends. */
  const queueSession = (): FakeSession => {
    const session = new FakeSession({ onPrompt: () => undefined });
    pendingSessions.push(session);
    return session;
  };

  /** One attempt's work: the tool calls it made, then the usage its messages reported. */
  const work = (session: FakeSession, attempt: { tools: string[]; usage: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost: number }): void => {
    const calls = attempt.tools.map((name, i) => ({ type: 'toolCall', id: `tc-${name}-${i}`, name, arguments: {} }));
    session.emit({ type: 'message_end', message: { role: 'assistant', content: calls } });
    for (const call of calls) session.emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: {} });
    session.emitAssistantUsage(attempt.usage, attempt.cost);
  };

  const specialistContext = (name: string): AgentMcpContext => (runner as unknown as {
    buildSpecialistContext: (id: string, scope: string, name: string) => AgentMcpContext;
  }).buildSpecialistContext(`id-${name}`, `id-${name}#0`, name);

  const loadedAgent = async (name: string): Promise<WebviewTeamAgent> => {
    const state = await persistence.loadTeamState(TEAM_ID);
    const agent = state?.agents.find(a => a.name === name);
    if (!agent) throw new Error(`the log restored no agent named ${name}`);
    return agent;
  };

  const liveTeam = (): TeamState => {
    const team = useTeamStore().teams[TEAM_ID];
    if (!team) throw new Error('the store holds no team');
    return team;
  };

  const liveAgent = (name: string): WebviewTeamAgent => {
    const agent = liveTeam().agents.find(a => a.name === name);
    if (!agent) throw new Error(`the store holds no agent named ${name}`);
    return agent;
  };

  return { runner, persistence, settle, queueSession, work, specialistContext, loadedAgent, liveAgent, liveTeam };
}

/**
 * The observed run: a specialist works, is cancelled mid-task, is re-dispatched under the same name,
 * works again, reports complete and is released by synthesis.
 */
async function runCancelledThenRedispatched(cwd: string) {
  const h = await makeHarness(cwd);

  const first = h.queueSession();
  h.runner.startSpecialist('alpha', TASK);
  await first.whenPrompted(1);
  h.work(first, ATTEMPT_1);
  await h.settle();

  vi.setSystemTime(new Date('2026-09-01T10:40:38.479Z'));
  h.runner.cancelSpecialist('alpha');
  // pi ends the in-flight turn when it aborts a session, which is what releases the runner's prompt.
  first.emit({ type: 'turn_end' });
  await h.settle();

  const second = h.queueSession();
  vi.setSystemTime(new Date('2026-09-01T10:40:46.872Z'));
  h.runner.redispatchSpecialist('alpha', TASK);
  await second.whenPrompted(1);
  h.work(second, ATTEMPT_2);
  await h.settle();

  vi.setSystemTime(new Date('2026-09-01T10:41:15.527Z'));
  h.specialistContext('alpha').reportComplete('alpha', 'ALPHA-DONE: reported the read outcome after redispatch.');
  second.emit({ type: 'turn_end' });
  await h.settle();
  h.runner.synthesizeResult('the team result');
  await h.settle();
  // Appends are synchronous; flush only surfaces a write that failed.
  await h.persistence.flush();

  return h;
}

// The first pi import takes about a second, which under a loaded machine overruns the first test's timeout.
beforeAll(async () => {
  await initPiLoader();
});

afterAll(() => rmSync(DAMOCLES_HOME_DIR, { recursive: true, force: true }));

beforeEach(() => {
  setActivePinia(createPinia());
  // Only Date is faked: the runner drives itself on microtasks, which must stay real. A frozen clock
  // makes the live timestamps and the log timestamps comparable rather than a race.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-01T10:40:23.547Z'));
});

afterEach(() => vi.useRealTimers());

describe('a cancelled and re-dispatched specialist', () => {
  it('reads the same on the live card and on the card a reopened team restores', async () => {
    const h = await runCancelledThenRedispatched(join(DAMOCLES_HOME_DIR, 'parity'));

    const live = h.liveAgent('alpha');
    const reloaded = await h.loadedAgent('alpha');

    // One assertion, not two: the defect was the two surfaces disagreeing, so the invariant is equality.
    expect(figures(live)).toEqual(figures(reloaded));
    expect(figures(live)).toMatchObject({
      status: 'completed',
      toolCount: ATTEMPT_2.tools.length,
      // The card times the attempt now running, so the stopwatch starts at the redispatch.
      activeMs: 28_655,
      runningSince: null,
      totalOutputTokens: ATTEMPT_1.usage.output + ATTEMPT_2.usage.output,
      costUsd: ATTEMPT_1.cost + ATTEMPT_2.cost,
    });
  });

  it('counts only the live attempt in the team tool total, on both surfaces', async () => {
    const h = await runCancelledThenRedispatched(join(DAMOCLES_HOME_DIR, 'parity-tools'));

    const reloaded = await h.persistence.loadTeamState(TEAM_ID);

    expect(h.liveTeam().totalToolCount).toBe(ATTEMPT_2.tools.length);
    expect(reloaded?.totalToolCount).toBe(ATTEMPT_2.tools.length);
  });

  it('keeps the dead attempt spend in the agent total, on both surfaces', async () => {
    const h = await runCancelledThenRedispatched(join(DAMOCLES_HOME_DIR, 'parity-spend'));

    const live = h.liveAgent('alpha');
    const reloaded = await h.loadedAgent('alpha');

    // The cancelled attempt burned real tokens under this name; only its work fields are gone.
    expect(live.costUsd).toBeCloseTo(0.21859875, 10);
    expect(reloaded.costUsd).toBeCloseTo(0.21859875, 10);
    expect(live.cacheReadTokens).toBe(ATTEMPT_1.usage.cacheRead + ATTEMPT_2.usage.cacheRead);
    expect(reloaded.cacheReadTokens).toBe(ATTEMPT_1.usage.cacheRead + ATTEMPT_2.usage.cacheRead);
  });

  it('records each attempt own usage in the log, so the loader never counts a dollar twice', async () => {
    const h = await runCancelledThenRedispatched(join(DAMOCLES_HOME_DIR, 'parity-entries'));
    await h.persistence.flush();

    const state = await h.persistence.loadTeamState(TEAM_ID);
    const alpha = state?.agents.find(a => a.name === 'alpha');

    // Both entries carry an attempt-local figure, and the restored total is exactly their sum.
    expect(alpha?.costUsd).toBeCloseTo(ATTEMPT_1.cost + ATTEMPT_2.cost, 10);
    expect(alpha?.attempt).toBe(1);
  });
});

describe('a batch an abort cut short', () => {
  it('counts only the call that ran, on the live card and run, in the log and on a reopened team', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'cut-batch');
    const h = await makeHarness(cwd);
    // `run()` opens the run that stamps each `agent-completed`; the harness does not call it.
    (h.runner as unknown as { beginRun: (toolUseId: string, at: string) => void }).beginRun('toolu_1', new Date().toISOString());
    const read = (id: string) => ({ type: 'toolCall', id, name: 'read', arguments: { path: `/${id}.ts` } });

    const session = h.queueSession();
    h.runner.startSpecialist('alpha', TASK);
    await session.whenPrompted(1);
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [read('tc-ran'), read('tc-skipped')], stopReason: 'toolUse' } });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-ran', toolName: 'read', args: { path: '/tc-ran.ts' } });
    h.runner.cancelSpecialist('alpha');
    session.emit({ type: 'tool_execution_end', toolCallId: 'tc-ran', toolName: 'read', result: { content: [{ type: 'text', text: 'Operation aborted' }], details: {} }, isError: true });
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request was aborted' } });
    session.emit({ type: 'turn_end' });
    await h.settle();
    await h.persistence.flush();

    const entries = readFileSync(teamEventLogPath(ensurePiSessionDir(cwd), SESSION_ID, TEAM_ID), 'utf-8')
      .split(String.fromCharCode(10)).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const reloaded = await h.persistence.loadTeamState(TEAM_ID);
    expect(entries.filter((e) => e['type'] === 'agent-completed').map((e) => e['toolCallCount'])).toEqual([1]);
    expect({
      card: h.liveAgent('alpha').toolCount,
      team: h.liveTeam().totalToolCount,
      liveRun: h.liveTeam().runs.at(-1)?.toolCount,
      runnerRun: h.runner.getTeamState().runs.at(-1)?.toolCount,
      reloadedCard: reloaded?.agents.find((a) => a.name === 'alpha')?.toolCount,
      reloadedRun: reloaded?.runs.at(-1)?.toolCount,
    }).toEqual({ card: 1, team: 1, liveRun: 1, runnerRun: 1, reloadedCard: 1, reloadedRun: 1 });
  });
});

describe('a team agent effort', () => {
  /** pi reports the clamped level on the session, and the model's reasoning flag beside it. */
  const runningAt = (session: FakeSession, thinkingLevel: string, reasoning = true): FakeSession =>
    Object.assign(session, { thinkingLevel, model: { reasoning } });

  it('shows each attempt its own session level, the same live and after a reload, and resets on a new attempt', async () => {
    const cwd = join(DAMOCLES_HOME_DIR, 'effort-attempts');
    const h = await makeHarness(cwd);

    const first = runningAt(h.queueSession(), 'high');
    h.runner.startSpecialist('alpha', TASK);
    await first.whenPrompted(1);
    await h.settle();
    await h.persistence.flush();
    expect(h.liveAgent('alpha').effort).toBe('high');
    expect((await h.loadedAgent('alpha')).effort).toBe('high');

    h.runner.cancelSpecialist('alpha');
    first.emit({ type: 'turn_end' });
    await h.settle();

    const second = runningAt(h.queueSession(), 'medium');
    h.runner.redispatchSpecialist('alpha', TASK);
    // The new attempt's session does not exist yet, so neither surface may keep the dead attempt's level.
    expect(h.liveAgent('alpha').effort).toBeNull();
    // Read synchronously, before the session the redispatch is creating can append its entry.
    const log = new TeamRunLog();
    for (const line of readFileSync(teamEventLogPath(ensurePiSessionDir(cwd), SESSION_ID, TEAM_ID), 'utf-8').split(String.fromCharCode(10)).filter(Boolean)) log.add(JSON.parse(line));
    expect(log.memberEffort('id-alpha')).toBeNull();

    await second.whenPrompted(1);
    await h.settle();
    await h.persistence.flush();
    expect(h.liveAgent('alpha').effort).toBe('medium');
    expect((await h.loadedAgent('alpha')).effort).toBe('medium');
  });

  it('shows no effort for a model that does not reason, on either surface', async () => {
    const h = await makeHarness(join(DAMOCLES_HOME_DIR, 'effort-no-reasoning'));

    const session = runningAt(h.queueSession(), 'off', false);
    h.runner.startSpecialist('alpha', TASK);
    await session.whenPrompted(1);
    await h.settle();
    await h.persistence.flush();

    expect(h.liveAgent('alpha').effort).toBeNull();
    expect((await h.loadedAgent('alpha')).effort).toBeNull();
  });
});
