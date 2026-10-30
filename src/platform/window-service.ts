import type { Disposable } from './disposable';
import type { ErrorPageStrings, PageSpec } from '../shared/panel-html';
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
  // A host that builds the page itself from what it is told to show (desktop main, VS Code's browser panel); core then sends no HTML.
  showPage?(page: PageSpec): void;
  // The error page's words in the host's language, which a host without showPage must give: core builds that page for it.
  errorPageStrings?(): ErrorPageStrings;
  postMessage(message: unknown): Promise<boolean>;
  // A host whose posts can back up toward the page (a remote client): settles once they are back within its flow window.
  drained?(): Promise<void>;
  // viewKey: the view that sent it, on a host whose panel several views show (a daemon's core); undefined elsewhere.
  onMessage(listener: (message: unknown, viewKey?: string) => void): Disposable;
  // A host whose panel several views show: the host of one view, whose posts reach that view alone and which delegates the rest.
  viewHost?(viewKey: string): PanelHost;
  // Set on a host viewHost made: the panel's own host.
  readonly panelHost?: PanelHost;
  // Set on a host whose posts reach one device's views alone: that device's client id, once core heard from it.
  readonly clientId?: string;
  // The views core heard from and whose view is still there, each with the actor of its first message or join.
  views?(): ReadonlyArray<{ readonly viewKey: string; readonly clientId?: string }>;
  // Posts to every view but those named, which take the message from elsewhere (a joining view's replay).
  postMessageExcept?(message: unknown, viewKeys: readonly string[]): Promise<boolean>;
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
  // when windowLayout is true. clientId names the device on a daemon's core, whose devices each have their own window; a host
  // with one window ignores it.
  terminalToggle(clientId?: string): TerminalToggle;
}

export interface TerminalToggle {
  readonly shown: boolean;
  readonly shortcut: string;
}
