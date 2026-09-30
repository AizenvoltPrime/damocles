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
