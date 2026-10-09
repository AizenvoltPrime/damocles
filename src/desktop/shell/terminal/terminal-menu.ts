import type { OverlayMenuItem, OverlayRect } from '../../preload/overlay-channels';
import type { DamoclesShellApi, ShellPlatform } from '../../preload/shell-channels';
import { MAX_TERMINAL_GROUP_PANES, MAX_TERMINAL_NAME_LENGTH, type DamoclesTerminalApi, type TerminalInfo } from '../../preload/terminal-channels';
import { tidyMenu } from '../../preload/overlay-channels';
import { inputChunks } from './terminal-keys';
import type { RenameReturn, TerminalStore } from './terminal-store';

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

export interface TerminalMenuContext {
  // terminal: right-click or the menu key in the xterm; tab: a list row or the single-terminal tab, which have no clipboard
  readonly target: 'terminal' | 'tab';
  readonly hasSelection: boolean;
  readonly platform: ShellPlatform;
  readonly group: TerminalMenuGroup;
  // the last finished command, for Copy Last Command and Copy Last Command Output; null when none is known
  readonly lastCommand?: CommandMenuContext | null;
  // the command keyboard navigation stands on, whose actions lead the menu
  readonly navigated?: CommandMenuContext | null;
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
 * context menu does. A command navigation stands on leads the terminal menu with its own actions.
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
  const split: OverlayMenuItem[] = [
    item('split', 'columns-2', { disabled: context.group.panes >= MAX_TERMINAL_GROUP_PANES, ...(context.group.shortcut ? { shortcut: context.group.shortcut } : {}) }),
    ...(context.group.panes > 1 ? [item('unsplit', 'ungroup')] : []),
  ];
  const navigated = !tab && context.navigated ? [...commandMenuItems(context.navigated, t), separator] : [];
  return tidyMenu([
    ...navigated,
    ...clipboard,
    separator,
    ...commands,
    separator,
    ...split,
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
  return terminal.exitCode === null ? t('terminal.hostStopped') : t('terminal.exited', { code: terminal.exitCode });
}

/** A list row's or the single tab's menu: the terminal menu without its clipboard group, run on that terminal. */
export async function openTabMenu(
  deps: { readonly api: Pick<DamoclesShellApi, 'requestOverlay' | 'terminal'>; readonly store: Pick<TerminalStore, 'startRename'>; readonly t: (key: string, values?: Record<string, unknown>) => string; readonly platform: ShellPlatform },
  terminal: Pick<TerminalInfo, 'id' | 'title'>,
  group: TerminalMenuGroup,
  anchor: OverlayRect,
): Promise<void> {
  const answer = await deps.api.requestOverlay({
    kind: 'menu',
    label: deps.t('terminal.menu.label', { title: terminal.title }),
    anchor: { x: Math.max(0, anchor.x), y: Math.max(0, anchor.y), width: anchor.width, height: anchor.height },
    items: terminalMenuItems({ target: 'tab', hasSelection: false, platform: deps.platform, group }, deps.t),
  });
  const action = answer.kind === 'menu' ? terminalMenuAction(answer.itemId) : undefined;
  if (action === 'split' || action === 'unsplit' || action === 'rename' || action === 'changeIcon' || action === 'changeColor' || action === 'kill') {
    runTerminalAction(action, terminal.id, { api: deps.api.terminal, store: deps.store, returnTo: 'tab' });
  }
}

