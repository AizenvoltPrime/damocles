import { describe, it, expect } from 'vitest';
import { formatBackgroundResults, SUBAGENT_RESULTS_CUSTOM_TYPE } from '../background-results';
import type { AgentRecord } from '../types';

function rec(over: Partial<AgentRecord>): AgentRecord {
  return {
    id: 'a1', type: 'Explore', description: 'find things', status: 'completed',
    toolUses: 0, startedAt: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, costUsd: 0, compactionCount: 0,
    ...over,
  };
}

describe('formatBackgroundResults', () => {
  it('renders each record as a labelled block with its result text', () => {
    const out = formatBackgroundResults([
      rec({ type: 'Explore', description: 'vehicles', result: 'found A, B' }),
      rec({ id: 'a2', type: 'Explore', description: 'personnel', result: 'found C' }),
    ]);
    expect(out).toContain('## Explore — vehicles\nfound A, B');
    expect(out).toContain('## Explore — personnel\nfound C');
    expect(out).toContain('subagents you launched have finished');
  });

  it('uses singular phrasing and falls back to error/no-output text', () => {
    const out = formatBackgroundResults([rec({ result: undefined, error: 'boom' })]);
    expect(out).toContain('subagent you launched has finished');
    expect(out).toContain('boom');
  });

  it('prefixes user-steer lines into the record block so the parent sees mid-task redirects', () => {
    const out = formatBackgroundResults([
      rec({ type: 'Explore', description: 'vehicles', result: 'found A', userSteers: ['focus on tests', 'skip UI'] }),
    ]);
    expect(out).toContain('## Explore — vehicles\n[User steered this agent mid-task: "focus on tests"]\n[User steered this agent mid-task: "skip UI"]\nfound A');
  });

  it('exports a stable custom-message type', () => {
    expect(SUBAGENT_RESULTS_CUSTOM_TYPE).toBe('damocles-subagent-results');
  });
});
