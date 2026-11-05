import type { Component } from 'vue';
import { Folder } from 'lucide-vue-next';
import { quickOpenRowKey, type OverlayQuickPickIcon, type OverlayQuickPickItem, type PaletteCommand, type QuickOpenMatch, type QuickOpenPick, type QuickOpenResponse, type QuickOpenResult } from '../../preload/overlay-channels';
import type { TerminalProfileOption, TerminalProjectOption } from '../../preload/terminal-channels';
import { compareScoredItems, prepareQuery, scoreItem, type FuzzyItem, type ItemScore, type PreparedQuery } from '../../../core/quick-open/fuzzy-match';
import { glyphLook, terminalGlyph } from '../terminal/terminal-icons';
import { QUICK_PICK_ICON_COMPONENTS } from './icons';

// The quick pick's rows: a reusable list of items with match ranges, grouped under separators. Quick Open fills it with
// files; the command palette fills it with commands.
export interface QuickPickItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly labelMatches: readonly QuickOpenMatch[];
  readonly descriptionMatches: readonly QuickOpenMatch[];
  readonly icon?: Component;
  // a --d-* colour token
  readonly iconColor?: string;
  // a Quick Open file's project-relative or absolute path, drawn as its file icon in place of `icon`
  readonly file?: string;
  // the project chip at the row's end
  readonly project?: string;
  // a command's "Category: " prefix of label, drawn quieter
  readonly categoryLength?: number;
  // a command's shortcut in the platform's display form, drawn as keycaps
  readonly shortcut?: string;
  // shown dimmed; Enter and click do not accept it
  readonly disabled?: boolean;
  readonly checked?: boolean;
  // a quiet chip after the label, such as a terminal profile's Default or a typed path's host
  readonly badge?: string;
  // quiet text at the row's end, such as a branch's "local" or "2↓ 1↑"
  readonly hint?: string;
  // the label in the mono font, as a ref name reads
  readonly mono?: boolean;
  // a folder: `file` draws as its folder icon, and the accessible name says it is a folder
  readonly folder?: true;
  // the query Enter, a click and Tab set instead of accepting the row
  readonly descend?: string;
  // the query Tab sets
  readonly complete?: string;
  // UTF-16 offset into descend or complete for the caret after it is set; absent for its end
  readonly caret?: number;
}

export type QuickPickRow = { readonly kind: 'separator'; readonly label: string } | { readonly kind: 'item'; readonly item: QuickPickItem };

export interface QuickPickModel {
  readonly rows: readonly QuickPickRow[];
  // what Enter does with the query as typed (go to a line, mention in chat)
  readonly hint?: string;
  // a quiet note beside the hint, such as a listing cut at its bounds
  readonly notice?: string;
  // shown for no rows in place of the picker's own empty text
  readonly empty?: string;
  // the item the list starts on instead of the first, such as a picker's current value
  readonly activeId?: string;
  // why the list could not load, shown instead of the text for no matches
  readonly failure?: string;
  // the same query's later model, shown in place of this one when it arrives while the query is unchanged; never rejects
  readonly update?: Promise<QuickPickModel | undefined>;
}

export interface Segment {
  readonly text: string;
  readonly match: boolean;
}

/** The text cut at its [start, end) match ranges, for highlighting; ranges outside the text or overlapping are clamped. */
export function highlightSegments(text: string, matches: readonly QuickOpenMatch[]): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  for (const [rawStart, rawEnd] of [...matches].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(at, Math.min(rawStart, text.length));
    const end = Math.max(start, Math.min(rawEnd, text.length));
    if (start > at) segments.push({ text: text.slice(at, start), match: false });
    if (end > start) segments.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length) segments.push({ text: text.slice(at), match: false });
  return segments;
}

export interface QuickOpenLabels {
  recent: string;
  current: (project: string) => string;
  other: (project: string) => string;
  goToLine: (line: number) => string;
  goToLineColumn: (line: number, column: number) => string;
  mention: string;
  // count: the listing's entries shown
  truncated: (count: number) => string;
  // the host's bounds cut the listing before it kept any entry
  stopped: string;
  noEntries: (name: string) => string;
  folderEmpty: string;
  denied: string;
}

// main's `..` row is a way up, not one of the folder's entries
const isParentRow = (result: QuickOpenResult): boolean => result.kind === 'folder' && result.label === '..';

const caretOf = (caret: number | undefined): { caret?: number } => (caret === undefined ? {} : { caret });

/**
 * Quick Open's rows from main's answer. An empty query groups its results (recent files, then each project's, the current
 * project's first as main ordered them); a typed query lists them by score with no groups. A typed path's rows (its file, its
 * folder's entries) keep main's order and have no group; a folder row sets the query main built for it, never a pick.
 */
export function quickOpenModel(response: QuickOpenResponse, grouped: boolean, labels: QuickOpenLabels): QuickPickModel {
  const rows: QuickPickRow[] = [];
  let group: string | undefined;
  for (const result of response.results) {
    if (result.kind === 'folder') {
      group = undefined;
      rows.push({
        kind: 'item',
        item: {
          id: quickOpenRowKey(result), label: result.label, labelMatches: result.labelMatches, descriptionMatches: [], file: result.label, folder: true,
          descend: result.input, ...caretOf(result.caret), ...(result.host === undefined ? {} : { badge: result.host }),
        },
      });
      continue;
    }
    const matches = { labelMatches: result.labelMatches, descriptionMatches: result.descriptionMatches };
    const complete = result.complete === undefined ? {} : { complete: result.complete.input, ...caretOf(result.complete.caret) };
    if (result.kind === 'path') {
      group = undefined;
      rows.push({
        kind: 'item',
        item: {
          id: quickOpenRowKey(result), label: result.label, description: result.description, ...matches, file: result.path, ...complete,
          ...(result.host === undefined ? {} : { badge: result.host }),
        },
      });
      continue;
    }
    if (grouped) {
      const key = result.recent ? '\0recent' : result.projectKey;
      if (key !== group) {
        group = key;
        const label = result.recent ? labels.recent : result.projectKey === response.currentProjectKey ? labels.current(result.projectName) : labels.other(result.projectName);
        rows.push({ kind: 'separator', label });
      }
    }
    rows.push({
      kind: 'item',
      item: { id: quickOpenRowKey(result), label: result.label, description: result.description, ...matches, file: result.relativePath, project: result.projectName, ...complete },
    });
  }
  const { line, column } = response;
  const hint = response.mention ? labels.mention : line === undefined ? undefined : column === undefined ? labels.goToLine(line) : labels.goToLineColumn(line, column);
  const listed = response.truncated?.listed;
  const cut = listed === undefined ? undefined : listed === 0 ? labels.stopped : labels.truncated(listed);
  const empty = response.emptyText === 'folderNoMatch' ? labels.noEntries(response.emptyName ?? '')
    : response.emptyText === 'folderEmpty' ? labels.folderEmpty
      : response.emptyText === 'folderDenied' ? labels.denied
        : rows.length === 0 ? cut : undefined;
  // `..` leads, but list autocomplete starts on the first suggestion, so Enter and Tab take the folder's first entry
  const [lead, next] = response.results;
  return {
    rows,
    ...(hint === undefined ? {} : { hint }),
    ...(cut !== undefined && rows.length > 0 ? { notice: cut } : {}),
    ...(empty === undefined ? {} : { empty }),
    ...(lead && next && isParentRow(lead) ? { activeId: quickOpenRowKey(next) } : {}),
  };
}

/**
 * The pick of the row `itemId` of main's answer, with the query's :line[:column], which belongs to the exact row alone when the
 * answer has one; a typed path's pick never mentions, and a folder is no pick.
 */
export function quickOpenPick(response: QuickOpenResponse, itemId: string): QuickOpenPick | undefined {
  const result = response.results.find((candidate) => quickOpenRowKey(candidate) === itemId);
  if (!result || result.kind === 'folder') return undefined;
  const positioned = result.exact === true || !response.results.some((candidate) => candidate.kind !== 'folder' && candidate.exact === true);
  const position = positioned ? { ...(response.line === undefined ? {} : { line: response.line }), ...(response.column === undefined ? {} : { column: response.column }) } : {};
  if (result.kind === 'path') return { kind: 'path', authority: result.authority, path: result.path, ...position, mention: false };
  return { kind: 'project', projectKey: result.projectKey, relativePath: result.relativePath, ...position, mention: response.mention };
}

export interface CommandLabels {
  recent: string;
  other: string;
}

interface ScoredEntry {
  readonly entry: PaletteCommand;
  // the label that matched, as scored, for compareScoredItems
  readonly item: FuzzyItem;
  readonly itemScore: ItemScore;
  readonly labelMatches: readonly QuickOpenMatch[];
  // the English label matched where the localized one did not
  readonly aliasMatches?: readonly QuickOpenMatch[];
}

const labelItem = (label: string): FuzzyItem => ({ label, description: '', path: label });

function scoreLabel(label: string, query: PreparedQuery): ItemScore {
  // Contiguous matching, as VS Code's palette filters by substring and word starts rather than scattered letters.
  return scoreItem(labelItem(label), query, false);
}

function scoreEntry(entry: PaletteCommand, query: PreparedQuery, englishAlias: boolean): ScoredEntry | undefined {
  const local = scoreLabel(entry.label, query);
  const alias = englishAlias && entry.englishLabel !== entry.label ? scoreLabel(entry.englishLabel, query) : undefined;
  if (local.score === 0 && !alias?.score) return undefined;
  const localItem = labelItem(entry.label);
  if (!alias?.score || (local.score > 0 && compareScoredItems(localItem, local, labelItem(entry.englishLabel), alias, query) <= 0)) {
    return { entry, item: localItem, itemScore: local, labelMatches: local.labelMatches };
  }
  return { entry, item: labelItem(entry.englishLabel), itemScore: alias!, labelMatches: [], aliasMatches: alias!.labelMatches };
}

/**
 * The palette's rows. Main lists the commands run this session first, most recent on top, then the rest by label; a query
 * keeps that recent-first order, as VS Code does, and ranks the rest by score. With `englishAlias` (a UI language other than
 * English) a command also matches by its English label, which then shows as its description.
 */
export function commandsModel(entries: readonly PaletteCommand[], rawQuery: string, englishAlias: boolean, labels: CommandLabels): QuickPickModel {
  const query = prepareQuery(rawQuery.trim());
  const scored: ScoredEntry[] = [];
  for (const entry of entries) {
    if (!query.normalized) scored.push({ entry, item: labelItem(entry.label), itemScore: { score: 0, labelMatches: [], descriptionMatches: [] }, labelMatches: [] });
    else {
      const match = scoreEntry(entry, query, englishAlias);
      if (match) scored.push(match);
    }
  }
  const recent = scored.filter((match) => match.entry.recent);
  const rest = scored.filter((match) => !match.entry.recent);
  // Summed per-word scores can pass the identity score, so the order is VS Code's comparer, never the raw score.
  if (query.normalized) rest.sort((a, b) => compareScoredItems(a.item, a.itemScore, b.item, b.itemScore, query) || a.entry.label.localeCompare(b.entry.label));
  const rows: QuickPickRow[] = [];
  const push = (match: ScoredEntry): void => {
    const { entry } = match;
    rows.push({
      kind: 'item',
      item: {
        id: entry.id,
        label: entry.label,
        labelMatches: match.labelMatches,
        ...(match.aliasMatches ? { description: entry.englishLabel } : {}),
        descriptionMatches: match.aliasMatches ?? [],
        categoryLength: entry.category ? entry.category.length + 2 : 0,
        ...(entry.accelerator ? { shortcut: entry.accelerator } : {}),
        disabled: !entry.enabled,
        ...(entry.checked !== undefined ? { checked: entry.checked } : {}),
      },
    });
  };
  if (recent.length > 0) {
    rows.push({ kind: 'separator', label: labels.recent });
    recent.forEach(push);
    if (rest.length > 0) rows.push({ kind: 'separator', label: labels.other });
  }
  rest.forEach(push);
  return { rows };
}

const MAC_MODIFIERS: Readonly<Record<string, string>> = { '⌃': 'Control', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'Meta' };
const KEY_NAMES: Readonly<Record<string, string>> = { Ctrl: 'Control', Cmd: 'Meta', Command: 'Meta', Option: 'Alt', Win: 'Meta', Super: 'Meta' };

/** A display accelerator split into its keycaps: "Ctrl+Shift+F" and macOS's "⇧⌘F" both give one cap per key. */
export function keycaps(accelerator: string): string[] {
  const caps: string[] = [];
  let rest = accelerator;
  while (rest.length > 1 && MAC_MODIFIERS[rest[0]!] !== undefined) {
    caps.push(rest[0]!);
    rest = rest.slice(1);
  }
  if (caps.length > 0) return [...caps, rest];
  // "Ctrl++" ends with the plus key itself.
  const parts = rest.endsWith('++') ? [...rest.slice(0, -2).split('+'), '+'] : rest.split('+');
  return parts.filter((part) => part !== '');
}

/** The accelerator in aria-keyshortcuts' form, e.g. "Control+Shift+F". */
export function ariaKeyshortcuts(accelerator: string): string {
  return keycaps(accelerator).map((cap) => MAC_MODIFIERS[cap] ?? KEY_NAMES[cap] ?? cap).join('+');
}

/** Items whose label matches the query (all of them for an empty one), best first; an empty query keeps their order. */
function filterItems<T>(entries: readonly T[], rawQuery: string, label: (entry: T) => string, item: (entry: T, matches: readonly QuickOpenMatch[]) => QuickPickItem): QuickPickRow[] {
  const query = prepareQuery(rawQuery.trim());
  const scored = entries.flatMap((entry) => {
    if (!query.normalized) return [{ entry, scored: labelItem(label(entry)), score: { score: 0, labelMatches: [], descriptionMatches: [] } as ItemScore }];
    const score = scoreLabel(label(entry), query);
    return score.score === 0 ? [] : [{ entry, scored: labelItem(label(entry)), score }];
  });
  if (query.normalized) scored.sort((a, b) => compareScoredItems(a.scored, a.score, b.scored, b.score, query));
  return scored.map(({ entry, score }) => ({ kind: 'item', item: item(entry, score.labelMatches) }));
}

export interface TerminalPickLabels {
  isDefault: string;
  current: string;
  // what Shift+Enter does on a profile row, naming the current project
  shiftHint?: string;
}

/** The new-terminal pick's first step: the detected shells, the default one first and marked, so Enter starts it. */
export function terminalProfilesModel(profiles: readonly TerminalProfileOption[], query: string, labels: TerminalPickLabels): QuickPickModel {
  const ordered = [...profiles.filter((profile) => profile.isDefault), ...profiles.filter((profile) => !profile.isDefault)];
  const rows = filterItems(ordered, query, (profile) => profile.name, (profile, labelMatches) => ({
    id: profile.id,
    label: profile.name,
    description: profile.path,
    labelMatches,
    descriptionMatches: [],
    // a user profile's own icon in its colour
    icon: terminalGlyph(profile).icon,
    iconColor: terminalGlyph(profile).color,
    ...(profile.isDefault ? { badge: labels.isDefault } : {}),
  }));
  return { rows, ...(labels.shiftHint === undefined ? {} : { hint: labels.shiftHint }) };
}

/** The second step: the open projects whose folder the terminal starts in, the current one first and marked. */
export function terminalProjectsModel(projects: readonly TerminalProjectOption[], query: string, labels: TerminalPickLabels): QuickPickModel {
  const rows = filterItems(projects, query, (project) => project.name, (project, labelMatches) => ({
    id: project.key,
    label: project.name,
    description: project.path,
    labelMatches,
    descriptionMatches: [],
    icon: Folder,
    iconColor: 'var(--d-muted)',
    ...(project.current ? { badge: labels.current } : {}),
  }));
  return { rows };
}

// A quick pick icon's tint: local branches in the accent, tags in the warning hue as the prototype's ref chips, stashes in the
// info hue, the rest quiet.
const QUICK_PICK_ICON_COLORS: Readonly<Record<OverlayQuickPickIcon, string>> = {
  add: 'var(--d-muted)',
  branch: 'var(--d-accent-text)',
  remoteBranch: 'var(--d-muted)',
  tag: 'var(--d-warning-text)',
  detached: 'var(--d-muted)',
  stash: 'var(--d-info-text)',
  worktree: 'var(--d-muted)',
  remote: 'var(--d-muted)',
};

// The icons that lead a ref name, whose label reads in the mono font.
const REF_ICONS: ReadonlySet<OverlayQuickPickIcon> = new Set(['branch', 'remoteBranch', 'tag']);

/**
 * A list main offers (Change Icon..., Change Color..., Select Default Profile, the branch picker): each item's glyph or icon in
 * its colour, the current one checked. Grouped items (VS Code's sortByLabel false) keep main's order under each group's
 * label, filtered in place with the label above its first match, and an ungrouped item after a group under an unlabelled
 * rule, as a VS Code separator with no label; others sort by score, the current one active first. echo quotes the trimmed
 * query for an echoQuery item's description.
 */
export function overlayPickModel(items: readonly OverlayQuickPickItem[], rawQuery: string, echo: (query: string) => string): QuickPickModel {
  const query = prepareQuery(rawQuery.trim());
  const item = (entry: OverlayQuickPickItem, labelMatches: readonly QuickOpenMatch[], descriptionMatches: readonly QuickOpenMatch[]): QuickPickItem => {
    const look = entry.glyph ? glyphLook(entry.glyph, entry.color) : entry.icon ? { icon: QUICK_PICK_ICON_COMPONENTS[entry.icon], color: QUICK_PICK_ICON_COLORS[entry.icon] } : undefined;
    return {
      id: entry.id,
      label: entry.label,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      labelMatches,
      descriptionMatches,
      ...(look ? { icon: look.icon, iconColor: look.color } : {}),
      ...(entry.current ? { checked: true } : {}),
      ...(entry.hint === undefined ? {} : { hint: entry.hint }),
      ...(entry.icon !== undefined && REF_ICONS.has(entry.icon) ? { mono: true } : {}),
      ...(entry.info ? { disabled: true } : {}),
    };
  };
  const match = (entry: OverlayQuickPickItem): { score: number; labelMatches: readonly QuickOpenMatch[]; descriptionMatches: readonly QuickOpenMatch[] } | undefined => {
    const label = scoreLabel(entry.label, query);
    if (label.score > 0) return { score: label.score, labelMatches: label.labelMatches, descriptionMatches: [] };
    const description = entry.description ? scoreLabel(entry.description, query) : undefined;
    return description?.score ? { score: description.score / 2, labelMatches: [], descriptionMatches: description.labelMatches } : undefined;
  };
  // A query moves the alwaysShow items (a picker's commands) after the matches, under an unlabelled rule, as VS Code's
  // checkout picker lists them (commands.ts setQuickPickItems).
  const always = query.normalized ? items.filter((entry) => entry.alwaysShow) : [];
  const withAlways = (rows: QuickPickRow[]): QuickPickModel => {
    if (always.length === 0) return { rows };
    const tail = always.map((entry): QuickPickRow => {
      const found = match(entry);
      // an echoing item's description is the query itself, so it carries no highlights
      if (entry.echoQuery) return { kind: 'item', item: { ...item(entry, found?.labelMatches ?? [], []), description: echo(rawQuery.trim()) } };
      return { kind: 'item', item: item(entry, found?.labelMatches ?? [], found?.descriptionMatches ?? []) };
    });
    return { rows: [...rows, ...(rows.length > 0 ? [{ kind: 'separator', label: '' } as const] : []), ...tail] };
  };
  if (items.some((entry) => entry.group !== undefined)) {
    const rows: QuickPickRow[] = [];
    let group: string | undefined;
    for (const entry of items) {
      if (always.includes(entry)) continue;
      const found = query.normalized ? match(entry) : { labelMatches: [], descriptionMatches: [] };
      if (!found) continue;
      if (entry.group !== group) rows.push({ kind: 'separator', label: entry.group ?? '' });
      group = entry.group;
      rows.push({ kind: 'item', item: item(entry, found.labelMatches, found.descriptionMatches) });
    }
    return withAlways(rows);
  }
  if (!query.normalized) {
    const current = items.find((entry) => entry.current);
    return { rows: items.map((entry) => ({ kind: 'item', item: item(entry, [], []) })), ...(current ? { activeId: current.id } : {}) };
  }
  const scored = items.flatMap((entry) => {
    const found = always.includes(entry) ? undefined : match(entry);
    return found ? [{ entry, ...found }] : [];
  });
  scored.sort((a, b) => b.score - a.score);
  return withAlways(scored.map((match) => ({ kind: 'item', item: item(match.entry, match.labelMatches, match.descriptionMatches) })));
}
