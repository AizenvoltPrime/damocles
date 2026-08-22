// The test-only surface `src/__mocks__/vscode.ts` adds on top of the `vscode` API.
//
// `@types/vscode` declares `vscode` as an ambient module, which resolves ahead of any `paths` alias,
// so a test importing `__setTrusted` from 'vscode' is type-checked against the real API and cannot
// see the mock's exports. Declaring them here as an augmentation is what makes those imports
// resolve. Anything listed below MUST exist in the mock: this file only declares, it does not
// implement, so a name that drifts out of the mock still type-checks and then fails at run time.
declare module 'vscode' {
  interface FakeWebviewPanel {
    viewType: string;
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

  /** Every panel created via `window.createWebviewPanel`, newest last. */
  const __webviewPanels: FakeWebviewPanel[];

  type FakeWatcherCb = (uri: { fsPath: string }) => void;

  class FakeFileSystemWatcher {
    disposed: boolean;
    readonly globPattern: GlobPattern | undefined;
    constructor(globPattern?: GlobPattern);
    onDidChange(cb: FakeWatcherCb): { dispose: () => void };
    onDidCreate(cb: FakeWatcherCb): { dispose: () => void };
    onDidDelete(cb: FakeWatcherCb): { dispose: () => void };
    dispose(): void;
    emitChange(fsPath: string): void;
    emitCreate(fsPath: string): void;
    emitDelete(fsPath: string): void;
  }

  /** Every watcher created via `workspace.createFileSystemWatcher`, newest last. */
  const __watchers: FakeFileSystemWatcher[];

  type FakeRenameEvent = { files: ReadonlyArray<{ oldUri: { fsPath: string }; newUri: { fsPath: string } }> };

  const __renameEmitter: {
    cbs: Array<(e: FakeRenameEvent) => void>;
    register(cb: (e: FakeRenameEvent) => void): { dispose: () => void };
    fire(e: FakeRenameEvent): void;
    clear(): void;
  };

  const __trustEmitter: {
    cbs: Array<() => void>;
    register(cb: () => void): { dispose: () => void };
    fire(): void;
    clear(): void;
  };

  const __configEmitter: {
    cbs: Array<(e: { affectsConfiguration: (section: string) => boolean }) => void>;
    register(cb: (e: { affectsConfiguration: (section: string) => boolean }) => void): { dispose: () => void };
    fire(changedSection: string): void;
    clear(): void;
  };

  /** Sets what `workspace.isTrusted` reports; the real property is a readonly getter. */
  function __setTrusted(value: boolean): void;

  /** Every argument passed to `env.openExternal`, newest last. */
  const __openedExternal: unknown[];
}
