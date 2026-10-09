import type { Disposable } from './disposable';
import type { SettingsAccountId, SettingsSectionId } from '../shared/settings-sections';

export interface PanelHost {
  readonly visible: boolean;
  readonly active: boolean;
  // False when hiding discards the page (a VS Code webview without retainContextWhenHidden), which reloads and posts its
  // ready again when shown; true when a hidden page keeps running and posts nothing on show.
  readonly retainsContextWhenHidden: boolean;
  // Host editor column the panel sits in; undefined when the host has none.
  readonly column: number | undefined;
  readonly cspSource: string;
  // worker-src sources for the chat panel page; undefined omits the directive (the VS Code hosts never set it, so their CSP is unchanged).
  readonly workerSrc?: string;
  // CSS text that fills the --d-* design tokens (desktop palettes and fonts); '' where tokens.css maps the host's own theme variables.
  themeCssSource(): string;
  setHtml(html: string): void;
  postMessage(message: unknown): Promise<boolean>;
  onMessage(listener: (message: unknown) => void): Disposable;
  // Never called for a listener added after the host closed (VS Code's semantics), so subscribe before any await.
  onDispose(listener: () => void): Disposable;
  // Fires on every host view-state event, including a focus change that leaves visible unchanged.
  onDidChangeViewState(listener: () => void): Disposable;
  asResourceUri(absolutePath: string): string;
  // absolute path; undefined clears the icon
  setIcon(path: string | undefined): void;
  setTitle(title: string): void;
  setFolderLabel(label: string | undefined): void;
  // column undefined keeps the panel's current column
  reveal(column?: number): void;
  close(): void;
}

export interface PanelOptions {
  readonly kind: 'chat' | 'browser';
  readonly title: string;
  // absolute paths the panel may load; the browser panel passes [] (deny by default)
  readonly localResourceRoots: readonly string[];
  // undefined lets the host pick
  readonly column?: number;
  // The chat panel a browser page belongs to; a host with chatBrowserPane shows the page only among that chat's pages.
  readonly owner?: PanelHost;
}

export interface WindowService {
  // Each chat panel owns its browser pages, which the host shows with navigation chrome of its own (desktop: editor tabs of
  // the chat), so every chat gets its own browser scope and a page omits its own toolbar. False: one browser scope shared by
  // every chat.
  readonly chatBrowserPane: boolean;
  createPanel(opts: PanelOptions): PanelHost;
  // Opens in a column holding only panels of this kind, else in an unused column the host then reserves for them (VS Code: lockEditorGroup).
  createPanelInOwnColumn(opts: Omit<PanelOptions, 'column'>): Promise<PanelHost>;
  // Shows the settings modal outside the chat pages (desktop: the overlay). Only a host whose capabilities say
  // settingsInPanel false is asked; one that shows the modal inside the chat page has nowhere else to show it.
  openAppSettings(section: SettingsSectionId | undefined, account?: SettingsAccountId): void;
  // Shows or hides the window's terminal pane as the Toggle Terminal command does; only a host whose capabilities say
  // windowLayout true is asked.
  toggleTerminal(): void;
  // Whether the window shows its terminal pane, and Toggle Terminal's display shortcut, for the chat header's toggle; asked only
  // when windowLayout is true.
  terminalToggle(): { readonly shown: boolean; readonly shortcut: string };
}
