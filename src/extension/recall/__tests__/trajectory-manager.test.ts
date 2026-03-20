import { describe, it, expect, beforeEach } from 'vitest';
import { TrajectoryManager } from '../managers/trajectory-manager';
import type { RecallTrajectory } from '../types';

function makeTrajectory(overrides: Partial<RecallTrajectory> = {}): RecallTrajectory {
  return {
    promptIndex: 0,
    userPrompt: 'test',
    iterations: [],
    finalContext: null,
    totalDurationMs: 100,
    shortCircuited: false,
    forcedAnswer: false,
    timedOut: false,
    turnCount: 5,
    historyChars: 1000,
    nodeId: null,
    nodeTitle: null,
    contextTurns: [],
    seedContext: null,
    relatedSummaries: [],
    orientation: null,
    ...overrides,
  };
}

describe('TrajectoryManager', () => {
  let manager: TrajectoryManager;

  beforeEach(() => {
    manager = new TrajectoryManager();
  });

  it('stores and retrieves trajectories by promptIndex', () => {
    const traj = makeTrajectory({ promptIndex: 3 });
    manager.store(3, traj);
    expect(manager.get(3)).toBe(traj);
  });

  it('returns undefined for unknown promptIndex', () => {
    expect(manager.get(999)).toBeUndefined();
  });

  it('overwrites existing trajectory at same index', () => {
    const first = makeTrajectory({ userPrompt: 'first' });
    const second = makeTrajectory({ userPrompt: 'second' });
    manager.store(0, first);
    manager.store(0, second);
    expect(manager.get(0)?.userPrompt).toBe('second');
  });

  it('stores multiple trajectories independently', () => {
    const t1 = makeTrajectory({ promptIndex: 0, userPrompt: 'q1' });
    const t2 = makeTrajectory({ promptIndex: 1, userPrompt: 'q2' });
    const t3 = makeTrajectory({ promptIndex: 2, userPrompt: 'q3' });
    manager.store(0, t1);
    manager.store(1, t2);
    manager.store(2, t3);
    expect(manager.get(0)?.userPrompt).toBe('q1');
    expect(manager.get(1)?.userPrompt).toBe('q2');
    expect(manager.get(2)?.userPrompt).toBe('q3');
  });

  it('resets clears all trajectories', () => {
    manager.store(0, makeTrajectory());
    manager.store(1, makeTrajectory());
    manager.reset();
    expect(manager.get(0)).toBeUndefined();
    expect(manager.get(1)).toBeUndefined();
  });

  it('load replaces all trajectories from a map', () => {
    manager.store(0, makeTrajectory({ userPrompt: 'old' }));

    const newTrajectories = new Map<number, RecallTrajectory>();
    newTrajectories.set(5, makeTrajectory({ promptIndex: 5, userPrompt: 'loaded' }));
    newTrajectories.set(6, makeTrajectory({ promptIndex: 6, userPrompt: 'loaded2' }));
    manager.load(newTrajectories);

    expect(manager.get(0)).toBeUndefined();
    expect(manager.get(5)?.userPrompt).toBe('loaded');
    expect(manager.get(6)?.userPrompt).toBe('loaded2');
  });

  it('load creates an independent copy', () => {
    const source = new Map<number, RecallTrajectory>();
    source.set(0, makeTrajectory());
    manager.load(source);

    source.set(1, makeTrajectory({ promptIndex: 1 }));
    expect(manager.get(1)).toBeUndefined();
  });
});
