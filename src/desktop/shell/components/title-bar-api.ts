import type { DamoclesShellApi, ShellLayout, ShellState } from '../../preload/shell-channels';

// Everything the title bar and its pills call and read, so a page with no shell API can give them a null object of these types.
export type EnginePillApi = Pick<DamoclesShellApi, 'restartEngine'>;
export type UpdatePillApi = Pick<DamoclesShellApi, 'getUpdate' | 'onUpdate' | 'requestOverlay' | 'runUpdateAction'>;
export type WindowControlsApi = Pick<DamoclesShellApi, 'windowControl'>;
export type TitleBarApi = Pick<DamoclesShellApi, 'openAppMenu' | 'showHostCard' | 'requestOverlay' | 'openQuickOpen' | 'toggleSidebar' | 'toggleTerminal' | 'toggleEditor' | 'toggleTheme' | 'openSettings'>
  & EnginePillApi & UpdatePillApi & WindowControlsApi;
export type TitleBarState = Pick<ShellState, 'projects' | 'selected' | 'hosts' | 'selectedChat' | 'effectiveTheme' | 'notifications' | 'platform' | 'engineHalted' | 'engines' | 'windowState'> & {
  readonly shortcuts: Pick<ShellState['shortcuts'], 'toggleSidebar' | 'settings' | 'quickOpen' | 'toggleTerminal'>;
  readonly layout: Pick<ShellLayout, 'sidebarVisible' | 'grid'>;
};
