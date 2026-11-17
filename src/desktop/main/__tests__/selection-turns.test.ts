import { describe, expect, it } from 'vitest';
import { SelectionTurns } from '../selection-turns';

describe('SelectionTurns', () => {
  it('drops a project selection a later selection overtook while its presence check ran', async () => {
    const turns = new SelectionTurns();
    const selected: string[] = [];
    const selectProject = async (key: string, presenceCheck: Promise<void>): Promise<void> => {
      const turn = turns.begin();
      await presenceCheck;
      if (turn.current()) selected.push(key);
      turn.settle();
    };
    let answerSlowShare!: () => void;
    const slow = selectProject('A', new Promise<void>((resolve) => { answerSlowShare = resolve; }));
    await selectProject('B', Promise.resolve());
    answerSlowShare();
    await slow;
    expect(selected).toEqual(['B']);
  });

  it('lets a re-check no selection asked for neither run while a selection is in flight nor overtake one that starts after it', async () => {
    const turns = new SelectionTurns();
    const selected: string[] = [];
    const select = async (key: string, presenceCheck: Promise<void>): Promise<void> => {
      const turn = turns.begin();
      await presenceCheck;
      if (turn.current()) selected.push(key);
      turn.settle();
    };
    const recheck = async (key: string, presenceCheck: Promise<void>): Promise<void> => {
      const current = turns.join();
      if (!current) return;
      await presenceCheck;
      if (current()) selected.push(key);
    };
    let answerB!: () => void;
    const userSelectsB = select('B', new Promise<void>((resolve) => { answerB = resolve; }));
    await recheck('A', Promise.resolve());
    answerB();
    await userSelectsB;
    expect(selected).toEqual(['B']);

    let answerLate!: () => void;
    const lateRecheck = recheck('B', new Promise<void>((resolve) => { answerLate = resolve; }));
    await select('C', Promise.resolve());
    answerLate();
    await lateRecheck;
    expect(selected).toEqual(['B', 'C']);
  });
});
