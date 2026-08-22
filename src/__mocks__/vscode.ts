export const window = {
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  showInformationMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showTextDocument: () => Promise.resolve(undefined),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: '',
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  registerTreeDataProvider: () => ({ dispose: () => {} }),
  createQuickPick: () => ({
    placeholder: '',
    matchOnDescription: false,
    items: [],
    selectedItems: [],
    onDidChangeValue: () => ({ dispose: () => {} }),
    onDidAccept: () => ({ dispose: () => {} }),
    onDidHide: () => ({ dispose: () => {} }),
    show: () => {},
    dispose: () => {},
  }),
  createTextEditorDecorationType: () => ({ dispose: () => {} }),
  onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
  onDidChangeVisibleTextEditors: () => ({ dispose: () => {} }),
  visibleTextEditors: [],
  activeTextEditor: undefined,
  createWebviewPanel: (
    _viewType: string,
    title: string,
    _showOptions?: unknown,
    createOptions?: Record<string, unknown>,
  ): FakeWebviewPanel => {
    const disposeCbs: Array<() => void> = [];
    const messageCbs: Array<(msg: unknown) => void> = [];
    const viewStateCbs: Array<(e: { webviewPanel: FakeWebviewPanel }) => void> = [];
    let disposed = false;
    const panel: FakeWebviewPanel = {
      title,
      viewColumn: 1,
      visible: true,
      active: true,
      iconPath: undefined as unknown,
      webview: {
        html: '',
        cspSource: '',
        options: {},
        onDidReceiveMessage: (cb: (msg: unknown) => void) => {
          messageCbs.push(cb);
          return { dispose: () => { const i = messageCbs.indexOf(cb); if (i !== -1) messageCbs.splice(i, 1); } };
        },
        postMessage: (msg: unknown) => { panel.posted.push(msg); return Promise.resolve(true); },
        asWebviewUri: (u: unknown) => u,
      },
      onDidChangeViewState: (cb: (e: { webviewPanel: FakeWebviewPanel }) => void) => {
        viewStateCbs.push(cb);
        return { dispose: () => { const i = viewStateCbs.indexOf(cb); if (i !== -1) viewStateCbs.splice(i, 1); } };
      },
      onDidDispose: (cb: () => void) => { disposeCbs.push(cb); return { dispose: () => {} }; },
      reveal: () => {},
      dispose: () => { if (disposed) return; disposed = true; for (const cb of disposeCbs) cb(); },
      posted: [],
      createOptions: createOptions ?? null,
      fireMessage: (msg: unknown) => { for (const cb of [...messageCbs]) cb(msg); },
      setVisible: (next: boolean) => {
        panel.visible = next;
        for (const cb of [...viewStateCbs]) cb({ webviewPanel: panel });
      },
    };
    __webviewPanels.push(panel);
    return panel;
  },
};

/**
 * Controllable WebviewPanel test double. A superset of the real API: `posted` records every
 * `webview.postMessage` payload, `fireMessage` drives the retained `onDidReceiveMessage` callbacks
 * (webview → extension), and `setVisible` flips `visible` and fires the retained
 * `onDidChangeViewState` callbacks (VS Code sets the flag before emitting the event, so tests that
 * read `panel.visible` inside the handler see the new value). `createOptions` records the 4th
 * argument `createWebviewPanel` was called with (`WebviewPanelOptions & WebviewOptions`), which is
 * the only way a test can assert `localResourceRoots` / the ABSENCE of `retainContextWhenHidden` —
 * both are fixed at construction time and unreadable off a live panel.
 */
export interface FakeWebviewPanel {
  title: string;
  viewColumn: number;
  visible: boolean;
  active: boolean;
  iconPath: unknown;
  webview: {
    html: string;
    cspSource: string;
    options: object;
    onDidReceiveMessage: (cb: (msg: unknown) => void) => { dispose: () => void };
    postMessage: (msg: unknown) => Promise<boolean>;
    asWebviewUri: (u: unknown) => unknown;
  };
  onDidChangeViewState: (cb: (e: { webviewPanel: FakeWebviewPanel }) => void) => { dispose: () => void };
  onDidDispose: (cb: () => void) => { dispose: () => void };
  reveal: () => void;
  dispose: () => void;
  posted: unknown[];
  /** The options object passed as `createWebviewPanel`'s 4th argument, or null if omitted. */
  createOptions: Record<string, unknown> | null;
  fireMessage: (msg: unknown) => void;
  setVisible: (next: boolean) => void;
}

/** Every panel created via window.createWebviewPanel, newest last. Tests reset it in beforeEach. */
export const __webviewPanels: FakeWebviewPanel[] = [];

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
} as const;

type WatcherCb = (uri: { fsPath: string }) => void;

/** The `globPattern` argument `createFileSystemWatcher` accepts, matching `vscode.GlobPattern`. */
export type GlobPattern = string | RelativePattern;

/**
 * Controllable FileSystemWatcher test double: tests drive synchronous events via
 * `emitChange`/`emitCreate`/`emitDelete`. A disposable-shaped superset of the real API. Every
 * instance is recorded in `__watchers` so tests can reach the most-recently-created watcher.
 * `globPattern` holds the argument `createFileSystemWatcher` was called with, stored by reference so
 * an assertion can still tell a `RelativePattern` on a `Uri` base from one on a string base and from
 * a bare glob string. VS Code reports no events from a bare glob outside the workspace folders, so
 * that distinction is the difference between a watcher that fires and one that never does.
 */
export class FakeFileSystemWatcher {
  private changeCbs: WatcherCb[] = [];
  private createCbs: WatcherCb[] = [];
  private deleteCbs: WatcherCb[] = [];
  disposed = false;
  readonly globPattern: GlobPattern | undefined;
  constructor(globPattern?: GlobPattern) { this.globPattern = globPattern; }
  private remove(list: WatcherCb[], cb: WatcherCb) { const i = list.indexOf(cb); if (i !== -1) list.splice(i, 1); }
  onDidChange(cb: WatcherCb) { this.changeCbs.push(cb); return { dispose: () => this.remove(this.changeCbs, cb) }; }
  onDidCreate(cb: WatcherCb) { this.createCbs.push(cb); return { dispose: () => this.remove(this.createCbs, cb) }; }
  onDidDelete(cb: WatcherCb) { this.deleteCbs.push(cb); return { dispose: () => this.remove(this.deleteCbs, cb) }; }
  dispose() { this.disposed = true; this.changeCbs = []; this.createCbs = []; this.deleteCbs = []; }
  emitChange(fsPath: string) { for (const cb of this.changeCbs) cb({ fsPath }); }
  emitCreate(fsPath: string) { for (const cb of this.createCbs) cb({ fsPath }); }
  emitDelete(fsPath: string) { for (const cb of this.deleteCbs) cb({ fsPath }); }
}

/** All FakeFileSystemWatcher instances created via workspace.createFileSystemWatcher, newest last. */
export const __watchers: FakeFileSystemWatcher[] = [];

type RenameEvent = { files: ReadonlyArray<{ oldUri: { fsPath: string }; newUri: { fsPath: string } }> };
type RenameCb = (e: RenameEvent) => void;

/** Controllable onDidRenameFiles emitter: `register` mirrors the subscription, `fire` drives a rename synchronously. */
export const __renameEmitter = {
  cbs: [] as RenameCb[],
  register(cb: RenameCb) { this.cbs.push(cb); return { dispose: () => { this.cbs = this.cbs.filter((c) => c !== cb); } }; },
  fire(e: RenameEvent) { for (const cb of this.cbs) cb(e); },
  clear() { this.cbs = []; },
};

type TrustCb = () => void;

/**
 * Controllable onDidGrantWorkspaceTrust emitter: `register` retains the subscription so `fire` can
 * drive a trust grant synchronously. Nothing fires it unless a test does, so retaining the callback
 * changes no existing behavior. Tests that grant trust should call `__setTrusted(true)` first, since
 * the listeners re-read it.
 */
export const __trustEmitter = {
  cbs: [] as TrustCb[],
  register(cb: TrustCb) { this.cbs.push(cb); return { dispose: () => { this.cbs = this.cbs.filter((c) => c !== cb); } }; },
  fire() { for (const cb of [...this.cbs]) cb(); },
  clear() { this.cbs = []; },
};

type ConfigChangeEvent = { affectsConfiguration: (section: string) => boolean };
type ConfigCb = (e: ConfigChangeEvent) => void;

/**
 * Controllable onDidChangeConfiguration emitter, same shape as `__trustEmitter`. `fire` takes the
 * setting id that changed and builds the event callers destructure: `affectsConfiguration(section)`
 * answers true for that id and for every ancestor section of it, which is what VS Code reports.
 */
export const __configEmitter = {
  cbs: [] as ConfigCb[],
  register(cb: ConfigCb) { this.cbs.push(cb); return { dispose: () => { this.cbs = this.cbs.filter((c) => c !== cb); } }; },
  fire(changedSection: string) {
    const e: ConfigChangeEvent = {
      affectsConfiguration: (section) => changedSection === section || changedSection.startsWith(`${section}.`),
    };
    for (const cb of [...this.cbs]) cb(e);
  },
  clear() { this.cbs = []; },
};

let trusted = true;

/**
 * Set the value `workspace.isTrusted` reports. The real property is a readonly getter, so a test
 * cannot assign to it and neither can production code.
 */
export function __setTrusted(value: boolean): void {
  trusted = value;
}

const workspaceMock = {
  getConfiguration: () => ({
    get: (_key: string, defaultValue?: unknown) => defaultValue,
    update: () => Promise.resolve(),
  }),
  workspaceFolders: [],
  onDidChangeConfiguration: (cb: ConfigCb) => __configEmitter.register(cb),
  onDidGrantWorkspaceTrust: (cb: TrustCb) => __trustEmitter.register(cb),
  onDidSaveTextDocument: () => ({ dispose: () => {} }),
  onDidRenameFiles: (cb: RenameCb) => __renameEmitter.register(cb),
  createFileSystemWatcher: (globPattern: GlobPattern) => {
    const w = new FakeFileSystemWatcher(globPattern);
    __watchers.push(w);
    return w;
  },
  fs: {
    readFile: () => Promise.reject(new Error('mock: file not found')),
  },
};

Object.defineProperty(workspaceMock, 'isTrusted', {
  get: () => trusted,
  enumerable: true,
  configurable: true,
});

export const workspace = workspaceMock as typeof workspaceMock & { readonly isTrusted: boolean };

export const Uri = {
  file: (path: string) => ({ fsPath: path, path, scheme: 'file' }),
  parse: (str: string) => ({ fsPath: str, path: str, scheme: 'file' }),
  joinPath: (base: { fsPath: string }, ...segments: string[]) => {
    const joined = [base.fsPath, ...segments].join('/');
    return { fsPath: joined, path: joined, scheme: 'file' };
  },
};

export class RelativePattern {
  base: unknown;
  pattern: string;
  constructor(base: unknown, pattern: string) {
    this.base = base;
    this.pattern = pattern;
  }
}

export const EventEmitter = class {
  event = () => ({ dispose: () => {} });
  fire() {}
  dispose() {}
};

export const Disposable = {
  from: () => ({ dispose: () => {} }),
};

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;

export class TreeItem {
  label: string | undefined;
  description: string | undefined;
  tooltip: string | undefined;
  iconPath: unknown;
  contextValue: string | undefined;
  command: unknown;
  collapsibleState: number;
  constructor(label: string | unknown, collapsibleState?: number) {
    this.label = typeof label === 'string' ? label : undefined;
    this.collapsibleState = collapsibleState ?? 0;
  }
}

export class ThemeIcon {
  id: string;
  constructor(id: string) { this.id = id; }
}

export class ThemeColor {
  id: string;
  constructor(id: string) { this.id = id; }
}

export class Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
  constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
    this.start = { line: startLine, character: startChar };
    this.end = { line: endLine, character: endChar };
  }
}

export class MarkdownString {
  value: string;
  constructor(value?: string) { this.value = value ?? ''; }
}

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
} as const;

export const OverviewRulerLane = {
  Left: 1,
  Center: 2,
  Right: 4,
  Full: 7,
} as const;

export const commands = {
  registerCommand: (_id: string, _handler: (...args: unknown[]) => unknown) => ({ dispose: () => {} }),
  executeCommand: () => Promise.resolve(undefined),
};

export const l10n = {
  t: (message: string, ...args: unknown[]) =>
    args.length ? message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? '')) : message,
};

/**
 * `env.openExternal` / `env.clipboard` test doubles. The browser service opens the external DevTools
 * URL through `env.openExternal` and writes copy/cut text through `env.clipboard`; without these the
 * real code paths throw on `undefined` before reaching the behavior under test. `__openedExternal`
 * records every URI so a test can assert a DevTools window was — or crucially was NOT — opened.
 */
export const __openedExternal: unknown[] = [];

export const env = {
  openExternal: (uri: unknown) => { __openedExternal.push(uri); return Promise.resolve(true); },
  clipboard: {
    writeText: () => Promise.resolve(),
    readText: () => Promise.resolve(''),
  },
  language: 'en',
};
