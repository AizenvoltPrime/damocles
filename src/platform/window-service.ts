import type { Disposable } from './disposable';

export interface PanelHost {
  readonly visible: boolean;
  readonly active: boolean;
  // Host editor column the panel sits in; undefined when the host has none.
  readonly column: number | undefined;
  readonly cspSource: string;
  // worker-src sources for the chat panel page; undefined omits the directive (the VS Code hosts never set it, so their CSP is unchanged).
  readonly workerSrc?: string;
  // CSS text defining the --vscode-* variables when the host does not inject them itself; '' otherwise.
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
  // The chat panel a browser page belongs to; a host with a chat browser pane shows the page in that chat's pane.
  readonly owner?: PanelHost;
}

export interface WindowService {
  // Each chat panel shows its own browser pages in a side pane that draws their navigation chrome, so every chat gets
  // its own browser scope and a page omits its own toolbar. False: one browser scope shared by every chat.
  readonly chatBrowserPane: boolean;
  createPanel(opts: PanelOptions): PanelHost;
  // Opens in a column holding only panels of this kind, else in an unused column the host then reserves for them (VS Code: lockEditorGroup).
  createPanelInOwnColumn(opts: Omit<PanelOptions, 'column'>): Promise<PanelHost>;
}
