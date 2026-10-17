import type { OverlayRefPickerRef } from '../../preload/overlay-channels';
import type { ScmCommitDetails, ScmCommitFileChange, ScmHistoryCommit, ScmHistoryLoad } from '../../preload/scm-channels';
import { MAX_GRAPH_CHOICE_REFS, type GraphRefChoice } from '../../preload/shell-channels';
import { graphRows, rowGeometry, type GraphRow, type RowGeometry, type Swimlane } from '../../../core/scm/graph-lanes';
import { visibleText } from '@shared/visible-text';

// The Graph's model (plan slice 13, VS Code's scmHistoryViewPane.ts): the ref choice and its picker, the refresh rule and the
// list of fixed-height rows the section virtualizes.

const REF_PREFIXES = ['refs/heads/', 'refs/remotes/', 'refs/tags/'] as const;

/** A full refname's short name, as git's --decorate=short prints it: 'main', 'origin/main', 'v1.0'. */
export function shortRefName(id: string): string {
  const prefix = REF_PREFIXES.find((candidate) => id.startsWith(candidate));
  return prefix === undefined ? id : id.slice(prefix.length);
}

export type RefGroup = 'branches' | 'remotes' | 'tags';

export const refGroupOf = (id: string): RefGroup | undefined =>
  id.startsWith('refs/heads/') ? 'branches' : id.startsWith('refs/remotes/') ? 'remotes' : id.startsWith('refs/tags/') ? 'tags' : undefined;

/** The header chip's text (A.4): "Auto", "All", the one ref's name with its hidden characters shown, or "{n} refs". */
export function chipText(choice: GraphRefChoice, labels: { readonly auto: string; readonly all: string; readonly refs: (n: number) => string }): string {
  if (choice === 'auto') return labels.auto;
  if (choice === 'all') return labels.all;
  return choice.length === 1 ? visibleText(shortRefName(choice[0]!)) : labels.refs(choice.length);
}

/**
 * The choice to keep once a load resolved it: Auto and All as they are, a list without the refs that no longer exist, and Auto
 * when none of them does (the plan's fallback; main loaded Auto's refs then).
 */
export function keptChoice(choice: GraphRefChoice, resolvedRefs: readonly string[]): GraphRefChoice {
  if (choice === 'auto' || choice === 'all') return choice;
  const kept = choice.filter((ref) => resolvedRefs.includes(ref));
  return kept.length === 0 ? 'auto' : kept;
}

export const sameChoice = (a: GraphRefChoice, b: GraphRefChoice): boolean =>
  a === b || (typeof a !== 'string' && typeof b !== 'string' && a.length === b.length && a.every((ref, index) => ref === b[index]));

/** The choice HEAD's ref is shown under, as VS Code's _isCurrentHistoryItemInFilter: Auto and All always, a list when it names it. */
export const headInChoice = (choice: GraphRefChoice, load: Pick<ScmHistoryLoad, 'headRefs' | 'resolvedRefs'>): boolean =>
  choice === 'auto' || choice === 'all' || load.resolvedRefs.includes(load.headRefs.head.id);

// The picker's selection, as VS Code's HistoryItemRefPicker keeps it: Auto, All, or refs, never a mix.
export type PickerSelection = { readonly kind: 'auto' } | { readonly kind: 'all' } | { readonly kind: 'refs'; readonly refs: readonly string[] };

export const selectionOf = (choice: GraphRefChoice): PickerSelection =>
  choice === 'auto' || choice === 'all' ? { kind: choice } : { kind: 'refs', refs: [...choice] };

/**
 * The selection after the user toggles `item`: picking Auto or All clears the rest, picking a ref clears Auto and All, as
 * VS Code's picker does; a ref past MAX_GRAPH_CHOICE_REFS is not added.
 */
export function toggleSelection(selection: PickerSelection, item: 'auto' | 'all' | string): PickerSelection {
  if (item === 'auto' || item === 'all') return selection.kind === item ? { kind: 'refs', refs: [] } : { kind: item };
  const refs = selection.kind === 'refs' ? selection.refs : [];
  if (refs.includes(item)) return { kind: 'refs', refs: refs.filter((ref) => ref !== item) };
  return refs.length >= MAX_GRAPH_CHOICE_REFS ? selection : { kind: 'refs', refs: [...refs, item] };
}

/** The choice a selection accepts as; nothing selected is Auto. */
export const choiceOfSelection = (selection: PickerSelection): GraphRefChoice =>
  selection.kind === 'refs' ? (selection.refs.length === 0 ? 'auto' : selection.refs) : selection.kind;

export const isPicked = (selection: PickerSelection, item: 'auto' | 'all' | string): boolean =>
  item === 'auto' || item === 'all' ? selection.kind === item : selection.kind === 'refs' && selection.refs.includes(item);

export type PickerRow =
  | { readonly kind: 'special'; readonly id: 'auto' | 'all' }
  | { readonly kind: 'group'; readonly group: RefGroup }
  | { readonly kind: 'ref'; readonly ref: OverlayRefPickerRef; readonly group: RefGroup };

/**
 * The picker's rows for what is typed: Auto and All, then Branches, Remote branches and Tags with their refs, each group shown
 * while it has a match. A ref matches when its name holds the text, case-insensitively; Auto and All match their labels.
 */
export function pickerRows(refs: readonly OverlayRefPickerRef[], filter: string, specialLabels: { readonly auto: string; readonly all: string }): PickerRow[] {
  const needle = filter.trim().toLocaleLowerCase();
  const matches = (text: string): boolean => needle === '' || text.toLocaleLowerCase().includes(needle);
  const rows: PickerRow[] = (['auto', 'all'] as const).filter((id) => matches(specialLabels[id])).map((id) => ({ kind: 'special', id }));
  for (const group of ['branches', 'remotes', 'tags'] as const) {
    const members = refs.filter((ref) => refGroupOf(ref.id) === group && matches(ref.name));
    if (members.length === 0) continue;
    rows.push({ kind: 'group', group }, ...members.map((ref) => ({ kind: 'ref' as const, ref, group })));
  }
  return rows;
}

/**
 * VS Code's rule for a ref change: one the user made (a commit, a checkout, a pull) reloads; one made in the background (autofetch,
 * a terminal) reloads only while the list is at its top, and otherwise marks the graph Outdated until a refresh or a scroll to
 * the top.
 */
export const refChangeAction = (background: boolean, atTop: boolean): 'reload' | 'outdated' => (!background || atTop ? 'reload' : 'outdated');

// A commit's expansion as the section holds it: its details once read.
export type DetailsState = { readonly state: 'loading' } | { readonly state: 'failed' } | { readonly state: 'ready'; readonly details: ScmCommitDetails };

// Lines the message block shows before it scrolls.
export const MESSAGE_MAX_LINES = 6;

// position: the row's 1-based place among the commit and changes rows (aria-posinset), which expanding never moves
export type LaneListRow =
  | { readonly kind: 'commit'; readonly key: string; readonly row: GraphRow<ScmHistoryCommit>; readonly geometry: RowGeometry; readonly expanded: boolean; readonly position: number }
  | { readonly kind: 'changes'; readonly key: string; readonly row: GraphRow<ScmHistoryCommit>; readonly geometry: RowGeometry; readonly direction: 'incoming' | 'outgoing'; readonly position: number };

// more: the next page is being read, or its read failed and the row offers to try again
export type GraphListRow = LaneListRow | DetailRow | { readonly kind: 'more'; readonly key: string; readonly state: 'loading' | 'failed' };

// The rows an expanded commit flattens into; lanes are the commit's output lanes, which pass down beside them. position and
// size: the row's place among its commit's detail rows and their count (aria-posinset, aria-setsize).
export type DetailRow = { readonly key: string; readonly hash: string; readonly lanes: readonly Swimlane[]; readonly last: boolean; readonly position: number; readonly size: number } & (
  | { readonly kind: 'meta'; readonly details: ScmCommitDetails | undefined; readonly commit: ScmHistoryCommit }
  | { readonly kind: 'message'; readonly text: string; readonly lines: number; readonly truncated: boolean }
  | { readonly kind: 'stat'; readonly stat: NonNullable<ScmCommitDetails['stat']> }
  | { readonly kind: 'file'; readonly file: ScmCommitFileChange }
  // filesTruncated: the commit changed more files than main lists
  | { readonly kind: 'note'; readonly state: 'loading' | 'failed' | 'filesTruncated' });

export const isDetailRow = (row: GraphListRow): row is DetailRow =>
  row.kind === 'meta' || row.kind === 'message' || row.kind === 'stat' || row.kind === 'file' || row.kind === 'note';

export interface LaneSize {
  readonly rowHeight: number;
  readonly laneWidth: number;
}

export interface ComposeOptions {
  readonly expanded: ReadonlySet<string>;
  readonly details: ReadonlyMap<string, DetailsState>;
  // the row ending the list while a next page is read, or after its read failed
  readonly more?: 'loading' | 'failed' | undefined;
  // the lines a message takes once wrapped beside the lanes of a row that has `lanes` of them; absent counts its line breaks
  readonly messageLines?: (text: string, lanes: number) => number;
}

export type ListOptions = LaneSize & ComposeOptions;

/** One expanded commit's detail rows: the meta row, then the message, the stat and the files once read. */
function detailRows(row: GraphRow<ScmHistoryCommit>, state: DetailsState | undefined, measure: ComposeOptions['messageLines']): DetailRow[] {
  const commit = row.commit!;
  const base = { hash: commit.hash, lanes: row.output, last: false, position: 0, size: 0 };
  const details = state?.state === 'ready' ? state.details : undefined;
  const rows: DetailRow[] = [{ ...base, kind: 'meta', key: `${commit.hash}:meta`, details, commit }];
  if (!details) {
    rows.push({ ...base, kind: 'note', key: `${commit.hash}:note`, state: state?.state === 'failed' ? 'failed' : 'loading' });
  } else {
    const text = details.message.trimEnd();
    rows.push({ ...base, kind: 'message', key: `${commit.hash}:message`, text, lines: Math.min(MESSAGE_MAX_LINES, Math.max(1, measure ? measure(text, row.output.length) : text.split('\n').length)), truncated: details.messageTruncated });
    if (details.stat && details.stat.files > 0) rows.push({ ...base, kind: 'stat', key: `${commit.hash}:stat`, stat: details.stat });
    for (const file of details.files) rows.push({ ...base, kind: 'file', key: `${commit.hash}:file:${file.path}`, file });
    if (details.filesTruncated) rows.push({ ...base, kind: 'note', key: `${commit.hash}:more-files`, state: 'filesTruncated' });
  }
  return rows.map((each, index) => ({ ...each, position: index + 1, size: rows.length, last: index === rows.length - 1 }));
}

/**
 * The lane rows of the loaded commits, with the incoming and outgoing changes rows the port inserts, every commit closed. One
 * pass over the commits: what expands, collapses or arrives later composes on top of it (composeListRows).
 */
export function laneListRows(commits: readonly ScmHistoryCommit[], load: ScmHistoryLoad | undefined, size: LaneSize): LaneListRow[] {
  const { head, upstream, base } = load?.headRefs ?? {};
  const refIds = load?.resolvedRefs ?? [];
  const lanes = graphRows(commits, {
    ...(head ? { head } : {}),
    ...(upstream ? { upstream } : {}),
    ...(base ? { base } : {}),
    refIds,
    incoming: upstream !== undefined && refIds.includes(upstream.id),
    outgoing: head !== undefined && refIds.includes(head.id),
    ...(load?.mergeBase ? { mergeBase: load.mergeBase } : {}),
  });
  return lanes.map((row, index): LaneListRow => {
    const geometry = rowGeometry(row, size);
    if (row.kind === 'incoming-changes' || row.kind === 'outgoing-changes') {
      return { kind: 'changes', key: row.id, row, geometry, direction: row.kind === 'incoming-changes' ? 'incoming' : 'outgoing', position: index + 1 };
    }
    return { kind: 'commit', key: row.id, row, geometry, expanded: false, position: index + 1 };
  });
}

/**
 * The Graph's rows from its lane rows: each expanded commit followed by its detail rows, and the row ending the list while a
 * next page is read or failed. A closed commit keeps its lane row as it is.
 */
export function composeListRows(lanes: readonly LaneListRow[], options: ComposeOptions): GraphListRow[] {
  const rows: GraphListRow[] = [];
  for (const lane of lanes) {
    if (lane.kind === 'commit' && options.expanded.has(lane.key)) {
      rows.push({ ...lane, expanded: true }, ...detailRows(lane.row, options.details.get(lane.key), options.messageLines));
    } else rows.push(lane);
  }
  if (options.more) rows.push({ kind: 'more', key: 'more', state: options.more });
  return rows;
}

/**
 * The picker's refs: every chosen ref the listing holds, and the others in the listing's order while they fit in max; omitted
 * counts the rest.
 */
export function pickerRefs(listed: readonly OverlayRefPickerRef[], chosen: GraphRefChoice, max: number): { readonly refs: OverlayRefPickerRef[]; readonly omitted: number } {
  const keep = new Set(typeof chosen === 'string' ? [] : chosen);
  let room = max - listed.filter((ref) => keep.has(ref.id)).length;
  const refs = listed.filter((ref) => keep.has(ref.id) || room-- > 0);
  return { refs, omitted: listed.length - refs.length };
}

// rem of a row (the prototype's 26px), of a message line, of the message block's padding above and below together, and of
// the card's bottom margin on its last row (CommitDetails.vue's mb-1).
export const ROW_REM = 1.625;
export const MESSAGE_LINE_REM = 1.125;
export const MESSAGE_PAD_REM = 0.5;
export const CARD_END_REM = 0.25;

/**
 * A row's height in rem: one row, except the message block, which takes its lines (capped) plus its padding, and the card's end
 * when it is the card's last row (its 1px bottom border is added in px by the caller).
 */
export const rowRem = (row: GraphListRow): number => (row.kind === 'message' ? MESSAGE_LINE_REM * row.lines + MESSAGE_PAD_REM + (row.last ? CARD_END_REM : 0) : ROW_REM);

/**
 * The lanes a hovered commit's path runs through, as swimlane ids: the commit and its first parents down the loaded rows, and
 * up the rows above it each first child that stays in the commit's lane colour. Its other parents' curves light in its own row.
 */
export function lanePath(rows: readonly GraphListRow[], hash: string): ReadonlySet<string> {
  const commits = rows.flatMap((row) => (row.kind === 'commit' ? [row] : []));
  const at = commits.findIndex((row) => row.key === hash);
  const path = new Set<string>([hash]);
  if (at === -1) return path;
  for (let index = at, current = hash; index < commits.length; index++) {
    const row = commits[index]!;
    if (row.key !== current) continue;
    const parent = row.row.parents[0];
    if (parent === undefined) break;
    path.add(parent);
    current = parent;
  }
  const color = commits[at]!.geometry.node.color;
  for (let index = at - 1, current = hash; index >= 0; index--) {
    const row = commits[index]!;
    if (row.row.parents[0] !== current || row.geometry.node.color !== color) continue;
    path.add(row.key);
    current = row.key;
  }
  return path;
}

const AGE_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit & Intl.NumberFormatOptions['unit'], number]> = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3600], ['minute', 60]];
const shortAges = new Map<string, { readonly now: string; readonly units: ReadonlyMap<string, Intl.NumberFormat> }>();

/**
 * A row's age as the prototype's compact one: "20m", "2h", "5d" (VS Code's fromNow units, narrow), months spelled short so they
 * never read as minutes; under a minute is "now".
 */
export function shortFromNow(date: number, now: number, locale: string): string {
  let formats = shortAges.get(locale);
  if (!formats) {
    const units = new Map(AGE_UNITS.map(([unit]) => [unit, new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: unit === 'month' ? 'short' : 'narrow' })]));
    formats = { now: new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' }).format(0, 'second'), units };
    shortAges.set(locale, formats);
  }
  const seconds = Math.max(0, Math.floor((now - date) / 1000));
  const unit = AGE_UNITS.find(([, size]) => seconds >= size);
  return unit ? formats.units.get(unit[0])!.format(Math.floor(seconds / unit[1])) : formats.now;
}
