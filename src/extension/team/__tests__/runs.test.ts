import { describe, it, expect } from 'vitest';
import { TeamRunLog } from '../runs';

const at = (second: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const ms = (second: number): number => Date.parse(at(second));

function runsOf(entries: unknown[]) {
  const log = new TeamRunLog();
  for (const entry of entries) log.add(entry);
  return log.runs();
}

describe('TeamRunLog', () => {
  it('sums a run with no recorded totals from its members, counting only each launch\'s own tool calls', () => {
    const runs = runsOf([
      { type: 'team-created', toolUseId: 'tc-create', timestamp: at(0) },
      { type: 'agent-spawned', name: 'Lead', timestamp: at(1) },
      { type: 'agent-completed', name: 'Lead', toolCallCount: 4, totalInputTokens: 10, totalOutputTokens: 5, costUsd: 0.25, timestamp: at(2) },
      { type: 'team-completed', status: 'cancelled', timestamp: at(3) },
      { type: 'team-resumed', toolUseId: 'tc-resume', timestamp: at(10) },
      // The resumed launch carries the attempt's 4 earlier calls, and the redispatched attempt starts at zero.
      { type: 'agent-completed', name: 'Lead', toolCallCount: 6, totalInputTokens: 1, totalOutputTokens: 1, costUsd: 0.5, timestamp: at(11) },
      { type: 'agent-spawned', name: 'Lead', timestamp: at(12) },
      { type: 'agent-completed', name: 'Lead', toolCallCount: 3, timestamp: at(13) },
      { type: 'team-completed', status: 'completed', timestamp: at(14) },
    ]);

    expect(runs).toEqual([
      { toolUseId: 'tc-create', status: 'cancelled', startTime: ms(0), endTime: ms(3), toolCount: 4, tokens: 15, costUsd: 0.25 },
      { toolUseId: 'tc-resume', status: 'completed', startTime: ms(10), endTime: ms(14), toolCount: 5, tokens: 2, costUsd: 0.5 },
    ]);
  });

  it('prefers the totals team-completed recorded, then the ones team-cancelled recorded', () => {
    const runs = runsOf([
      { type: 'team-created', toolUseId: 'tc-create', timestamp: at(0) },
      { type: 'agent-completed', name: 'Lead', toolCallCount: 9, timestamp: at(1) },
      { type: 'team-cancelled', run: { toolCount: 2, tokens: 20, costUsd: 0.5 }, timestamp: at(2) },
      { type: 'team-completed', status: 'cancelled', run: { toolCount: 3, tokens: 30, costUsd: 0.75 }, timestamp: at(3) },
      { type: 'team-resumed', toolUseId: 'tc-resume', timestamp: at(10) },
      { type: 'team-cancelled', run: { toolCount: 1, tokens: 7, costUsd: 0.125 }, timestamp: at(11) },
    ]);

    expect(runs.map((r) => [r.toolCount, r.tokens, r.costUsd])).toEqual([[3, 30, 0.75], [1, 7, 0.125]]);
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
      { type: 'agent-completed', name: 'Lead', toolCallCount: -3, totalInputTokens: 'many', totalOutputTokens: 1.5, costUsd: Number.NaN, timestamp: at(2) },
      { type: 'team-cancelled', run: { toolCount: 1, tokens: -1, costUsd: 0 }, timestamp: at(3) },
      { type: 'team-completed', status: 'running', timestamp: at(4) },
      { type: 'team-completed', status: 'cancelled', run: { toolCount: '5', tokens: 1, costUsd: 1 }, timestamp: at(5) },
    ]);

    expect(runs).toEqual([{ toolUseId: 'tc-create', status: 'cancelled', startTime: ms(1), endTime: ms(5), toolCount: 0, tokens: 0, costUsd: 0 }]);
  });
});
