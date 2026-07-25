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
  createWebviewPanel: (_viewType: string, title: string) => {
    const disposeCbs: Array<() => void> = [];
    let disposed = false;
    return {
      title,
      viewColumn: 1,
      visible: true,
      active: true,
      iconPath: undefined as unknown,
      webview: {
        html: '',
        cspSource: '',
        options: {},
        onDidReceiveMessage: () => ({ dispose: () => {} }),
        postMessage: () => Promise.resolve(true),
        asWebviewUri: (u: unknown) => u,
      },
      onDidChangeViewState: () => ({ dispose: () => {} }),
      onDidDispose: (cb: () => void) => { disposeCbs.push(cb); return { dispose: () => {} }; },
      reveal: () => {},
      dispose: () => { if (disposed) return; disposed = true; for (const cb of disposeCbs) cb(); },
    };
  },
};

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
} as const;

type WatcherCb = (uri: { fsPath: string }) => void;

/**
 * Controllable FileSystemWatcher test double: tests drive synchronous events via
 * `emitChange`/`emitCreate`/`emitDelete`. A disposable-shaped superset of the real API. Every
 * instance is recorded in `__watchers` so tests can reach the most-recently-created watcher.
 */
export class FakeFileSystemWatcher {
  private changeCbs: WatcherCb[] = [];
  private createCbs: WatcherCb[] = [];
  private deleteCbs: WatcherCb[] = [];
  disposed = false;
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

export const workspace = {
  getConfiguration: () => ({
    get: (_key: string, defaultValue?: unknown) => defaultValue,
    update: () => Promise.resolve(),
  }),
  workspaceFolders: [],
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  onDidGrantWorkspaceTrust: () => ({ dispose: () => {} }),
  onDidSaveTextDocument: () => ({ dispose: () => {} }),
  onDidRenameFiles: (cb: RenameCb) => __renameEmitter.register(cb),
  createFileSystemWatcher: () => {
    const w = new FakeFileSystemWatcher();
    __watchers.push(w);
    return w;
  },
  fs: {
    readFile: () => Promise.reject(new Error('mock: file not found')),
  },
  isTrusted: true,
};

export const Uri = {
  file: (path: string) => ({ fsPath: path, path, scheme: 'file' }),
  parse: (str: string) => ({ fsPath: str, path: str, scheme: 'file' }),
  joinPath: (base: { fsPath: string }, ...segments: string[]) => {
    const joined = [base.fsPath, ...segments].join('/');
    return { fsPath: joined, path: joined, scheme: 'file' };
  },
};

export class RelativePattern {
  constructor(public base: unknown, public pattern: string) {}
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
