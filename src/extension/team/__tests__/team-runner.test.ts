import { describe, it, expect } from 'vitest';
import { TeamRunner } from '../team-runner';
import { MessageBus } from '../message-bus';
import { Scratchpad } from '../scratchpad';
import type { TeamConfig, TeamAgent, AgentRunConfig, TeamRole, AgentMcpContext, AgentResult } from '../types';
import { type NestedMcpToolset } from '../../pi-session/tools/mcp-tools';
import { teamAgentToolset, TEAM_BASE_TOOL_NAMES, TEAM_MCP_NAMES } from './team-mcp-fixture';

/**
 * Lightweight harness for the stranded-standby recovery path (the team-deadlock fix). It injects the
 * private collaborators TeamRunner normally builds in run() so the private settle-path recovery can be
 * driven directly, without a live pi engine.
 */
function makeAgent(partial: Partial<TeamAgent> & { name: string; role: TeamAgent['role'] }): TeamAgent {
  return {
    agentId: `id-${partial.name}`,
    teamId: 'team-1',
    attempt: 0,
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
    carriedUsage: { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
    dollarBilled: true,
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
  owedTerminalAction: Set<string>;
  terminalNudgeScheduled: Set<string>;
  terminalNudgeDelivered: Set<string>;
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
  const owedTerminalAction = inject(target, 'owedTerminalAction', new Set<string>());
  const terminalNudgeScheduled = inject(target, 'terminalNudgeScheduled', new Set<string>());
  const terminalNudgeDelivered = inject(target, 'terminalNudgeDelivered', new Set<string>());
  const specialistReviewRounds = inject(target, 'specialistReviewRounds', new Map<string, number>());
  const briefConflicts = inject(target, 'briefConflicts', new Map<string, string>());
  inject(target, 'conflictNudges', 0);
  inject(target, 'leadReviewStalls', 0);
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
    pendingStandby, confirmedComplete, nudgeScheduled, nudgeDelivered,
    owedTerminalAction, terminalNudgeScheduled, terminalNudgeDelivered,
    specialistReviewRounds, briefConflicts, resolve,
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
    expect(nudges[0]!.content).toContain('Dev (async vs sync mismatch)');
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
/** A private TeamRunner collaborator, failing loudly rather than widening to `undefined`. */
function privateField<T>(runner: TeamRunner, key: string): T {
  const value = (runner as unknown as Record<string, unknown>)[key];
  if (value === undefined) throw new Error(`TeamRunner has no '${key}' field`);
  return value as T;
}

interface CapturedRun {
  config: AgentRunConfig;
  resolve: (result: unknown) => void;
  /** Reject the run the way a THROWN agent failure does — the runner's `.catch` teardown branch. */
  reject: (error: unknown) => void;
}

function makeWiringRunner(names: string[]): { runner: TeamRunner; runs: Map<string, CapturedRun>; sentToLead: string[]; messageBus: MessageBus; disposedScopes: Array<[string, boolean]>; cancelledDialogs: string[]; boundScopes: string[]; mcpContexts: AgentMcpContext[]; factoryMcpSnapshots: NestedMcpToolset[]; toolsetSnapshots: NestedMcpToolset[]; sessionOpts: Array<Record<string, unknown>> } {
  const runs = new Map<string, CapturedRun>();
  const sentToLead: string[] = [];
  const disposedScopes: Array<[string, boolean]> = [];
  const cancelledDialogs: string[] = [];
  const boundScopes: string[] = [];
  /** Every per-spawn `AgentMcpContext`, so the identity a nested dialog is attributed to is observable. */
  const mcpContexts: AgentMcpContext[] = [];
  /** The `mcp` snapshot each spawn threaded into `buildExtensionFactory`, so the runner can be held
   *  to ONE `buildAgentToolset` call per spawn whose result reaches BOTH consumers (brief §3.2). */
  const factoryMcpSnapshots: NestedMcpToolset[] = [];
  const sessionOpts: Array<Record<string, unknown>> = [];
  const toolsetSnapshots: NestedMcpToolset[] = [];

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
    resolveRoleModel: (role: TeamRole) => ({ modelLabel: role === 'lead' ? 'lead-model' : 'spec-model' }),
    engine: {
      createSession: async (opts: Record<string, unknown>) => { sessionOpts.push(opts); return {} as never; },
      forgetSession: () => undefined,
      // The REAL `TeamEngine` shape: ONE call per spawn returning names + customTools + the frozen MCP
      // snapshot, and `buildExtensionFactory` receiving that SAME snapshot as its third argument. The
      // snapshot is NON-EMPTY and built by the real builder, which is what makes the spawn site's use
      // of it observable at all — see `team-mcp-fixture.ts` for why an empty one proved nothing.
      buildAgentToolset: (ctx: AgentMcpContext) => {
        boundScopes.push(ctx.browserScopeId);
        mcpContexts.push(ctx);
        const { toolNames, customTools, mcp } = teamAgentToolset();
        toolsetSnapshots.push(mcp);
        return { toolNames, customTools, mcp };
      },
      buildExtensionFactory: (_agentName: string, _agentId: string, mcp: NestedMcpToolset) => {
        factoryMcpSnapshots.push(mcp);
        return (() => undefined) as never;
      },
      onAgentCost: () => undefined,
      disposeBrowserScope: (browserScopeId: string, closeTabs: boolean) => disposedScopes.push([browserScopeId, closeTabs]),
      // Slice 2: a team agent's MCP tools elicit on the parent panel, so its teardown must withdraw
      // those dialogs. Recorded (not a silent no-op) so deleting the call fails a test.
      cancelAgentDialogs: (agentId: string) => cancelledDialogs.push(agentId),
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
    startAgent: (cfg: AgentRunConfig) => new Promise((resolve, reject) => { runs.set(cfg.name, { config: cfg, resolve, reject }); }),
  };

  const agentMap = target['agents'] as Map<string, TeamAgent>;
  for (const spec of config.agents) {
    agentMap.set(spec.name, makeAgent({ name: spec.name, role: spec.role, status: 'pending' }));
  }

  return { runner, runs, sentToLead, messageBus, disposedScopes, cancelledDialogs, boundScopes, mcpContexts, factoryMcpSnapshots, toolsetSnapshots, sessionOpts };
}

describe('TeamRunner — per-agent browser scope disposal (success-only auto-close)', () => {
  const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
  const result = (status: 'completed' | 'failed' | 'cancelled', agentId = 'A'): AgentResult => ({
    agentId, status, finalResponse: status === 'completed' ? 'ok' : null, toolCallCount: 0, durationMs: 0,
    totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
  });
  const agentOf = (runner: TeamRunner, name: string): TeamAgent =>
    (runner as unknown as { agents: Map<string, TeamAgent> }).agents.get(name)!;

  it('one buildAgentToolset per spawn, and THAT snapshot is what buildExtensionFactory receives', async () => {
    // Brief §3.2: exactly one `getAllToolDescriptors()` read per spawn, and every consumer derives from
    // it. `TeamRunner` is the only place that can break that on the team path — it composes `tools:`,
    // `customTools:` and the extension factory in one object literal, which is exactly where three
    // independent live reads used to sit. Asserted by IDENTITY (`toBe`), not by value: two separate
    // builds over an unchanged manager are deep-equal and would pass a `toEqual`, so only object
    // identity can tell "threaded the same snapshot" from "read it twice". That check is only
    // meaningful because the fixture allocates a fresh object per call — against the shared empty
    // singleton it used to use, identity held across independent reads and the assertion could not fail.
    const { runner, runs, factoryMcpSnapshots, toolsetSnapshots, sessionOpts } = makeWiringRunner(['A']);
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    await settle();
    // The runner composes the spawn INSIDE `createSession`; the stubbed AgentRunner never calls it, so
    // drive the real closure the runner built — that is the object literal under test.
    await runs.get('A')!.config.createSession();

    expect(toolsetSnapshots).toHaveLength(1);
    expect(factoryMcpSnapshots).toHaveLength(1);
    expect(factoryMcpSnapshots[0]).toBe(toolsetSnapshots[0]);

    // …and the snapshot actually reached the session options. Identity alone would still pass if the
    // spawn threaded the right object into the factory and then dropped it from `tools:`/`customTools`.
    const opts = sessionOpts[0]!;
    expect(opts['tools']).toEqual([...TEAM_BASE_TOOL_NAMES, ...TEAM_MCP_NAMES]);
    expect((opts['customTools'] as { name: string }[]).map((t) => t.name)).toEqual(expect.arrayContaining(TEAM_MCP_NAMES));

    runs.get('A')!.resolve(result('completed'));
    await settle();
  });

  it('closes a specialist\'s tab(s) on successful completion (closeTabs=true)', async () => {
    const { runner, runs, disposedScopes } = makeWiringRunner(['A']);
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    await settle();
    const agent = agentOf(runner, 'A');

    runs.get('A')!.resolve(result('completed'));
    await settle();

    expect(disposedScopes).toContainEqual([`${agent.agentId}#0`, true]);
  });

  it('KEEPS a failed specialist\'s tab(s) open (closeTabs=false)', async () => {
    const { runner, runs, disposedScopes } = makeWiringRunner(['A']);
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    await settle();
    const agent = agentOf(runner, 'A');

    runs.get('A')!.resolve(result('failed'));
    await settle();

    expect(disposedScopes).toContainEqual([`${agent.agentId}#0`, false]);
    expect(disposedScopes).not.toContainEqual([`${agent.agentId}#0`, true]);
  });

  it('gives a redispatched specialist a FRESH scope, so a retry never adopts or closes the failed attempt\'s tabs', async () => {
    const { runner, runs, disposedScopes, boundScopes } = makeWiringRunner(['A']);
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    await settle();
    const agent = agentOf(runner, 'A');
    const firstScope = `${agent.agentId}#0`;
    const secondScope = `${agent.agentId}#1`;
    // The runner builds an agent's tools inside createSession; the stubbed AgentRunner never calls it.
    const buildTools = async (): Promise<void> => { await runs.get('A')!.config.createSession(); };

    await buildTools();
    runs.get('A')!.resolve(result('failed'));
    await settle();
    expect(disposedScopes).toContainEqual([firstScope, false]); // attempt 0's tabs kept for inspection

    runner.redispatchSpecialist('A', 'retry the task with a fresh attempt');
    await settle();
    await buildTools();
    expect(agentOf(runner, 'A').agentId).toBe(agent.agentId); // the card/transcript key is preserved
    expect(boundScopes).toEqual([firstScope, secondScope]); // but the browser tools bind to a new scope

    runs.get('A')!.resolve(result('completed'));
    await settle();

    // The successful retry closes ONLY its own scope; attempt 0's kept tabs survive as evidence.
    expect(disposedScopes).toContainEqual([secondScope, true]);
    expect(disposedScopes).not.toContainEqual([firstScope, true]);
  });

  /**
   * Slice 2 — a specialist's MCP tools elicit on the parent panel under that specialist's name. When
   * the specialist ends, whatever it left on screen names an agent that no longer exists and blocks a
   * call that is already gone, so teardown must withdraw it on EVERY exit path.
   */
  it('withdraws a completed specialist\'s panel dialogs, keyed by agentId (not the browser scope id)', async () => {
    const { runner, runs, cancelledDialogs } = makeWiringRunner(['A']);
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    await settle();
    const agent = agentOf(runner, 'A');

    runs.get('A')!.resolve(result('completed'));
    await settle();

    expect(cancelledDialogs).toContain(agent.agentId);
    // The scope id is per-ATTEMPT (`agentId#N`); a redispatch mints a new one while the dialogs stay
    // owned by the agent. Cancelling by scope id would silently miss them after the first retry.
    expect(cancelledDialogs).not.toContain(`${agent.agentId}#0`);
  });

  it('withdraws a FAILED specialist\'s dialogs too — the exit path most likely to have one open', async () => {
    const { runner, runs, cancelledDialogs } = makeWiringRunner(['A']);
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    await settle();
    const agent = agentOf(runner, 'A');

    runs.get('A')!.resolve(result('failed'));
    await settle();

    expect(cancelledDialogs).toContain(agent.agentId);
  });

  it('withdraws each attempt\'s dialogs on redispatch, so a retry never inherits a stale modal', async () => {
    const { runner, runs, cancelledDialogs } = makeWiringRunner(['A']);
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    await settle();
    const agent = agentOf(runner, 'A');

    runs.get('A')!.resolve(result('failed'));
    await settle();
    runner.redispatchSpecialist('A', 'retry the task with a fresh attempt');
    await settle();
    runs.get('A')!.resolve(result('completed'));
    await settle();

    expect(cancelledDialogs.filter((id) => id === agent.agentId)).toHaveLength(2);
  });

  it('withdraws them when the agent run THROWS (the catch branch, not the settle branch)', async () => {
    // A thrown run never reaches the settle handler, so its teardown lives in a separate `.catch`. That
    // branch is the one that gets forgotten — and a crashed specialist is precisely the case where a
    // dialog is still on screen with the call behind it already dead.
    const { runner, runs, cancelledDialogs, disposedScopes } = makeWiringRunner(['A']);
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    await settle();
    const agent = agentOf(runner, 'A');

    runs.get('A')!.reject(new Error('agent crashed'));
    await settle();

    expect(agentOf(runner, 'A').status).toBe('failed');
    expect(disposedScopes).toContainEqual([`${agent.agentId}#0`, false]); // the paired browser teardown
    expect(cancelledDialogs).toContain(agent.agentId);
  });

  it('hands each spawn the identity its panel dialogs are attributed to (agentId, agentName, teamId)', async () => {
    // Attribution is only useful if it identifies the agent the USER sees in the team panel. The name
    // here is the roster name; `teamId` is what lets the webview tie the modal back to the team card.
    const { runner, runs, mcpContexts } = makeWiringRunner(['A']);
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    await settle();
    await runs.get('A')!.config.createSession();
    const agent = agentOf(runner, 'A');

    expect(mcpContexts.at(-1)).toMatchObject({ agentId: agent.agentId, agentName: 'A', teamId: 'team-1' });

    runs.get('A')!.resolve(result('completed'));
    await settle();
  });

  it('does not withdraw a still-running specialist\'s dialogs', async () => {
    // The whole point is an interruption the user can ANSWER; cancelling a live agent's prompt would
    // hand the server a cancel it never earned — the defect this slice removes, reintroduced downstream.
    const { runner, runs, cancelledDialogs } = makeWiringRunner(['A']);
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    await settle();

    expect(cancelledDialogs).toEqual([]);

    runs.get('A')!.resolve(result('completed'));
    await settle();
  });
});

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
    runner.reportComplete('B', 'sign-off from B');
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

/**
 * Terminal-contract wiring (Slice A — the 75-min-deadlock root fix). Drives the REAL specialist
 * AgentRunConfig closures TeamRunner builds in startSpecialist (keepAlive / onTurnEnd /
 * onKeepAliveResume / onReconcileBeforeEnd, captured via the stubbed agentRunner) to prove a specialist
 * that ends a turn owing a terminal action (neither team_report_complete nor team_standby) is nudged
 * once (deferred) + given one grace turn, then converted to awaiting-review — NEVER left terminal
 * `completed`. Each test replays the agent-runner loop by hand: at a bare turn-end keepAlive() is false,
 * so the runner calls onReconcileBeforeEnd then re-checks keepAlive to decide park-vs-break.
 */
const DONE_RESULT = { status: 'completed' as const, finalResponse: null, toolCallCount: 0, durationMs: 0, totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };

describe('TeamRunner terminal-contract wiring (bare turn-end recovery)', () => {
  function agentsOf(runner: TeamRunner): Map<string, TeamAgent> {
    return (runner as unknown as { agents: Map<string, TeamAgent> }).agents;
  }
  function setOf(runner: TeamRunner, key: string): Set<string> {
    return privateField<Set<string>>(runner, key);
  }

  it('INCIDENT REPRO: a lone specialist ending bare is nudged once (deferred) then converted — never completed', async () => {
    const { runner, runs, sentToLead, messageBus } = makeWiringRunner(['Solo']);
    const soloMsgs: string[] = [];
    messageBus.subscribe((m) => { if (m.to === 'Solo') soloMsgs.push(m.content); });
    runner.startSpecialist('Solo', 'task for Solo that is descriptive enough');
    await Promise.resolve();
    await Promise.resolve();
    const solo = runs.get('Solo')!;
    const agents = agentsOf(runner);
    const cfg = solo.config;

    expect(agents.get('Solo')!.status).toBe('running');

    // --- Bare turn-end #1: keepAlive false → runner calls onReconcileBeforeEnd → classify 'nudge'.
    expect(cfg.keepAlive!()).toBe(false);
    cfg.onReconcileBeforeEnd!();
    // The hold is armed synchronously → the runner's keepAlive re-check is now TRUE → it PARKS, not ends.
    expect(cfg.keepAlive!()).toBe(true);
    expect(setOf(runner, 'owedTerminalAction').has('Solo')).toBe(true);
    // Nudge is NOT delivered synchronously (lost-wakeup rule) and not yet flagged delivered.
    expect(soloMsgs).toEqual([]);
    expect(setOf(runner, 'terminalNudgeDelivered').has('Solo')).toBe(false);
    // Status is still running — CRUCIALLY never 'completed'.
    expect(agents.get('Solo')!.status).toBe('running');

    // Flush the microtask → the deferred nudge is delivered and the delivered flag is set inside it.
    await Promise.resolve();
    expect(soloMsgs).toHaveLength(1);
    expect(soloMsgs[0]).toContain('You ended a turn without a terminal action');
    expect(setOf(runner, 'terminalNudgeDelivered').has('Solo')).toBe(true);
    expect(agents.get('Solo')!.status).toBe('running');

    // --- Wake for the grace turn: onKeepAliveResume clears owedTerminalAction but NOT the delivered flag.
    cfg.onKeepAliveResume!();
    expect(setOf(runner, 'owedTerminalAction').has('Solo')).toBe(false);
    expect(setOf(runner, 'terminalNudgeDelivered').has('Solo')).toBe(true);
    expect(agents.get('Solo')!.status).toBe('running');

    // --- Bare turn-end #2 (re-offense): keepAlive false again → reconcile → classify 'convert'.
    expect(cfg.keepAlive!()).toBe(false);
    cfg.onReconcileBeforeEnd!();
    expect(agents.get('Solo')!.status).toBe('awaiting-review');
    expect(setOf(runner, 'confirmedComplete').has('Solo')).toBe(true);
    expect(sentToLead.some((m) => m.includes('[REVIEW ROUND READY]'))).toBe(true);
    // Post-convert liveness: keepAlive is true (confirmedComplete, rounds < MAX) → session stays parked/alive.
    expect(cfg.keepAlive!()).toBe(true);

    // Only one nudge was ever delivered across the whole episode.
    expect(soloMsgs.filter((m) => m.includes('You ended a turn without a terminal action'))).toHaveLength(1);

    solo.resolve(DONE_RESULT);
  });

  it('DISCHARGE: after nudge + resume, a grace turn calling team_report_complete settles via the normal onTurnEnd path (no spurious convert)', async () => {
    const { runner, runs, sentToLead } = makeWiringRunner(['Solo']);
    runner.startSpecialist('Solo', 'task for Solo that is descriptive enough');
    await Promise.resolve();
    await Promise.resolve();
    const solo = runs.get('Solo')!;
    const agents = agentsOf(runner);
    const cfg = solo.config;

    // Bare end #1 → nudge armed + delivered.
    cfg.onReconcileBeforeEnd!();
    await Promise.resolve();
    expect(setOf(runner, 'terminalNudgeDelivered').has('Solo')).toBe(true);

    // Wake, then the grace turn ends with a LEGITIMATE team_report_complete.
    cfg.onKeepAliveResume!();
    runner.reportComplete('Solo', 'sign-off from Solo');
    // Discharge: the owed hold is gone; the nudge-tracking sets are untouched by resume/reportComplete.
    expect(setOf(runner, 'owedTerminalAction').has('Solo')).toBe(false);
    expect(setOf(runner, 'terminalNudgeScheduled').has('Solo')).toBe(true);
    expect(setOf(runner, 'terminalNudgeDelivered').has('Solo')).toBe(true);

    // keepAlive is now true via confirmedComplete → the runner never reaches reconcile; onTurnEnd runs.
    expect(cfg.keepAlive!()).toBe(true);
    cfg.onTurnEnd!();
    expect(agents.get('Solo')!.status).toBe('awaiting-review');
    // Exactly one review-round notification (normal path), no spurious convert double-transition.
    expect(sentToLead.filter((m) => m.includes('[REVIEW ROUND READY]'))).toHaveLength(1);

    solo.resolve(DONE_RESULT);
  });

  it('CEILING: a specialist at MAX_SPECIALIST_REVIEW_ROUNDS ending bare gets no nudge, no convert (completes as designed)', async () => {
    const { runner, runs, sentToLead } = makeWiringRunner(['Solo']);
    runner.startSpecialist('Solo', 'task for Solo that is descriptive enough');
    await Promise.resolve();
    await Promise.resolve();
    const solo = runs.get('Solo')!;
    const agents = agentsOf(runner);
    const cfg = solo.config;

    // Drive to the review-round ceiling (MAX_SPECIALIST_REVIEW_ROUNDS = 2).
    (runner as unknown as { specialistReviewRounds: Map<string, number> }).specialistReviewRounds.set('Solo', 2);

    expect(cfg.keepAlive!()).toBe(false);
    cfg.onReconcileBeforeEnd!();
    // classify 'not-owed' at the ceiling → no hold, no nudge scheduled, no convert. keepAlive stays false.
    expect(setOf(runner, 'owedTerminalAction').has('Solo')).toBe(false);
    expect(setOf(runner, 'terminalNudgeScheduled').has('Solo')).toBe(false);
    expect(cfg.keepAlive!()).toBe(false);
    await Promise.resolve();
    expect(setOf(runner, 'terminalNudgeDelivered').has('Solo')).toBe(false);
    expect(agents.get('Solo')!.status).toBe('running'); // status unchanged by reconcile; runner will break/end
    expect(sentToLead.some((m) => m.includes('[REVIEW ROUND READY]'))).toBe(false);

    solo.resolve(DONE_RESULT);
  });

  it('MUTUAL EXCLUSION: a specialist in standby keeps keepAlive true via pendingStandby (reconcile is never reached); enterStandby/reportComplete each clear owedTerminalAction', async () => {
    const { runner, runs } = makeWiringRunner(['Solo']);
    runner.startSpecialist('Solo', 'task for Solo that is descriptive enough');
    await Promise.resolve();
    await Promise.resolve();
    const solo = runs.get('Solo')!;
    const cfg = solo.config;

    // team_standby → pendingStandby set → keepAlive true, so the runner never calls onReconcileBeforeEnd.
    runner.enterStandby('Solo');
    expect(setOf(runner, 'pendingStandby').has('Solo')).toBe(true);
    expect(cfg.keepAlive!()).toBe(true);
    // owed and standby are mutually exclusive — enterStandby cleared any owed hold.
    expect(setOf(runner, 'owedTerminalAction').has('Solo')).toBe(false);

    // Directly assert the discharge invariant both terminal actions honor: seed an owed hold, then each
    // legitimate terminal action deletes it, so the two sets are never both populated for one name.
    setOf(runner, 'owedTerminalAction').add('Solo');
    runner.enterStandby('Solo');
    expect(setOf(runner, 'owedTerminalAction').has('Solo')).toBe(false);

    // Re-run for reportComplete: bring Solo back to running (leave standby) and seed the hold again.
    setOf(runner, 'pendingStandby').delete('Solo');
    agentsOf(runner).get('Solo')!.status = 'running';
    setOf(runner, 'owedTerminalAction').add('Solo');
    runner.reportComplete('Solo', 'sign-off from Solo');
    expect(setOf(runner, 'owedTerminalAction').has('Solo')).toBe(false);
    expect(setOf(runner, 'pendingStandby').has('Solo')).toBe(false);

    solo.resolve(DONE_RESULT);
  });

  it('NON-INTERFERENCE: a stranded standby peer is recovered independently in the same tick a terminal-contract convert fires', async () => {
    const { runner, runs, sentToLead, messageBus } = makeWiringRunner(['A', 'B']);
    const aMsgs: string[] = [];
    messageBus.subscribe((m) => { if (m.to === 'A') aMsgs.push(m.content); });
    runner.startSpecialist('A', 'task for A that is descriptive enough');
    runner.startSpecialist('B', 'task for B that is descriptive enough');
    await Promise.resolve();
    await Promise.resolve();
    const a = runs.get('A')!;
    const b = runs.get('B')!;
    const agents = agentsOf(runner);

    // A parks in standby while B still runs (not stranded yet — B is a running peer).
    runner.enterStandby('A');
    a.config.onTurnEnd!();
    expect(agents.get('A')!.status).toBe('standby');

    // B ends bare, already nudged once → its reconcile converts it to awaiting-review. That convert calls
    // resolveStrandedStandbys(), which must independently recover A (now stranded — no running peer left).
    setOf(runner, 'terminalNudgeDelivered').add('B');
    expect(b.config.keepAlive!()).toBe(false);
    b.config.onReconcileBeforeEnd!();

    expect(agents.get('B')!.status).toBe('awaiting-review');
    // A's stranded-standby recovery ran in the same tick: it is nudged (its own path), independent of B.
    expect(setOf(runner, 'nudgeScheduled').has('A')).toBe(true);
    await Promise.resolve();
    // A got its OWN stranded-standby nudge independently of B's terminal-contract convert.
    expect(aMsgs.some((m) => m.includes('call team_report_complete now'))).toBe(true);
    expect(agents.get('A')!.status).toBe('standby'); // A nudged, not yet converted — its own cadence
    // The review round is NOT ready yet: A hasn't settled, so no premature [REVIEW ROUND READY].
    expect(sentToLead.some((m) => m.includes('[REVIEW ROUND READY]'))).toBe(false);

    a.resolve(DONE_RESULT);
    b.resolve(DONE_RESULT);
  });

  it('MICROTASK GUARD: a specialist that discharges (reportComplete) before the scheduled nudge microtask runs gets no nudge delivered', async () => {
    const { runner, runs, messageBus } = makeWiringRunner(['Solo']);
    const soloMsgs: string[] = [];
    messageBus.subscribe((m) => { if (m.to === 'Solo') soloMsgs.push(m.content); });
    runner.startSpecialist('Solo', 'task for Solo that is descriptive enough');
    await Promise.resolve();
    await Promise.resolve();
    const solo = runs.get('Solo')!;
    const cfg = solo.config;

    // Bare end schedules the deferred nudge (owedTerminalAction armed, microtask queued).
    cfg.onReconcileBeforeEnd!();
    expect(setOf(runner, 'owedTerminalAction').has('Solo')).toBe(true);

    // BEFORE the microtask runs, Solo discharges via team_report_complete → owedTerminalAction cleared.
    runner.reportComplete('Solo', 'sign-off from Solo');
    expect(setOf(runner, 'owedTerminalAction').has('Solo')).toBe(false);

    // The microtask guard sees owedTerminalAction gone → returns early: no nudge, no delivered flag.
    await Promise.resolve();
    expect(soloMsgs).toEqual([]);
    expect(setOf(runner, 'terminalNudgeDelivered').has('Solo')).toBe(false);

    solo.resolve(DONE_RESULT);
  });
});

/**
 * Role-model resolution wiring (Slice 1): startSpecialist resolves the role slot via
 * `config.resolveRoleModel(kind ?? 'implementor')`, threading the resolved model + thinkingLevel into the
 * engine's createSession opts, and throws up front when the resolver returns a blocking `.error`.
 */
interface ResolvedRoleModel {
  model?: unknown;
  modelLabel?: string;
  thinkingLevel?: string;
  error?: string;
}

function makeModelWiringRunner(
  resolveRoleModel: (role: TeamRole) => ResolvedRoleModel,
): { runner: TeamRunner; runs: Map<string, CapturedRun>; sessionOpts: Map<string, Record<string, unknown>> } {
  const runs = new Map<string, CapturedRun>();
  const sessionOpts = new Map<string, Record<string, unknown>>();
  let currentName = '';

  const config = {
    teamId: 'team-1',
    title: 'model-wire',
    cwd: '/cwd',
    persistenceSessionId: 'sess',
    permissionMode: 'default' as const,
    agents: [
      { name: 'Lead', role: 'lead' as const },
      { name: 'Rev', role: 'specialist' as const },
    ],
    resolveRoleModel,
    engine: {
      createSession: async (opts: Record<string, unknown>) => { sessionOpts.set(currentName, opts); return {} as never; },
      forgetSession: () => undefined,
      // The REAL `TeamEngine` shape: ONE call per spawn returning names + customTools + the frozen MCP
      // snapshot, and `buildExtensionFactory` receiving that SAME snapshot as its third argument. The
      // empty snapshot here is the REAL `buildNestedMcpToolset(pi, null, …)` value, not a hand-written
      // stand-in — a fake that returned `{}` or dropped the third arg would fake away exactly the
      // `tools:` ⟺ `customTools` correspondence acceptance criterion 1 exists to catch (brief §4.9).
      buildAgentToolset: () => {
        const { toolNames, customTools, mcp } = teamAgentToolset();
        return { toolNames, customTools, mcp };
      },
      buildExtensionFactory: (_agentName: string, _agentId: string, _mcp: NestedMcpToolset) => (() => undefined) as never,
      onAgentCost: () => undefined,
      disposeBrowserScope: () => undefined,
      cancelAgentDialogs: () => undefined,
    },
  } as unknown as TeamConfig;

  const runner = new TeamRunner(config, () => undefined);
  const target = runner as unknown as Record<string, unknown>;
  const messageBus = new MessageBus('team-1');
  target['messageBus'] = messageBus;
  target['scratchpad'] = new Scratchpad();
  target['persistence'] = { initAgentFile: async () => undefined, appendAgentEntry: () => undefined, appendTeamEntry: () => undefined, flush: async () => undefined };
  target['agentRunner'] = {
    startAgent: (cfg: AgentRunConfig) => {
      // Invoke the real createSession closure TeamRunner built so its resolved opts are captured.
      currentName = cfg.name;
      void cfg.createSession();
      return new Promise((resolve, reject) => { runs.set(cfg.name, { config: cfg, resolve, reject }); });
    },
  };

  const agentMap = target['agents'] as Map<string, TeamAgent>;
  for (const spec of config.agents) {
    agentMap.set(spec.name, makeAgent({ name: spec.name, role: spec.role, status: 'pending' }));
  }

  return { runner, runs, sessionOpts };
}

describe('TeamRunner role-model resolution wiring', () => {
  it('resolves the reviewer slot on a kind:reviewer spawn — session opts carry the reviewer model + thinkingLevel', async () => {
    const reviewerModel = { id: 'gpt-5.6-sol' };
    const { runner, sessionOpts } = makeModelWiringRunner((role) =>
      role === 'reviewer'
        ? { model: reviewerModel, modelLabel: 'GPT-5.6 Sol', thinkingLevel: 'max' }
        : { modelLabel: role === 'lead' ? 'lead-model' : 'impl-model' },
    );

    runner.startSpecialist('Rev', 'review task descriptive enough', undefined, 'reviewer');
    await Promise.resolve();
    await Promise.resolve();

    const opts = sessionOpts.get('Rev');
    expect(opts).toBeDefined();
    expect(opts!.model).toBe(reviewerModel);
    expect(opts!.thinkingLevel).toBe('max');
    // The agent card label reflects the reviewer slot.
    const agents = (runner as unknown as { agents: Map<string, TeamAgent> }).agents;
    expect(agents.get('Rev')!.model).toBe('GPT-5.6 Sol');
  });

  it('throws at spawn time when the resolved role slot returns a blocking .error', () => {
    const { runner } = makeModelWiringRunner((role) =>
      role === 'reviewer'
        ? { error: 'Team role "reviewer" is configured to model "gpt-5.6-sol" (damocles.team.reviewerModel), but that model is not available or its provider is not signed in. Sign in or change the setting.' }
        : { modelLabel: 'ok' },
    );

    expect(() => runner.startSpecialist('Rev', 'review task descriptive enough', undefined, 'reviewer'))
      .toThrow('damocles.team.reviewerModel');
  });

  it('leaves the agent pending (no ghost running agent) when the role slot resolution throws', () => {
    const { runner } = makeModelWiringRunner((role) =>
      role === 'reviewer'
        ? { error: 'Team role "reviewer" is configured to model "gpt-5.6-sol" (damocles.team.reviewerModel), but that model is not available or its provider is not signed in. Sign in or change the setting.' }
        : { modelLabel: 'ok' },
    );

    expect(() => runner.startSpecialist('Rev', 'review task descriptive enough', undefined, 'reviewer')).toThrow();

    // Resolution runs BEFORE any state mutation, so the failed spawn must not strand a running agent:
    // status stays 'pending', it is not counted active, and re-spawn is not blocked by 'already spawned'.
    const agents = (runner as unknown as { agents: Map<string, TeamAgent> }).agents;
    expect(agents.get('Rev')!.status).toBe('pending');
    expect(agents.get('Rev')!.startTime).toBeNull();
    expect(runner.getActiveSpecialistNames()).not.toContain('Rev');
  });
});

/**
 * Slice C — team_redispatch_specialist. Re-run a `failed` or `cancelled` specialist as a FRESH attempt:
 * reuse the same agentId, preserve the prior transcript (no initAgentFile truncate), reset all per-attempt
 * bookkeeping, keep any open briefConflict. Exact guard strings + reattempt entry shape are pinned in the
 * `engine-contract` scratchpad section (as-built) and asserted verbatim below.
 */
interface RedispatchHarness {
  runner: TeamRunner;
  runs: Map<string, CapturedRun>;
  agents: Map<string, TeamAgent>;
  initAgentFileCalls: string[];
  teamEntries: Array<Record<string, unknown>>;
  statusUpdates: Array<{ agentId: string; status: string }>;
  sentToLead: string[];
  messageBus: MessageBus;
  set: (name: string, key: string) => Set<string>;
  map: (name: string) => Map<string, unknown>;
}

/** A wiring runner with spy-able persistence (records initAgentFile calls + appended team entries) so the
 *  transcript-preservation and reattempt-marker contracts can be asserted directly. */
function makeRedispatchHarness(names: string[]): RedispatchHarness {
  const runs = new Map<string, CapturedRun>();
  const initAgentFileCalls: string[] = [];
  const teamEntries: Array<Record<string, unknown>> = [];
  const statusUpdates: Array<{ agentId: string; status: string }> = [];
  const sentToLead: string[] = [];

  const config = {
    teamId: 'team-1',
    title: 'redispatch',
    cwd: '/cwd',
    persistenceSessionId: 'sess',
    permissionMode: 'default' as const,
    agents: [
      { name: 'Lead', role: 'lead' as const },
      ...names.map((n) => ({ name: n, role: 'specialist' as const })),
    ],
    resolveRoleModel: (role: TeamRole) => ({ modelLabel: role === 'lead' ? 'lead-model' : 'spec-model' }),
    engine: {
      createSession: async () => ({}) as never,
      forgetSession: () => undefined,
      // The REAL `TeamEngine` shape: ONE call per spawn returning names + customTools + the frozen MCP
      // snapshot, and `buildExtensionFactory` receiving that SAME snapshot as its third argument. The
      // empty snapshot here is the REAL `buildNestedMcpToolset(pi, null, …)` value, not a hand-written
      // stand-in — a fake that returned `{}` or dropped the third arg would fake away exactly the
      // `tools:` ⟺ `customTools` correspondence acceptance criterion 1 exists to catch (brief §4.9).
      buildAgentToolset: () => {
        const { toolNames, customTools, mcp } = teamAgentToolset();
        return { toolNames, customTools, mcp };
      },
      buildExtensionFactory: (_agentName: string, _agentId: string, _mcp: NestedMcpToolset) => (() => undefined) as never,
      onAgentCost: () => undefined,
      disposeBrowserScope: () => undefined,
      cancelAgentDialogs: () => undefined,
    },
  } as unknown as TeamConfig;

  const runner = new TeamRunner(config, (m) => {
    if (m.type === 'teamAgentStatusUpdate') statusUpdates.push({ agentId: m.agentId, status: m.status });
  });

  const target = runner as unknown as Record<string, unknown>;
  const messageBus = new MessageBus('team-1');
  messageBus.subscribe((m) => { if (m.to === 'Lead') sentToLead.push(m.content); });
  target['messageBus'] = messageBus;
  target['scratchpad'] = new Scratchpad();
  target['persistence'] = {
    initAgentFile: async (_teamId: string, agentId: string) => { initAgentFileCalls.push(agentId); },
    appendAgentEntry: () => undefined,
    appendTeamEntry: (e: Record<string, unknown>) => teamEntries.push(e),
    flush: async () => undefined,
  };
  target['agentRunner'] = {
    startAgent: (cfg: AgentRunConfig) => new Promise((resolve, reject) => { runs.set(cfg.name, { config: cfg, resolve, reject }); }),
  };

  const agents = target['agents'] as Map<string, TeamAgent>;
  for (const spec of config.agents) {
    agents.set(spec.name, makeAgent({
      name: spec.name,
      role: spec.role,
      status: spec.role === 'lead' ? 'monitoring' : 'pending',
    }));
  }

  return {
    runner, runs, agents, initAgentFileCalls, teamEntries, statusUpdates, sentToLead, messageBus,
    set: (_name, key) => privateField<Set<string>>(runner, key),
    map: (key) => privateField<Map<string, unknown>>(runner, key),
  };
}

/** Drive a real fresh spawn (so initAgentFile + the fresh agent-spawned entry are recorded), then settle it
 *  into the terminal `failed` state exactly as the runner's promise-.catch handler would. */
async function driveToFailed(h: RedispatchHarness, name: string): Promise<void> {
  h.runner.startSpecialist(name, `task for ${name} that is descriptive enough`);
  await Promise.resolve();
  await Promise.resolve();
  const agent = h.agents.get(name)!;
  agent.status = 'failed';
  agent.endTime = Date.now();
  agent.error = 'boom';
  await Promise.resolve();
}

describe('TeamRunner.redispatchSpecialist — guards (exact engine-contract strings)', () => {
  it('unknown agent → throws "Unknown agent"', () => {
    const h = makeRedispatchHarness(['A']);
    expect(() => h.runner.redispatchSpecialist('Ghost', 'a well-described redispatch task'))
      .toThrow('Unknown agent: Ghost');
  });

  it('non-specialist (lead) → throws "is not a specialist"', () => {
    const h = makeRedispatchHarness(['A']);
    expect(() => h.runner.redispatchSpecialist('Lead', 'a well-described redispatch task'))
      .toThrow('Agent "Lead" is not a specialist');
  });

  it('pending → throws pointing at team_spawn_specialist', () => {
    const h = makeRedispatchHarness(['A']); // A seeded as pending
    expect(() => h.runner.redispatchSpecialist('A', 'a well-described redispatch task'))
      .toThrow('Agent "A" has never been dispatched (status: pending) — use team_spawn_specialist to start it');
  });

  it('completed → throws the "approved work is final" message (NOT the "still active" one)', () => {
    const h = makeRedispatchHarness(['A']);
    h.agents.get('A')!.status = 'completed';
    expect(() => h.runner.redispatchSpecialist('A', 'a well-described redispatch task'))
      .toThrow('Agent "A" is completed — approved work is final; cover the gap with team_request_revision or a new task assignment, not a redispatch');
  });

  it.each(['running', 'awaiting-review', 'standby'] as Array<TeamAgent['status']>)(
    'active status %s → throws "is still active" naming the status',
    (status) => {
      const h = makeRedispatchHarness(['A']);
      h.agents.get('A')!.status = status;
      expect(() => h.runner.redispatchSpecialist('A', 'a well-described redispatch task'))
        .toThrow(`Agent "A" is still active (status: ${status}) — only failed or cancelled specialists can be re-dispatched`);
    },
  );

  it('MAX_AGENTS cap: with 5 running specialists, redispatch of a failed one throws the cap error', () => {
    const h = makeRedispatchHarness(['R1', 'R2', 'R3', 'R4', 'R5', 'F']);
    for (const r of ['R1', 'R2', 'R3', 'R4', 'R5']) h.agents.get(r)!.status = 'running';
    h.agents.get('F')!.status = 'failed';
    expect(() => h.runner.redispatchSpecialist('F', 'a well-described redispatch task'))
      .toThrow('Max 5 concurrent agents reached');
  });
});

describe('TeamRunner.startSpecialist — improved already-spawned guard (Slice C)', () => {
  it('a failed agent → throws naming team_redispatch_specialist and the status', () => {
    const h = makeRedispatchHarness(['A']);
    h.agents.get('A')!.status = 'failed';
    expect(() => h.runner.startSpecialist('A', 'a well-described task here'))
      .toThrow('Agent "A" already spawned (status: failed) — use team_redispatch_specialist to re-run it');
  });

  it('a cancelled agent → throws naming team_redispatch_specialist and the status', () => {
    const h = makeRedispatchHarness(['A']);
    h.agents.get('A')!.status = 'cancelled';
    expect(() => h.runner.startSpecialist('A', 'a well-described task here'))
      .toThrow('Agent "A" already spawned (status: cancelled) — use team_redispatch_specialist to re-run it');
  });

  it('a running agent → throws with the status but WITHOUT the redispatch hint', () => {
    const h = makeRedispatchHarness(['A']);
    h.agents.get('A')!.status = 'running';
    expect(() => h.runner.startSpecialist('A', 'a well-described task here'))
      .toThrow('Agent "A" already spawned (status: running)');
    expect(() => h.runner.startSpecialist('A', 'a well-described task here'))
      .not.toThrow(/team_redispatch_specialist/);
  });
});

describe('TeamRunner.redispatchSpecialist — fresh-attempt reset (failed and cancelled)', () => {
  it.each(['failed', 'cancelled'] as Array<TeamAgent['status']>)(
    'redispatch on a %s specialist reuses the SAME agentId and resets it to a fresh running attempt',
    (status) => {
      const h = makeRedispatchHarness(['A']);
      const agent = h.agents.get('A')!;
      const originalId = agent.agentId;
      agent.status = status;
      agent.endTime = 123;
      agent.error = 'prior failure';
      agent.finalResponse = 'stale';
      agent.toolCallCount = 9;

      const returnedId = h.runner.redispatchSpecialist('A', 'the new redispatch task, described');

      expect(returnedId).toBe(originalId);
      expect(agent.agentId).toBe(originalId);
      expect(agent.status).toBe('running');
      expect(agent.specialization).toBe('the new redispatch task, described');
      expect(agent.endTime).toBeNull();
      expect(agent.error).toBeNull();
      expect(agent.finalResponse).toBeNull();
      expect(agent.toolCallCount).toBe(0);
      // A running-status update was emitted on the EXISTING agentId (no new webview message type).
      expect(h.statusUpdates.some((u) => u.agentId === originalId && u.status === 'running')).toBe(true);

      h.runs.get('A')?.resolve(DONE_RESULT);
    },
  );

  it('clears ALL 11 per-attempt bookkeeping sets/maps for the name, but KEEPS an open briefConflict', () => {
    const h = makeRedispatchHarness(['A']);
    h.agents.get('A')!.status = 'failed';

    // Seed every per-attempt bookkeeping entry for A + an open brief conflict.
    h.set('A', 'reviewedSpecialists').add('A');
    h.set('A', 'confirmedComplete').add('A');
    h.set('A', 'pendingStandby').add('A');
    h.set('A', 'nudgeScheduled').add('A');
    h.set('A', 'nudgeDelivered').add('A');
    h.set('A', 'owedTerminalAction').add('A');
    h.set('A', 'terminalNudgeScheduled').add('A');
    h.set('A', 'terminalNudgeDelivered').add('A');
    (h.map('specialistReviewRounds') as Map<string, number>).set('A', 2);
    (h.map('cancelAttempts') as Map<string, number>).set('A', 1);
    (h.map('cancellationTimestamps') as Map<string, number>).set('A', Date.now());
    (h.runner as unknown as { flagBriefConflict: (n: string, d: string) => void }).flagBriefConflict('A', 'brief mandates async; attempt was sync');

    h.runner.redispatchSpecialist('A', 'the fresh attempt task, described');

    expect((h.map('specialistReviewRounds') as Map<string, number>).get('A')).toBeUndefined();
    for (const key of ['reviewedSpecialists', 'confirmedComplete', 'pendingStandby', 'nudgeScheduled', 'nudgeDelivered', 'owedTerminalAction', 'terminalNudgeScheduled', 'terminalNudgeDelivered']) {
      expect(h.set('A', key).has('A')).toBe(false);
    }
    expect((h.map('cancelAttempts') as Map<string, number>).has('A')).toBe(false);
    expect((h.map('cancellationTimestamps') as Map<string, number>).has('A')).toBe(false);

    // briefConflicts is a SAFETY flag — never silently dropped by a redispatch.
    expect((h.runner as unknown as { getOpenBriefConflicts: () => Array<{ name: string; detail: string }> }).getOpenBriefConflicts())
      .toEqual([{ name: 'A', detail: 'brief mandates async; attempt was sync' }]);

    h.runs.get('A')?.resolve(DONE_RESULT);
  });
});

describe('TeamRunner.redispatchSpecialist — transcript preservation', () => {
  it('does NOT call initAgentFile on redispatch (fresh spawn DOES) and appends a reattempt:true agent-spawned entry', async () => {
    const h = makeRedispatchHarness(['A']);

    // Fresh spawn: initAgentFile IS called; the agent-spawned entry carries NO reattempt marker.
    await driveToFailed(h, 'A');
    expect(h.initAgentFileCalls).toEqual(['id-A']);
    const freshSpawn = h.teamEntries.find((e) => e.type === 'agent-spawned');
    expect(freshSpawn).toBeDefined();
    expect(freshSpawn!.reattempt).toBeUndefined();

    const entriesBefore = h.teamEntries.length;
    h.runner.redispatchSpecialist('A', 'the fresh redispatch task, described');

    // Redispatch: initAgentFile is NOT called again (transcript preserved — no fs truncate).
    expect(h.initAgentFileCalls).toEqual(['id-A']);
    // An agent-spawned entry WITH the reattempt marker IS appended.
    const reattemptEntry = h.teamEntries.slice(entriesBefore).find((e) => e.type === 'agent-spawned');
    expect(reattemptEntry).toBeDefined();
    expect(reattemptEntry!.reattempt).toBe(true);
    expect(reattemptEntry!.agentId).toBe('id-A');
    expect(reattemptEntry!.specialization).toBe('the fresh redispatch task, described');

    await Promise.resolve();
    await Promise.resolve();
    h.runs.get('A')?.resolve(DONE_RESULT);
  });
});

describe('TeamRunner.redispatchSpecialist — review-round gate cycle', () => {
  it('re-introduces a non-settled specialist: the gate closes then re-opens as it re-settles', async () => {
    const h = makeRedispatchHarness(['A', 'B']);
    // A is settled (awaiting-review + confirmedComplete); B failed. The review round is READY.
    h.agents.get('A')!.status = 'awaiting-review';
    h.set('A', 'confirmedComplete').add('A');
    h.agents.get('B')!.status = 'failed';

    const api = h.runner as unknown as {
      isReviewRoundReady: () => boolean;
      getNonSettledSpecialistDetails: () => Array<{ name: string }>;
    };
    expect(api.isReviewRoundReady()).toBe(true);
    expect(api.getNonSettledSpecialistDetails()).toEqual([]);

    // Redispatch B → it becomes running (non-settled): the gate CLOSES.
    h.runner.redispatchSpecialist('B', 'the fresh redispatch task, described');
    expect(api.getNonSettledSpecialistDetails().map((d) => d.name)).toEqual(['B']);
    expect(api.isReviewRoundReady()).toBe(false);

    // B re-settles via report_complete + turn-end → awaiting-review: the gate RE-OPENS.
    await Promise.resolve();
    await Promise.resolve();
    const bRun = h.runs.get('B')!;
    h.runner.reportComplete('B', 'sign-off from B');
    bRun.config.onTurnEnd!();
    expect(h.agents.get('B')!.status).toBe('awaiting-review');
    expect(api.getNonSettledSpecialistDetails()).toEqual([]);
    expect(api.isReviewRoundReady()).toBe(true);

    h.runs.get('A')?.resolve(DONE_RESULT);
    bRun.resolve(DONE_RESULT);
  });
});

describe('TeamRunner.redispatchSpecialist — end-to-end wiring', () => {
  it('a redispatched specialist runs to awaiting-review, is approved, and synthesis proceeds', async () => {
    const h = makeRedispatchHarness(['A']);
    let completion: string | null = null;
    (h.runner as unknown as { completionResolve: (r: string) => void }).completionResolve = (r) => { completion = r; };

    // Fresh attempt fails, then the lead re-dispatches it.
    await driveToFailed(h, 'A');
    expect(h.agents.get('A')!.status).toBe('failed');

    h.runner.redispatchSpecialist('A', 'the fresh redispatch task, described');
    expect(h.agents.get('A')!.status).toBe('running');

    // The re-attempt starts (launchSpecialist → agentRunner.startAgent captured after the init microtask).
    await Promise.resolve();
    await Promise.resolve();
    const reRun = h.runs.get('A')!;

    // It reaches awaiting-review via the normal report_complete → onTurnEnd path.
    h.runner.reportComplete('A', 'sign-off from A');
    reRun.config.onTurnEnd!();
    expect(h.agents.get('A')!.status).toBe('awaiting-review');
    expect(h.sentToLead.some((m) => m.includes('[REVIEW ROUND READY]'))).toBe(true);

    // The lead approves (no scratchpad section authored → approval read-gate passes), then synthesizes.
    h.runner.approveSpecialist('A');
    expect(h.agents.get('A')!.status).toBe('completed');

    (h.runner as unknown as { synthesizeResult: (r: string) => void }).synthesizeResult('all done after re-run');
    expect(completion).toBe('all done after re-run');

    reRun.resolve(DONE_RESULT);
  });
});

/**
 * Slice D — stranded-lead review liveness + fail-loud force-synthesis. When the lead's turn ends with an
 * actionable review round still open and NO review progress made that turn, onTurnEnd re-fires
 * [REVIEW ROUND READY] (deferred), bounded by LEAD_REVIEW_STALL_MAX = 2 CONSECUTIVE no-progress turns; the
 * budget RESETS on any review action (approveSpecialist / requestRevision). When the budget exhausts with
 * the round still open, forceSynthesizeStrandedReview() synthesizes a SUSPECT banner + partial results
 * (SYNCHRONOUSLY — the >=MAX branch is not deferred) then queueMicrotask-defers a [TEAM FORCE-COMPLETED]
 * wake so the parked lead exits without the 30s drain. Strings pinned in the `engine-contract` scratchpad
 * section (as-built) and asserted below. Each test names its acceptance criterion.
 *
 * The methodical-lead test (test 1) is the anti-false-positive proof: it fires THREE nudges total but never
 * trips the cap, because each per-turn approveSpecialist resets the stall budget. A naive TOTAL-nudge
 * counter would force-synthesize on the 3rd nudge — this test would fail it, which is the whole point.
 */
describe('TeamRunner stranded-lead review liveness (Slice D)', () => {
  const SUSPECT_BANNER = 'REVIEW ROUND ABANDONED';
  const FORCE_WAKE = '[TEAM FORCE-COMPLETED]';
  const PARTIAL_HEADER = '## Partial Team Results';
  const RRR = '[REVIEW ROUND READY]';
  const CONFLICT_NUDGE = 'UNRESOLVED brief conflicts';

  interface ReviewApi {
    nudgeLeadOnOpenReviewRound: (leadName: string) => void;
    nudgeLeadOnOpenConflicts: (leadName: string) => void;
    approveSpecialist: (name: string) => void;
    requestRevision: (name: string, feedback: string) => void;
    synthesizeResult: (result: string) => void;
    isReviewRoundReady: () => boolean;
    getUnreviewedSpecialistNames: () => string[];
  }
  function api(h: Harness): ReviewApi {
    return h.runner as unknown as ReviewApi;
  }
  function stalls(h: Harness): number {
    return (h.runner as unknown as { leadReviewStalls: number }).leadReviewStalls;
  }
  function setStalls(h: Harness, n: number): void {
    (h.runner as unknown as { leadReviewStalls: number }).leadReviewStalls = n;
  }
  function conflictNudgeCount(h: Harness): number {
    return (h.runner as unknown as { conflictNudges: number }).conflictNudges;
  }
  /** Capture the terminal completion the run() await hangs on, plus a resolution counter for idempotency. */
  function captureCompletion(h: Harness): { get: () => string | null; count: () => number } {
    let completion: string | null = null;
    let count = 0;
    (h.runner as unknown as { completionResolve: (r: string) => void }).completionResolve = (r) => { completion = r; count++; };
    return { get: () => completion, count: () => count };
  }
  function reviewRoundNudges(h: Harness): string[] {
    return h.sentToLead.filter((m) => m.includes(RRR));
  }
  /** An awaiting-review specialist the lead has NOT yet reviewed but that HAS confirmed complete — the exact
   *  state that makes isReviewRoundReady() true (an actionable, unreviewed round). */
  function seedActionableRound(h: Harness, names: string[]): void {
    for (const n of names) h.confirmedComplete.add(n);
  }

  it('METHODICAL LEAD (no false positive): approving one of three per turn NEVER force-synthesizes and never trips the cap', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const s1 = makeAgent({ name: 'S1', role: 'specialist', status: 'awaiting-review' });
    const s2 = makeAgent({ name: 'S2', role: 'specialist', status: 'awaiting-review' });
    const s3 = makeAgent({ name: 'S3', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, s1, s2, s3]);
    seedActionableRound(h, ['S1', 'S2', 'S3']);
    const completion = captureCompletion(h);

    // Turn 1: lead ends turn (nudge fires) THEN reviews one specialist.
    expect(api(h).isReviewRoundReady()).toBe(true);
    api(h).nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();
    expect(stalls(h)).toBe(1);                 // one delivered nudge = one stall
    api(h).approveSpecialist('S1');
    expect(stalls(h)).toBe(0);                 // review action RESETS the budget

    // Turn 2: same cadence — a fresh nudge, then a review action resets again.
    api(h).nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();
    expect(stalls(h)).toBe(1);
    api(h).approveSpecialist('S2');
    expect(stalls(h)).toBe(0);

    // Turn 3: last specialist.
    api(h).nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();
    expect(stalls(h)).toBe(1);
    api(h).approveSpecialist('S3');
    expect(stalls(h)).toBe(0);

    // Three nudges were delivered across the episode — a TOTAL-nudge counter (>=2) would have
    // force-synthesized on the 3rd. The stall budget never reached LEAD_REVIEW_STALL_MAX (2), so it did not.
    expect(reviewRoundNudges(h)).toHaveLength(3);
    expect(h.sentToLead.some((m) => m.includes(SUSPECT_BANNER))).toBe(false);
    expect(h.sentToLead.some((m) => m.includes(FORCE_WAKE))).toBe(false);
    expect(completion.get()).toBeNull();       // nothing forced completion

    // The round is now fully reviewed; the lead synthesizes normally.
    expect(api(h).isReviewRoundReady()).toBe(false);
    api(h).synthesizeResult('all three reviewed normally');
    expect(completion.get()).toBe('all three reviewed normally');
    expect(completion.get()).not.toContain(SUSPECT_BANNER);
  });

  it('STALLED LEAD: re-fires [REVIEW ROUND READY] exactly LEAD_REVIEW_STALL_MAX times, then force-synthesizes with SUSPECT banner + partial results', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const solo = makeAgent({ name: 'Solo', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, solo]);
    seedActionableRound(h, ['Solo']);
    const completion = captureCompletion(h);

    // Stall #1 and #2: each no-progress turn-end delivers one deferred re-send and counts one stall.
    api(h).nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();
    api(h).nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();
    expect(stalls(h)).toBe(2);                       // LEAD_REVIEW_STALL_MAX
    expect(reviewRoundNudges(h)).toHaveLength(2);    // bounded re-sends — exactly the cap
    expect(completion.get()).toBeNull();             // not forced yet

    // The NEXT no-progress turn-end is over budget → SYNCHRONOUS force-synthesis (no flush needed).
    api(h).nudgeLeadOnOpenReviewRound('Lead');
    expect(completion.get()).not.toBeNull();         // completionPromise resolved — no hang
    expect(completion.get()).toContain(SUSPECT_BANNER);
    expect(completion.get()).toContain('did not review 1 specialist(s)'); // N interpolation
    expect(completion.get()).toContain(PARTIAL_HEADER);
    // The over-budget turn did NOT emit a 3rd [REVIEW ROUND READY] — it force-synthesized instead.
    expect(reviewRoundNudges(h)).toHaveLength(2);
  });

  it('DEFERRED WAKE: [TEAM FORCE-COMPLETED] lands only AFTER a microtask flush, and completion resolves without the 30s drain', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const solo = makeAgent({ name: 'Solo', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, solo]);
    seedActionableRound(h, ['Solo']);
    const completion = captureCompletion(h);

    setStalls(h, 2); // at cap: the next turn-end force-synthesizes
    api(h).nudgeLeadOnOpenReviewRound('Lead');

    // Synthesis is synchronous — completion is already resolved on this tick (no timer, no drain).
    expect(completion.get()).not.toBeNull();
    expect(completion.get()).toContain(SUSPECT_BANNER);
    // The wake message is DEFERRED (lost-wakeup rule): not present synchronously.
    expect(h.sentToLead.some((m) => m.includes(FORCE_WAKE))).toBe(false);

    await Promise.resolve();
    // After the microtask flush, the parked lead receives its release message.
    expect(h.sentToLead.some((m) => m.includes(FORCE_WAKE))).toBe(true);
    expect(h.sentToLead.filter((m) => m.includes(FORCE_WAKE))).toHaveLength(1);
  });

  it('ROUND NOT READY (no unreviewed awaiting-review): nudge is a no-op — no send, no stall increment, no force-synthesis', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const solo = makeAgent({ name: 'Solo', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, solo]);
    // confirmedComplete but ALREADY reviewed → nothing actionable remains.
    h.confirmedComplete.add('Solo');
    (h.runner as unknown as { reviewedSpecialists: Set<string> }).reviewedSpecialists.add('Solo');
    const completion = captureCompletion(h);

    expect(api(h).isReviewRoundReady()).toBe(false);
    api(h).nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();

    expect(reviewRoundNudges(h)).toEqual([]);
    expect(stalls(h)).toBe(0);
    expect(completion.get()).toBeNull();
  });

  it('ROUND NOT READY (a specialist still running): not all settled → nudge is a no-op', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const done = makeAgent({ name: 'Done', role: 'specialist', status: 'awaiting-review' });
    const busy = makeAgent({ name: 'Busy', role: 'specialist', status: 'running' });
    const h = makeHarness([lead, done, busy]);
    h.confirmedComplete.add('Done');
    const completion = captureCompletion(h);

    expect(api(h).isReviewRoundReady()).toBe(false); // Busy is not settled
    api(h).nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();

    expect(reviewRoundNudges(h)).toEqual([]);
    expect(stalls(h)).toBe(0);
    expect(completion.get()).toBeNull();
  });

  it('RESET SITE: approveSpecialist resets the stall budget to 0', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const solo = makeAgent({ name: 'Solo', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, solo]);
    h.confirmedComplete.add('Solo');
    setStalls(h, 2);

    api(h).approveSpecialist('Solo');

    expect(stalls(h)).toBe(0);
    expect(h.agents.get('Solo')!.status).toBe('completed');
  });

  it('RESET SITE: approveSpecialist resets the stall budget even with a NON-EMPTY scratchpad (read-gate passes on a current cursor)', () => {
    // Belt-and-suspenders: the other reset test approves an UNAUTHORED specialist (empty read cursor →
    // checkApprovalReadGate short-circuits on zero stale sections). This one exercises the DISTINCT gate-pass
    // path — the specialist HAS authored a section and the lead's read cursor is CURRENT (stale.length === 0
    // with sections present) — proving the reset still lands past a non-trivial read-gate check.
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const solo = makeAgent({ name: 'Solo', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, solo]);
    h.confirmedComplete.add('Solo');
    setStalls(h, 2);

    // Solo authors a section; the lead reads it so its cursor is current (no stale sections).
    const scratchpad = (h.runner as unknown as { scratchpad: Scratchpad }).scratchpad;
    scratchpad.set('solo-findings', 'my analysis', 'Solo');
    scratchpad.markRead('Lead', 'solo-findings');

    api(h).approveSpecialist('Solo'); // read-gate passes on a NON-EMPTY scratchpad, then resets the budget

    expect(stalls(h)).toBe(0);
    expect(h.agents.get('Solo')!.status).toBe('completed');
  });

  it('RESET SITE: requestRevision resets the stall budget to 0', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const solo = makeAgent({ name: 'Solo', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, solo]);
    setStalls(h, 2);

    api(h).requestRevision('Solo', 'please address the edge case');

    expect(stalls(h)).toBe(0);
  });

  it('NON-INTERFERENCE: conflict-nudge and review-nudge budgets increment independently and do not perturb each other', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const solo = makeAgent({ name: 'Solo', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, solo]);
    seedActionableRound(h, ['Solo']);
    h.briefConflicts.set('Solo', 'brief mandates async; work is sync');

    // Same turn-end: BOTH mechanisms fire (independent — both may run).
    api(h).nudgeLeadOnOpenConflicts('Lead');
    api(h).nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();

    // Each budget counted exactly one delivered nudge; each landed its own distinct message.
    expect(conflictNudgeCount(h)).toBe(1);
    expect(stalls(h)).toBe(1);
    expect(h.sentToLead.filter((m) => m.includes(CONFLICT_NUDGE))).toHaveLength(1);
    expect(reviewRoundNudges(h)).toHaveLength(1);

    // Exhaust the REVIEW budget one more step — the CONFLICT counter is untouched.
    api(h).nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();
    expect(stalls(h)).toBe(2);
    expect(conflictNudgeCount(h)).toBe(1);   // unaffected by review-budget consumption

    // Fire the CONFLICT nudge again — the REVIEW counter is untouched.
    api(h).nudgeLeadOnOpenConflicts('Lead');
    await Promise.resolve();
    expect(conflictNudgeCount(h)).toBe(2);
    expect(stalls(h)).toBe(2);               // unaffected by conflict-budget consumption
  });

  it('IDEMPOTENCY: a force-synthesis wins first; a later explicit synthesizeResult is a no-op (single resolution)', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const solo = makeAgent({ name: 'Solo', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, solo]);
    seedActionableRound(h, ['Solo']);
    const completion = captureCompletion(h);

    setStalls(h, 2);
    api(h).nudgeLeadOnOpenReviewRound('Lead'); // force-synthesis fires first → completionResolved = true
    expect(completion.count()).toBe(1);
    expect(completion.get()).toContain(SUSPECT_BANNER);

    // A late explicit synthesis (e.g. the lead's own turn racing the force path) hits the completionResolved
    // guard and does nothing — no double-resolution, no banner overwrite.
    api(h).synthesizeResult('lead tried to synthesize after the fact');
    expect(completion.count()).toBe(1);
    expect(completion.get()).toContain(SUSPECT_BANNER);
    expect(completion.get()).not.toContain('lead tried to synthesize after the fact');

    await Promise.resolve(); // only the single deferred wake, nothing more
    expect(h.sentToLead.filter((m) => m.includes(FORCE_WAKE))).toHaveLength(1);
  });

  it('BANNER COMPOSITION: with an open brief conflict, the force result carries BOTH banners (conflict block first) + partial results', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const solo = makeAgent({ name: 'Solo', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, solo]);
    seedActionableRound(h, ['Solo']);
    h.briefConflicts.set('Solo', 'brief mandates async pipeline; work is a sync toy');
    const completion = captureCompletion(h);

    setStalls(h, 2);
    api(h).nudgeLeadOnOpenReviewRound('Lead'); // force-synthesis composes with synthesizeResult's prepend

    const result = completion.get()!;
    expect(result).toContain('UNRESOLVED BRIEF CONFLICTS');
    expect(result).toContain('Solo: brief mandates async pipeline; work is a sync toy');
    expect(result).toContain(SUSPECT_BANNER);
    expect(result).toContain(PARTIAL_HEADER);
    // Composition ORDER: the brief-conflict block is PREPENDED ahead of the SUSPECT banner.
    expect(result.indexOf('UNRESOLVED BRIEF CONFLICTS')).toBeLessThan(result.indexOf(SUSPECT_BANNER));
    expect(result.indexOf(SUSPECT_BANNER)).toBeLessThan(result.indexOf(PARTIAL_HEADER));
  });

  it('GUARD-INSIDE-MICROTASK: if the round becomes not-ready before the scheduled microtask runs, no send and no stall increment', async () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const solo = makeAgent({ name: 'Solo', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, solo]);
    seedActionableRound(h, ['Solo']);
    setStalls(h, 1); // below cap → the nudge SCHEDULES a microtask (does not force-synthesize)

    api(h).nudgeLeadOnOpenReviewRound('Lead');
    // Between scheduling and the microtask, the round goes not-ready (Solo un-confirms — e.g. a revision
    // re-opened it). The deferred guard must re-check and bail.
    h.confirmedComplete.delete('Solo');
    expect(api(h).isReviewRoundReady()).toBe(false);
    await Promise.resolve();

    expect(reviewRoundNudges(h)).toEqual([]);
    expect(stalls(h)).toBe(1); // NOT incremented to 2 — the send-and-count both live behind the guard
  });

  it('CAPSTONE incident repro: a bare-ending specialist (Slice A) → open round → lead parks → bounded re-fires → force-synthesis resolves (never hangs)', async () => {
    const { runner, runs, sentToLead } = makeWiringRunner(['Solo']);
    let completion: string | null = null;
    (runner as unknown as { completionResolve: (r: string) => void }).completionResolve = (r) => { completion = r; };

    runner.startSpecialist('Solo', 'task for Solo that is descriptive enough');
    await Promise.resolve();
    await Promise.resolve();
    const solo = runs.get('Solo')!;
    const cfg = solo.config;
    const agents = (runner as unknown as { agents: Map<string, TeamAgent> }).agents;
    const reviewApi = runner as unknown as ReviewApi;

    // --- Slice A: Solo ends a turn owing a terminal action → nudged once (deferred) + a grace turn.
    cfg.onReconcileBeforeEnd!();
    await Promise.resolve(); // deliver the terminal nudge
    cfg.onKeepAliveResume!();
    // Re-offends by ending bare again → converted to awaiting-review (+ confirmedComplete), round OPENS.
    cfg.onReconcileBeforeEnd!();
    expect(agents.get('Solo')!.status).toBe('awaiting-review');
    expect(sentToLead.some((m) => m.includes(RRR))).toBe(true);
    expect(reviewApi.isReviewRoundReady()).toBe(true);

    // --- Slice D: the lead 'parks' without acting. Each parked turn-end nudges (bounded), then forces.
    reviewApi.nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();
    reviewApi.nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();
    expect((runner as unknown as { leadReviewStalls: number }).leadReviewStalls).toBe(2);

    reviewApi.nudgeLeadOnOpenReviewRound('Lead'); // over budget → force-synthesis

    // The run TERMINATES (does not hang): completionPromise resolved, carrying the fail-loud SUSPECT banner.
    expect(completion).not.toBeNull();
    expect(completion!).toContain(SUSPECT_BANNER);
    expect(completion!).toContain(PARTIAL_HEADER);
    await Promise.resolve();
    expect(sentToLead.some((m) => m.includes(FORCE_WAKE))).toBe(true);

    solo.resolve(DONE_RESULT);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Review remediation — four regressions:
 *  1. leadReviewStalls must reset on EVERY lead progress action (cancel, redispatch,
 *     spawn, resolveBriefConflict), not only approve/requestRevision — otherwise a
 *     healthy cancel→redispatch recovery burns the budget and gets force-synthesized.
 *  2. startSpecialist/redispatchSpecialist must refuse to launch after completion.
 *  3. A cancelled-from-pending specialist has no transcript: its redispatch IS the
 *     first launch and must initAgentFile (a launched one must NEVER be re-inited).
 *  4. The role-aware deliverability copy is pinned against the REAL helper here
 *     (team-agent-tools.test.ts uses sentinel mocks for tool mechanics only).
 * ──────────────────────────────────────────────────────────────────────────── */

function stallsOf(runner: TeamRunner): number {
  return (runner as unknown as Record<string, unknown>)['leadReviewStalls'] as number;
}

describe('TeamRunner — leadReviewStalls resets on every lead progress action', () => {
  it('cancelSpecialist resets the stall budget', () => {
    const h = makeRedispatchHarness(['A']);
    inject(h.runner as unknown as Record<string, unknown>, 'leadReviewStalls', 2);
    h.runner.cancelSpecialist('A');
    expect(stallsOf(h.runner)).toBe(0);
  });

  it('redispatchSpecialist resets the stall budget (cancel→redispatch recovery earns fresh nudges)', () => {
    const h = makeRedispatchHarness(['A']);
    h.runner.cancelSpecialist('A');
    inject(h.runner as unknown as Record<string, unknown>, 'leadReviewStalls', 2);
    h.runner.redispatchSpecialist('A', 'a well-described redispatch task');
    expect(stallsOf(h.runner)).toBe(0);
  });

  it('startSpecialist resets the stall budget (spawning work is progress, not a stall)', () => {
    const h = makeRedispatchHarness(['A']);
    inject(h.runner as unknown as Record<string, unknown>, 'leadReviewStalls', 2);
    h.runner.startSpecialist('A', 'a well-described task here');
    expect(stallsOf(h.runner)).toBe(0);
  });

  it('resolveBriefConflict resets the stall budget (mandated gate work is progress)', () => {
    const h = makeRedispatchHarness(['A']);
    inject(h.runner as unknown as Record<string, unknown>, 'briefConflicts', new Map([['A', 'conflict']]));
    inject(h.runner as unknown as Record<string, unknown>, 'leadReviewStalls', 2);
    h.runner.resolveBriefConflict('A', 'resolved: brief wins');
    expect(stallsOf(h.runner)).toBe(0);
  });

  it('a guard-throwing call does NOT reset the budget (only real progress counts)', () => {
    const h = makeRedispatchHarness(['A']); // A is pending — redispatch must throw
    inject(h.runner as unknown as Record<string, unknown>, 'leadReviewStalls', 2);
    expect(() => h.runner.redispatchSpecialist('A', 'a well-described redispatch task')).toThrow();
    expect(stallsOf(h.runner)).toBe(2);
  });
});

describe('TeamRunner — completionResolved guards spawn/redispatch (no post-completion session launches)', () => {
  const COMPLETED_ERR = 'Team already completed — no further team actions are possible';

  it('startSpecialist after completion throws and launches nothing', () => {
    const h = makeRedispatchHarness(['A']);
    inject(h.runner as unknown as Record<string, unknown>, 'completionResolved', true);
    expect(() => h.runner.startSpecialist('A', 'a well-described task here')).toThrow(COMPLETED_ERR);
    expect(h.runs.size).toBe(0);
    expect(h.initAgentFileCalls).toHaveLength(0);
  });

  it('redispatchSpecialist after completion throws and launches nothing', () => {
    const h = makeRedispatchHarness(['A']);
    h.runner.cancelSpecialist('A');
    inject(h.runner as unknown as Record<string, unknown>, 'completionResolved', true);
    expect(() => h.runner.redispatchSpecialist('A', 'a well-described redispatch task')).toThrow(COMPLETED_ERR);
    expect(h.runs.size).toBe(0);
  });
});

describe('TeamRunner.redispatchSpecialist — cancelled-from-pending gets a first-launch transcript init', () => {
  it('pending→cancelled→redispatch calls initAgentFile (first real launch) and appends the reattempt marker', async () => {
    const h = makeRedispatchHarness(['A']);
    h.runner.cancelSpecialist('A'); // never launched: startTime null, no transcript exists
    expect(h.agents.get('A')!.startTime).toBeNull();
    expect(h.initAgentFileCalls).toHaveLength(0);

    h.runner.redispatchSpecialist('A', 'a well-described redispatch task');
    await Promise.resolve();
    await Promise.resolve();

    expect(h.initAgentFileCalls).toEqual(['id-A']);
    const reattempt = h.teamEntries.find((e) => e['type'] === 'agent-spawned' && e['reattempt'] === true);
    expect(reattempt).toBeDefined();
    expect(h.agents.get('A')!.status).toBe('running');
  });

  it('a previously-launched (failed) specialist is NEVER re-inited — transcript preserved', async () => {
    const h = makeRedispatchHarness(['B']);
    await driveToFailed(h, 'B');
    expect(h.initAgentFileCalls).toEqual(['id-B']); // the fresh spawn only

    h.runner.redispatchSpecialist('B', 'a well-described redispatch task');
    await Promise.resolve();
    await Promise.resolve();

    expect(h.initAgentFileCalls).toEqual(['id-B']); // unchanged — no truncate
  });
});

describe('TeamRunner.checkMessageDeliverable — REAL helper, role-aware guidance', () => {
  type Check = (name: string, role: 'lead' | 'specialist') => { ok: boolean; error?: string };
  function realCheck(h: Harness): Check {
    const runner = h.runner as unknown as { checkMessageDeliverable: Check };
    return (name, role) => runner.checkMessageDeliverable.call(runner, name, role);
  }
  function statusHarness(): Harness {
    return makeHarness([
      makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' }),
      makeAgent({ name: 'R', role: 'specialist', status: 'running' }),
      makeAgent({ name: 'W', role: 'specialist', status: 'awaiting-review' }),
      makeAgent({ name: 'S', role: 'specialist', status: 'standby' }),
      makeAgent({ name: 'P', role: 'specialist', status: 'pending' }),
      makeAgent({ name: 'C', role: 'specialist', status: 'completed' }),
      makeAgent({ name: 'F', role: 'specialist', status: 'failed' }),
      makeAgent({ name: 'X', role: 'specialist', status: 'cancelled' }),
    ]);
  }

  it.each(['Lead', 'R', 'W', 'S'])('deliverable recipient %s → ok for both sender roles', (name) => {
    const check = realCheck(statusHarness());
    expect(check(name, 'lead')).toEqual({ ok: true });
    expect(check(name, 'specialist')).toEqual({ ok: true });
  });

  it('unknown recipient → defensive error', () => {
    const check = realCheck(statusHarness());
    expect(check('Ghost', 'lead').error).toBe('Unknown agent "Ghost"');
  });

  it('pending recipient, lead sender → points at team_spawn_specialist (verbatim)', () => {
    const check = realCheck(statusHarness());
    expect(check('P', 'lead').error).toBe(
      "Cannot message 'P' — they have not been spawned yet and will not be woken by messages. Spawn them with team_spawn_specialist and put the context in the spawn task.",
    );
  });

  it('pending recipient, specialist sender → routes through the lead (never a lead-only tool)', () => {
    const check = realCheck(statusHarness());
    expect(check('P', 'specialist').error).toBe(
      "Cannot message 'P' — they have not been spawned yet and will not be woken by messages. Message the lead and ask them to spawn 'P' with the needed context in the spawn task.",
    );
  });

  it.each([['C', 'completed'], ['F', 'failed'], ['X', 'cancelled']])(
    'terminal recipient %s, lead sender → names the status + team_redispatch_specialist (verbatim)',
    (name, status) => {
      const check = realCheck(statusHarness());
      expect(check(name, 'lead').error).toBe(
        `Cannot message '${name}' — they are ${status} and no longer receiving messages. Read their scratchpad section with team_read_scratchpad, or (if failed/cancelled) re-run them with team_redispatch_specialist.`,
      );
    },
  );

  it.each([['C', 'completed'], ['F', 'failed'], ['X', 'cancelled']])(
    'terminal recipient %s, specialist sender → routes through the lead (never a lead-only tool)',
    (name, status) => {
      const check = realCheck(statusHarness());
      expect(check(name, 'specialist').error).toBe(
        `Cannot message '${name}' — they are ${status} and no longer receiving messages. Read their scratchpad section with team_read_scratchpad, or message the lead if their work needs to be re-run.`,
      );
    },
  );
});

/**
 * RC4 — duplicate `[REVIEW ROUND READY]`. `notifyLeadIfReviewRoundReady()` has six call sites (each
 * closing a documented deadlock hole), so the same state was rendered and re-sent several times per
 * round; each duplicate is a full re-prompt of the lead's whole conversation. Suppression compares the
 * RENDERED STRING rather than enumerating invalidation triggers: the notification is a pure function of
 * exactly the state the lead must see, so anything worth a re-prompt renders differently.
 */
describe('TeamRunner — [REVIEW ROUND READY] suppression by rendered-string identity', () => {
  interface NotifyApi {
    notifyLeadIfReviewRoundReady: () => void;
    nudgeLeadOnOpenReviewRound: (leadName: string) => void;
    approveSpecialist: (name: string) => void;
  }
  const notifyApi = (h: Harness): NotifyApi => h.runner as unknown as NotifyApi;
  const rrrCount = (h: Harness): number => h.sentToLead.filter((m) => m.includes('[REVIEW ROUND READY]')).length;
  const scratchpadOf = (h: Harness): Scratchpad => (h.runner as unknown as { scratchpad: Scratchpad }).scratchpad;
  const lastNotification = (h: Harness): string | null =>
    (h.runner as unknown as { lastReviewRoundNotification: string | null }).lastReviewRoundNotification;

  function openRound(names: string[]): Harness {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const specialists = names.map((n) => makeAgent({ name: n, role: 'specialist', status: 'awaiting-review' }));
    const h = makeHarness([lead, ...specialists]);
    for (const n of names) h.confirmedComplete.add(n);
    return h;
  }

  it('sends ONE message for repeated notifications rendering identical text', () => {
    const h = openRound(['Solo']);
    notifyApi(h).notifyLeadIfReviewRoundReady();
    notifyApi(h).notifyLeadIfReviewRoundReady();
    notifyApi(h).notifyLeadIfReviewRoundReady();
    expect(rrrCount(h)).toBe(1);
  });

  it('re-enables notification when a section version bump changes the rendered text', () => {
    const h = openRound(['Solo']);
    scratchpadOf(h).set('solo-findings', 'v1', 'Solo');
    notifyApi(h).notifyLeadIfReviewRoundReady();
    expect(rrrCount(h)).toBe(1);
    expect(h.sentToLead[0]).toContain('"solo-findings" v1 [UNREAD]');

    scratchpadOf(h).set('solo-findings', 'v2', 'Solo');
    notifyApi(h).notifyLeadIfReviewRoundReady();

    expect(rrrCount(h)).toBe(2);
    expect(h.sentToLead[1]).toContain('"solo-findings" v2 [UNREAD]');
  });

  it('re-enables notification when the LEAD merely reads a section (read cursor is part of the text)', () => {
    const h = openRound(['Solo']);
    scratchpadOf(h).set('solo-findings', 'v1', 'Solo');
    notifyApi(h).notifyLeadIfReviewRoundReady();
    notifyApi(h).notifyLeadIfReviewRoundReady();
    expect(rrrCount(h)).toBe(1);

    scratchpadOf(h).markRead('Lead', 'solo-findings');
    notifyApi(h).notifyLeadIfReviewRoundReady();

    expect(rrrCount(h)).toBe(2);
    expect(h.sentToLead[1]).toContain('up to date');
  });

  it('re-enables notification when an approval removes a specialist from the round', () => {
    const h = openRound(['S1', 'S2']);
    notifyApi(h).notifyLeadIfReviewRoundReady();
    notifyApi(h).notifyLeadIfReviewRoundReady();
    expect(rrrCount(h)).toBe(1);

    notifyApi(h).approveSpecialist('S1');
    notifyApi(h).notifyLeadIfReviewRoundReady();

    expect(rrrCount(h)).toBe(2);
    expect(h.sentToLead[1]).not.toContain('  - S1:');
    expect(h.sentToLead[1]).toContain('  - S2:');
  });

  it('clears the suppression baseline once the round closes, so an identical later round still notifies', () => {
    const h = openRound(['Solo']);
    notifyApi(h).notifyLeadIfReviewRoundReady();
    expect(lastNotification(h)).not.toBeNull();

    // The lead requests a revision: Solo leaves confirmedComplete, so nothing is actionable — the
    // notification renders null and the baseline drops.
    h.confirmedComplete.delete('Solo');
    h.agents.get('Solo')!.status = 'running';
    notifyApi(h).notifyLeadIfReviewRoundReady();
    expect(lastNotification(h)).toBeNull();

    // Solo re-reports complete: the SAME text renders again and must be delivered, not suppressed.
    h.confirmedComplete.add('Solo');
    h.agents.get('Solo')!.status = 'awaiting-review';
    notifyApi(h).notifyLeadIfReviewRoundReady();

    expect(rrrCount(h)).toBe(2);
    expect(h.sentToLead[0]).toBe(h.sentToLead[1]);
  });

  it('does NOT suppress nudgeLeadOnOpenReviewRound — it re-fires identical text and burns the stall budget to force-synthesis', async () => {
    const h = openRound(['Solo']);
    let completion: string | null = null;
    (h.runner as unknown as { completionResolve: (r: string) => void }).completionResolve = (r) => { completion = r; };

    notifyApi(h).notifyLeadIfReviewRoundReady();
    expect(rrrCount(h)).toBe(1);

    // Identical text, but the stall nudge must still deliver — it is what breaks a stalled lead.
    notifyApi(h).nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();
    notifyApi(h).nudgeLeadOnOpenReviewRound('Lead');
    await Promise.resolve();

    expect(rrrCount(h)).toBe(3);
    expect((h.runner as unknown as { leadReviewStalls: number }).leadReviewStalls).toBe(2);

    notifyApi(h).nudgeLeadOnOpenReviewRound('Lead'); // over budget → fail-loud force-synthesis
    expect(completion).not.toBeNull();
    expect(completion!).toContain('REVIEW ROUND ABANDONED');
  });

  it('synthesis teardown clears the suppression baseline', () => {
    const h = openRound(['Solo']);
    notifyApi(h).notifyLeadIfReviewRoundReady();
    expect(lastNotification(h)).not.toBeNull();

    (h.runner as unknown as { synthesizeResult: (r: string) => void }).synthesizeResult('done');

    expect(lastNotification(h)).toBeNull();
  });
});

describe('TeamRunner — a revision round re-earns its notification', () => {
  it('requestRevision drops the suppression baseline, so the re-opened round notifies even with identical text', () => {
    const lead = makeAgent({ name: 'Lead', role: 'lead', status: 'monitoring' });
    const solo = makeAgent({ name: 'Solo', role: 'specialist', status: 'awaiting-review' });
    const h = makeHarness([lead, solo]);
    h.confirmedComplete.add('Solo');
    const api = h.runner as unknown as {
      notifyLeadIfReviewRoundReady: () => void;
      requestRevision: (name: string, feedback: string) => void;
      lastReviewRoundNotification: string | null;
    };

    api.notifyLeadIfReviewRoundReady();
    expect(api.lastReviewRoundNotification).not.toBeNull();

    api.requestRevision('Solo', 'please address the edge case');
    expect(api.lastReviewRoundNotification).toBeNull();

    // The specialist revises without bumping a section version, so the re-opened round renders the SAME
    // text — it must still reach the lead.
    h.confirmedComplete.add('Solo');
    api.notifyLeadIfReviewRoundReady();

    const rrr = h.sentToLead.filter((m) => m.includes('[REVIEW ROUND READY]'));
    expect(rrr).toHaveLength(2);
    expect(rrr[0]).toBe(rrr[1]);
  });
});

/**
 * The counters are instrumentation for the webview and telemetry. `getTeamStatus()` is serialized
 * straight into an agent's context, so they live on their own accessor and not in that payload.
 */
describe('TeamRunner.getScratchpadReadStats', () => {
  it('reports zeros for every agent before any read happens', () => {
    const h = makeHarness([
      makeAgent({ name: 'Lead', role: 'lead' }),
      makeAgent({ name: 'Backend', role: 'specialist' }),
    ]);
    const stats = h.runner.getScratchpadReadStats();
    expect(stats.total).toEqual({ markerHits: 0, fullReturns: 0 });
    expect(stats.byAgent).toEqual([
      { name: 'Lead', markerHits: 0, fullReturns: 0 },
      { name: 'Backend', markerHits: 0, fullReturns: 0 },
    ]);
    const status = h.runner.getTeamStatus() as { agents: Array<{ name: string }> };
    expect(stats.byAgent.map(a => a.name)).toEqual(status.agents.map(a => a.name));
  });

  it('reports per-agent counts and the team total from the runner scratchpad', () => {
    const h = makeHarness([
      makeAgent({ name: 'Lead', role: 'lead' }),
      makeAgent({ name: 'Backend', role: 'specialist' }),
    ]);
    const scratchpad = (h.runner as unknown as { scratchpad: Scratchpad }).scratchpad;
    scratchpad.recordReadOutcome('Lead', 'marker');
    scratchpad.recordReadOutcome('Lead', 'marker');
    scratchpad.recordReadOutcome('Backend', 'full');

    const stats = h.runner.getScratchpadReadStats();
    expect(stats.total).toEqual({ markerHits: 2, fullReturns: 1 });
    expect(stats.byAgent).toEqual([
      { name: 'Lead', markerHits: 2, fullReturns: 0 },
      { name: 'Backend', markerHits: 0, fullReturns: 1 },
    ]);
  });

  it('keeps the counters out of the payload team_get_status serializes to the model', () => {
    const h = makeHarness([makeAgent({ name: 'Lead', role: 'lead' })]);
    const scratchpad = (h.runner as unknown as { scratchpad: Scratchpad }).scratchpad;
    scratchpad.recordReadOutcome('Lead', 'marker');

    const status = h.runner.getTeamStatus();

    expect(Object.keys(status)).not.toContain('scratchpadReads');
    expect(JSON.stringify(status)).not.toContain('markerHits');
  });
});
