import type { OverlayMenuItem, OverlayRect } from '../../preload/overlay-channels';
import type { DamoclesShellApi, ShellPlatform } from '../../preload/shell-channels';
import { MAX_TERMINAL_GROUP_PANES, MAX_TERMINAL_NAME_LENGTH, type DamoclesTerminalApi, type TerminalInfo, type TerminalState } from '../../preload/terminal-channels';
import { tidyMenu } from '../../preload/overlay-channels';
import { inputChunks } from './terminal-keys';
import { panelTerminals, type RenameReturn, type TerminalStore } from './terminal-store';

// The actions on one command: its mark's menu, and the terminal menu's first group while Ctrl+Up or Ctrl+Down stands on it.
export type CommandMenuAction = 'rerunCommand' | 'copyCommand' | 'copyOutput' | 'addOutputToChat';
export type TerminalMenuAction = 'copy' | 'paste' | 'selectAll' | 'clear' | 'copyLastCommand' | 'copyLastCommandOutput' | 'addToChat' | 'split' | 'unsplit' | 'rename' | 'changeIcon' | 'changeColor' | 'kill' | CommandMenuAction;

// What a command offers: a command line to rerun or copy, and output once it finished.
export interface CommandMenuContext {
  readonly hasCommandLine: boolean;
  readonly hasOutput: boolean;
}

// The pane's group: Split while it has room, Unsplit while it holds another pane; shortcut is main's Split key.
export interface TerminalMenuGroup {
  readonly panes: number;
  readonly shortcut: string;
}

// The tab menu's own entries, which the xterm's menu never offers.
type ArrangeAction = 'joinTerminals' | 'moveUp' | 'moveDown' | 'moveToEditor';

// Where a list row or the single tab can go: up or down a place in the list, whether Join Terminals has room and others
// to offer, and whether it may move into the editor area.
export interface TerminalArrangement {
  readonly up: boolean;
  readonly down: boolean;
  readonly join: boolean;
  readonly toEditor: boolean;
}

/**
 * The arrangement moves open to panel terminal `id` in main's state, among the panel's terminals. Join needs a free slot in
 * its group and a terminal outside it that is no worktree Setup task, which joins nothing and stays in the panel.
 */
export function terminalArrangement(state: Pick<TerminalState, 'terminals' | 'groups'> | null, id: string): TerminalArrangement {
  const panel = panelTerminals(state);
  const index = panel.findIndex((terminal) => terminal.id === id);
  const group = state?.groups.find((candidate) => candidate.paneIds.includes(id));
  const task = panel[index]?.task === true;
  return {
    up: index > 0,
    down: index >= 0 && index < panel.length - 1,
    join: !task && group !== undefined && group.paneIds.length < MAX_TERMINAL_GROUP_PANES && panel.some((terminal) => terminal.task !== true && !group.paneIds.includes(terminal.id)),
    toEditor: index >= 0 && !task,
  };
}

export interface TerminalMenuContext {
  // terminal: right-click or the menu key in the xterm; tab: a list row or the single-terminal tab, which have no clipboard
  readonly target: 'terminal' | 'tab';
  readonly hasSelection: boolean;
  readonly platform: ShellPlatform;
  // null for an editor terminal, which never splits
  readonly group: TerminalMenuGroup | null;
  // the last finished command, for Copy Last Command and Copy Last Command Output; null when none is known
  readonly lastCommand?: CommandMenuContext | null;
  // the command keyboard navigation stands on, whose actions lead the menu
  readonly navigated?: CommandMenuContext | null;
  // the tab menu's Join Terminals..., Move Up, Move Down and Move Terminal into Editor Area
  readonly arrangement?: TerminalArrangement;
}

const ACTIONS: readonly TerminalMenuAction[] = ['copy', 'paste', 'selectAll', 'clear', 'copyLastCommand', 'copyLastCommandOutput', 'addToChat', 'split', 'unsplit', 'rename', 'changeIcon', 'changeColor', 'kill', 'rerunCommand', 'copyCommand', 'copyOutput', 'addOutputToChat'];
const isAction = (id: string): id is TerminalMenuAction => (ACTIONS as readonly string[]).includes(id);

type MenuIcon = NonNullable<Extract<OverlayMenuItem, { kind: 'item' }>['icon']>;

// Each platform's primary Copy and Paste keys in the xterm (terminalKeyAction), as VS Code's terminal menu shows them.
const CLIPBOARD_KEYS: Readonly<Record<ShellPlatform, { readonly copy: string; readonly paste: string }>> = {
  win32: { copy: 'Ctrl+C', paste: 'Ctrl+V' },
  linux: { copy: 'Ctrl+Shift+C', paste: 'Ctrl+Shift+V' },
  darwin: { copy: '⌘C', paste: '⌘V' },
};

/** A command's mark menu (VS Code's decorationAddon actions): Rerun Command, Copy Command, Copy Output, Add Output to Chat. */
export function commandMenuItems(command: CommandMenuContext, t: (key: string) => string): OverlayMenuItem[] {
  const item = (id: CommandMenuAction, icon: MenuIcon, disabled: boolean): OverlayMenuItem => ({ kind: 'item', id, label: t(`terminal.menu.${id}`), icon, disabled });
  return [
    item('rerunCommand', 'rotate-cw', !command.hasCommandLine),
    { kind: 'separator' },
    item('copyCommand', 'copy', !command.hasCommandLine),
    item('copyOutput', 'scroll-text', !command.hasOutput),
    { kind: 'separator' },
    item('addOutputToChat', 'message-square', !command.hasOutput),
  ];
}

/**
 * VS Code's terminal context menu (terminalMenus.ts) in its group order: clipboard and buffer, the last command and Add to
 * Chat, Split and Unsplit, then the terminal's own appearance, then Kill. The tab menu drops the clipboard and command groups, as VS Code's tabs
 * context menu does, and adds Join Terminals... beside Unsplit, and Move Up, Move Down and Move Terminal into Editor Area
 * after them. A command navigation stands on leads the terminal menu with its own actions.
 */
export function terminalMenuItems(context: TerminalMenuContext, t: (key: string) => string): OverlayMenuItem[] {
  const keys = CLIPBOARD_KEYS[context.platform];
  const tab = context.target === 'tab';
  const item = (id: TerminalMenuAction, icon: MenuIcon, extra: Partial<Extract<OverlayMenuItem, { kind: 'item' }>> = {}): OverlayMenuItem => ({
    kind: 'item', id, label: t(`terminal.menu.${id}`), icon, ...extra,
  });
  const separator: OverlayMenuItem = { kind: 'separator' };
  const clipboard: OverlayMenuItem[] = tab ? [] : [
    item('copy', 'copy', { shortcut: keys.copy, disabled: !context.hasSelection }),
    // Its pick allows main one paste into this terminal, which the view then asks for.
    item('paste', 'clipboard-paste', { shortcut: keys.paste, clipboard: 'terminalPaste' }),
    item('selectAll', 'text-select'),
    item('clear', 'eraser'),
  ];
  const last = context.lastCommand ?? null;
  const commands: OverlayMenuItem[] = tab ? [] : [
    item('copyLastCommand', 'square-code', { disabled: !last?.hasCommandLine }),
    item('copyLastCommandOutput', 'scroll-text', { disabled: !last?.hasOutput }),
    item('addToChat', 'message-square', { disabled: !context.hasSelection && !last?.hasOutput }),
  ];
  const arrangement = tab ? context.arrangement : undefined;
  // the panel's only terminal (the single tab) has no row to move past and no terminal to join
  const listed = arrangement !== undefined && (arrangement.up || arrangement.down);
  const arrangeItem = (id: ArrangeAction, disabled: boolean): Extract<OverlayMenuItem, { kind: 'item' }> => ({ kind: 'item', id, label: t(`terminal.menu.${id}`), disabled });
  const group = context.group;
  const split: OverlayMenuItem[] = group ? [
    item('split', 'columns-2', { disabled: group.panes >= MAX_TERMINAL_GROUP_PANES, ...(group.shortcut ? { shortcut: group.shortcut } : {}) }),
    ...(group.panes > 1 ? [item('unsplit', 'ungroup')] : []),
    ...(arrangement && listed ? [arrangeItem('joinTerminals', !arrangement.join)] : []),
  ] : [];
  const mac = context.platform === 'darwin';
  const moves: OverlayMenuItem[] = arrangement ? [
    ...(listed ? [
      { ...arrangeItem('moveUp', !arrangement.up), shortcut: mac ? '⌥↑' : 'Alt+Up' },
      { ...arrangeItem('moveDown', !arrangement.down), shortcut: mac ? '⌥↓' : 'Alt+Down' },
    ] : []),
    { ...arrangeItem('moveToEditor', !arrangement.toEditor), icon: 'arrow-up-from-line' },
  ] : [];
  const navigated = !tab && context.navigated ? [...commandMenuItems(context.navigated, t), separator] : [];
  return tidyMenu([
    ...navigated,
    ...clipboard,
    separator,
    ...commands,
    separator,
    ...split,
    separator,
    ...moves,
    separator,
    item('rename', 'pencil', tab ? { shortcut: 'F2' } : {}),
    item('changeIcon', 'shapes'),
    item('changeColor', 'palette'),
    separator,
    item('kill', 'trash-2', { danger: true, ...(tab ? { shortcut: 'Del' } : {}) }),
  ]);
}

/** The actions every terminal menu runs the same way; the clipboard ones need the terminal's xterm. */
export function runTerminalAction(
  action: 'split' | 'unsplit' | 'rename' | 'changeIcon' | 'changeColor' | 'kill',
  id: string,
  deps: { readonly api: Pick<DamoclesTerminalApi, 'pickIcon' | 'pickColor' | 'kill' | 'split' | 'unsplit'>; readonly store: Pick<TerminalStore, 'startRename'>; readonly returnTo: RenameReturn },
): void {
  if (action === 'rename') deps.store.startRename(id, deps.returnTo);
  else if (action === 'split') deps.api.split(id);
  else if (action === 'unsplit') deps.api.unsplit(id);
  else if (action === 'changeIcon') deps.api.pickIcon(id);
  else if (action === 'changeColor') deps.api.pickColor(id);
  else deps.api.kill(id);
}

// A terminal editor tab's entries after the editor's close group (VS Code's terminal editor tab menu).
export type TerminalTabMenuAction = 'moveToPanel' | 'rename' | 'changeIcon' | 'changeColor' | 'kill';
const TAB_ACTIONS: readonly TerminalTabMenuAction[] = ['moveToPanel', 'rename', 'changeIcon', 'changeColor', 'kill'];

/** A terminal editor tab's own entries: Move Terminal into Panel, the terminal's appearance, then Kill. */
export function terminalTabMenuItems(t: (key: string) => string): OverlayMenuItem[] {
  return [
    { kind: 'item', id: 'moveToPanel', label: t('terminal.menu.moveToPanel'), icon: 'arrow-down-to-line' },
    { kind: 'separator' },
    { kind: 'item', id: 'rename', label: t('terminal.menu.rename'), icon: 'pencil', shortcut: 'F2' },
    { kind: 'item', id: 'changeIcon', label: t('terminal.menu.changeIcon'), icon: 'shapes' },
    { kind: 'item', id: 'changeColor', label: t('terminal.menu.changeColor'), icon: 'palette' },
    { kind: 'separator' },
    { kind: 'item', id: 'kill', label: t('terminal.menu.kill'), icon: 'trash-2', danger: true },
  ];
}

/** Runs a terminal editor tab's menu answer on its terminal; false for an answer that is not one of its entries. */
export function runTerminalTabAction(
  itemId: string,
  id: string,
  deps: { readonly api: Pick<DamoclesTerminalApi, 'pickIcon' | 'pickColor' | 'kill' | 'split' | 'unsplit'>; readonly store: Pick<TerminalStore, 'startRename' | 'move'> },
): boolean {
  const action = TAB_ACTIONS.find((candidate) => candidate === itemId);
  if (action === undefined) return false;
  // Into the panel as a group of its own at the end, which main makes the panel's active and focuses.
  if (action === 'moveToPanel') deps.store.move({ kind: 'detach', id });
  else runTerminalAction(action, id, { api: deps.api, store: deps.store, returnTo: 'tab' });
  return true;
}

/** The menu's answer as an action, or undefined for one it did not offer. */
export function terminalMenuAction(itemId: string): TerminalMenuAction | undefined {
  return isAction(itemId) ? itemId : undefined;
}

/**
 * What an inline rename sends main, or undefined to send nothing: an emptied field restores the automatic title, and a
 * field left at the title it opened with keeps the terminal as it was, so an automatic title never turns into a fixed name.
 */
export function renameRequestName(draft: string, terminal: Pick<TerminalInfo, 'title' | 'name'>): string | undefined {
  // Compared before the cut: an automatic title runs past the name's bound, and its cut copy would differ from it.
  if (draft.trim() === terminal.title) return undefined;
  const name = inputChunks(draft.trim(), MAX_TERMINAL_NAME_LENGTH)[0] ?? '';
  if (name === '') return terminal.name === null ? undefined : '';
  return name === terminal.title ? undefined : name;
}

/** A terminal's status as a screen reader hears it on its list row or tab. */
export function terminalStatusLabel(terminal: Pick<TerminalInfo, 'status' | 'exitCode'>, t: (key: string, values?: Record<string, unknown>) => string): string {
  if (terminal.status === 'starting') return t('terminal.status.starting');
  if (terminal.status === 'running') return t('terminal.status.running');
  if (terminal.status === 'reconnecting') return t('terminal.status.reconnecting');
  return terminal.exitCode === null ? t('terminal.hostStopped') : t('terminal.exited', { code: terminal.exitCode });
}

/** Where the terminal runs: its project's name, or the home folder's label for one started while no project was open. */
export function terminalProjectLabel(terminal: Pick<TerminalInfo, 'projectKey' | 'projectName'>, t: (key: string) => string): string {
  return terminal.projectKey === null ? t('projects.home') : terminal.projectName;
}

/** A list row's or the single tab's menu: the terminal menu without its clipboard group, run on that terminal. */
export async function openTabMenu(
  deps: { readonly api: Pick<DamoclesShellApi, 'requestOverlay' | 'terminal'>; readonly store: Pick<TerminalStore, 'startRename' | 'state' | 'move'>; readonly t: (key: string, values?: Record<string, unknown>) => string; readonly platform: ShellPlatform },
  terminal: Pick<TerminalInfo, 'id' | 'title'>,
  group: TerminalMenuGroup,
  anchor: OverlayRect,
): Promise<void> {
  const answer = await deps.api.requestOverlay({
    kind: 'menu',
    label: deps.t('terminal.menu.label', { title: terminal.title }),
    anchor: { x: Math.max(0, anchor.x), y: Math.max(0, anchor.y), width: anchor.width, height: anchor.height },
    items: terminalMenuItems({ target: 'tab', hasSelection: false, platform: deps.platform, group, arrangement: terminalArrangement(deps.store.state.value, terminal.id) }, deps.t),
  });
  const itemId = answer.kind === 'menu' ? answer.itemId : undefined;
  if (itemId === 'moveUp' || itemId === 'moveDown') {
    deps.store.move({ kind: 'step', id: terminal.id, delta: itemId === 'moveUp' ? -1 : 1 });
    return;
  }
  if (itemId === 'joinTerminals') {
    deps.api.terminal.joinPick(terminal.id);
    return;
  }
  if (itemId === 'moveToEditor') {
    deps.store.move({ kind: 'toEditor', id: terminal.id });
    return;
  }
  const action = itemId === undefined ? undefined : terminalMenuAction(itemId);
  if (action === 'split' || action === 'unsplit' || action === 'rename' || action === 'changeIcon' || action === 'changeColor' || action === 'kill') {
    runTerminalAction(action, terminal.id, { api: deps.api.terminal, store: deps.store, returnTo: 'tab' });
  }
}

