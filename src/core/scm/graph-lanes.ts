// The Graph's lanes, ported from VS Code's src/vs/workbench/contrib/scm/browser/scmHistory.ts (MIT, Copyright (c) Microsoft
// Corporation; see THIRD-PARTY-NOTICES.md): toISCMHistoryItemViewModelArray, addIncomingOutgoingChangesHistoryItems,
// compareHistoryItemRefs and the geometry of renderSCMHistoryItemGraph, with the row height and lane width as parameters.
// Pure: the shell imports it.

// The default row height and lane width in CSS px at the default font (1.625rem and VS Code's SWIMLANE_WIDTH).
export const GRAPH_ROW_HEIGHT = 26;
export const GRAPH_LANE_WIDTH = 11;
// The tokens a lane colour maps to through tokenIndex, in order: --d-accent, --d-info, --d-warning, --d-success, --d-danger.
export const GRAPH_TOKEN_COUNT = 5;
// Lane colours: HEAD's ref, its upstream and its base ref have their own; every other lane takes the next of the cycle,
// FIRST_CYCLE_COLOR onwards, so lane colours stay distinct values while tokenIndex maps them onto the five tokens.
export const HEAD_REF_COLOR = 0;
export const UPSTREAM_REF_COLOR = 1;
export const BASE_REF_COLOR = 2;
export const FIRST_CYCLE_COLOR = 3;
// The ids of the incoming and outgoing changes rows, which no commit hash can equal.
export const INCOMING_CHANGES_ID = 'incoming-changes';
export const OUTGOING_CHANGES_ID = 'outgoing-changes';

/** The token (0 accent, 1 info, 2 warning, 3 success, 4 danger) a lane colour is drawn with. */
export function tokenIndex(color: number): number {
  return color % GRAPH_TOKEN_COUNT;
}

/** The lane colour of the k-th lane the cycle colours (k from 0). */
export function cycleColor(k: number): number {
  return FIRST_CYCLE_COLOR + (k % GRAPH_TOKEN_COUNT);
}

export interface GraphRefLike {
  readonly id: string;
}

export interface GraphCommitLike {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly refs: readonly GraphRefLike[];
}

// A ref of HEAD's set with the commit it points to.
export interface GraphHeadRef {
  readonly id: string;
  readonly revision: string;
}

export interface GraphOptions {
  readonly head?: GraphHeadRef;
  readonly upstream?: GraphHeadRef;
  readonly base?: GraphHeadRef;
  // the load's resolved refs: their badges take their commit's lane colour, as VS Code's colour map lists them
  readonly refIds?: readonly string[];
  // show the incoming changes row (VS Code adds it only while the upstream is among the refs shown)
  readonly incoming?: boolean;
  // show the outgoing changes row (only while HEAD's ref is among the refs shown)
  readonly outgoing?: boolean;
  // merge-base of HEAD and its upstream
  readonly mergeBase?: string;
}

export interface Swimlane {
  // the commit the lane leads to, or INCOMING_CHANGES_ID
  readonly id: string;
  readonly color: number;
}

export type GraphRowKind = 'HEAD' | 'node' | 'incoming-changes' | 'outgoing-changes';

export interface GraphRowRef<R extends GraphRefLike> {
  readonly ref: R;
  // a lane colour, or undefined for a badge drawn in the neutral colour
  readonly color: number | undefined;
}

export interface GraphRow<C extends GraphCommitLike> {
  readonly kind: GraphRowKind;
  // the commit's hash, or INCOMING_CHANGES_ID / OUTGOING_CHANGES_ID
  readonly id: string;
  readonly parents: readonly string[];
  // absent on the incoming and outgoing changes rows
  readonly commit?: C;
  // the commit's badges, HEAD's ref first, then its upstream, its base, the coloured ones and the rest, each in git's order
  readonly refs: ReadonlyArray<GraphRowRef<C['refs'][number]>>;
  readonly input: readonly Swimlane[];
  readonly output: readonly Swimlane[];
}

// The colour map of VS Code's _getGraphColorMap: HEAD's set with their fixed colours, then the other refs shown, uncoloured.
function colorMapOf(options: GraphOptions): Map<string, number | undefined> {
  const map = new Map<string, number | undefined>();
  if (options.head) {
    map.set(options.head.id, HEAD_REF_COLOR);
    if (options.upstream) map.set(options.upstream.id, UPSTREAM_REF_COLOR);
    if (options.base) map.set(options.base.id, BASE_REF_COLOR);
  }
  for (const id of options.refIds ?? []) if (!map.has(id)) map.set(id, undefined);
  return map;
}

function labelColor(id: string, refs: readonly GraphRefLike[], colors: ReadonlyMap<string, number | undefined>): number | undefined {
  if (id === INCOMING_CHANGES_ID) return UPSTREAM_REF_COLOR;
  if (id === OUTGOING_CHANGES_ID) return HEAD_REF_COLOR;
  for (const ref of refs) {
    const color = colors.get(ref.id);
    if (color !== undefined) return color;
  }
  return undefined;
}

// Where a row's node sits: its lane in the input, or a new lane after the last.
function circleIndexOf(input: readonly Swimlane[], id: string): number {
  const index = input.findIndex((lane) => lane.id === id);
  return index !== -1 ? index : input.length;
}

// The node's colour: the output lane at the node's index (its first parent's), else the input lane, else HEAD's colour. A
// commit with no parent has no lane of its own in the output, where the next lane moved into its slot.
function circleColorOf(input: readonly Swimlane[], output: readonly Swimlane[], index: number, parents: number): number {
  return parents > 0 && index < output.length ? output[index]!.color : index < input.length ? input[index]!.color : HEAD_REF_COLOR;
}

function refOrder(id: string, color: number | undefined, options: GraphOptions): number {
  if (id === options.head?.id) return 1;
  if (id === options.upstream?.id) return 2;
  if (id === options.base?.id) return 3;
  return color !== undefined ? 4 : 99;
}

/**
 * The rows of loaded commits in git's topological order: each row's input lanes (the lanes coming down from the row above)
 * and output lanes (those going on below), with the incoming and outgoing changes rows inserted as VS Code inserts them.
 * Recompute from the first commit when a page arrives, since the changes rows reshape lanes of earlier rows.
 */
export function graphRows<C extends GraphCommitLike>(commits: readonly C[], options: GraphOptions = {}): Array<GraphRow<C>> {
  const colors = colorMapOf(options);
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const rows: Array<GraphRow<C>> = [];
  let cycled = 0;
  for (const commit of commits) {
    const input = (rows.at(-1)?.output ?? []).map((lane) => ({ ...lane }));
    const output: Swimlane[] = [];
    let firstParentAdded = false;
    // a root, or a shallow clone's boundary whose parent git leaves out, ends only its own lane (VS Code ends every lane there)
    for (const lane of input) {
      if (lane.id === commit.hash) {
        if (!firstParentAdded && commit.parents.length > 0) {
          output.push({ id: commit.parents[0]!, color: labelColor(commit.hash, commit.refs, colors) ?? lane.color });
          firstParentAdded = true;
        }
        continue;
      }
      output.push({ ...lane });
    }
    for (let i = firstParentAdded ? 1 : 0; i < commit.parents.length; i++) {
      let color: number | undefined;
      if (i === 0) color = labelColor(commit.hash, commit.refs, colors);
      else {
        const parent = byHash.get(commit.parents[i]!);
        color = parent ? labelColor(parent.hash, parent.refs, colors) : undefined;
      }
      output.push({ id: commit.parents[i]!, color: color ?? cycleColor(cycled++) });
    }
    const refs = commit.refs.map((ref) => {
      let color = colors.get(ref.id);
      if (colors.has(ref.id) && color === undefined) color = circleColorOf(input, output, circleIndexOf(input, commit.hash), commit.parents.length);
      return { ref, color };
    });
    refs.sort((a, b) => refOrder(a.ref.id, a.color, options) - refOrder(b.ref.id, b.color, options));
    rows.push({ kind: commit.hash === options.head?.revision ? 'HEAD' : 'node', id: commit.hash, parents: commit.parents, commit, refs, input, output });
  }
  addChangesRows(rows, options);
  return rows;
}

function findLastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return i;
  return -1;
}

function addChangesRows<C extends GraphCommitLike>(rows: Array<GraphRow<C>>, options: GraphOptions): void {
  const { head, upstream, mergeBase } = options;
  if (head?.revision === upstream?.revision || !mergeBase) return;
  if (options.incoming && upstream && upstream.revision !== mergeBase) {
    // the merge base's row may not be loaded yet
    const before = findLastIndex(rows, (row) => row.output.some((lane) => lane.id === mergeBase));
    const after = rows.findIndex((row) => row.id === mergeBase);
    if (before !== -1 && after !== -1) {
      // incoming changes already merged show no row (microsoft/vscode#276064)
      const merged = rows[before]!.parents.length === 2 && rows[before]!.parents.includes(mergeBase);
      if (!merged) {
        const retarget = (lane: Swimlane): Swimlane => (lane.id === mergeBase && lane.color === UPSTREAM_REF_COLOR ? { ...lane, id: INCOMING_CHANGES_ID } : lane);
        rows[before] = { ...rows[before]!, input: rows[before]!.input.map(retarget), output: rows[before]!.output.map(retarget) };
        rows.splice(after, 0, {
          kind: 'incoming-changes',
          id: INCOMING_CHANGES_ID,
          parents: [mergeBase],
          refs: [],
          input: rows[before]!.output.map((lane) => ({ ...lane })),
          output: rows[after]!.input.map((lane) => ({ ...lane })),
        });
      }
    }
  }
  if (options.outgoing && head?.revision && head.revision !== mergeBase) {
    // HEAD's row may not be loaded yet
    const at = rows.findIndex((row) => row.kind === 'HEAD' && row.id === head.revision);
    if (at !== -1) {
      const input = rows[at]!.input.slice(0);
      rows.splice(at, 0, {
        kind: 'outgoing-changes',
        id: OUTGOING_CHANGES_ID,
        parents: [head.revision],
        refs: [],
        input,
        output: [...input, { id: head.revision, color: HEAD_REF_COLOR }],
      });
      const headRow = rows[at + 1]!;
      rows[at + 1] = { ...headRow, input: [...headRow.input, { id: head.revision, color: HEAD_REF_COLOR }] };
    }
  }
}

export type GraphNodeKind = 'node' | 'merge' | 'head' | 'incoming' | 'outgoing';

export interface LanePath {
  // SVG path data in CSS px, the row's top left at 0 0
  readonly d: string;
  readonly color: number;
  // the lane's swimlane id: the commit it leads to
  readonly id: string;
}

export interface RowGeometry {
  readonly width: number;
  readonly height: number;
  // drawn first to last, under the node
  readonly paths: readonly LanePath[];
  readonly node: { readonly x: number; readonly y: number; readonly kind: GraphNodeKind; readonly color: number };
}

export interface GraphSize {
  readonly rowHeight?: number;
  readonly laneWidth?: number;
}

/**
 * One row's lanes and node, as renderSCMHistoryItemGraph draws them: straight lanes, VS Code's arcs where a lane moves left
 * (curve radius 5/11 of a lane), where a branch's first commit joins its parent lane and where a merge's other parents leave.
 * The rows join because each lane ends at the row's bottom where the next row's starts.
 */
export function rowGeometry(row: GraphRow<GraphCommitLike>, size: GraphSize = {}): RowGeometry {
  const height = size.rowHeight ?? GRAPH_ROW_HEIGHT;
  const w = size.laneWidth ?? GRAPH_LANE_WIDTH;
  const r = (w * 5) / 11;
  const mid = height / 2;
  const x = (index: number): number => w * (index + 1);
  const { input, output } = row;
  const inputIndex = input.findIndex((lane) => lane.id === row.id);
  const circleIndex = inputIndex !== -1 ? inputIndex : input.length;
  const circleColor = circleColorOf(input, output, circleIndex, row.parents.length);
  const paths: LanePath[] = [];
  let outputIndex = 0;
  for (let index = 0; index < input.length; index++) {
    const lane = input[index]!;
    if (lane.id === row.id) {
      if (index !== circleIndex) {
        // a second lane into this commit bends left into the node
        paths.push({ d: `M ${x(index)} 0 V ${mid - w} A ${w} ${w} 0 0 1 ${w * index} ${mid} H ${x(circleIndex)}`, color: lane.color, id: lane.id });
        continue;
      }
      // a commit with no parent leaves no lane in its slot, as graphRows ends only its own lane
      if (row.parents.length > 0) outputIndex++;
      continue;
    }
    if (outputIndex < output.length && lane.id === output[outputIndex]!.id) {
      if (index === outputIndex) paths.push({ d: `M ${x(index)} 0 V ${height}`, color: lane.color, id: lane.id });
      else {
        // the lane shifts left to the output index
        const to = x(outputIndex);
        paths.push({ d: `M ${x(index)} 0 V ${mid - r} A ${r} ${r} 0 0 1 ${x(index) - r} ${mid} H ${to + r} A ${r} ${r} 0 0 0 ${to} ${mid + r} V ${height}`, color: lane.color, id: lane.id });
      }
      outputIndex++;
    }
  }
  for (let i = 1; i < row.parents.length; i++) {
    const parent = findLastIndex(output, (lane) => lane.id === row.parents[i]);
    if (parent === -1) continue;
    // a merge's other parent leaves the node to the right and bends down into its lane
    paths.push({ d: `M ${w * parent} ${mid} A ${w} ${w} 0 0 1 ${x(parent)} ${mid + w} V ${height} M ${w * parent} ${mid} H ${x(circleIndex)}`, color: output[parent]!.color, id: output[parent]!.id });
  }
  if (inputIndex !== -1) paths.push({ d: `M ${x(circleIndex)} 0 V ${mid}`, color: input[inputIndex]!.color, id: row.id });
  if (row.parents.length > 0) paths.push({ d: `M ${x(circleIndex)} ${mid} V ${height}`, color: circleColor, id: row.parents[0]! });
  const kind: GraphNodeKind =
    row.kind === 'HEAD' ? 'head' : row.kind === 'incoming-changes' ? 'incoming' : row.kind === 'outgoing-changes' ? 'outgoing' : row.parents.length > 1 ? 'merge' : 'node';
  return { width: w * (Math.max(input.length, output.length, 1) + 1), height, paths, node: { x: x(circleIndex), y: mid, kind, color: circleColor } };
}
