import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import picomatch from 'picomatch';
import type { AppPaths, WorkerName } from '../platform/app-paths';
import type { ClipboardService } from '../platform/clipboard-service';
import type { DialogService, InputBoxOptions, PickFileOptions, PickFolderOptions, QuickPickItem, QuickPickOptions } from '../platform/dialog-service';
import type { Disposable } from '../platform/disposable';
import type { ActiveEditorContext, DiffRequest, DiffView, EditorService, OpenFileOptions, OpenUntitledOptions } from '../platform/editor-service';
import type { FileRename, FileWatcher, FileWatcherFactory } from '../platform/file-watcher';
import type { HostLifecycle } from '../platform/host-lifecycle';
import type { KeyValueState, Memento } from '../platform/key-value-state';
import type { LocalizationService } from '../platform/localization-service';
import type { LogSink, LogSinkFactory } from '../platform/log-sink';
import type { NotificationOptions, NotificationService } from '../platform/notification-service';
import type { Platform } from '../platform/platform';
import type { SecretsStore } from '../platform/secrets-store';
import type { SettingInspection, SettingsChange, SettingsScope, SettingsStore } from '../platform/settings-store';
import type { ShellService } from '../platform/shell-service';
import type { TrustService } from '../platform/trust-service';
import type { PanelHost, PanelOptions, WindowService } from '../platform/window-service';
import type { OpenFolder, WorkspaceFolders } from '../platform/workspace-folders';
import { installPlatform } from '../core/platform-host';
import { mergeSettingValues } from '../core/config/settings-file';
import { VSCODE_HOST_CAPABILITIES, type HostCapabilities } from '../shared/types/messages';

type SettingsLayer = Readonly<Record<string, unknown>>;

export interface FakePlatformInit {
  /** Values per layer, keyed by full dotted key. An undefined value is treated as absent, as VS Code has no way to store one. */
  readonly settings?: {
    readonly defaults?: SettingsLayer;
    readonly user?: SettingsLayer;
    readonly project?: SettingsLayer;
    readonly local?: SettingsLayer;
    /** What scopeFile answers per scope; absent scopes answer undefined, as on VS Code. */
    readonly scopeFiles?: Readonly<Partial<Record<SettingsScope, string>>>;
  };
  readonly secrets?: Readonly<Record<string, string>>;
  readonly secretsPersistent?: boolean;
  readonly globalState?: Readonly<Record<string, unknown>>;
  readonly workspaceState?: Readonly<Record<string, unknown>>;
  /** Defaults to true, matching the vscode mock's `workspace.isTrusted`. */
  readonly trusted?: boolean;
  readonly folders?: readonly OpenFolder[];
  /** resourceRoot and unpackedRoot; workers resolve under `<appRoot>/dist` as on VS Code. */
  readonly appRoot?: string;
  readonly version?: string;
  /** Defaults to 'vscode'. */
  readonly host?: 'vscode' | 'desktop';
  /** Defaults to 'en'. */
  readonly language?: string;
  /** Overrides of the VS Code capability values. */
  readonly capabilities?: Partial<HostCapabilities>;
  /** WindowService.chatBrowserPane; defaults to false, the VS Code value. */
  readonly chatBrowserPane?: boolean;
}

export interface FakeSecretsStore extends SecretsStore {
  readonly entries: ReadonlyMap<string, string>;
}

export interface FakeTrustService extends TrustService {
  /** Every folderPath passed to isTrusted, oldest first. */
  readonly checkedPaths: readonly string[];
  /** Every folderPath passed to requestTrust, oldest first. */
  readonly trustRequests: readonly string[];
  setTrusted(value: boolean): void;
  /** Sets trusted and fires onDidGrantTrust with `folderPaths`, defaulting to the VS Code payload: every open folder, or [homeDirectory()] with none open. */
  grantTrust(folderPaths?: readonly string[]): void;
}

export interface FakeWorkspaceFolders extends WorkspaceFolders {
  setFolders(folders: readonly OpenFolder[]): void;
}

export interface FakeFileWatcher extends FileWatcher {
  /** null for a watchWorkspace watcher. */
  readonly base: string | null;
  readonly glob: string;
  readonly disposed: boolean;
  /** Each fire reaches listeners only for a path the glob matches, relative to base (or to an open workspace folder), as on both hosts. */
  fireCreate(fsPath: string): void;
  fireChange(fsPath: string): void;
  fireDelete(fsPath: string): void;
}

export interface FakeFileWatcherFactory extends FileWatcherFactory {
  /** Every watcher created, newest last, including disposed ones. */
  readonly watchers: readonly FakeFileWatcher[];
  /** The newest undisposed watch(base, glob) watcher; throws when there is none. */
  watcher(base: string, glob: string): FakeFileWatcher;
  /** The newest undisposed watchWorkspace(glob) watcher; throws when there is none. */
  workspaceWatcher(glob: string): FakeFileWatcher;
  /** Fires onDidRenameFiles, as a host-performed rename (explorer, refactoring) would. */
  fireRename(renames: readonly FileRename[]): void;
}

export type NotificationLevel = 'info' | 'warn' | 'error';

export interface NotificationCall {
  readonly level: NotificationLevel;
  readonly message: string;
  /** Present only when the caller used the options overload. */
  readonly options?: NotificationOptions;
  readonly actions: readonly string[];
}

export interface FakeNotificationService extends NotificationService {
  readonly calls: readonly NotificationCall[];
  /** Chooses the action each later call resolves with; the default answers undefined (dismissed). */
  answerWith(responder: (call: NotificationCall) => string | undefined): void;
}

export interface FakeClipboardService extends ClipboardService {
  /** Every writeText argument, oldest first. */
  readonly writes: readonly string[];
}

export interface FakeShellService extends ShellService {
  readonly openedExternal: readonly string[];
  readonly openedFolders: readonly string[];
  readonly revealedPaths: readonly string[];
}

export interface FakeHostLifecycle extends HostLifecycle {
  readonly reloads: number;
}

export interface FakeInputBoxCall {
  readonly options: InputBoxOptions;
  readonly signal: AbortSignal | undefined;
}

export type DialogAnswer<O> = (opts: O) => string | undefined | Promise<string | undefined>;

export interface FakeQuickPickCall {
  readonly items: readonly QuickPickItem[];
  readonly options: QuickPickOptions;
  readonly signal: AbortSignal | undefined;
}

export interface FakeDialogService extends DialogService {
  readonly pickFolderCalls: readonly PickFolderOptions[];
  readonly pickFileCalls: readonly PickFileOptions[];
  readonly inputBoxCalls: readonly FakeInputBoxCall[];
  readonly quickPickCalls: readonly FakeQuickPickCall[];
  /** The default answers undefined (cancelled). */
  answerPickFolder(responder: DialogAnswer<PickFolderOptions>): void;
  /** The default answers undefined (cancelled). */
  answerPickFile(responder: DialogAnswer<PickFileOptions>): void;
  /** The default answers undefined (cancelled); an abort before the answer settles resolves undefined, as the host dismisses the box. */
  answerInputBox(responder: DialogAnswer<InputBoxOptions>): void;
  /** Answers an item id; the default answers undefined (dismissed). An abort before the answer settles resolves undefined. */
  answerQuickPick(responder: (items: readonly QuickPickItem[], opts: QuickPickOptions) => string | undefined | Promise<string | undefined>): void;
}

export interface FakeDiffView extends DiffView {
  readonly request: DiffRequest;
  readonly closeCalls: number;
}

export interface FakeOpenedFile {
  readonly path: string;
  readonly options: OpenFileOptions | undefined;
}

export interface FakeUntitledDocument {
  readonly content: string;
  readonly language: string;
  readonly options?: OpenUntitledOptions;
}

export interface FakeEditorService extends EditorService {
  readonly openedFiles: readonly FakeOpenedFile[];
  readonly untitled: readonly FakeUntitledDocument[];
  /** Every showDiff view, oldest first, each carrying the DiffRequest it was opened with. */
  readonly diffs: readonly FakeDiffView[];
  readonly markdownPreviews: readonly string[];
  readonly settingsQueries: readonly (string | undefined)[];
  readonly extensionSearches: readonly string[];
  /** Host extensions start inactive. */
  setHostExtensionActive(id: string, active: boolean): void;
  /** Sets the focused editor's context (undefined: none focused, the initial state) and fires onDidChangeActiveContext. */
  setActiveContext(context: ActiveEditorContext | undefined): void;
}

export interface FakeLogSink extends LogSink {
  readonly name: string;
  readonly lines: readonly string[];
  readonly shows: number;
  readonly disposed: boolean;
}

export interface FakeLogSinkFactory extends LogSinkFactory {
  /** Every sink created, oldest first, including disposed ones. */
  readonly sinks: readonly FakeLogSink[];
  /** The newest sink created under `name`; throws when there is none. */
  sink(name: string): FakeLogSink;
}

export interface FakePanelHost extends PanelHost {
  /** The options the panel was created with. */
  readonly options: PanelOptions;
  /** True when created through createPanelInOwnColumn. */
  readonly ownColumn: boolean;
  readonly title: string;
  readonly html: string;
  readonly icon: string | undefined;
  readonly folderLabel: string | undefined;
  /** Every message postMessage accepted, oldest first; nothing is recorded after close. Tests may clear it. */
  readonly posted: unknown[];
  /** The column argument of each reveal call. */
  readonly reveals: readonly (number | undefined)[];
  readonly disposed: boolean;
  /** Drives onMessage listeners (webview to host). */
  fireMessage(message: unknown): void;
  /** Sets visible, then fires onDidChangeViewState, as the host does. */
  setVisible(next: boolean): void;
  /** Sets active, then fires onDidChangeViewState, as the host does. */
  setActive(next: boolean): void;
}

export interface FakeWindowService extends WindowService {
  /** Every panel created, newest last; tests may reset it with `panels.length = 0`. */
  readonly panels: FakePanelHost[];
}

export interface FakePlatform extends Platform {
  readonly secrets: FakeSecretsStore;
  readonly trust: FakeTrustService;
  readonly workspaceFolders: FakeWorkspaceFolders;
  readonly fileWatchers: FakeFileWatcherFactory;
  readonly notifications: FakeNotificationService;
  readonly clipboard: FakeClipboardService;
  readonly shell: FakeShellService;
  readonly dialogs: FakeDialogService;
  readonly editor: FakeEditorService;
  readonly window: FakeWindowService;
  readonly lifecycle: FakeHostLifecycle;
  readonly logSinks: FakeLogSinkFactory;
}

function listenerSet<A extends unknown[]>(): {
  add(cb: (...args: A) => void): Disposable;
  fire(...args: A): void;
} {
  const cbs = new Set<(...args: A) => void>();
  return {
    add: (cb) => {
      cbs.add(cb);
      return { dispose: () => cbs.delete(cb) };
    },
    fire: (...args) => {
      for (const cb of [...cbs]) cb(...args);
    },
  };
}

function layerMap(values: SettingsLayer | undefined): Map<string, unknown> {
  return new Map(Object.entries(values ?? {}).filter(([, v]) => v !== undefined));
}

// affectsConfiguration semantics: a change to `a.b.c` affects `a.b.c`, `a.b` and `a`.
function affectsFor(changedKey: string): SettingsChange {
  return { affects: (key) => changedKey === key || changedKey.startsWith(`${key}.`) };
}

function createSettingsStore(init: FakePlatformInit['settings']): SettingsStore {
  const defaults = layerMap(init?.defaults);
  const layers: Record<SettingsScope, Map<string, unknown>> = {
    user: layerMap(init?.user),
    project: layerMap(init?.project),
    local: layerMap(init?.local),
  };
  const listeners = listenerSet<[SettingsChange]>();

  // Object values merge across layers, as VS Code merges them.
  const effective = (key: string): unknown =>
    mergeSettingValues([defaults, layers.user, layers.project, layers.local].filter((layer) => layer.has(key)).map((layer) => layer.get(key)));

  function get<T>(key: string): T | undefined;
  function get<T>(key: string, defaultValue: T): T;
  function get<T>(key: string, defaultValue?: T): T | undefined {
    const value = effective(key);
    return value === undefined ? defaultValue : (value as T);
  }

  return {
    get,
    inspect: <T>(key: string): SettingInspection<T> => {
      const out: { defaultValue?: T; userValue?: T; projectValue?: T; localValue?: T } = {};
      if (defaults.has(key)) out.defaultValue = defaults.get(key) as T;
      if (layers.user.has(key)) out.userValue = layers.user.get(key) as T;
      if (layers.project.has(key)) out.projectValue = layers.project.get(key) as T;
      if (layers.local.has(key)) out.localValue = layers.local.get(key) as T;
      return out;
    },
    update: (key, value, scope) => {
      const layer = layers[scope];
      const before = layer.has(key) ? JSON.stringify(layer.get(key)) : undefined;
      if (value === undefined) layer.delete(key);
      else layer.set(key, value);
      const after = layer.has(key) ? JSON.stringify(layer.get(key)) : undefined;
      // VS Code raises no change event for a write that leaves the value as it was.
      if (before !== after) listeners.fire(affectsFor(key));
      return Promise.resolve();
    },
    onDidChange: (section, cb) =>
      listeners.add((change) => {
        if (change.affects(section)) cb(change);
      }),
    scopeFile: (scope) => init?.scopeFiles?.[scope],
  };
}

function createSecretsStore(values: Readonly<Record<string, string>> | undefined, isPersistent: boolean): FakeSecretsStore {
  const entries = new Map(Object.entries(values ?? {}));
  const listeners = new Set<(key: string) => void>();
  const fire = (key: string): void => {
    for (const listener of [...listeners]) listener(key);
  };
  return {
    entries,
    isPersistent,
    get: (key) => Promise.resolve(entries.get(key)),
    keys: () => Promise.resolve([...entries.keys()]),
    store: (key, value) => {
      entries.set(key, value);
      fire(key);
      return Promise.resolve();
    },
    delete: (key) => {
      entries.delete(key);
      fire(key);
      return Promise.resolve();
    },
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };
}

function createMemento(values: Readonly<Record<string, unknown>> | undefined): Memento {
  const entries = new Map(Object.entries(values ?? {}));
  function get<T>(key: string): T | undefined;
  function get<T>(key: string, defaultValue: T): T;
  function get<T>(key: string, defaultValue?: T): T | undefined {
    return entries.has(key) ? (entries.get(key) as T) : defaultValue;
  }
  return {
    get,
    // VS Code's Memento removes a key updated to undefined.
    update: (key, value) => {
      if (value === undefined) entries.delete(key);
      else entries.set(key, value);
      return Promise.resolve();
    },
  };
}

function createWorkspaceFolders(initial: readonly OpenFolder[]): FakeWorkspaceFolders {
  let current = [...initial];
  const listeners = listenerSet<[]>();
  return {
    folders: () => current,
    onDidChange: (cb) => listeners.add(cb),
    setFolders: (folders) => {
      current = [...folders];
      listeners.fire();
    },
  };
}

// Must equal folder-registry's homeDirectory(); importing it here would load logger.ts before a test's vi.mock.
const homeDirectory = (): string => process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();

function createTrustService(initial: boolean, workspaceFolders: WorkspaceFolders): FakeTrustService {
  let trusted = initial;
  const checkedPaths: string[] = [];
  const trustRequests: string[] = [];
  const listeners = listenerSet<[readonly string[]]>();
  return {
    checkedPaths,
    trustRequests,
    isTrusted: (folderPath) => {
      checkedPaths.push(folderPath);
      return trusted;
    },
    onDidGrantTrust: (cb) => listeners.add(cb),
    requestTrust: (folderPath) => {
      trustRequests.push(folderPath);
      return Promise.resolve(trusted);
    },
    setTrusted: (value) => {
      trusted = value;
    },
    grantTrust: (folderPaths) => {
      trusted = true;
      const open = workspaceFolders.folders().map((f) => f.fsPath);
      listeners.fire(folderPaths ?? (open.length > 0 ? open : [homeDirectory()]));
    },
  };
}

function globMatcher(glob: string): (base: string, fsPath: string) => boolean {
  const matches = picomatch(glob, { dot: true, nocase: process.platform === 'win32' });
  return (base, fsPath) => {
    const relative = path.relative(base, fsPath);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      && matches(relative.split(path.sep).join('/'));
  };
}

// base null: a watchWorkspace watcher, matched against the folders open when the event fires.
function createFakeWatcher(base: string | null, glob: string, folders: WorkspaceFolders): FakeFileWatcher {
  const create = listenerSet<[string]>();
  const change = listenerSet<[string]>();
  const del = listenerSet<[string]>();
  let disposed = false;
  const matcher = globMatcher(glob);
  const matches = (fsPath: string): boolean => (base !== null
    ? matcher(base, fsPath)
    : folders.folders().some((folder) => matcher(folder.fsPath, fsPath)));
  const live = (fire: (fsPath: string) => void) => (fsPath: string): void => {
    if (!disposed && matches(fsPath)) fire(fsPath);
  };
  return {
    base,
    glob,
    get disposed() {
      return disposed;
    },
    onDidCreate: (cb) => create.add(cb),
    onDidChange: (cb) => change.add(cb),
    onDidDelete: (cb) => del.add(cb),
    dispose: () => {
      disposed = true;
    },
    fireCreate: live(create.fire),
    fireChange: live(change.fire),
    fireDelete: live(del.fire),
  };
}

function createFileWatcherFactory(folders: WorkspaceFolders): FakeFileWatcherFactory {
  const watchers: FakeFileWatcher[] = [];
  const renames = listenerSet<[readonly FileRename[]]>();
  const add = (w: FakeFileWatcher): FakeFileWatcher => {
    watchers.push(w);
    return w;
  };
  const find = (base: string | null, glob: string): FakeFileWatcher => {
    const match = [...watchers].reverse().find((w) => !w.disposed && w.base === base && w.glob === glob);
    if (match) return match;
    const have = watchers.map((w) => `${w.base ?? '<workspace>'} ${w.glob}${w.disposed ? ' (disposed)' : ''}`);
    throw new Error(`No live watcher for ${base ?? '<workspace>'} ${glob}; watchers: [${have.join(', ')}]`);
  };
  return {
    watchers,
    watch: (base, glob) => add(createFakeWatcher(base, glob, folders)),
    watchWorkspace: (glob) => add(createFakeWatcher(null, glob, folders)),
    watcher: (base, glob) => find(base, glob),
    workspaceWatcher: (glob) => find(null, glob),
    onDidRenameFiles: (cb) => renames.add(cb),
    fireRename: (list) => renames.fire(list),
  };
}

function createNotificationService(): FakeNotificationService {
  const calls: NotificationCall[] = [];
  let responder: (call: NotificationCall) => string | undefined = () => undefined;
  // A non-string second argument selects the options overload, as the interface's overloads do.
  const notify = (level: NotificationLevel) => (
    message: string,
    ...rest: [NotificationOptions, ...string[]] | string[]
  ): Promise<string | undefined> => {
    const [first, ...others] = rest;
    const call: NotificationCall =
      first !== undefined && typeof first !== 'string'
        ? { level, message, options: first, actions: others as string[] }
        : { level, message, actions: rest as string[] };
    calls.push(call);
    return Promise.resolve(responder(call));
  };
  return {
    calls,
    info: notify('info'),
    warn: notify('warn'),
    error: notify('error'),
    answerWith: (next) => {
      responder = next;
    },
  };
}

// Mirrors vscode.l10n.t for positional args: {N} becomes String(args[N]), and an index with no arg stays as written.
function createLocalization(language: string): LocalizationService {
  return {
    language,
    t(message: string, ...args: Array<string | number | boolean>): string {
      return args.length ? message.replace(/\{(\d+)\}/g, (match, i: string) => (args[Number(i)] === undefined ? match : String(args[Number(i)]))) : message;
    },
  };
}

function createClipboard(): FakeClipboardService {
  const writes: string[] = [];
  return {
    writes,
    writeText: (text) => {
      writes.push(text);
      return Promise.resolve();
    },
  };
}

function createShell(): FakeShellService {
  const openedExternal: string[] = [];
  const openedFolders: string[] = [];
  const revealedPaths: string[] = [];
  return {
    openedExternal,
    openedFolders,
    revealedPaths,
    openExternal: (url) => {
      openedExternal.push(url);
      return Promise.resolve(true);
    },
    openFolder: (p) => {
      openedFolders.push(p);
      return Promise.resolve(true);
    },
    revealPath: (p) => {
      revealedPaths.push(p);
      return Promise.resolve();
    },
  };
}

function createLifecycle(): FakeHostLifecycle {
  let reloads = 0;
  return {
    get reloads() {
      return reloads;
    },
    reload: () => {
      reloads += 1;
      return Promise.resolve();
    },
  };
}

function createDialogs(): FakeDialogService {
  const pickFolderCalls: PickFolderOptions[] = [];
  const pickFileCalls: PickFileOptions[] = [];
  const inputBoxCalls: FakeInputBoxCall[] = [];
  let pickFolderAnswer: DialogAnswer<PickFolderOptions> = () => undefined;
  let pickFileAnswer: DialogAnswer<PickFileOptions> = () => undefined;
  let inputBoxAnswer: DialogAnswer<InputBoxOptions> = () => undefined;
  const quickPickCalls: FakeQuickPickCall[] = [];
  let quickPickAnswer: (items: readonly QuickPickItem[], opts: QuickPickOptions) => string | undefined | Promise<string | undefined> = () => undefined;
  // An abort before the answer settles resolves undefined, as the host dismisses the prompt.
  const abortable = (signal: AbortSignal | undefined, answer: () => string | undefined | Promise<string | undefined>): Promise<string | undefined> => {
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolve, reject) => {
      const onAbort = (): void => resolve(undefined);
      signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(answer()).then(
        (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  };
  return {
    pickFolderCalls,
    pickFileCalls,
    inputBoxCalls,
    quickPickCalls,
    pickFolder: (opts) => {
      pickFolderCalls.push(opts);
      return Promise.resolve(pickFolderAnswer(opts));
    },
    pickFile: (opts) => {
      pickFileCalls.push(opts);
      return Promise.resolve(pickFileAnswer(opts));
    },
    inputBox: (opts, signal) => {
      inputBoxCalls.push({ options: opts, signal });
      return abortable(signal, () => inputBoxAnswer(opts));
    },
    quickPick: (items, opts, signal) => {
      quickPickCalls.push({ items, options: opts, signal });
      return abortable(signal, () => quickPickAnswer(items, opts));
    },
    answerPickFolder: (next) => {
      pickFolderAnswer = next;
    },
    answerPickFile: (next) => {
      pickFileAnswer = next;
    },
    answerInputBox: (next) => {
      inputBoxAnswer = next;
    },
    answerQuickPick: (next) => {
      quickPickAnswer = next;
    },
  };
}

function createFakeDiffView(request: DiffRequest): FakeDiffView {
  let closeCalls = 0;
  return {
    request,
    get closeCalls() {
      return closeCalls;
    },
    close: () => {
      closeCalls += 1;
      return Promise.resolve();
    },
  };
}

function createEditor(): FakeEditorService {
  const openedFiles: FakeOpenedFile[] = [];
  const diffs: FakeDiffView[] = [];
  const markdownPreviews: string[] = [];
  const settingsQueries: (string | undefined)[] = [];
  const extensionSearches: string[] = [];
  const activeExtensions = new Set<string>();
  const untitled: FakeUntitledDocument[] = [];
  const contextListeners = listenerSet<[ActiveEditorContext | undefined]>();
  let activeContext: ActiveEditorContext | undefined;
  return {
    openedFiles,
    untitled,
    diffs,
    markdownPreviews,
    settingsQueries,
    extensionSearches,
    openFile: (p, opts) => {
      openedFiles.push({ path: p, options: opts });
      return Promise.resolve();
    },
    openUntitled: (content, language, opts) => {
      untitled.push({ content, language, ...(opts !== undefined ? { options: opts } : {}) });
      return Promise.resolve();
    },
    // The fake holds no unsaved edits, so the editor text is the file on disk.
    readText: (p) => fs.promises.readFile(p, 'utf8'),
    showDiff: (req) => {
      const view = createFakeDiffView(req);
      diffs.push(view);
      return Promise.resolve(view);
    },
    showMarkdownPreview: (p) => {
      markdownPreviews.push(p);
      return Promise.resolve();
    },
    getActiveContext: () => activeContext,
    onDidChangeActiveContext: (cb) => contextListeners.add(cb),
    setActiveContext: (context) => {
      activeContext = context;
      contextListeners.fire(context);
    },
    openHostSettings: (query) => {
      settingsQueries.push(query);
      return Promise.resolve();
    },
    isHostExtensionActive: (id) => activeExtensions.has(id),
    searchHostExtensions: (query) => {
      extensionSearches.push(query);
      return Promise.resolve();
    },
    setHostExtensionActive: (id, active) => {
      if (active) activeExtensions.add(id);
      else activeExtensions.delete(id);
    },
  };
}

function createLogSinks(): FakeLogSinkFactory {
  const sinks: FakeLogSink[] = [];
  return {
    sinks,
    create: (name) => {
      const lines: string[] = [];
      let shows = 0;
      let disposed = false;
      const sink: FakeLogSink = {
        name,
        lines,
        get shows() {
          return shows;
        },
        get disposed() {
          return disposed;
        },
        appendLine: (line) => {
          lines.push(line);
        },
        show: () => {
          shows += 1;
        },
        dispose: () => {
          disposed = true;
        },
      };
      sinks.push(sink);
      return sink;
    },
    sink: (name) => {
      const match = [...sinks].reverse().find((s) => s.name === name);
      if (match) return match;
      throw new Error(`No log sink named ${name}; sinks: [${sinks.map((s) => s.name).join(', ')}]`);
    },
  };
}

function createFakePanelHost(options: PanelOptions, ownColumn: boolean): FakePanelHost {
  const messages = listenerSet<[unknown]>();
  const disposes = listenerSet<[]>();
  const viewStates = listenerSet<[]>();
  const posted: unknown[] = [];
  const reveals: (number | undefined)[] = [];
  let title = options.title;
  let column = options.column ?? 1;
  let visible = true;
  let active = true;
  let html = '';
  let icon: string | undefined;
  let folderLabel: string | undefined;
  let disposed = false;
  return {
    options,
    ownColumn,
    posted,
    reveals,
    cspSource: '',
    themeCssSource: () => '',
    get title() {
      return title;
    },
    get column() {
      return column;
    },
    get visible() {
      return visible;
    },
    get active() {
      return active;
    },
    get html() {
      return html;
    },
    get icon() {
      return icon;
    },
    get folderLabel() {
      return folderLabel;
    },
    get disposed() {
      return disposed;
    },
    setHtml: (next) => {
      html = next;
    },
    // A disposed VS Code webview resolves postMessage false.
    postMessage: (message) => {
      if (disposed) return Promise.resolve(false);
      posted.push(message);
      return Promise.resolve(true);
    },
    onMessage: (cb) => messages.add(cb),
    onDispose: (cb) => disposes.add(cb),
    onDidChangeViewState: (cb) => viewStates.add(cb),
    asResourceUri: (absolutePath) => absolutePath,
    setIcon: (next) => {
      icon = next;
    },
    setTitle: (next) => {
      title = next;
    },
    setFolderLabel: (next) => {
      folderLabel = next;
    },
    reveal: (next) => {
      reveals.push(next);
      if (next !== undefined) column = next;
    },
    close: () => {
      if (disposed) return;
      disposed = true;
      disposes.fire();
    },
    fireMessage: (message) => messages.fire(message),
    setVisible: (next) => {
      visible = next;
      viewStates.fire();
    },
    setActive: (next) => {
      active = next;
      viewStates.fire();
    },
  };
}

function createWindow(chatBrowserPane: boolean): FakeWindowService {
  const panels: FakePanelHost[] = [];
  const kindColumns = new Map<PanelOptions['kind'], number>();
  const add = (panel: FakePanelHost): FakePanelHost => {
    panels.push(panel);
    return panel;
  };
  return {
    panels,
    chatBrowserPane,
    createPanel: (opts) => add(createFakePanelHost(opts, false)),
    // Each kind keeps one column, allocated past every column a live panel occupies.
    createPanelInOwnColumn: (opts) => {
      let column = kindColumns.get(opts.kind);
      if (column === undefined) {
        const used = panels.filter((p) => !p.disposed).map((p) => p.column ?? 0);
        column = Math.max(0, ...used, ...kindColumns.values()) + 1;
        kindColumns.set(opts.kind, column);
      }
      return Promise.resolve(add(createFakePanelHost({ ...opts, column }, true)));
    },
  };
}

// Worker file names match the esbuild outfiles in esbuild.config.mjs.
const WORKER_FILES: Readonly<Record<WorkerName, string>> = {
  compass: 'compass-worker.js',
  usageStats: 'usage-stats-worker.js',
  sentinel: 'sentinel.js',
};

function createAppPaths(root: string): AppPaths {
  return {
    resourceRoot: root,
    unpackedRoot: root,
    workerEntry: (name) => path.join(root, 'dist', WORKER_FILES[name]),
  };
}

export function createFakePlatform(init: FakePlatformInit = {}): FakePlatform {
  const workspaceFolders = createWorkspaceFolders(init.folders ?? []);
  const state: KeyValueState = {
    global: createMemento(init.globalState),
    workspace: createMemento(init.workspaceState),
  };
  return {
    capabilities: { ...VSCODE_HOST_CAPABILITIES, ...init.capabilities },
    settings: createSettingsStore(init.settings),
    secrets: createSecretsStore(init.secrets, init.secretsPersistent ?? true),
    state,
    trust: createTrustService(init.trusted ?? true, workspaceFolders),
    workspaceFolders,
    fileWatchers: createFileWatcherFactory(workspaceFolders),
    notifications: createNotificationService(),
    paths: createAppPaths(init.appRoot ?? path.resolve(__dirname, '..', '..')),
    appInfo: { version: init.version ?? '0.0.0-test', host: init.host ?? 'vscode' },
    localization: createLocalization(init.language ?? 'en'),
    clipboard: createClipboard(),
    shell: createShell(),
    dialogs: createDialogs(),
    editor: createEditor(),
    window: createWindow(init.chatBrowserPane ?? false),
    lifecycle: createLifecycle(),
    logSinks: createLogSinks(),
  };
}

/** Creates a fake platform and installs it as the platform() accessor for module-level readers. */
export function installFakePlatform(init: FakePlatformInit = {}): FakePlatform {
  const fake = createFakePlatform(init);
  installPlatform(fake);
  return fake;
}
