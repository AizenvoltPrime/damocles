import { describe, expect, it } from 'vitest';
import {
  BASE_REF_COLOR,
  cycleColor,
  graphRows,
  HEAD_REF_COLOR,
  INCOMING_CHANGES_ID,
  rowGeometry,
  tokenIndex,
  UPSTREAM_REF_COLOR,
  type GraphOptions,
  type GraphRow,
  type Swimlane,
} from '../graph-lanes';

// The cases of VS Code's src/vs/workbench/contrib/scm/test/browser/scmHistory.test.ts, with its colour registry as the cycle
// and its ref, remote and base colours as HEAD's, the upstream's and the base's.
interface Item {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly refs: ReadonlyArray<{ readonly id: string }>;
}

const item = (hash: string, parents: string[], refs: string[] = []): Item => ({ hash, parents, refs: refs.map((id) => ({ id })) });
const lanes = (list: readonly Swimlane[]): Array<[string, number]> => list.map((lane) => [lane.id, lane.color]);
const shape = (rows: ReadonlyArray<GraphRow<Item>>) => rows.map((row) => ({ kind: row.kind, input: lanes(row.input), output: lanes(row.output) }));
const [C0, C1, C2] = [cycleColor(0), cycleColor(1), cycleColor(2)];
const [R, U, B] = [HEAD_REF_COLOR, UPSTREAM_REF_COLOR, BASE_REF_COLOR];
const INC = INCOMING_CHANGES_ID;

describe('graphRows (ported from scmHistory.test.ts)', () => {
  it('empty graph', () => {
    expect(graphRows([])).toEqual([]);
  });

  it('single commit', () => {
    expect(shape(graphRows([item('a', [])]))).toEqual([{ kind: 'node', input: [], output: [] }]);
  });

  it('linear graph', () => {
    const rows = graphRows([item('a', ['b']), item('b', ['c']), item('c', ['d']), item('d', ['e']), item('e', [])]);
    expect(shape(rows).map(({ input, output }) => [input, output])).toEqual([
      [[], [['b', C0]]],
      [[['b', C0]], [['c', C0]]],
      [[['c', C0]], [['d', C0]]],
      [[['d', C0]], [['e', C0]]],
      [[['e', C0]], []],
    ]);
  });

  it('merge commit (single commit in topic branch)', () => {
    const rows = graphRows([item('a', ['b']), item('b', ['c', 'd']), item('d', ['c']), item('c', ['e']), item('e', ['f'])]);
    expect(shape(rows).map(({ input, output }) => [input, output])).toEqual([
      [[], [['b', C0]]],
      [[['b', C0]], [['c', C0], ['d', C1]]],
      [[['c', C0], ['d', C1]], [['c', C0], ['c', C1]]],
      [[['c', C0], ['c', C1]], [['e', C0]]],
      [[['e', C0]], [['f', C0]]],
    ]);
  });

  it('merge commit (multiple commits in topic branch)', () => {
    const rows = graphRows([item('a', ['b', 'c']), item('c', ['d']), item('b', ['e']), item('e', ['f']), item('f', ['d']), item('d', ['g'])]);
    expect(shape(rows).map(({ input, output }) => [input, output])).toEqual([
      [[], [['b', C0], ['c', C1]]],
      [[['b', C0], ['c', C1]], [['b', C0], ['d', C1]]],
      [[['b', C0], ['d', C1]], [['e', C0], ['d', C1]]],
      [[['e', C0], ['d', C1]], [['f', C0], ['d', C1]]],
      [[['f', C0], ['d', C1]], [['d', C0], ['d', C1]]],
      [[['d', C0], ['d', C1]], [['g', C0]]],
    ]);
  });

  it('create brach from merge commit', () => {
    const rows = graphRows([item('a', ['b', 'c']), item('c', ['b']), item('b', ['d', 'e']), item('e', ['f']), item('f', ['g']), item('d', ['h'])]);
    expect(shape(rows).map(({ input, output }) => [input, output])).toEqual([
      [[], [['b', C0], ['c', C1]]],
      [[['b', C0], ['c', C1]], [['b', C0], ['b', C1]]],
      [[['b', C0], ['b', C1]], [['d', C0], ['e', C2]]],
      [[['d', C0], ['e', C2]], [['d', C0], ['f', C2]]],
      [[['d', C0], ['f', C2]], [['d', C0], ['g', C2]]],
      [[['d', C0], ['g', C2]], [['h', C0], ['g', C2]]],
    ]);
  });

  it('create multiple branches from a commit', () => {
    const rows = graphRows([item('a', ['b', 'c']), item('c', ['d']), item('b', ['e', 'f']), item('f', ['g']), item('e', ['g']), item('d', ['g']), item('g', ['h'])]);
    expect(shape(rows).map(({ input, output }) => [input, output])).toEqual([
      [[], [['b', C0], ['c', C1]]],
      [[['b', C0], ['c', C1]], [['b', C0], ['d', C1]]],
      [[['b', C0], ['d', C1]], [['e', C0], ['d', C1], ['f', C2]]],
      [[['e', C0], ['d', C1], ['f', C2]], [['e', C0], ['d', C1], ['g', C2]]],
      [[['e', C0], ['d', C1], ['g', C2]], [['g', C0], ['d', C1], ['g', C2]]],
      [[['g', C0], ['d', C1], ['g', C2]], [['g', C0], ['g', C1], ['g', C2]]],
      [[['g', C0], ['g', C1], ['g', C2]], [['h', C0]]],
    ]);
  });

  it('graph with color map', () => {
    const rows = graphRows(
      [item('a', ['b'], ['topic']), item('b', ['c']), item('c', ['d'], ['origin/topic']), item('d', ['e']), item('e', ['f', 'g']), item('g', ['h'], ['origin/main'])],
      { head: { id: 'topic', revision: 'not-loaded' }, upstream: { id: 'origin/topic', revision: 'c' }, base: { id: 'origin/main', revision: 'g' } },
    );
    expect(shape(rows).map(({ input, output }) => [input, output])).toEqual([
      [[], [['b', R]]],
      [[['b', R]], [['c', R]]],
      [[['c', R]], [['d', U]]],
      [[['d', U]], [['e', U]]],
      [[['e', U]], [['f', U], ['g', B]]],
      [[['f', U], ['g', B]], [['f', U], ['h', B]]],
    ]);
  });

  it('graph with incoming/outgoing changes (remote ref first)', () => {
    const options: GraphOptions = { head: { id: 'main', revision: 'c' }, upstream: { id: 'origin/main', revision: 'a' }, incoming: true, outgoing: true, mergeBase: 'e' };
    const rows = graphRows([item('a', ['b'], ['origin/main']), item('b', ['e']), item('c', ['d'], ['main']), item('d', ['e']), item('e', ['f']), item('f', ['g'])], options);
    expect(shape(rows)).toEqual([
      { kind: 'node', input: [], output: [['b', U]] },
      { kind: 'node', input: [['b', U]], output: [['e', U]] },
      { kind: 'outgoing-changes', input: [['e', U]], output: [['e', U], ['c', R]] },
      { kind: 'HEAD', input: [['e', U], ['c', R]], output: [['e', U], ['d', R]] },
      { kind: 'node', input: [[INC, U], ['d', R]], output: [[INC, U], ['e', R]] },
      { kind: 'incoming-changes', input: [[INC, U], ['e', R]], output: [['e', U], ['e', R]] },
      { kind: 'node', input: [['e', U], ['e', R]], output: [['f', U]] },
      { kind: 'node', input: [['f', U]], output: [['g', U]] },
    ]);
  });

  it('graph with incoming/outgoing changes (local ref first)', () => {
    const options: GraphOptions = { head: { id: 'main', revision: 'a' }, upstream: { id: 'origin/main', revision: 'c' }, incoming: true, outgoing: true, mergeBase: 'e' };
    const rows = graphRows([item('a', ['b'], ['main']), item('b', ['e']), item('c', ['d'], ['origin/main']), item('d', ['e']), item('e', ['f']), item('f', ['g'])], options);
    expect(shape(rows)).toEqual([
      { kind: 'outgoing-changes', input: [], output: [['a', R]] },
      { kind: 'HEAD', input: [['a', R]], output: [['b', R]] },
      { kind: 'node', input: [['b', R]], output: [['e', R]] },
      { kind: 'node', input: [['e', R]], output: [['e', R], ['d', U]] },
      { kind: 'node', input: [['e', R], ['d', U]], output: [['e', R], [INC, U]] },
      { kind: 'incoming-changes', input: [['e', R], [INC, U]], output: [['e', R], ['e', U]] },
      { kind: 'node', input: [['e', R], ['e', U]], output: [['f', R]] },
      { kind: 'node', input: [['f', R]], output: [['g', R]] },
    ]);
    expect(rows[5]).toMatchObject({ id: INC, parents: ['e'], refs: [] });
    expect(rows[0]).toMatchObject({ parents: ['a'] });
  });

  it('graph with merged incoming changes', () => {
    const options: GraphOptions = { head: { id: 'main', revision: 'c' }, upstream: { id: 'origin/main', revision: 'a' }, incoming: true, outgoing: true, mergeBase: 'c' };
    const rows = graphRows([item('a', ['b'], ['origin/main']), item('b', ['c', 'd']), item('c', ['e'], ['main']), item('d', ['e']), item('e', ['f']), item('f', ['g'])], options);
    expect(shape(rows)).toEqual([
      { kind: 'node', input: [], output: [['b', U]] },
      { kind: 'node', input: [['b', U]], output: [['c', U], ['d', C0]] },
      { kind: 'HEAD', input: [['c', U], ['d', C0]], output: [['e', R], ['d', C0]] },
      { kind: 'node', input: [['e', R], ['d', C0]], output: [['e', R], ['e', C0]] },
      { kind: 'node', input: [['e', R], ['e', C0]], output: [['f', R]] },
      { kind: 'node', input: [['f', R]], output: [['g', R]] },
    ]);
  });
});

describe('a commit without parents', () => {
  it('ends only its own lane, as a shallow clone\'s boundary commit whose parent git leaves out', () => {
    const rows = graphRows([item('x', ['a', 'y']), item('a', []), item('y', ['z']), item('z', [])]);
    expect(shape(rows).map(({ input, output }) => [input, output])).toEqual([
      [[], [['a', C0], ['y', C1]]],
      [[['a', C0], ['y', C1]], [['y', C1]]],
      [[['y', C1]], [['z', C1]]],
      [[['z', C1]], []],
    ]);
    // the node keeps its own lane's colour, never the one that moved into its slot
    expect(rowGeometry(rows[1]!).node).toEqual({ x: 11, y: 13, kind: 'node', color: C0 });
    const badged = graphRows([item('x', ['a', 'y']), item('a', [], ['refs/tags/root']), item('y', [])], { refIds: ['refs/tags/root'] });
    expect(badged[1]!.refs).toEqual([{ ref: { id: 'refs/tags/root' }, color: C0 }]);
  });
});

describe('graphRows refs and colours', () => {
  it('sorts a commit\'s badges HEAD\'s ref first, then the upstream, the base and the coloured ones, and colours the refs shown', () => {
    const rows = graphRows([item('a', ['b'], ['refs/heads/main', 'refs/tags/v1', 'refs/remotes/origin/main', 'refs/heads/other', 'refs/remotes/up/main'])], {
      head: { id: 'refs/heads/main', revision: 'a' },
      upstream: { id: 'refs/remotes/origin/main', revision: 'a' },
      base: { id: 'refs/remotes/up/main', revision: 'a' },
      refIds: ['refs/heads/other'],
    });
    expect(rows[0]!.refs.map(({ ref, color }) => [ref.id, color])).toEqual([
      ['refs/heads/main', R],
      ['refs/remotes/origin/main', U],
      ['refs/remotes/up/main', B],
      ['refs/heads/other', R],
      ['refs/tags/v1', undefined],
    ]);
  });

  it('maps every lane colour onto the five tokens, the fixed colours first and the cycle after them', () => {
    expect([R, U, B].map(tokenIndex)).toEqual([0, 1, 2]);
    expect(Array.from({ length: 6 }, (_, k) => tokenIndex(cycleColor(k)))).toEqual([3, 4, 0, 1, 2, 3]);
  });

  it('finds a merge\'s other parents through one index of the loaded commits, never a scan per merge', () => {
    let scans = 0;
    class Watched extends Array<Item> {
      override find(...args: Parameters<Item[]['find']>): Item | undefined {
        scans++;
        return super.find(...args);
      }
    }
    const commits = Watched.from([item('m', ['a', 'b'], ['main']), item('a', ['c']), item('b', ['c'], ['side']), item('c', [])]);
    const rows = graphRows(commits, { head: { id: 'main', revision: 'm' }, refIds: ['main', 'side'] });
    expect(rows.map((row) => row.id)).toEqual(['m', 'a', 'b', 'c']);
    // the second parent's lane takes its own ref's colour, as VS Code's lookup gives it
    expect(lanes(rows[0]!.output)).toEqual([['a', R], ['b', C0]]);
    expect(scans).toBe(0);
  });
});

describe('rowGeometry', () => {
  it('draws a straight lane through a commit\'s node at the row\'s middle, scaled by the row height and lane width', () => {
    const [row] = graphRows([item('a', ['b'])]);
    expect(rowGeometry(row!)).toEqual({ width: 22, height: 26, paths: [{ d: 'M 11 13 V 26', color: C0, id: 'b' }], node: { x: 11, y: 13, kind: 'node', color: C0 } });
    const rows = graphRows([item('a', ['b']), item('b', ['c'])]);
    expect(rowGeometry(rows[1]!, { rowHeight: 32, laneWidth: 14 })).toEqual({
      width: 28,
      height: 32,
      paths: [{ d: 'M 14 0 V 16', color: C0, id: 'b' }, { d: 'M 14 16 V 32', color: C0, id: 'c' }],
      node: { x: 14, y: 16, kind: 'node', color: C0 },
    });
  });

  it('draws a merge\'s other parent leaving the node with VS Code\'s arc, and a lane that moves left with its curve', () => {
    const rows = graphRows([item('a', ['b', 'c']), item('c', ['d']), item('b', ['d']), item('d', [])]);
    const merge = rowGeometry(rows[0]!);
    expect(merge.node.kind).toBe('merge');
    expect(merge.paths).toContainEqual({ d: 'M 11 13 A 11 11 0 0 1 22 24 V 26 M 11 13 H 11', color: C1, id: 'c' });
    // b joins d's lane: the second lane into d bends into the node
    const join = rowGeometry(rows[3]!);
    expect(join.paths).toContainEqual({ d: 'M 22 0 V 2 A 11 11 0 0 1 11 13 H 11', color: C1, id: 'd' });
    expect(join.node).toEqual({ x: 11, y: 13, kind: 'node', color: C0 });
    // a lane right of a node whose lane ends shifts left by the curve radius 5/11 of a lane
    const shift = graphRows([item('x', ['a', 'y']), item('a', []), item('y', ['z'])]);
    expect(rowGeometry(shift[1]!).paths).toContainEqual({ d: 'M 22 0 V 8 A 5 5 0 0 1 17 13 H 16 A 5 5 0 0 0 11 18 V 26', color: C1, id: 'y' });
  });

  it('marks HEAD\'s node and the incoming and outgoing rows', () => {
    const options: GraphOptions = { head: { id: 'main', revision: 'a' }, upstream: { id: 'origin/main', revision: 'c' }, incoming: true, outgoing: true, mergeBase: 'e' };
    const rows = graphRows([item('a', ['b'], ['main']), item('b', ['e']), item('c', ['d'], ['origin/main']), item('d', ['e']), item('e', [])], options);
    expect(rows.map((row) => rowGeometry(row).node.kind)).toEqual(['outgoing', 'head', 'node', 'node', 'node', 'incoming', 'node']);
  });
});
