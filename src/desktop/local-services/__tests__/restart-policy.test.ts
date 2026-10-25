import { describe, expect, it } from 'vitest';
import { restartDecision, RESTART_LIMIT, RESTART_WINDOW_MS } from '../restart-policy';

describe('restartDecision', () => {
  it('restarts the first three crashes in five minutes and not the fourth', () => {
    let crashes: readonly number[] = [];
    const counts: Array<number | 'down'> = [];
    for (const at of [0, 1_000, 2_000, 3_000]) {
      const decision = restartDecision(crashes, at);
      crashes = decision.crashes;
      counts.push(decision.restart ? decision.count : 'down');
    }
    expect(counts).toEqual([1, 2, 3, 'down']);
    expect(RESTART_LIMIT).toBe(3);
    expect(RESTART_WINDOW_MS).toBe(300_000);
  });

  it('counts only the crashes of the rolling window', () => {
    const decision = restartDecision([0, 1_000, 2_000], RESTART_WINDOW_MS + 1_500);
    expect(decision).toEqual({ restart: true, count: 2, crashes: [2_000, RESTART_WINDOW_MS + 1_500] });
    expect(restartDecision([0, 1_000, 2_000], RESTART_WINDOW_MS - 1).restart).toBe(false);
  });

  it('starts over from an empty history, as a Restart that clears the count does', () => {
    const halted = restartDecision([0, 1_000, 2_000], 3_000);
    expect(halted.restart).toBe(false);
    expect(restartDecision([], 3_000)).toEqual({ restart: true, count: 1, crashes: [3_000] });
  });
});
