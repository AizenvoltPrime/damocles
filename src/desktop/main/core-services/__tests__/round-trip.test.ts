import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform, type FakePanelHost, type FakePlatform } from '../../../../__mocks__/fake-platform';
import type { Disposable } from '../../../../platform/disposable';
import type { PanelOptions } from '../../../../platform/window-service';
import { createCorePlatform, type CorePlatform } from '../../../core-host/platform';
import { createLoopback, createMainEndpoint, INVALID, parseCoreInit } from '../../../core-protocol';
import { createDesktopKeyValueState, type DesktopKeyValueState } from '../../platform/key-value-state';
import { createHostServices, type HostServices, type HostTrust, type HostUi, type RelayView } from '../host-services';
import { hostExtras } from './host-deps';

interface Harness {
  readonly main: FakePlatform;
  readonly core: CorePlatform;
  readonly host: HostServices;
  readonly state: DesktopKeyValueState;
  readonly grant: (folder: string) => void;
  readonly setTheme: (css: string) => void;
  readonly setTerminal: (shown: boolean) => void;
  // the JSON text main forwarded to each view, unparsed
  readonly relayed: Array<{ readonly viewId: string; readonly type: string; readonly json: string }>;
  // main's side of the channel closes, as when core's process ends
  readonly coreEnded: () => void;
  // core's end of the channel, for a message core's platform would never send
  readonly coreTransport: ReturnType<typeof createLoopback>['core'];
}

type FakeRelayView = FakePanelHost & RelayView;

/** A fake view main relays to: JSON text is recorded as it arrives, then parsed as the panel preload does. */
function relayView(view: FakePanelHost, panelId: string, relayed: Harness['relayed']): FakeRelayView {
  return Object.assign(view, {
    panelId,
    postJson: (type: string, json: string) => {
      relayed.push({ viewId: panelId, type, json });
      void view.postMessage(JSON.parse(json));
    },
  });
}

const dirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function connect(options: { readonly trusted?: readonly string[]; readonly globalState?: Record<string, unknown>; readonly ui?: Partial<HostUi> } = {}): Harness {
  const main = createFakePlatform({ chatBrowserPane: true, secrets: { stored: 'one' }, folders: [{ fsPath: path.resolve('/projects/a'), name: 'a' }] });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'core-round-trip-'));
  dirs.push(userData);
  if (options.globalState) {
    fs.mkdirSync(path.join(userData, 'state'));
    fs.writeFileSync(path.join(userData, 'state', 'global.json'), JSON.stringify(options.globalState));
  }
  const state = createDesktopKeyValueState(userData, () => undefined);
  const trusted = new Set(options.trusted ?? []);
  const grants = new Set<(folders: readonly string[]) => void>();
  const grant = (folder: string): void => {
    trusted.add(folder);
    for (const listener of [...grants]) listener([folder]);
  };
  const trust: HostTrust = {
    trustedFolders: () => [...trusted],
    onDidGrant: (listener): Disposable => {
      grants.add(listener);
      return { dispose: () => { grants.delete(listener); } };
    },
    requestTrust: async (folder) => {
      await Promise.resolve();
      grant(folder);
      return true;
    },
  };
  let css = 'initial-css';
  const themeListeners = new Set<(css: string) => void>();
  let terminal = { shown: false, shortcut: 'Ctrl+`' };
  const relayed: Harness['relayed'] = [];
  const { main: mainEnd, core: coreEnd } = createLoopback();
  const endpoint = createMainEndpoint(mainEnd, () => undefined);
  const host = createHostServices({
    endpoint,
    platform: main,
    trust,
    state,
    theme: {
      css: () => css,
      onDidChange: (listener) => {
        themeListeners.add(listener);
        return { dispose: () => { themeListeners.delete(listener); } };
      },
    },
    terminalToggle: () => terminal,
    resolveProxy: (url) => Promise.resolve(`PROXY proxy.example:8080 for ${url}`),
    createView: (panelId, create) => relayView(main.window.createPanel(create) as FakePanelHost, panelId, relayed),
    git: { available: true },
    e2eHooks: false,
    ...hostExtras(options.ui ? { ui: options.ui } : {}),
    log: () => undefined,
  });
  const init = parseCoreInit(structuredClone(host.init));
  if (init === INVALID) throw new Error('main\'s init does not parse');
  const core = createCorePlatform(coreEnd, init, () => ({
    capabilities: () => main.capabilities,
    settings: main.settings,
    fileWatchers: main.fileWatchers,
    confinement: main.confinement,
    localization: main.localization,
    logSinks: main.logSinks,
    paths: main.paths,
  }));
  cleanups.push(() => {
    core.dispose();
    endpoint.close('closed');
    host.dispose();
  });
  return {
    main,
    core,
    host,
    state,
    grant,
    setTheme: (next) => {
      css = next;
      for (const listener of themeListeners) listener(next);
    },
    setTerminal: (shown) => {
      terminal = { ...terminal, shown };
      host.terminalToggleChanged();
    },
    relayed,
    coreEnded: () => endpoint.close('Damocles Core stopped'),
    coreTransport: coreEnd,
  };
}

const CHAT: PanelOptions = { kind: 'chat', title: 'Damocles', localResourceRoots: [path.resolve('/app/dist/webview')] };

describe('local services', () => {
  it('are the instances core was given', () => {
    const { main, core } = connect();
    expect(core.settings).toBe(main.settings);
    expect(core.fileWatchers).toBe(main.fileWatchers);
    expect(core.confinement).toBe(main.confinement);
    expect(core.localization).toBe(main.localization);
    expect(core.logSinks).toBe(main.logSinks);
    expect(core.paths).toBe(main.paths);
    expect(core.capabilities).toEqual(main.capabilities);
  });
});

describe('mirrored services', () => {
  it('app info comes from init', () => {
    const { main, core } = connect();
    expect(core.appInfo).toEqual({ version: main.appInfo.version, host: 'desktop' });
  });

  it('trust reads the mirror; requestTrust is answered after the grant reached core', async () => {
    const trustedFolder = path.resolve('/projects/trusted');
    const asked = path.resolve('/projects/asked');
    const { core } = connect({ trusted: [trustedFolder] });
    expect(core.trust.isTrusted(trustedFolder)).toBe(true);
    expect(core.trust.isTrusted(asked)).toBe(false);
    const order: string[] = [];
    core.trust.onDidGrantTrust((folders) => order.push(`granted ${folders.join(',')}`));
    const answer = core.trust.requestTrust(asked).then((trusted) => {
      order.push(`answered ${trusted} while trusted=${core.trust.isTrusted(asked)}`);
    });
    await answer;
    expect(order).toEqual([`granted ${asked}`, `answered true while trusted=true`]);
  });

  it('a grant main makes reaches core', () => {
    const folder = path.resolve('/projects/b');
    const { core, grant } = connect();
    const granted = vi.fn();
    core.trust.onDidGrantTrust(granted);
    grant(folder);
    expect(granted).toHaveBeenCalledWith([folder]);
    expect(core.trust.isTrusted(folder)).toBe(true);
  });

  it('key-value state starts from main\'s values, updates locally at once and reaches main', async () => {
    const { core, state } = connect({ globalState: { seeded: { a: 1 } } });
    expect(core.state.global.get('seeded')).toEqual({ a: 1 });
    const update = core.state.global.update('written', ['x']);
    expect(core.state.global.get('written')).toEqual(['x']);
    await update;
    expect(state.global.get('written')).toEqual(['x']);
    await core.state.workspace.update('written', 'w');
    expect(state.workspace.get('written')).toBe('w');
    await core.state.global.update('written', undefined);
    expect(state.global.get('written')).toBeUndefined();
    expect(core.state.global.get('written', 'default')).toBe('default');
  });

  it('a write main makes reaches core', async () => {
    const { core, state } = connect();
    await state.workspace.update('fromMain', 7);
    expect(core.state.workspace.get('fromMain')).toBe(7);
  });

  it('core\'s own value stands while its write is in flight', async () => {
    const { core, state } = connect();
    const mainWrite = state.global.update('raced', 'main');
    const coreWrite = core.state.global.update('raced', 'core');
    await mainWrite;
    expect(core.state.global.get('raced')).toBe('core');
    await coreWrite;
    expect(core.state.global.get('raced')).toBe('core');
    expect(state.global.get('raced')).toBe('core');
  });

  it('workspace folders follow main', () => {
    const { main, core } = connect();
    expect(core.workspaceFolders.folders()).toEqual(main.workspaceFolders.folders());
    const changed = vi.fn();
    core.workspaceFolders.onDidChange(changed);
    const next = [{ fsPath: path.resolve('/projects/c'), name: 'c' }];
    main.workspaceFolders.setFolders(next);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(core.workspaceFolders.folders()).toEqual(next);
  });

  it('the terminal pane\'s state follows main', () => {
    const { core, setTerminal } = connect();
    expect(core.window.terminalToggle()).toEqual({ shown: false, shortcut: 'Ctrl+`' });
    setTerminal(true);
    expect(core.window.terminalToggle()).toEqual({ shown: true, shortcut: 'Ctrl+`' });
  });

  it('the active editor context follows main', () => {
    const { main, core } = connect();
    expect(core.editor.getActiveContext()).toBeUndefined();
    const changed = vi.fn();
    core.editor.onDidChangeActiveContext(changed);
    const context = { filePath: path.resolve('/projects/a/x.ts'), selection: { startLine: 2, endLine: 3, text: 'two\nthree' } };
    main.editor.setActiveContext(context);
    expect(core.editor.getActiveContext()).toEqual(context);
    expect(changed).toHaveBeenCalledWith(context);
  });
});

describe('proxied services', () => {
  it('secrets', async () => {
    const { main, core } = connect();
    expect(core.secrets.isPersistent).toBe(main.secrets.isPersistent);
    const changed = vi.fn();
    core.secrets.onDidChange(changed);
    expect(await core.secrets.get('stored')).toBe('one');
    expect(await core.secrets.get('missing')).toBeUndefined();
    await core.secrets.store('added', 'two');
    expect(main.secrets.entries.get('added')).toBe('two');
    expect(changed).toHaveBeenCalledWith('added');
    expect(await core.secrets.keys()).toEqual(['stored', 'added']);
    await core.secrets.delete('stored');
    expect(main.secrets.entries.has('stored')).toBe(false);
  });

  it('notifications, with and without options', async () => {
    const { main, core } = connect();
    main.notifications.answerWith((call) => call.actions[1]);
    expect(await core.notifications.warn('careful', 'One', 'Two')).toBe('Two');
    expect(await core.notifications.error('broken', { modal: true }, 'Retry')).toBeUndefined();
    await core.notifications.info('plain');
    expect(main.notifications.calls).toEqual([
      { level: 'warn', message: 'careful', actions: ['One', 'Two'] },
      { level: 'error', message: 'broken', options: { modal: true, signal: expect.any(AbortSignal) }, actions: ['Retry'] },
      { level: 'info', message: 'plain', actions: [] },
    ]);
  });

  it('withdraws every question core asked once core is gone', async () => {
    const signals: Record<string, AbortSignal> = {};
    const asked = (name: string) => (_request: unknown, signal: AbortSignal): Promise<never> => {
      signals[name] = signal;
      return new Promise<never>(() => undefined);
    };
    const { main, core, coreEnded } = connect({
      ui: {
        ask: asked('ask'),
        worktrees: { ...hostExtras().ui.worktrees, reviewSetup: asked('reviewSetup'), confirmHandOff: asked('confirmHandOff'), showRefusal: asked('showRefusal') },
      },
    });
    let modalSignal: AbortSignal | undefined;
    main.notifications.answerWith((call) => {
      modalSignal = call.options?.signal;
      return new Promise<undefined>(() => undefined) as unknown as undefined;
    });
    const requests = Promise.allSettled([
      core.endpoint.request('dialogs.ask', { severity: 'info', message: 'Keep?', actions: ['Keep'] }),
      core.endpoint.request('worktrees.reviewSetup', { projectPath: path.resolve('/p'), projectName: 'p', commands: ['npm ci'] }),
      core.endpoint.request('worktrees.confirmHandOff', { direction: 'toWorktree', files: [] }),
      core.endpoint.request('worktrees.showRefusal', { kind: 'apply', files: [] }),
      core.notifications.warn('Reload?', { modal: true }, 'Reload'),
    ]);
    const all = [...Object.values(signals), modalSignal];
    expect(all).toHaveLength(5);
    expect(all.every((signal) => signal?.aborted === false)).toBe(true);
    coreEnded();
    expect(all.every((signal) => signal?.aborted === true)).toBe(true);
    void requests;
  });

  it('pickers are main\'s; text input and quick picks render in a chat, which core asks', async () => {
    const { main, core } = connect();
    const folder = path.resolve('/picked');
    main.dialogs.answerPickFolder(() => folder);
    main.dialogs.answerPickFile(() => path.join(folder, 'f.md'));
    expect(await core.dialogs.pickFolder({ title: 'Folder', buttonLabel: 'Open' })).toBe(folder);
    expect(await core.dialogs.pickFile({ filters: { Markdown: ['md'] } })).toBe(path.join(folder, 'f.md'));
    expect(main.dialogs.pickFileCalls).toEqual([{ filters: { Markdown: ['md'] } }]);
    await expect(core.dialogs.inputBox({ prompt: 'Key' })).rejects.toThrow('core services were not running');
    const signal = new AbortController().signal;
    const inputBox = vi.fn(async () => 'typed');
    const quickPick = vi.fn(async () => 'b');
    core.setChatPrompts({ inputBox, quickPick });
    expect(await core.dialogs.inputBox({ prompt: 'Key', password: true }, signal)).toBe('typed');
    expect(inputBox).toHaveBeenCalledWith({ prompt: 'Key', password: true }, signal);
    expect(await core.dialogs.quickPick([{ id: 'b', label: 'B' }], { title: 'Pick' })).toBe('b');
    expect(main.dialogs.inputBoxCalls).toEqual([]);
  });

  it('clipboard and shell', async () => {
    const { main, core } = connect();
    await core.clipboard.writeText('copied');
    expect(main.clipboard.writes).toEqual(['copied']);
    expect(await core.shell.openExternal('https://example.com/')).toBe(true);
    expect(await core.shell.openFolder(path.resolve('/projects/a'))).toBe(true);
    await core.shell.revealPath(path.resolve('/projects/a/x.ts'));
    expect(main.shell.openedExternal).toEqual(['https://example.com/']);
    expect(main.shell.openedFolders).toEqual([path.resolve('/projects/a')]);
    expect(main.shell.revealedPaths).toEqual([path.resolve('/projects/a/x.ts')]);
  });

  it('editor', async () => {
    const { main, core } = connect();
    const file = path.join(dirs[0]!, 'read.txt');
    fs.writeFileSync(file, 'disk text');
    await core.editor.openFile(file, { line: 3, preserveFocus: true, panelId: 'p1' });
    await core.editor.openUntitled('content', 'markdown', { panelId: 'p1' });
    expect(await core.editor.readText(file)).toBe('disk text');
    await core.editor.showMarkdownPreview(file, { panelId: 'p1' });
    await core.editor.openHostSettings('damocles.x', 'chat');
    await core.editor.openSettingsFile('user', { key: 'damocles.x' });
    await core.editor.showChatReview('p1', 'turn');
    await core.editor.searchHostExtensions('speech').catch(() => undefined);
    expect(main.editor.openedFiles).toEqual([{ path: file, options: { line: 3, preserveFocus: true, panelId: 'p1' } }]);
    expect(main.editor.untitled).toEqual([{ content: 'content', language: 'markdown', options: { panelId: 'p1' } }]);
    expect(main.editor.markdownPreviews).toEqual([{ path: file, options: { panelId: 'p1' } }]);
    expect(main.editor.settingsQueries).toEqual(['damocles.x']);
    expect(main.editor.settingsFiles).toEqual([{ scope: 'user', key: 'damocles.x' }]);
    expect(main.editor.chatReviews).toEqual([{ panelId: 'p1', scope: 'turn' }]);
    expect(core.editor.isHostExtensionActive('ms-vscode.vscode-speech')).toBe(false);
  });

  it('a diff\'s title follows its file\'s name on main, and closing it reaches main', async () => {
    const { main, core } = connect();
    const view = await core.editor.showDiff({
      title: (name) => `${name} (Current ↔ Proposed)`,
      filePath: path.resolve('/projects/a/old.ts'),
      left: { path: path.resolve('/projects/a/old.ts') },
      right: { name: 'old.ts', content: 'proposed' },
      purpose: 'proposal',
      approvalId: 'tool-1',
    });
    const opened = main.editor.diffs[0]!;
    expect(opened.request.title('renamed.ts')).toBe('renamed.ts (Current ↔ Proposed)');
    expect(opened.request.right).toEqual({ name: 'old.ts', content: 'proposed' });
    expect(opened.request.approvalId).toBe('tool-1');
    await view.close();
    expect(opened.closeCalls).toBe(1);
  });

  it('forgets a diff whose tab the user closed, so a checkpoint diff core never closes holds nothing in main', async () => {
    const { main, core } = connect();
    const view = await core.editor.showDiff({
      title: (name) => `${name} (At checkpoint ↔ Current)`,
      filePath: path.resolve('/projects/a/a.ts'),
      left: { name: 'a.ts', content: 'before' },
      right: { path: path.resolve('/projects/a/a.ts') },
      purpose: 'checkpoint',
    });
    const opened = main.editor.diffs[0]!;
    opened.closedByUser();
    await new Promise((resolve) => setImmediate(resolve));
    // Main no longer holds the view, so a close core sends after the tab went reaches nothing.
    await view.close();
    expect(opened.closeCalls).toBe(0);
  });

  it('refuses a create for a panel id it already relays: no second view, and core is told that id is gone', async () => {
    const { main, core, coreTransport } = connect();
    const chat = core.window.createPanel(CHAT);
    let disposed = false;
    chat.onDispose(() => {
      disposed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const first = main.window.panels[0] as FakeRelayView;
    coreTransport.post({ kind: 'panel', panelId: first.panelId, op: 'create', payload: CHAT });
    await new Promise((resolve) => setImmediate(resolve));
    expect(main.window.panels).toHaveLength(1);
    expect(disposed).toBe(true);
  });

  it('lifecycle and proxy resolution', async () => {
    const { main, core } = connect();
    await core.lifecycle.reload();
    expect(main.lifecycle.reloads).toBe(1);
    expect(await core.resolveProxy('https://api.example.com/')).toBe('PROXY proxy.example:8080 for https://api.example.com/');
  });

  it('window events', () => {
    const { main, core } = connect();
    expect(core.window.chatBrowserPane).toBe(true);
    core.window.openAppSettings('voice', undefined);
    core.window.toggleTerminal();
    expect(main.window.appSettingsOpened).toEqual(['voice']);
    expect(main.window.terminalToggles()).toBe(1);
  });
});

describe('panels', () => {
  it('a panel core creates is a proxy main makes a view for, named by one id on both sides', () => {
    const { main, core, setTheme, relayed } = connect();
    const panel = core.window.createPanel(CHAT);
    const view = main.window.panels[0] as FakeRelayView;
    expect(view.options).toEqual(CHAT);
    expect(core.panels.idOf(panel)).toBe(view.panelId);
    expect(core.panels.get(view.panelId)).toBe(panel);
    expect(panel.workerSrc).toBe('app://damocles/webview/assets/');
    expect(panel.cspSource).toBe('app://damocles');
    expect(panel.themeCssSource()).toBe('initial-css');
    setTheme('next-css');
    expect(panel.themeCssSource()).toBe('next-css');

    panel.setHtml('<html></html>');
    void panel.postMessage({ type: 'ping', nothing: undefined });
    panel.setTitle('Renamed');
    panel.setIcon(path.resolve('/icon.png'));
    panel.setFolderLabel('a');
    panel.reveal(2);
    expect(view.html).toBe('<html></html>');
    expect(relayed).toEqual([{ viewId: view.panelId, type: 'ping', json: '{"type":"ping"}' }]);
    expect(view.posted).toEqual([{ type: 'ping' }]);
    expect(view.title).toBe('Renamed');
    expect(view.icon).toBe(path.resolve('/icon.png'));
    expect(view.folderLabel).toBe('a');
    expect(view.reveals).toEqual([2]);

    const received = vi.fn();
    panel.onMessage(received);
    view.fireMessage({ type: 'ready' });
    expect(received).toHaveBeenCalledWith({ type: 'ready' });

    const viewState = vi.fn();
    panel.onDidChangeViewState(viewState);
    expect(panel.visible).toBe(true);
    view.setVisible(false);
    expect(viewState).toHaveBeenCalledTimes(1);
    expect(panel.visible).toBe(false);
  });

  it('a chat view main created is attached by its id once main relays it, view state included', () => {
    const { main, core, host } = connect();
    const view = relayView(main.window.createPanel(CHAT) as FakePanelHost, 'main-view', []);
    let panel!: ReturnType<typeof core.panels.attach>;
    void host.adopt(view, async () => {
      panel = core.panels.attach('main-view');
      panel.setHtml('<html>at once</html>');
    });
    expect(view.html).toBe('<html>at once</html>');
    expect(core.panels.idOf(panel)).toBe('main-view');
    expect(panel.visible).toBe(true);
    const received = vi.fn();
    panel.onMessage(received);
    view.fireMessage({ type: 'ready' });
    expect(received).toHaveBeenCalledWith({ type: 'ready' });
    expect(core.panels.attach('main-view')).toBe(panel);
    view.close();
    expect(core.panels.get('main-view')).toBeUndefined();
  });

  it('closing on either side disposes both', () => {
    const { main, core } = connect();
    const fromCore = core.window.createPanel(CHAT);
    const coreDisposed = vi.fn();
    fromCore.onDispose(coreDisposed);
    fromCore.close();
    expect(main.window.panels[0]!.disposed).toBe(true);
    expect(coreDisposed).toHaveBeenCalledTimes(1);

    const fromMain = core.window.createPanel(CHAT);
    const mainDisposed = vi.fn();
    fromMain.onDispose(mainDisposed);
    main.window.panels[1]!.close();
    expect(mainDisposed).toHaveBeenCalledTimes(1);
    expect(fromMain.visible).toBe(false);
    expect(core.panels.get(core.panels.idOf(fromMain)!)).toBeUndefined();
  });

  it('a browser page names its chat, core-created or main-created, as owner', () => {
    const { main, core, host } = connect();
    const chat = core.window.createPanel(CHAT);
    core.window.createPanel({ kind: 'browser', title: 'page', localResourceRoots: [], owner: chat });
    expect(main.window.panels[1]!.options.owner).toBe(main.window.panels[0]);

    const mainChat = relayView(main.window.createPanel(CHAT) as FakePanelHost, 'main-chat', []);
    let attached!: ReturnType<typeof core.panels.attach>;
    void host.adopt(mainChat, async () => {
      attached = core.panels.attach('main-chat');
    });
    core.window.createPanel({ kind: 'browser', title: 'page', localResourceRoots: [], owner: attached });
    expect(main.window.panels[3]!.options.owner).toBe(mainChat);
  });

  it('a view main cannot create disposes the panel core holds, as main answers on a later turn across processes', () => {
    const { main, core } = connect();
    vi.spyOn(main.window, 'createPanel').mockImplementation(() => {
      throw new Error('The chats are closing');
    });
    const panel = core.window.createPanel(CHAT);
    expect(core.panels.idOf(panel)).toBeDefined();
    expect(core.panels.get(core.panels.idOf(panel)!)).toBeUndefined();
    expect(panel.visible).toBe(false);
  });

  it('a browser page\'s frame crosses as binary, never as JSON text', () => {
    const { main, core, relayed } = connect();
    const chat = core.window.createPanel(CHAT);
    const page = core.window.createPanel({ kind: 'browser', title: 'page', localResourceRoots: [], owner: chat });
    void page.postMessage({ type: 'frame', frameId: 1, width: 2, height: 1, bytes: new Uint8Array([1, 2, 3]).buffer });
    const posted = main.window.panels[1]!.posted[0] as { bytes: ArrayBuffer };
    expect([...new Uint8Array(posted.bytes)]).toEqual([1, 2, 3]);
    expect(relayed).toEqual([]);
  });

  it('a panel in its own column is a new chat, named by the id core issued', async () => {
    const { main, core } = connect();
    const panel = await core.window.createPanelInOwnColumn({ kind: 'chat', title: 'Damocles', localResourceRoots: [] });
    expect(core.panels.idOf(panel)).toBe((main.window.panels[0] as FakeRelayView).panelId);
  });
});

describe('a value that cannot cross the process boundary', () => {
  const notCloneable = (): string => 'a function';

  it('fails an RPC', async () => {
    const { core } = connect();
    await expect(core.secrets.store('k', notCloneable as unknown as string)).rejects.toThrow(/could not be cloned/);
    await expect(core.state.global.update('k', { callback: notCloneable })).rejects.toThrow(/could not be cloned/);
  });

  it('leaves core\'s state as main holds it when the write fails', async () => {
    const { core, state } = connect({ globalState: { kept: 'saved' } });
    const changed = vi.fn();
    core.state.onDidChange('global', 'kept', changed);
    await expect(core.state.global.update('kept', { callback: notCloneable })).rejects.toThrow(/could not be cloned/);
    expect(core.state.global.get('kept')).toBe('saved');
    expect(state.global.get('kept')).toBe('saved');
    expect(changed).toHaveBeenCalledTimes(2);
    await expect(core.state.global.update('fresh', notCloneable)).rejects.toThrow(/could not be cloned/);
    expect(core.state.global.get('fresh')).toBeUndefined();
  });

  it('takes the value main published meanwhile when core\'s write fails', async () => {
    const { core, state } = connect();
    let failWrite!: (err: Error) => void;
    const request = vi.spyOn(core.endpoint, 'request').mockImplementationOnce(() => new Promise((_resolve, reject) => (failWrite = reject)));
    const coreWrite = core.state.global.update('raced', 'core');
    await state.global.update('raced', 'main');
    expect(core.state.global.get('raced')).toBe('core');
    failWrite(new Error('disk full'));
    await expect(coreWrite).rejects.toThrow('disk full');
    expect(core.state.global.get('raced')).toBe('main');
    request.mockRestore();
  });

  it('leaves a panel message to JSON, as a webview\'s postMessage does', () => {
    const { main, core } = connect();
    const panel = core.window.createPanel(CHAT);
    void panel.postMessage({ type: 'x', run: notCloneable });
    expect(main.window.panels[0]!.posted).toEqual([{ type: 'x' }]);
  });
});
