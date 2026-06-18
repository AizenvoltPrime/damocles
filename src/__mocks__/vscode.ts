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
};

const noopWatcher = () => ({
  onDidCreate: () => ({ dispose: () => {} }),
  onDidChange: () => ({ dispose: () => {} }),
  onDidDelete: () => ({ dispose: () => {} }),
  dispose: () => {},
});

export const workspace = {
  getConfiguration: () => ({
    get: () => undefined,
    update: () => Promise.resolve(),
  }),
  workspaceFolders: [],
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  onDidGrantWorkspaceTrust: () => ({ dispose: () => {} }),
  createFileSystemWatcher: noopWatcher,
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
