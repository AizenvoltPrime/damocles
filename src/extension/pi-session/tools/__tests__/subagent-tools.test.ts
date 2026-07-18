import { describe, it, expect } from 'vitest';
import { recordResultText } from '../subagent-tools';
import type { AgentRecord } from '../../subagents/types';

function rec(over: Partial<AgentRecord>): AgentRecord {
  return {
    id: 'a1', type: 'Explore', description: 'find things', status: 'completed',
    toolUses: 0, startedAt: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, costUsd: 0, compactionCount: 0,
    ...over,
  };
}

describe('recordResultText', () => {
  it('prefixes a line per user steer before the composed result text', () => {
    const out = recordResultText(rec({ result: 'done', userSteers: ['focus on tests', 'skip UI'] }));
    expect(out).toBe('[User steered this agent mid-task: "focus on tests"]\n[User steered this agent mid-task: "skip UI"]\ndone');
  });

  it('is byte-for-byte unchanged when no user steers occurred', () => {
    expect(recordResultText(rec({ result: 'done' }))).toBe('done');
  });
});
