import { describe, expect, it } from 'vitest';
import {
  moveGroup,
  moveProject,
  moveProjectInGroup,
  stepGroup,
  stepProject,
  type OrderedProject,
  type ReorderResult,
} from '../components/project-reorder';

const LOCAL = 'local';
const PROD = 'ssh+prod';
const STAGING = 'ssh+staging';

const rows = (...entries: readonly (readonly [string, string])[]): readonly OrderedProject[] =>
  Object.freeze(entries.map(([key, group]) => Object.freeze({ key, group })));

// The order the shell shows when local and prod projects interleave in the one sidebar order.
const MIXED = rows(['a', LOCAL], ['x', PROD], ['b', LOCAL], ['y', PROD]);
const keysOf = (projects: readonly OrderedProject[]): readonly string[] => projects.map((project) => project.key);

const moved = (order: readonly string[]): ReorderResult => ({ ok: true, order });
const refused = (reason: 'otherGroup' | 'unchanged'): ReorderResult => ({ ok: false, reason });

describe('moveProject (flat view)', () => {
  it('moves a remote project above a local one, ignoring groups', () => {
    const projects = rows(['a', LOCAL], ['b', LOCAL], ['app', PROD], ['billing', PROD]);
    expect(moveProject(projects, 'billing', 0)).toEqual(moved(['billing', 'a', 'b', 'app']));
  });

  it('moves a project down to its final index', () => {
    expect(moveProject(MIXED, 'a', 2)).toEqual(moved(['x', 'b', 'a', 'y']));
    expect(moveProject(MIXED, 'a', 3)).toEqual(moved(['x', 'b', 'y', 'a']));
  });

  it('moves a project up to its final index', () => {
    expect(moveProject(MIXED, 'y', 1)).toEqual(moved(['a', 'y', 'x', 'b']));
  });

  it('refuses a move to the index the project already holds', () => {
    expect(moveProject(MIXED, 'b', 2)).toEqual(refused('unchanged'));
  });

  it('never mutates its input and returns a permutation', () => {
    const result = moveProject(MIXED, 'x', 3);
    expect(result.ok && [...result.order].sort()).toEqual([...keysOf(MIXED)].sort());
    expect(keysOf(MIXED)).toEqual(['a', 'x', 'b', 'y']);
  });
});

describe('moveProjectInGroup (grouped view)', () => {
  it('moves among the group positions in the one order while other rows keep theirs', () => {
    expect(moveProjectInGroup(MIXED, 'y', PROD, 0)).toEqual(moved(['a', 'y', 'b', 'x']));
    expect(moveProjectInGroup(MIXED, 'a', LOCAL, 1)).toEqual(moved(['b', 'x', 'a', 'y']));
  });

  it('keeps a third group untouched when two groups trade places inside theirs', () => {
    const projects = rows(['a', LOCAL], ['s', STAGING], ['x', PROD], ['b', LOCAL], ['y', PROD], ['z', PROD]);
    expect(moveProjectInGroup(projects, 'z', PROD, 0)).toEqual(moved(['a', 's', 'z', 'b', 'x', 'y']));
    expect(moveProjectInGroup(projects, 'x', PROD, 2)).toEqual(moved(['a', 's', 'y', 'b', 'z', 'x']));
  });

  it('refuses a drop on another host\'s group', () => {
    expect(moveProjectInGroup(MIXED, 'y', LOCAL, 0)).toEqual(refused('otherGroup'));
    expect(moveProjectInGroup(MIXED, 'a', PROD, 1)).toEqual(refused('otherGroup'));
  });

  it('refuses a move to the place the project already holds in its group', () => {
    expect(moveProjectInGroup(MIXED, 'y', PROD, 1)).toEqual(refused('unchanged'));
  });
});

describe('moveGroup', () => {
  it('moves a group to its final index in the group order', () => {
    expect(moveGroup([LOCAL, PROD, STAGING], PROD, 0)).toEqual(moved([PROD, LOCAL, STAGING]));
    expect(moveGroup([LOCAL, PROD, STAGING], LOCAL, 2)).toEqual(moved([PROD, STAGING, LOCAL]));
  });

  it('refuses a move to the index the group already holds', () => {
    expect(moveGroup([LOCAL, PROD], PROD, 1)).toEqual(refused('unchanged'));
  });
});

describe('stepProject (Alt+Up, Alt+Down, Move up, Move down)', () => {
  it('steps one place in the whole list in flat view', () => {
    expect(stepProject(MIXED, 'x', 1, 'flat')).toEqual(moved(['a', 'b', 'x', 'y']));
    expect(stepProject(MIXED, 'b', -1, 'flat')).toEqual(moved(['a', 'b', 'x', 'y']));
  });

  it('refuses a step past either end of the list in flat view', () => {
    expect(stepProject(MIXED, 'a', -1, 'flat')).toEqual(refused('unchanged'));
    expect(stepProject(MIXED, 'y', 1, 'flat')).toEqual(refused('unchanged'));
  });

  it('steps one place among its group\'s positions in grouped view', () => {
    expect(stepProject(MIXED, 'y', -1, 'grouped')).toEqual(moved(['a', 'y', 'b', 'x']));
    expect(stepProject(MIXED, 'a', 1, 'grouped')).toEqual(moved(['b', 'x', 'a', 'y']));
  });

  it('refuses a step past either end of its group in grouped view, though the list goes on', () => {
    expect(stepProject(MIXED, 'x', -1, 'grouped')).toEqual(refused('unchanged'));
    expect(stepProject(MIXED, 'b', 1, 'grouped')).toEqual(refused('unchanged'));
    expect(stepProject(MIXED, 'a', -1, 'grouped')).toEqual(refused('unchanged'));
    expect(stepProject(MIXED, 'y', 1, 'grouped')).toEqual(refused('unchanged'));
  });
});

describe('stepGroup', () => {
  it('steps a group one place', () => {
    expect(stepGroup([LOCAL, PROD, STAGING], PROD, -1)).toEqual(moved([PROD, LOCAL, STAGING]));
    expect(stepGroup([LOCAL, PROD, STAGING], PROD, 1)).toEqual(moved([LOCAL, STAGING, PROD]));
  });

  it('refuses a step past either end of the group order', () => {
    expect(stepGroup([LOCAL, PROD], LOCAL, -1)).toEqual(refused('unchanged'));
    expect(stepGroup([LOCAL, PROD], PROD, 1)).toEqual(refused('unchanged'));
  });
});
