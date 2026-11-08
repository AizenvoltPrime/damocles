import type { WebContents } from 'electron';
import { MAX_MENU_ITEMS, MAX_OVERLAY_ITEMS, type OverlayAnswer, type OverlayMenuItem, type OverlayQuickPickItem, type OverlayRect, type OverlayRequest } from '../preload/overlay-channels';
import {
  TERMINAL_COLORS,
  TERMINAL_CUSTOM_ICONS,
  type TerminalColor,
  type TerminalCreateResult,
  type TerminalCustomIcon,
  type TerminalIcon,
  type TerminalInfo,
  type TerminalPickShells,
  type TerminalProfileOption,
  type TerminalProjectOption,
  type TerminalTarget,
} from '../preload/terminal-channels';

export interface TerminalPickOverlay {
  // an aborted signal withdraws the request, which then answers dismissed
  request(request: OverlayRequest, returnFocus: WebContents | undefined, shown?: undefined, browse?: undefined, signal?: AbortSignal): Promise<OverlayAnswer>;
}

export interface TerminalPick {
  // null: the host's default shell
  readonly profileId: string | null;
  // home: no listed project was reachable
  readonly target: Exclude<TerminalTarget, { readonly current: true }>;
}

/**
 * One New Terminal pick: the projects its request offers and the shells step 2 was served for each, so an answer naming
 * anything else is refused.
 */
export class TerminalPickSession {
  readonly projects: readonly TerminalProjectOption[];
  private readonly served = new Map<string | null, Set<string>>();

  constructor(projects: readonly TerminalProjectOption[]) {
    this.projects = projects.slice(0, MAX_OVERLAY_ITEMS);
  }

  /** A target step 1 lets the user take: a reachable project, or the home folder (null) while no project is reachable. */
  offers(projectKey: string | null): boolean {
    const reachable = this.projects.filter((project) => project.reachable);
    return projectKey === null ? reachable.length === 0 : reachable.some((project) => project.key === projectKey);
  }

  /** Step 2's shells for an offered target, its host's default first; undefined for a target the request does not offer. */
  serve(projectKey: string | null, profiles: readonly TerminalProfileOption[]): TerminalProfileOption[] | undefined {
    if (!this.offers(projectKey)) return undefined;
    const listed = [...profiles.filter((profile) => profile.isDefault), ...profiles.filter((profile) => !profile.isDefault)].slice(0, MAX_OVERLAY_ITEMS);
    const ids = this.served.get(projectKey) ?? new Set<string>();
    for (const profile of listed) ids.add(profile.id);
    this.served.set(projectKey, ids);
    return listed;
  }

  /** An answer this pick offered: an offered target with a shell served for it, or null for its host's default. */
  accepts(projectKey: string | null, profileId: string | null): boolean {
    return this.offers(projectKey) && (profileId === null || this.served.get(projectKey)?.has(profileId) === true);
  }
}

/**
 * New Terminal's quick pick in the overlay: a project (skipped with one reachable project or none), then a shell of its host
 * (skipped by Shift on the project). Resolves the choice the session accepts, or undefined for Escape.
 */
export async function pickNewTerminal(overlay: TerminalPickOverlay, session: TerminalPickSession, returnFocus: WebContents | undefined): Promise<TerminalPick | undefined> {
  const answer = await overlay.request({ kind: 'newTerminal', projects: session.projects }, returnFocus);
  if (answer.kind !== 'newTerminal' || !session.accepts(answer.projectKey, answer.profileId)) return undefined;
  return { profileId: answer.profileId, target: answer.projectKey === null ? { home: true } : { project: answer.projectKey } };
}

// A target's host as main knows it now; null is the home folder, on this computer.
export interface TerminalPickHost {
  // settles once the shells a terminal of the target starts with are known
  readonly detected: (projectKey: string | null) => Promise<void>;
  // this computer's targets always, a remote project's while its host is connected
  readonly connected: (projectKey: string | null) => boolean;
  readonly profiles: (projectKey: string | null) => readonly TerminalProfileOption[];
}

/** terminalPickProfiles' argument: exactly `{ projectKey }`, a string or null; throws on anything else. */
export function parseTerminalPickCall(raw: unknown): string | null {
  const record = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const keys = record === undefined ? [] : Object.keys(record);
  const projectKey = keys.length === 1 && keys[0] === 'projectKey' ? record?.['projectKey'] : undefined;
  if (!(projectKey === null || typeof projectKey === 'string')) throw new Error('Malformed New Terminal shells request');
  return projectKey;
}

/**
 * Step 2 of the open New Terminal pick: the chosen target's host's shells once its detection settled, recorded as served, or
 * notConnected for a host that went away since the pick opened.
 */
export async function serveTerminalPick(session: TerminalPickSession | undefined, raw: unknown, host: TerminalPickHost): Promise<TerminalPickShells> {
  const projectKey = parseTerminalPickCall(raw);
  if (!session?.offers(projectKey)) throw new Error('Not a target the New Terminal pick offers');
  if (!host.connected(projectKey)) return { kind: 'notConnected' };
  await host.detected(projectKey);
  if (!host.connected(projectKey)) return { kind: 'notConnected' };
  return { kind: 'shells', profiles: session.serve(projectKey, host.profiles(projectKey)) ?? [] };
}

export interface PickedStartDeps {
  readonly host: Pick<TerminalPickHost, 'detected' | 'connected'>;
  readonly create: (pick: TerminalPick) => TerminalCreateResult;
  // a toast
  readonly tell: (message: string) => void;
  readonly notConnected: (projectKey: string) => string;
  // the target's host has no shell to start
  readonly noShells: (projectKey: string | null) => string;
}

export type PickedStart = TerminalCreateResult | { readonly ok: false; readonly reason: 'notConnected' };

/** A picked terminal, once its host's shells are known: refused with a toast when that host went away or has no shell. */
export async function startPickedTerminal(pick: TerminalPick, deps: PickedStartDeps): Promise<PickedStart> {
  const projectKey = 'project' in pick.target ? pick.target.project : null;
  if (projectKey !== null && !deps.host.connected(projectKey)) return notConnected(projectKey, deps);
  await deps.host.detected(projectKey);
  if (projectKey !== null && !deps.host.connected(projectKey)) return notConnected(projectKey, deps);
  const created = deps.create(pick);
  if (!created.ok && created.reason === 'noProfile') deps.tell(deps.noShells(projectKey));
  return created;
}

function notConnected(projectKey: string, deps: PickedStartDeps): PickedStart {
  deps.tell(deps.notConnected(projectKey));
  return { ok: false, reason: 'notConnected' };
}

// A host's shells as main knows them now.
export type HostShells = { readonly kind: 'detecting' } | { readonly kind: 'detected'; readonly profiles: readonly TerminalProfileOption[] };

export interface NewTerminalMenuLabels {
  // this computer's name in a project's host hint
  readonly local: string;
  readonly home: string;
  readonly detecting: string;
  readonly none: string;
  readonly notConnected: string;
  readonly selectDefault: string;
}

export type NewTerminalMenuAction =
  | { readonly kind: 'create'; readonly profileId: string; readonly target: TerminalPick['target'] }
  | { readonly kind: 'selectDefault' };

export interface NewTerminalMenu {
  readonly items: readonly OverlayMenuItem[];
  // by item id; the menu's answer is looked up here, never parsed
  readonly actions: ReadonlyMap<string, NewTerminalMenuAction>;
}

// A row of the arrow's menu: a project, or the home folder (key null) while no listed project is reachable.
interface MenuTarget {
  readonly key: string | null;
  readonly name: string;
  readonly host: string;
  readonly reachable: boolean;
}

/**
 * The New Terminal arrow's menu (VS Code's launch profile menu): one reachable project's shells flat, the home folder's with
 * none open, else a submenu per project in the order given, led by the home folder's while no project is reachable, as the
 * picker offers it, and hinted with its host when they span several. A host still detecting, one with no shell and one not
 * connected are disabled rows saying so. Select Default Profile... ends it.
 */
export function buildNewTerminalMenu(projects: readonly TerminalProjectOption[], shellsOf: (projectKey: string | null) => HostShells, labels: NewTerminalMenuLabels): NewTerminalMenu {
  const actions = new Map<string, NewTerminalMenuAction>();
  let next = 0;
  const shellRows = (projectKey: string | null, room: number): OverlayMenuItem[] => {
    const shells = shellsOf(projectKey);
    if (shells.kind === 'detecting') return [{ kind: 'item', id: `info-${next++}`, label: labels.detecting, disabled: true }];
    if (shells.profiles.length === 0) return [{ kind: 'item', id: `info-${next++}`, label: labels.none, disabled: true }];
    return shells.profiles.slice(0, room).map((profile): OverlayMenuItem => {
      const id = `shell-${next++}`;
      actions.set(id, { kind: 'create', profileId: profile.id, target: projectKey === null ? { home: true } : { project: projectKey } });
      return { kind: 'item', id, label: profile.name, glyph: profile.customIcon ?? profile.icon, ...(profile.color !== null ? { color: profile.color } : {}) };
    });
  };
  const tail: OverlayMenuItem[] = [{ kind: 'separator' }, { kind: 'item', id: 'selectDefaultProfile', label: labels.selectDefault }];
  actions.set('selectDefaultProfile', { kind: 'selectDefault' });
  const room = MAX_OVERLAY_ITEMS - tail.length;
  const targets: MenuTarget[] = [
    ...(projects.some((project) => project.reachable) ? [] : [{ key: null, name: labels.home, host: labels.local, reachable: true }]),
    ...projects.map((project) => ({ key: project.key, name: project.name, host: project.authority.name ?? labels.local, reachable: project.reachable })),
  ];
  const [only] = targets;
  if (targets.length === 1 && only?.reachable) return { items: [...shellRows(only.key, room), ...tail], actions };
  // both levels count against MAX_MENU_ITEMS, and each listed target may need a row of its own in its submenu
  const listed = targets.slice(0, Math.min(room, Math.floor((MAX_MENU_ITEMS - tail.length) / 2)));
  const hinted = new Set(listed.map((target) => target.host)).size > 1;
  // each submenu leaves one row for every submenu after it
  let budget = MAX_MENU_ITEMS - listed.length - tail.length;
  const items = listed.map((target, index): OverlayMenuItem => {
    const hint = hinted ? { hint: target.host } : {};
    if (!target.reachable) return { kind: 'item', id: `info-${next++}`, label: target.name, ...hint, disabled: true, disabledReason: labels.notConnected };
    const later = listed.slice(index + 1).filter((other) => other.reachable).length;
    const children = shellRows(target.key, Math.min(MAX_OVERLAY_ITEMS, budget - later));
    budget -= children.length;
    return { kind: 'submenu', id: `project-${index}`, label: target.name, ...hint, items: children };
  });
  return { items: [...items, ...tail], actions };
}

/**
 * Shows the arrow's menu and resolves once it closed, so the arrow is free again; the chosen action starts then and is not
 * awaited, since Select Default Profile... and a shell detection can outlast the menu. Its failure goes to report.
 */
export async function openNewTerminalMenu(
  overlay: TerminalPickOverlay,
  menu: NewTerminalMenu,
  placement: { readonly label: string; readonly anchor: OverlayRect },
  returnFocus: WebContents | undefined,
  run: (action: NewTerminalMenuAction) => Promise<void>,
  report: (action: NewTerminalMenuAction) => (err: unknown) => void,
): Promise<void> {
  const answer = await overlay.request({ kind: 'menu', label: placement.label, anchor: placement.anchor, items: menu.items }, returnFocus);
  const action = answer.kind === 'menu' ? menu.actions.get(answer.itemId) : undefined;
  if (action) void run(action).catch(report(action));
}

// The quick pick row that clears a custom icon or color; no icon or color has this name.
const DEFAULT_ITEM = 'default';

export interface TerminalAppearance {
  // the profile's icon, shown when there is no custom one
  readonly icon: TerminalIcon;
  readonly customIcon: TerminalCustomIcon | null;
  readonly color: TerminalColor | null;
}

// The chosen item's id, which parseOverlayAnswer has checked the request offered; undefined for Escape.
async function quickPick(overlay: TerminalPickOverlay, placeholder: string, items: OverlayQuickPickItem[], returnFocus: WebContents | undefined): Promise<string | undefined> {
  const answer = await overlay.request({ kind: 'quickPick', placeholder, items }, returnFocus);
  return answer.kind === 'quickPick' ? answer.itemId : undefined;
}

/** Change Icon...: the profile's icon (null) or a custom one, each drawn in the terminal's color; undefined for Escape. */
export async function pickTerminalIcon(
  overlay: TerminalPickOverlay,
  appearance: TerminalAppearance,
  labels: { readonly placeholder: string; readonly profileIcon: string; readonly icons: Readonly<Record<TerminalCustomIcon, string>> },
  returnFocus: WebContents | undefined,
): Promise<{ readonly customIcon: TerminalCustomIcon | null } | undefined> {
  const tint = appearance.color === null ? {} : { color: appearance.color };
  const items: OverlayQuickPickItem[] = [
    { id: DEFAULT_ITEM, label: labels.profileIcon, glyph: appearance.icon, ...tint, current: appearance.customIcon === null },
    ...TERMINAL_CUSTOM_ICONS.map((icon) => ({ id: icon, label: labels.icons[icon], glyph: icon, ...tint, current: icon === appearance.customIcon })),
  ];
  const picked = await quickPick(overlay, labels.placeholder, items, returnFocus);
  if (picked === undefined) return undefined;
  return { customIcon: TERMINAL_CUSTOM_ICONS.find((icon) => icon === picked) ?? null };
}

/** Change Color...: no color (null) or one of the eight hues, each row showing the terminal's icon in it; undefined for Escape. */
export async function pickTerminalColor(
  overlay: TerminalPickOverlay,
  appearance: TerminalAppearance,
  labels: { readonly placeholder: string; readonly noColor: string; readonly colors: Readonly<Record<TerminalColor, string>> },
  returnFocus: WebContents | undefined,
): Promise<{ readonly color: TerminalColor | null } | undefined> {
  const glyph = appearance.customIcon ?? appearance.icon;
  const items: OverlayQuickPickItem[] = [
    { id: DEFAULT_ITEM, label: labels.noColor, glyph, current: appearance.color === null },
    ...TERMINAL_COLORS.map((color) => ({ id: color, label: labels.colors[color], glyph, color, current: color === appearance.color })),
  ];
  const picked = await quickPick(overlay, labels.placeholder, items, returnFocus);
  if (picked === undefined) return undefined;
  return { color: TERMINAL_COLORS.find((color) => color === picked) ?? null };
}

/** Join Terminals' rows, one per candidate as the list shows it: its icon in its color, its title and its project. */
export function joinTerminalItems(candidates: readonly TerminalInfo[]): OverlayQuickPickItem[] {
  return candidates.map((terminal) => ({
    id: terminal.id,
    label: terminal.title,
    ...(terminal.projectName !== '' ? { description: terminal.projectName } : {}),
    glyph: terminal.customIcon ?? terminal.icon,
    ...(terminal.color !== null ? { color: terminal.color } : {}),
  }));
}

// A host Select Default Profile... offers, by its authority key ('local' for this computer).
export interface DefaultProfileHost {
  readonly authority: string;
  readonly name: string;
  // a host that is not connected is listed disabled, since its shells are not known
  readonly reachable: boolean;
  // this computer, or a saved host, whose record keeps its default
  readonly saved: boolean;
}

export interface DefaultProfileLabels {
  readonly hostPlaceholder: string;
  readonly notConnected: string;
  readonly detecting: string;
  readonly profilePlaceholder: (host: DefaultProfileHost) => string;
  readonly noShells: (host: DefaultProfileHost) => string;
  readonly unsaved: (host: DefaultProfileHost) => string;
}

export interface DefaultProfileShells {
  // a host's shells now, by its authority key
  readonly shellsOf: (authority: string) => HostShells;
  // settles once its detection did
  readonly detected: (authority: string) => Promise<void>;
  // a toast
  readonly tell: (message: string) => void;
}

/**
 * Select Default Profile: a host (skipped with one), then one of its profiles (a user profile in its icon and color), its
 * current default marked, after a pick that says the shells are being detected while they are; undefined for Escape. A host
 * with no saved record or no shell ends it with a toast saying so.
 */
export async function pickDefaultProfile(
  overlay: TerminalPickOverlay,
  hosts: readonly DefaultProfileHost[],
  shells: DefaultProfileShells,
  labels: DefaultProfileLabels,
  returnFocus: WebContents | undefined,
): Promise<{ readonly authority: string; readonly profileId: string } | undefined> {
  const listed = hosts.slice(0, MAX_OVERLAY_ITEMS);
  let host = listed.length === 1 ? listed[0] : undefined;
  if (listed.length > 1) {
    const items = listed.map((entry): OverlayQuickPickItem => ({ id: entry.authority, label: entry.name, ...(entry.reachable ? {} : { description: labels.notConnected, info: true as const }) }));
    const picked = await quickPick(overlay, labels.hostPlaceholder, items, returnFocus);
    host = listed.find((entry) => entry.authority === picked && entry.reachable);
  }
  if (!host) return undefined;
  if (!host.saved) {
    shells.tell(labels.unsaved(host));
    return undefined;
  }
  if (shells.shellsOf(host.authority).kind === 'detecting' && !(await waitForShells(overlay, host, shells, labels, returnFocus))) return undefined;
  const found = shells.shellsOf(host.authority);
  const profiles = found.kind === 'detected' ? found.profiles.slice(0, MAX_OVERLAY_ITEMS) : [];
  if (profiles.length === 0) {
    shells.tell(labels.noShells(host));
    return undefined;
  }
  const items = profiles.map((profile): OverlayQuickPickItem => ({
    id: profile.id,
    label: profile.name,
    description: profile.path,
    glyph: profile.customIcon ?? profile.icon,
    ...(profile.color !== null ? { color: profile.color } : {}),
    current: profile.isDefault,
  }));
  const profileId = await quickPick(overlay, labels.profilePlaceholder(host), items, returnFocus);
  return profileId === undefined ? undefined : { authority: host.authority, profileId };
}

// The profile step's placeholder over one row saying the shells are being detected, withdrawn once they are; false for Escape.
async function waitForShells(overlay: TerminalPickOverlay, host: DefaultProfileHost, shells: DefaultProfileShells, labels: DefaultProfileLabels, returnFocus: WebContents | undefined): Promise<boolean> {
  const settled = new AbortController();
  const withdraw = (): void => settled.abort();
  void shells.detected(host.authority).then(withdraw, withdraw);
  const request: OverlayRequest = { kind: 'quickPick', placeholder: labels.profilePlaceholder(host), items: [{ id: 'detecting', label: labels.detecting, info: true }] };
  await overlay.request(request, returnFocus, undefined, undefined, settled.signal);
  return settled.signal.aborted;
}
