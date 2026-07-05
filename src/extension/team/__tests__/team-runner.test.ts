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
  briefConflicts: Map<string, string>;
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
  inject(target, 'persistence', { appendTeamEntry: () => undefined, appendAgentEntry: () => undefined, flush: async () => undefined });
  const pendingStandby = inject(target, 'pendingStandby', new Set<string>());
  const confirmedComplete = inject(target, 'confirmedComplete', new Set<string>());
  const nudgeScheduled = inject(target, 'nudgeScheduled', new Set<string>());
  const nudgeDelivered = inject(target, 'nudgeDelivered', new Set<string>());
  const specialistReviewRounds = inject(target, 'specialistReviewRounds', new Map<string, number>());
  const briefConflicts = inject(target, 'briefConflicts', new Map<string, string>());
  inject(target, 'conflictNudges', 0);
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
    pendingStandby, confirmedComplete, nudgeScheduled, nudgeDelivered, specialistReviewRounds, briefConflicts, resolve,
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

describe('TeamRunner brief-conflict gate', () => {
  type ConflictRunner = {
    flagBriefConflict: (name: string, detail: string) => void;
    resolveBriefConflict: (name: string, resolution: string) => void;
    getOpenBriefConflicts: () => Array<{ name: string; detail: string }>;
    requestRevision: (name: string, feedback: string) => void;
    synthesizeResult: (result: string) => void;
    nudgeLeadOnOpenConflicts: (leadName: string) => void;
  };

  function conflictApi(h: Harness): ConflictRunner {
    return h.runner as unknown as ConflictRunner;
  }

  /** Swap in a persistence stub that records appended team entries, for asserting audit-trail writes. */
  function captureEntries(h: Harness): Array<Record<string, unknown>> {
    const entries: Array<Record<string, unknown>> = [];
    (h.runner as unknown as Record<string, unknown>)['persistence'] = {
      appendTeamEntry: (e: Record<string, unknown>) => entries.push(e),
      appendAgentEntry: () => undefined,
      flush: async () => undefined,
    };
    return entries;
  }

  it('flagBriefConflict records the conflict and messages the lead', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const dev = makeAgent({ name: 'Dev', role: 'specialist', status: 'running' });
    const h = makeHarness([lead, dev]);
    conflictApi(h).flagBriefConflict('Dev', 'brief mandates async pipeline; contract is sync toy');

    expect(h.briefConflicts.get('Dev')).toBe('brief mandates async pipeline; contract is sync toy');
    expect(conflictApi(h).getOpenBriefConflicts()).toEqual([{ name: 'Dev', detail: 'brief mandates async pipeline; contract is sync toy' }]);
    expect(h.sentToLead.some((m) => m.includes('[BRIEF CONFLICT]') && m.includes('Dev'))).toBe(true);
  });

  it('resolveBriefConflict clears the flag', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const dev = makeAgent({ name: 'Dev', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, dev]);
    conflictApi(h).flagBriefConflict('Dev', 'a real conflict detail');
    conflictApi(h).resolveBriefConflict('Dev', 'intentional deviation, accepted');
    expect(conflictApi(h).getOpenBriefConflicts()).toEqual([]);
  });

  it('resolveBriefConflict throws when no conflict was flagged (accountable no-op is rejected, not swallowed)', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const dev = makeAgent({ name: 'Dev', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, dev]);
    expect(() => conflictApi(h).resolveBriefConflict('Dev', 'nothing to resolve')).toThrow(/No open brief conflict/);
  });

  it('synthesizeResult persists a brief-conflict-unresolved entry when a conflict is still open', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const dev = makeAgent({ name: 'Dev', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, dev]);
    const entries = captureEntries(h);
    (h.runner as unknown as { completionResolve: (r: string) => void }).completionResolve = () => undefined;
    h.briefConflicts.set('Dev', 'brief mandates async; result is sync');

    conflictApi(h).synthesizeResult('sync endpoint');

    const unresolved = entries.find((e) => e.type === 'brief-conflict-unresolved');
    expect(unresolved).toBeDefined();
    expect(unresolved!.conflicts).toEqual([{ name: 'Dev', detail: 'brief mandates async; result is sync' }]);
  });

  it('synthesizeResult persists NO unresolved entry on a clean finish', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const dev = makeAgent({ name: 'Dev', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, dev]);
    const entries = captureEntries(h);
    (h.runner as unknown as { completionResolve: (r: string) => void }).completionResolve = () => undefined;

    conflictApi(h).synthesizeResult('clean result');

    expect(entries.some((e) => e.type === 'brief-conflict-unresolved')).toBe(false);
  });

  it('a resolved conflict does NOT waste nudge budget — a later distinct conflict still earns both nudges', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const dev = makeAgent({ name: 'Dev', role: 'specialist', status: 'running' });
    const h = makeHarness([lead, dev]);
    h.briefConflicts.set('Dev', 'first conflict');

    // Schedule a nudge, then resolve the conflict before the microtask runs: it must NOT burn budget.
    conflictApi(h).nudgeLeadOnOpenConflicts('Lead');
    h.briefConflicts.delete('Dev');
    await Promise.resolve();
    expect(h.messageBus.getAllMessages().filter((m) => m.content.includes('UNRESOLVED brief conflicts'))).toHaveLength(0);

    // A later, distinct conflict still gets its full budget of 2 delivered nudges.
    h.briefConflicts.set('Dev2', 'second conflict');
    conflictApi(h).nudgeLeadOnOpenConflicts('Lead');
    conflictApi(h).nudgeLeadOnOpenConflicts('Lead');
    conflictApi(h).nudgeLeadOnOpenConflicts('Lead'); // over budget
    await Promise.resolve();
    expect(h.messageBus.getAllMessages().filter((m) => m.content.includes('UNRESOLVED brief conflicts'))).toHaveLength(2);
  });

  it('team_request_revision clears the flagged specialist conflict (a revision IS the reconcile)', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const dev = makeAgent({ name: 'Dev', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, dev]);
    h.confirmedComplete.add('Dev');
    conflictApi(h).flagBriefConflict('Dev', 'a real conflict detail');
    conflictApi(h).requestRevision('Dev', 'rework to match the brief async pipeline');
    expect(conflictApi(h).getOpenBriefConflicts()).toEqual([]);
  });

  it('nudges the lead on turn-end while a conflict is open, bounded to 2', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const dev = makeAgent({ name: 'Dev', role: 'specialist', status: 'running' });
    const h = makeHarness([lead, dev]);
    h.briefConflicts.set('Dev', 'async vs sync mismatch');

    conflictApi(h).nudgeLeadOnOpenConflicts('Lead');
    conflictApi(h).nudgeLeadOnOpenConflicts('Lead');
    conflictApi(h).nudgeLeadOnOpenConflicts('Lead'); // 3rd is over budget — must not send
    await Promise.resolve();

    const nudges = h.messageBus.getAllMessages().filter((m) => m.to === 'Lead' && m.content.includes('UNRESOLVED brief conflicts'));
    expect(nudges).toHaveLength(2);
    expect(nudges[0].content).toContain('Dev (async vs sync mismatch)');
  });

  it('does not nudge when no conflict is open', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const dev = makeAgent({ name: 'Dev', role: 'specialist', status: 'running' });
    const h = makeHarness([lead, dev]);
    conflictApi(h).nudgeLeadOnOpenConflicts('Lead');
    await Promise.resolve();
    const nudges = h.messageBus.getAllMessages().filter((m) => m.content.includes('UNRESOLVED brief conflicts'));
    expect(nudges).toEqual([]);
  });

  it('synthesizeResult FAILS LOUD — prepends the unresolved block when a conflict is still open', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const dev = makeAgent({ name: 'Dev', role: 'specialist', status: 'awaiting-review' });
    let finalResult: string | null = null;
    const h = makeHarness([lead, dev]);
    (h.runner as unknown as { completionResolve: (r: string) => void }).completionResolve = (r) => { finalResult = r; };
    h.briefConflicts.set('Dev', 'brief mandates async; result is sync');

    conflictApi(h).synthesizeResult('The team built a synchronous endpoint.');

    expect(finalResult).toContain('⚠️ UNRESOLVED BRIEF CONFLICTS');
    expect(finalResult).toContain('Dev: brief mandates async; result is sync');
    expect(finalResult).toContain('The team built a synchronous endpoint.');
  });

  it('synthesizeResult passes the result through unchanged when no conflict is open', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const dev = makeAgent({ name: 'Dev', role: 'specialist', status: 'awaiting-review' });
    let finalResult: string | null = null;
    const h = makeHarness([lead, dev]);
    (h.runner as unknown as { completionResolve: (r: string) => void }).completionResolve = (r) => { finalResult = r; };

    conflictApi(h).synthesizeResult('Clean result.');

    expect(finalResult).toBe('Clean result.');
    expect(finalResult).not.toContain('UNRESOLVED BRIEF CONFLICTS');
  });

  it('conflict nudge does NOT perturb stranded-standby bookkeeping (non-interference)', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const a = makeAgent({ name: 'A', role: 'specialist', status: 'awaiting-review' });
    const b = makeAgent({ name: 'B', role: 'specialist', status: 'standby' });
    const h = makeHarness([lead, a, b]);
    h.confirmedComplete.add('A');
    h.pendingStandby.add('B');
    h.briefConflicts.set('A', 'a conflict detail');

    // Fire the conflict nudge AND the standby recovery in the same tick.
    conflictApi(h).nudgeLeadOnOpenConflicts('Lead');
    h.resolve();
    await Promise.resolve();

    // Standby recovery is unaffected: B was nudged (its own idiom), still standby, delivered flag set.
    expect(bMessages(h, 'B')).toHaveLength(1);
    expect(bMessages(h, 'B')[0]).toContain('call team_report_complete now');
    expect(h.nudgeDelivered.has('B')).toBe(true);
    expect(b.status).toBe('standby');
    // And the lead got exactly one conflict nudge, separate from B's standby nudge.
    const leadNudges = h.messageBus.getAllMessages().filter((m) => m.to === 'Lead' && m.content.includes('UNRESOLVED brief conflicts'));
    expect(leadNudges).toHaveLength(1);
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

  /**
   * The reviewer's "fix first": the individual pieces (conflict flag, bounded nudge, stranded-standby
   * recovery, fail-loud completion) are each unit-tested, but a regression could reintroduce a HANG in
   * their INTERACTION. This drives the real closures end to end: a specialist flags a brief conflict then
   * parks in standby (its promise.then never fires); the lead, per the adversarial D2 brief, never
   * resolves. The team must still TERMINATE — via the lead settling through synthesizeResult — and that
   * completion must carry the fail-loud unresolved block, never leave the completionPromise pending.
   */
  it('does not hang when a flagged conflict is left open and the lead ends without resolving (fail-loud terminates)', async () => {
    const { runner, runs } = makeWiringRunner(['Scout']);

    // Capture the terminal completion the run() await hangs on — proving the team resolves, not hangs.
    let completion: string | null = null;
    (runner as unknown as { completionResolve: (r: string) => void }).completionResolve = (r) => { completion = r; };

    runner.startSpecialist('Scout', 'task for Scout that is descriptive enough');
    await Promise.resolve();
    await Promise.resolve();
    const scout = runs.get('Scout')!;
    const runnerApi = runner as unknown as {
      flagBriefConflict: (n: string, d: string) => void;
      synthesizeResult: (r: string) => void;
      briefConflicts: Map<string, string>;
      agents: Map<string, TeamAgent>;
    };

    // Scout flags a HARD-STOP conflict then parks in standby as its final action (no running peer left).
    runnerApi.flagBriefConflict('Scout', 'brief mandates async pipeline; contract is a sync toy');
    runner.enterStandby('Scout');
    scout.config.onTurnEnd!();
    await Promise.resolve();

    // Stranded-standby recovery must surface Scout for the lead rather than leaving it unwakeable.
    // (deliver nudge microtask, then let the converted re-standby settle exactly as the wiring test does)
    scout.config.onKeepAliveResume!();
    runner.enterStandby('Scout');
    scout.config.onTurnEnd!();
    expect(runnerApi.agents.get('Scout')!.status).toBe('awaiting-review');

    // The lead, told not to resolve, simply ends: the lead promise settles and run() funnels the finish
    // through synthesizeResult. Simulate that terminal call directly (the lead-promise.then path).
    expect(runnerApi.briefConflicts.size).toBe(1); // conflict is still open at completion time
    runnerApi.synthesizeResult('Lead ended without resolving the conflict.');

    // TERMINATED (not hung) AND fail-loud: the completion carries the unresolved banner.
    expect(completion).not.toBeNull();
    expect(completion!).toContain('⚠️ UNRESOLVED BRIEF CONFLICTS');
    expect(completion!).toContain('Scout: brief mandates async pipeline; contract is a sync toy');

    // settle the captured specialist promise so no dangling handle remains
    scout.resolve({ status: 'completed' as const, finalResponse: null, toolCallCount: 0, durationMs: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 });
  });
});
