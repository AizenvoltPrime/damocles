export const window = {
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  showInformationMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
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
  createFileSystemWatcher: noopWatcher,
  fs: {
    readFile: () => Promise.reject(new Error('mock: file not found')),
  },
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
