import { describe, it, expect } from 'vitest';
import { TeamRunner } from '../team-runner';
import { MessageBus } from '../message-bus';
import { Scratchpad } from '../scratchpad';
import type { TeamConfig, TeamAgent, AgentRunConfig } from '../types';

/**
 * Lightweight harness for the stranded-standby recovery path (the team-deadlock fix). It injects the
 * private collaborators TeamRunner normally builds in run() so the private settle-path recovery can be
 * driven directly, without a live pi engine.
 */
function makeAgent(partial: Partial<TeamAgent> & { name: string; role: TeamAgent['role'] }): TeamAgent {
  return {
    agentId: `id-${partial.name}`,
    teamId: 'team-1',
    name: partial.name,
    role: partial.role,
    specialization: '',
    status: 'running',
    model: 'test',
    profileId: null,
    startTime: null,
    endTime: null,
    toolCallCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    finalResponse: null,
    error: null,
    logFilePath: null,
    ...partial,
  };
}

interface Harness {
  runner: TeamRunner;
  messageBus: MessageBus;
  sentToLead: string[];
  statusUpdates: Array<{ name: string; status: string }>;
  agents: Map<string, TeamAgent>;
  pendingStandby: Set<string>;
  confirmedComplete: Set<string>;
  nudgeScheduled: Set<string>;
  nudgeDelivered: Set<string>;
  specialistReviewRounds: Map<string, number>;
  /** Invoke the private recovery entry point under test. */
  resolve: () => void;
}

/** Assert a private field exists before overwriting it, so a rename fails loudly instead of writing a
 *  dead property (the real definite-assignment field would then stay undefined and mislead the test). */
function inject<T>(target: Record<string, unknown>, key: string, value: T): T {
  if (!(key in target)) {
    throw new Error(`TeamRunner no longer has a "${key}" field — update the test harness injection.`);
  }
  target[key] = value;
  return value;
}

function makeHarness(agents: TeamAgent[]): Harness {
  const nameById = new Map(agents.map(a => [a.agentId, a.name]));
  const statusUpdates: Array<{ name: string; status: string }> = [];
  const runner = new TeamRunner(
    { teamId: 'team-1' } as unknown as TeamConfig,
    (m) => {
      if (m.type === 'teamAgentStatusUpdate') {
        statusUpdates.push({ name: nameById.get(m.agentId) ?? m.agentId, status: m.status });
      }
    },
  );
  const messageBus = new MessageBus('team-1');
  const scratchpad = new Scratchpad();
  const agentMap = new Map(agents.map(a => [a.name, a]));

  const target = runner as unknown as Record<string, unknown>;
  inject(target, 'messageBus', messageBus);
  inject(target, 'scratchpad', scratchpad);
  inject(target, 'agents', agentMap);
  const pendingStandby = inject(target, 'pendingStandby', new Set<string>());
  const confirmedComplete = inject(target, 'confirmedComplete', new Set<string>());
  const nudgeScheduled = inject(target, 'nudgeScheduled', new Set<string>());
  const nudgeDelivered = inject(target, 'nudgeDelivered', new Set<string>());
  const specialistReviewRounds = inject(target, 'specialistReviewRounds', new Map<string, number>());
  inject(target, 'reviewedSpecialists', new Set<string>());
  inject(target, 'completionResolved', false);

  const sentToLead: string[] = [];
  messageBus.subscribe((msg) => {
    if (msg.to === 'Lead') sentToLead.push(msg.content);
  });

  const resolve = (): void => {
    (runner as unknown as { resolveStrandedStandbys: () => void }).resolveStrandedStandbys();
  };

  return {
    runner, messageBus, sentToLead, statusUpdates, agents: agentMap,
    pendingStandby, confirmedComplete, nudgeScheduled, nudgeDelivered, specialistReviewRounds, resolve,
  };
}

function bMessages(h: Harness, to: string): string[] {
  return h.messageBus.getAllMessages().filter(m => m.to === to).map(m => m.content);
}

describe('TeamRunner stranded-standby recovery', () => {
  it('nudges a stranded standby once (deferred), leaving it in standby until delivery', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const a = makeAgent({ name: 'A', role: 'specialist', status: 'awaiting-review' });
    const b = makeAgent({ name: 'B', role: 'specialist', status: 'standby' });
    const h = makeHarness([lead, a, b]);
    h.confirmedComplete.add('A');
    h.pendingStandby.add('B');

    h.resolve();

    // The nudge is scheduled but deferred — not delivered synchronously, and not yet "delivered".
    expect(h.sentToLead).toEqual([]);
    expect(h.nudgeScheduled.has('B')).toBe(true);
    expect(h.nudgeDelivered.has('B')).toBe(false);
    expect(b.status).toBe('standby');

    await Promise.resolve();
    // After the microtask, B received exactly one system nudge and is marked delivered; still standby.
    expect(bMessages(h, 'B')).toHaveLength(1);
    expect(bMessages(h, 'B')[0]).toContain('call team_report_complete now');
    expect(h.nudgeDelivered.has('B')).toBe(true);
    expect(b.status).toBe('standby');
  });

  it('does not re-nudge on a second settle before delivery (nudge-once)', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const a = makeAgent({ name: 'A', role: 'specialist', status: 'awaiting-review' });
    const b = makeAgent({ name: 'B', role: 'specialist', status: 'standby' });
    const h = makeHarness([lead, a, b]);
    h.confirmedComplete.add('A');
    h.pendingStandby.add('B');

    h.resolve();
    h.resolve(); // a second settle in the same tick must NOT convert or double-schedule

    expect(b.status).toBe('standby');
    await Promise.resolve();
    expect(bMessages(h, 'B')).toHaveLength(1);
  });

  it('converts only AFTER the nudge was delivered and the agent re-stranded', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const a = makeAgent({ name: 'A', role: 'specialist', status: 'awaiting-review' });
    const b = makeAgent({ name: 'B', role: 'specialist', status: 'standby' });
    const h = makeHarness([lead, a, b]);
    h.confirmedComplete.add('A');
    h.pendingStandby.add('B');

    h.resolve();
    await Promise.resolve(); // deliver the nudge (nudgeDelivered.add('B'))
    expect(h.nudgeDelivered.has('B')).toBe(true);

    // B re-parked in standby after its nudge turn → now convert.
    h.resolve();

    expect(b.status).toBe('awaiting-review');
    expect(h.confirmedComplete.has('B')).toBe(true);
    expect(h.pendingStandby.has('B')).toBe(false);
    expect(h.sentToLead).toHaveLength(1);
    const notification = h.sentToLead[0];
    expect(notification).toContain('[REVIEW ROUND READY]');
    expect(notification).toContain('  - A:');
    expect(notification).toContain('  - B:');
  });

  it('does nothing for a specialist that reported complete instead of re-standbying (no double-process)', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const a = makeAgent({ name: 'A', role: 'specialist', status: 'awaiting-review' });
    // B was nudged, then called team_report_complete: it left pendingStandby and is awaiting-review.
    const b = makeAgent({ name: 'B', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, a, b]);
    h.confirmedComplete.add('A');
    h.confirmedComplete.add('B');
    h.nudgeDelivered.add('B');
    // pendingStandby intentionally empty — B is no longer standing by.

    h.resolve();

    expect(b.status).toBe('awaiting-review');
    expect(h.sentToLead).toEqual([]);
  });

  it('nudges BOTH agents under mutual standby (no running peer left to wake either)', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const a = makeAgent({ name: 'A', role: 'specialist', status: 'standby' });
    const b = makeAgent({ name: 'B', role: 'specialist', status: 'standby' });
    const h = makeHarness([lead, a, b]);
    h.pendingStandby.add('A');
    h.pendingStandby.add('B');

    h.resolve();
    await Promise.resolve();

    expect(bMessages(h, 'A')).toHaveLength(1);
    expect(bMessages(h, 'B')).toHaveLength(1);
    expect(a.status).toBe('standby');
    expect(b.status).toBe('standby');
  });

  it('does NOT convert at the review-round ceiling boundary is still actionable (confirmedComplete set)', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const b = makeAgent({ name: 'B', role: 'specialist', status: 'standby' });
    const h = makeHarness([lead, b]);
    h.pendingStandby.add('B');
    h.nudgeDelivered.add('B');
    h.specialistReviewRounds.set('B', 2); // MAX_SPECIALIST_REVIEW_ROUNDS

    h.resolve();

    // Recovery must keep the lead actionable: awaiting-review + confirmedComplete so approve/synthesize work.
    expect(b.status).toBe('awaiting-review');
    expect(h.confirmedComplete.has('B')).toBe(true);
  });

  it('is a no-op once completion has resolved', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const b = makeAgent({ name: 'B', role: 'specialist', status: 'standby' });
    const h = makeHarness([lead, b]);
    h.pendingStandby.add('B');
    h.nudgeDelivered.add('B');
    (h.runner as unknown as { completionResolved: boolean }).completionResolved = true;

    h.resolve();

    expect(b.status).toBe('standby');
    expect(h.confirmedComplete.has('B')).toBe(false);
  });

  it('suppresses a scheduled nudge whose agent left standby before the microtask ran', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const a = makeAgent({ name: 'A', role: 'specialist', status: 'awaiting-review' });
    const b = makeAgent({ name: 'B', role: 'specialist', status: 'standby' });
    const h = makeHarness([lead, a, b]);
    h.confirmedComplete.add('A');
    h.pendingStandby.add('B');

    h.resolve();               // schedules the nudge microtask
    h.pendingStandby.delete('B'); // B settled/cancelled before the microtask runs
    await Promise.resolve();

    expect(bMessages(h, 'B')).toEqual([]);
    expect(h.nudgeDelivered.has('B')).toBe(false);
  });

  it('clears the nudge bookkeeping on requestRevision so a post-revision standby earns a fresh nudge', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const b = makeAgent({ name: 'B', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, b]);
    // B was previously nudged and converted, then the lead reviewed it.
    h.confirmedComplete.add('B');
    h.nudgeScheduled.add('B');
    h.nudgeDelivered.add('B');

    (h.runner as unknown as { requestRevision: (n: string, f: string) => void })
      .requestRevision('B', 'please fix the null check');

    // A fresh review round: the stale nudge flags must be cleared so a mid-revision standby nudges,
    // rather than insta-converting unfinished work.
    expect(h.nudgeScheduled.has('B')).toBe(false);
    expect(h.nudgeDelivered.has('B')).toBe(false);

    // Simulate B calling team_standby mid-revision, then the recovery re-evaluating.
    b.status = 'standby';
    h.confirmedComplete.delete('B');
    h.pendingStandby.add('B');
    h.resolve();

    expect(b.status).toBe('standby'); // nudge, not convert
    await Promise.resolve();
    const nudges = bMessages(h, 'B').filter((m) => m.includes('call team_report_complete now'));
    expect(nudges).toHaveLength(1);
  });
});

/**
 * Integration guard for the settle-path WIRING: drives the real AgentRunner-config closures TeamRunner
 * builds in startSpecialist (captured via a stubbed agentRunner) to prove recovery fires from the
 * awaiting-review branch of onTurnEnd — the ordering where the LAST peer settles via team_report_complete
 * while a peer is already parked in standby (its promise.then never fires, so the branch must recover).
 */
interface CapturedRun {
  config: AgentRunConfig;
  resolve: (result: unknown) => void;
}

function makeWiringRunner(names: string[]): { runner: TeamRunner; runs: Map<string, CapturedRun>; sentToLead: string[] } {
  const runs = new Map<string, CapturedRun>();
  const sentToLead: string[] = [];

  const config = {
    teamId: 'team-1',
    title: 'wire',
    cwd: '/cwd',
    persistenceSessionId: 'sess',
    permissionMode: 'default' as const,
    agents: [
      { name: 'Lead', role: 'lead' as const },
      ...names.map((n) => ({ name: n, role: 'specialist' as const })),
    ],
    resolveLeadModel: () => ({ modelLabel: 'lead-model' }),
    resolveSpecialistModel: () => ({ modelLabel: 'spec-model' }),
    allowedSpecialistModels: [],
    specialistModelForced: false,
    engine: {
      createSession: async () => ({}) as never,
      forgetSession: () => undefined,
      agentToolNames: () => [],
      buildAgentCustomTools: () => [],
      buildExtensionFactory: () => (() => undefined) as never,
      onAgentCost: () => undefined,
    },
  } as unknown as TeamConfig;

  const runner = new TeamRunner(config, () => undefined);

  // Inject the collaborators run() would build, plus a stub agentRunner that captures each config.
  const target = runner as unknown as Record<string, unknown>;
  const messageBus = new MessageBus('team-1');
  messageBus.subscribe((m) => { if (m.to === 'Lead') sentToLead.push(m.content); });
  target['messageBus'] = messageBus;
  target['scratchpad'] = new Scratchpad();
  target['persistence'] = { initAgentFile: async () => undefined, appendAgentEntry: () => undefined, appendTeamEntry: () => undefined, flush: async () => undefined };
  target['agentRunner'] = {
    startAgent: (cfg: AgentRunConfig) => new Promise((resolve) => { runs.set(cfg.name, { config: cfg, resolve }); }),
  };

  const agentMap = target['agents'] as Map<string, TeamAgent>;
  for (const spec of config.agents) {
    agentMap.set(spec.name, makeAgent({ name: spec.name, role: spec.role, status: 'pending' }));
  }

  return { runner, runs, sentToLead };
}

describe('TeamRunner settle-path wiring (recovery reaches every branch)', () => {
  it('recovers a stranded standby when the LAST peer settles via report_complete (awaiting-review onTurnEnd branch)', async () => {
    const { runner, runs, sentToLead } = makeWiringRunner(['A', 'B']);
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    runner.startSpecialist('B', 'task for B that is descriptive enough');
    // startAgent is invoked inside initPromise.then(...) — let the init microtask resolve first.
    await Promise.resolve();
    await Promise.resolve();
    const a = runs.get('A')!;
    const b = runs.get('B')!;

    // A enters standby while B still runs → A parks; not stranded yet (B running).
    runner.enterStandby('A');
    a.config.onTurnEnd!();
    expect((runner as unknown as { agents: Map<string, TeamAgent> }).agents.get('A')!.status).toBe('standby');

    // B reports complete as its FINAL action → its onTurnEnd takes the awaiting-review branch.
    runner.reportComplete('B');
    b.config.onTurnEnd!();

    // Recovery must run from that branch: A is stranded (no running peer), so it is nudged.
    const agents = (runner as unknown as { agents: Map<string, TeamAgent> }).agents;
    expect(agents.get('B')!.status).toBe('awaiting-review');
    const scheduled = (runner as unknown as { nudgeScheduled: Set<string> }).nudgeScheduled;
    expect(scheduled.has('A')).toBe(true);
    await Promise.resolve(); // deliver the nudge microtask (nudgeDelivered.add('A'))

    // A wakes on the nudge (onKeepAliveResume), re-standbys, and its turn ends → the standby branch of
    // onTurnEnd now converts it (nudge already delivered), surfacing it for the lead.
    a.config.onKeepAliveResume!();
    runner.enterStandby('A');
    a.config.onTurnEnd!();

    expect(agents.get('A')!.status).toBe('awaiting-review');
    expect(sentToLead.some((m) => m.includes('[REVIEW ROUND READY]'))).toBe(true);
    // settle the captured runner promises so no dangling handles remain
    const done = { status: 'completed' as const, finalResponse: null, toolCallCount: 0, durationMs: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
    a.resolve(done);
    b.resolve(done);
  });
});
