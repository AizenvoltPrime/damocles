import { describe, it, expect } from 'vitest';
import { TeamRunLog } from '../runs';
import type { AgentUsageTotals } from '../../../shared/usage-accounting';

const at = (second: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const ms = (second: number): number => Date.parse(at(second));

function runsOf(entries: unknown[]) {
  const log = new TeamRunLog();
  for (const entry of entries) log.add(entry);
  return log.runs();
}

function usage(totalInputTokens: number, totalOutputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, costUsd: number): AgentUsageTotals {
  return { totalInputTokens, totalOutputTokens, cacheReadTokens, cacheCreationTokens, costUsd };
}

describe('TeamRunLog', () => {
  it('sums a run with no recorded totals from its members, counting only each launch\'s own tool calls', () => {
    const runs = runsOf([
      { type: 'team-created', toolUseId: 'tc-create', timestamp: at(0) },
      { type: 'agent-spawned', name: 'Lead', timestamp: at(1) },
      { type: 'agent-completed', name: 'Lead', toolCallCount: 4, totalInputTokens: 10, totalOutputTokens: 5, cacheReadTokens: 900, cacheCreationTokens: 40, costUsd: 0.25, timestamp: at(2) },
      { type: 'team-completed', status: 'cancelled', timestamp: at(3) },
      { type: 'team-resumed', toolUseId: 'tc-resume', timestamp: at(10) },
      // The resumed launch carries the attempt's 4 earlier calls, and the redispatched attempt starts at zero.
      { type: 'agent-completed', name: 'Lead', toolCallCount: 6, totalInputTokens: 1, totalOutputTokens: 1, costUsd: 0.5, timestamp: at(11) },
      { type: 'agent-spawned', name: 'Lead', timestamp: at(12) },
      { type: 'agent-completed', name: 'Lead', toolCallCount: 3, timestamp: at(13) },
      { type: 'team-completed', status: 'completed', timestamp: at(14) },
    ]);

    expect(runs).toEqual([
      { toolUseId: 'tc-create', status: 'cancelled', startTime: ms(0), endTime: ms(3), toolCount: 4, usage: usage(10, 5, 900, 40, 0.25) },
      { toolUseId: 'tc-resume', status: 'completed', startTime: ms(10), endTime: ms(14), toolCount: 5, usage: usage(1, 1, 0, 0, 0.5) },
    ]);
  });

  it('prefers the totals team-completed recorded, then the ones team-cancelled recorded', () => {
    const recorded = (toolCount: number, u: AgentUsageTotals) => ({ toolCount, ...u });
    const runs = runsOf([
      { type: 'team-created', toolUseId: 'tc-create', timestamp: at(0) },
      { type: 'agent-completed', name: 'Lead', toolCallCount: 9, timestamp: at(1) },
      { type: 'team-cancelled', run: recorded(2, usage(20, 2, 200, 20, 0.5)), timestamp: at(2) },
      { type: 'team-completed', status: 'cancelled', run: recorded(3, usage(30, 3, 300, 30, 0.75)), timestamp: at(3) },
      { type: 'team-resumed', toolUseId: 'tc-resume', timestamp: at(10) },
      { type: 'team-cancelled', run: recorded(1, usage(7, 1, 70, 7, 0.125)), timestamp: at(11) },
    ]);

    expect(runs.map((r) => [r.toolCount, r.usage, r.legacyTokens])).toEqual([
      [3, usage(30, 3, 300, 30, 0.75), undefined],
      [1, usage(7, 1, 70, 7, 0.125), undefined],
    ]);
  });

  it('keeps the input-plus-output tokens an older log recorded apart, with no token kinds and no cache', () => {
    const runs = runsOf([
      { type: 'team-created', toolUseId: 'tc-create', timestamp: at(0) },
      { type: 'agent-completed', name: 'Lead', toolCallCount: 3, totalInputTokens: 10, totalOutputTokens: 20, cacheReadTokens: 9000, cacheCreationTokens: 5, costUsd: 0.75, timestamp: at(1) },
      { type: 'team-completed', status: 'completed', run: { toolCount: 3, tokens: 30, costUsd: 0.75 }, timestamp: at(2) },
      { type: 'team-resumed', toolUseId: 'tc-resume', timestamp: at(10) },
      { type: 'team-cancelled', run: { toolCount: 1, tokens: 7, costUsd: 0.125 }, timestamp: at(11) },
    ]);

    expect(runs.map((r) => [r.toolCount, r.usage, r.legacyTokens])).toEqual([
      [3, usage(0, 0, 0, 0, 0.75), 30],
      [1, usage(0, 0, 0, 0, 0.125), 7],
    ]);
  });

  it('ends a run cut short by a reload as cancelled at its last entry, before the resume that follows it', () => {
    const runs = runsOf([
      { type: 'team-created', toolUseId: 'tc-create', timestamp: at(0) },
      { type: 'agent-message', timestamp: at(5) },
      { type: 'team-resumed', toolUseId: 'tc-resume', timestamp: at(20) },
      { type: 'agent-message', timestamp: at(25) },
    ]);

    expect(runs.map((r) => [r.toolUseId, r.status, r.endTime])).toEqual([
      ['tc-create', 'cancelled', ms(5)],
      ['tc-resume', 'cancelled', ms(25)],
    ]);
  });

  it('ignores malformed values from the untrusted log', () => {
    const runs = runsOf([
      null,
      'text',
      { type: 'team-resumed', toolUseId: 7, timestamp: at(0) },
      { type: 'team-created', toolUseId: 'tc-create', timestamp: 'not a time' },
      { type: 'team-created', toolUseId: 'tc-create', timestamp: at(1) },
      { type: 'agent-completed', name: 'Lead', toolCallCount: -3, totalInputTokens: 'many', totalOutputTokens: 1.5, cacheReadTokens: -2, costUsd: Number.NaN, timestamp: at(2) },
      { type: 'team-cancelled', run: { toolCount: 1, tokens: -1, costUsd: 0 }, timestamp: at(3) },
      { type: 'team-cancelled', run: { toolCount: 1, totalInputTokens: 1, totalOutputTokens: 1, cacheReadTokens: 'x', cacheCreationTokens: 1, costUsd: 1 }, timestamp: at(3) },
      { type: 'team-completed', status: 'running', timestamp: at(4) },
      { type: 'team-completed', status: 'cancelled', run: { toolCount: '5', tokens: 1, costUsd: 1 }, timestamp: at(5) },
    ]);

    expect(runs).toEqual([{ toolUseId: 'tc-create', status: 'cancelled', startTime: ms(1), endTime: ms(5), toolCount: 0, usage: usage(0, 0, 0, 0, 0) }]);
  });
});

describe('TeamRunLog member effort', () => {
  const logOf = (entries: unknown[]): TeamRunLog => {
    const log = new TeamRunLog();
    for (const entry of entries) log.add(entry);
    return log;
  };
  const spawned = (attempt: number, second: number) => ({ type: 'agent-spawned', agentId: 'a1', name: 'dev', attempt, timestamp: at(second) });
  const started = (attempt: number, effort: unknown, second: number) => ({ type: 'agent-session-started', agentId: 'a1', attempt, effort, timestamp: at(second) });

  it("takes the effort the attempt's session recorded", () => {
    expect(logOf([spawned(0, 1), started(0, 'high', 2)]).memberEffort('a1')).toBe('high');
  });

  it("resets on a new attempt until that attempt's session starts, and ignores a late entry of the dead attempt", () => {
    expect(logOf([spawned(0, 1), started(0, 'high', 2), spawned(1, 3)]).memberEffort('a1')).toBeNull();
    expect(logOf([spawned(0, 1), started(0, 'high', 2), spawned(1, 3), started(0, 'low', 4)]).memberEffort('a1')).toBeNull();
    expect(logOf([spawned(0, 1), started(0, 'high', 2), spawned(1, 3), started(1, 'medium', 4)]).memberEffort('a1')).toBe('medium');
  });

  it('a resume continues the attempt, and its new session updates the effort', () => {
    expect(logOf([spawned(0, 1), started(0, 'high', 2), started(0, 'xhigh', 3)]).memberEffort('a1')).toBe('xhigh');
    expect(logOf([spawned(0, 1), started(0, 'high', 2), started(0, null, 3)]).memberEffort('a1')).toBeNull();
  });

  it('shows nothing for a log written before the entry existed, or an entry with an unknown level', () => {
    expect(logOf([spawned(0, 1)]).memberEffort('a1')).toBeNull();
    expect(logOf([{ type: 'agent-spawned', agentId: 'a1', name: 'dev', timestamp: at(1) }, started(0, 'high', 2)]).memberEffort('a1')).toBe('high');
    expect(logOf([spawned(0, 1), started(0, 'ultracode', 2)]).memberEffort('a1')).toBeNull();
    expect(logOf([]).memberEffort('a1')).toBeNull();
  });

  it('leaves the run totals alone', () => {
    const entries = [{ type: 'team-created', toolUseId: 'tc', timestamp: at(0) }, spawned(0, 1), { type: 'team-completed', status: 'completed', timestamp: at(3) }];
    expect(runsOf([...entries.slice(0, 2), started(0, 'high', 2), entries[2]])).toEqual(runsOf(entries));
  });
});

describe('TeamRunLog member active time', () => {
  const logOf = (entries: unknown[]): TeamRunLog => {
    const log = new TeamRunLog();
    for (const entry of entries) log.add(entry);
    return log;
  };
  const created = (second: number) => ({ type: 'team-created', toolUseId: 'tc-create', timestamp: at(second) });
  const resumed = (second: number) => ({ type: 'team-resumed', toolUseId: 'tc-resume', timestamp: at(second) });
  const teamDone = (second: number) => ({ type: 'team-completed', status: 'cancelled', timestamp: at(second) });
  const spawned = (attempt: number, second: number) => ({ type: 'agent-spawned', agentId: 'a1', name: 'dev', attempt, timestamp: at(second) });
  const memberResumed = (attempt: number, second: number) => ({ type: 'agent-resumed', agentId: 'a1', name: 'dev', attempt, timestamp: at(second) });
  const settled = (second: number) => ({ type: 'agent-completed', agentId: 'a1', name: 'dev', status: 'cancelled', timestamp: at(second) });
  const message = (second: number) => ({ type: 'agent-message', timestamp: at(second) });

  it('runs from the spawn entry to the settle entry', () => {
    expect(logOf([created(0), spawned(0, 2), settled(9)]).memberActiveMs('a1')).toBe(7_000);
  });

  it('carries across a resume and excludes the gap while the team was stopped', () => {
    const log = logOf([created(0), spawned(0, 1), settled(11), teamDone(12), resumed(100), memberResumed(0, 101), settled(106), teamDone(107)]);
    expect(log.memberActiveMs('a1')).toBe(10_000 + 5_000);
  });

  it('a parked member counts from its resume entry until the run ends', () => {
    // A park-mode resume writes agent-resumed like any other, and the member settles only when the team stops.
    const log = logOf([created(0), spawned(0, 1), settled(4), teamDone(5), resumed(50), memberResumed(0, 51), message(60), teamDone(70)]);
    expect(log.memberActiveMs('a1')).toBe(3_000 + 19_000);
  });

  it('closes an open segment at the entry before the next run starts, or at the log end, when a run was cut short', () => {
    expect(logOf([created(0), spawned(0, 1), message(8), resumed(50), memberResumed(0, 51), message(53)]).memberActiveMs('a1')).toBe(7_000 + 2_000);
    expect(logOf([created(0), spawned(0, 1), message(8)]).memberActiveMs('a1')).toBe(7_000);
  });

  it('closes at team-completed, and a member settling after it cannot move that figure', () => {
    expect(logOf([created(0), spawned(0, 1), teamDone(6), settled(9)]).memberActiveMs('a1')).toBe(5_000);
  });

  it("a late settle stamped with an earlier run's toolUseId does not close the resumed run's segment or count toward it", () => {
    const lateSettle = { ...settled(103), toolUseId: 'tc-create', toolCallCount: 4, costUsd: 1 };
    const log = logOf([created(0), spawned(0, 1), teamDone(6), resumed(100), memberResumed(0, 101), lateSettle, settled(110)]);
    expect(log.memberActiveMs('a1')).toBe(5_000 + 9_000);
    expect(log.runs()[1]).toMatchObject({ toolUseId: 'tc-resume', toolCount: 0, usage: { costUsd: 0 } });
    // A log written before the stamp keeps the earlier behaviour: the unstamped settle closes the segment.
    expect(logOf([created(0), spawned(0, 1), teamDone(6), resumed(100), memberResumed(0, 101), settled(103), settled(110)]).memberActiveMs('a1')).toBe(5_000 + 2_000);
  });

  it('a redispatch starts the new attempt from zero at its spawn entry', () => {
    const log = logOf([created(0), spawned(0, 1), settled(5), spawned(1, 20), settled(23)]);
    expect(log.memberActiveMs('a1')).toBe(3_000);
    expect(log.memberActiveTimes()).toEqual(new Map([['a1', 3_000]]));
  });

  it('ignores a resume entry of a dead attempt, and reads zero for a member that never spawned', () => {
    expect(logOf([created(0), spawned(0, 1), settled(2), spawned(1, 3), settled(4), memberResumed(0, 5), message(9)]).memberActiveMs('a1')).toBe(1_000);
    expect(logOf([created(0)]).memberActiveMs('a1')).toBe(0);
  });

  it('leaves the run totals alone', () => {
    const entries = [created(0), spawned(0, 1), settled(4), teamDone(5)];
    expect(runsOf([...entries.slice(0, 2), memberResumed(0, 2), ...entries.slice(2)])).toEqual(runsOf(entries));
  });
});
