// Shared by the shell preload, main and (as types only) the shell app; the shell never sees panel channels.

export const SHELL_CHANNELS = {
  // renderer → main, invoke
  getState: 'damocles:shell:get-state',
  addProject: 'damocles:shell:add-project',
  removeProject: 'damocles:shell:remove-project',
  selectProject: 'damocles:shell:select-project',
  grantTrust: 'damocles:shell:grant-trust',
  newTab: 'damocles:shell:new-tab',
  selectTab: 'damocles:shell:select-tab',
  closeTab: 'damocles:shell:close-tab',
  moveTab: 'damocles:shell:move-tab',
  togglePane: 'damocles:shell:toggle-pane',
  // renderer → main, send
  contentBounds: 'damocles:shell:content-bounds',
  resolveToast: 'damocles:shell:resolve-toast',
  // main → renderer
  state: 'damocles:shell:state',
  toast: 'damocles:shell:toast',
  toastDismiss: 'damocles:shell:toast-dismiss',
  // the user asked to move keyboard focus into the tab strip (F6)
  focusTabStrip: 'damocles:shell:focus-tab-strip',
  // main → renderer, PanelTheme; the preload applies it to the page itself
  theme: 'damocles:shell:theme',
} as const;

// Bounds the shell may send; main clamps nothing, it rejects anything outside these.
export const MAX_ID_LENGTH = 200;
export const MAX_ACTION_LENGTH = 500;

export type ShellLocale = 'en' | 'el';
export type ShellPlatform = 'win32' | 'darwin' | 'linux';

export interface ShellProject {
  readonly key: string;
  readonly name: string;
  readonly fsPath: string;
  readonly trusted: boolean;
  readonly isDefault: boolean;
}

// Every tab is a chat tab; its browser pages live in its side pane.
export interface ShellTab {
  readonly id: string;
  // conversation title; '' is a new conversation, which the shell labels itself
  readonly title: string;
  readonly projectKey?: string;
  readonly projectName?: string;
  readonly busy?: boolean;
}

// The selected chat tab's browser pane, for the top bar's toggle button.
export interface ShellPane {
  readonly open: boolean;
}

export interface ShellState {
  readonly locale: ShellLocale;
  readonly platform: ShellPlatform;
  readonly projects: readonly ShellProject[];
  // in strip order
  readonly tabs: readonly ShellTab[];
  readonly selectedTabId?: string;
  // present only when damocles.browser.enabled is on and a tab is selected
  readonly pane?: ShellPane;
  // display label of the menu accelerator that toggles the pane, e.g. "Ctrl+Alt+B" or "⌥⌘B"
  readonly paneShortcutLabel: string;
}

export interface ShellToast {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly actions: readonly string[];
}

// CSS px relative to the window's content area; main scales by the shell's zoom factor.
export interface ContentBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type RemoveProjectResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface DamoclesShellApi {
  getState(): Promise<ShellState>;
  // full snapshot on every change; returns the unsubscribe
  onState(listener: (state: ShellState) => void): () => void;
  addProject(): Promise<void>;
  removeProject(key: string): Promise<RemoveProjectResult>;
  // sets the default project for new tabs; open tabs keep their project
  selectProject(key: string): Promise<void>;
  grantTrust(key: string): Promise<void>;
  // chat tab in projectKey, or in the default project when omitted
  newTab(projectKey?: string): Promise<void>;
  selectTab(id: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  moveTab(id: string, toIndex: number): Promise<void>;
  // opens or collapses the chat tab's browser pane
  togglePane(id: string): Promise<void>;
  reportContentBounds(bounds: ContentBounds): void;
  onToast(listener: (toast: ShellToast) => void): () => void;
  // main timed the toast out or it was answered elsewhere
  onToastDismiss(listener: (id: string) => void): () => void;
  // undefined action = dismissed
  resolveToast(id: string, action?: string): void;
  onFocusTabStrip(listener: () => void): () => void;
}
