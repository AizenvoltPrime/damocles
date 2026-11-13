import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RemoteState, type RemoteTerminalRecord } from '../remote/remote-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_HOST_ENV_CHARS, MAX_HOST_ENV_ENTRIES, parseHostRequest, TERMINAL_BATCH_CHARS, TERMINAL_BATCH_MS, type HostMessage, type HostRequest } from '../../pty-host/protocol';
import { CONPTY_SPACING_MS, CONPTY_THROTTLE_MS, createPtySessions, EXIT_FLUSH_MS, PROCESS_NAME_THROTTLE_MS, type Pty, type PtySpawnOptions } from '../../pty-host/sessions';
import {
  MAX_TERMINAL_GROUP_PANES,
  MAX_TERMINAL_INPUT_CHARS,
  MAX_TERMINAL_NAME_LENGTH,
  MIN_TERMINAL_PANE_FRACTION,
  TERMINAL_HIGH_WATERMARK_CHARS,
  TERMINAL_LIST_MAX_REM,
  TERMINAL_LOW_WATERMARK_CHARS,
  type TerminalData,
  type TerminalScreen,
  type TerminalState,
} from '../../preload/terminal-channels';
import type { OverlayAnswer } from '../../preload/overlay-channels';
import { pickNewTerminal, TerminalPickSession } from '../terminal-pick';
import type { TerminalProfile } from '../../workspace/terminal/profiles';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { PtyHostExit, PtyHostProcess } from '../../workspace/host-starters';
import { createTerminalBackend, type LiveTerminal, type TerminalBackend } from '../../workspace/terminal/terminal-backend';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import type { Endpoint } from '../../core-protocol/endpoint';
import type { ClientToWorkspace, WorkspaceToClient } from '../../workspace/messages';
import { createRemoteWorkspace } from '../workspace/remote-workspace';
import { NotConnectedError } from '../workspace/workspaces';
import { createPtyScreen } from '../../pty-host/screen';
import { testWorkspaces } from './test-workspaces';
import { detectedProfile, type LaunchProfile } from '../terminal/user-profiles';
import {
  DEFAULT_PERSISTED_TERMINALS,
  isTerminalColor,
  isTerminalCustomIcon,
  parseTerminalName,
  TerminalService,
  type PersistedPane,
  type PersistedTerminals,
  type TerminalProject,
  type KillListEntry,
  type TerminalServiceSettings,
} from '../terminal/terminal-service';

const SCRIPTS_DIR = 'C:\\Program Files\\Damocles\\resources\\app.asar.unpacked\\resources\\shell-integration';

class FakePty implements Pty {
  static next = 100;
  pid = FakePty.next++;
  process: string | undefined = undefined;
  readonly written: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  paused = false;
  killed = false;
  // node-pty's Windows pty: a kill before the first output runs on that output, after the data listener
  deferKill = false;
  private killPending = false;
  private outputSeen = false;
  resizeError: Error | undefined;
  private dataListener: (data: string) => void = () => undefined;
  private exitListener: (event: { exitCode: number }) => void = () => undefined;
  readonly file: string;
  readonly args: readonly string[];
  readonly options: PtySpawnOptions;
  constructor(file: string, args: readonly string[], options: PtySpawnOptions) {
    this.file = file;
    this.args = args;
    this.options = options;
  }
  onData(listener: (data: string) => void): void { this.dataListener = listener; }
  onExit(listener: (event: { exitCode: number }) => void): void { this.exitListener = listener; }
  write(data: string): void { this.written.push(data); }
  resize(cols: number, rows: number): void {
    if (this.resizeError) throw this.resizeError;
    this.sizes.push([cols, rows]);
  }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  kill(): void {
    if (this.deferKill && !this.outputSeen) this.killPending = true;
    else this.killed = true;
  }
  emit(data: string): void {
    this.dataListener(data);
    if (this.outputSeen) return;
    this.outputSeen = true;
    if (this.killPending) this.killed = true;
  }
  exit(exitCode: number): void { this.exitListener({ exitCode }); }
}

const PWSH: TerminalProfile = { id: 'pwsh', name: 'PowerShell', file: 'C:\\pwsh\\pwsh.exe', args: [], icon: 'powershell' };
const BASH: TerminalProfile = { id: 'git-bash', name: 'Git Bash', file: 'C:\\Git\\bin\\bash.exe', args: ['--login', '-i'], icon: 'git-bash' };
const ALPHA: TerminalProject = { key: 'c:\\work\\alpha', name: 'alpha', fsPath: 'C:\\work\\alpha' };
const BETA: TerminalProject = { key: 'c:\\work\\beta', name: 'beta', fsPath: 'C:\\work\\beta' };
const SETTINGS: TerminalServiceSettings = {
  defaultProfile: '',
  multiLinePasteWarning: 'auto',
  fontSize: 13,
  scrollback: 1000,
  cursorStyle: 'block',
  fontFamily: 'Cascadia Code',
  lineHeight: 1.2,
  cursorBlinking: false,
  macOptionIsMeta: false,
  decorationsEnabled: true,
  shellIntegration: false,
  confirmOnKill: 'running',
};
const stored = (profileId: string, projectKey: string | null): Extract<PersistedPane, { kind: 'local' }> => ({ kind: 'local', profileId, projectKey, name: null, customIcon: null, color: null });
const panesOf = (layout: PersistedTerminals): PersistedPane[] => layout.groups.flatMap((group) => [...group.panes]);
// a layout of unsplit terminals, each its own group
const singles = (panes: readonly PersistedPane[], active: number | null, listWidthRem = 12): PersistedTerminals => ({
  version: 2,
  listWidthRem,
  groups: panes.map((pane) => ({ panes: [pane], activePane: 0, sizes: [1] })),
  active,
  editor: [],
});

interface Harness {
  readonly service: TerminalService;
  // the workspace's terminal backend every terminal of the harness runs on
  readonly backend: TerminalBackend;
  readonly ptys: FakePty[];
  readonly states: TerminalState[];
  readonly data: TerminalData[];
  readonly screens: TerminalScreen[];
  readonly focused: string[];
  readonly persisted: PersistedTerminals[];
  // calls of onDidChange, editorTabsChanged and showPanel, and the terminals showEditorTab named
  changes: number;
  editorTabs: number;
  panelShown: number;
  readonly shownTabs: string[];
  // each list of remote terminals main gave remote-state.json
  readonly remote: RemoteTerminalRecord[][];
  // each [authority, id] main asked remote-state.json to kill at the next reattach
  readonly kills: Array<[string, string]>;
  readonly hosts: { count: number; killed: number };
  readonly posted: unknown[];
  readonly asked: KillListEntry[][];
  readonly copied: string[];
  answer: boolean;
  settings: Partial<TerminalServiceSettings>;
  profiles: Array<TerminalProfile | LaunchProfile>;
  // the shells of the loopback host, which its terminals start with
  hostProfiles: TerminalProfile[];
  profilesReady: boolean;
  // folders that exist, for a split's inherited working directory
  readonly directories: Set<string>;
  projects: TerminalProject[];
  current: string | undefined;
  // the sidebar's host group order; hosts it lacks follow in the order given
  groupOrder: string[];
  // remote authorities that are connected
  connected: Set<string>;
  // each remote host record's default profile id, by authority key
  hostDefaults: Record<string, string>;
  readonly logs: string[];
  // the environment main reads at each spawn
  env: Record<string, string>;
  // Chromium's accessibility support, which each published state reads
  screenReader: boolean;
  // variables a root's terminals add, by root key
  rootEnv: Record<string, Record<string, string>>;
  // the git credential takeover's variables a local spawn gets; undefined registers nothing
  credentialEnv: Record<string, string> | undefined;
  // set: the takeover's registration rejects with it
  credentialError: Error | undefined;
  // each takeover registration: its root key, the GIT_CONFIG_PARAMETERS it inherited, and whether it was released
  readonly registrations: { projectKey: string | null; inherited: string | undefined; disposed: boolean }[];
  crashHost(exit?: PtyHostExit): void;
  hostSend(message: unknown): void;
}

// remote: the loopback host's workspace while it is connected; it throws while it is not
function harness(options: { saved?: PersistedTerminals; throttleConpty?: boolean; defaultProfile?: string; platform?: NodeJS.Platform; readProcessName?: boolean; remote?: () => ProjectWorkspace } = {}): Harness {
  const ptys: FakePty[] = [];
  const posted: unknown[] = [];
  let exitHost: (exit: PtyHostExit) => void = () => undefined;
  let hostSend: (message: unknown) => void = () => undefined;
  const h: Harness = {
    service: undefined as unknown as TerminalService,
    backend: undefined as unknown as TerminalBackend,
    ptys,
    states: [],
    data: [],
    screens: [],
    focused: [],
    persisted: [],
    changes: 0,
    editorTabs: 0,
    panelShown: 0,
    shownTabs: [],
    remote: [],
    kills: [],
    hosts: { count: 0, killed: 0 },
    posted,
    asked: [],
    copied: [],
    answer: true,
    settings: {},
    profiles: [PWSH, BASH],
    hostProfiles: [PWSH, BASH],
    profilesReady: true,
    directories: new Set([ALPHA.fsPath, BETA.fsPath]),
    projects: [ALPHA, BETA],
    current: ALPHA.key,
    groupOrder: [],
    connected: new Set(['loopback']),
    hostDefaults: {},
    logs: [],
    env: { PATH: 'C:\\bin', TERM_TEST: '1' },
    screenReader: false,
    rootEnv: {},
    credentialEnv: undefined,
    credentialError: undefined,
    registrations: [],
    crashHost: (exit) => exitHost(exit ?? { code: 1, reason: null, error: null }),
    hostSend: (message) => hostSend(message),
  };
  // The host's own logic, in process: requests and messages pass the structured-clone copy and the parse each side does.
  const spawnHost = (): PtyHostProcess => {
    h.hosts.count++;
    let onMessage: (message: unknown) => void = () => undefined;
    let onExit: (exit: PtyHostExit) => void = () => undefined;
    let alive = true;
    const sessions = createPtySessions({
      spawn: (file, args, spawnOptions) => {
        const pty = new FakePty(file, args, spawnOptions);
        ptys.push(pty);
        return pty;
      },
      post: (message: HostMessage) => {
        if (alive) onMessage(structuredClone(message));
      },
      throttleConpty: options.throttleConpty ?? false,
      readProcessName: options.readProcessName ?? false,
      screen: createPtyScreen,
      log: (line) => h.logs.push(line),
    });
    const exit = (hostExit: PtyHostExit): void => {
      if (!alive) return;
      alive = false;
      onExit(hostExit);
    };
    exitHost = exit;
    hostSend = (message) => onMessage(message);
    return {
      postMessage: (message) => {
        posted.push(message);
        const request = parseHostRequest(structuredClone(message));
        if (!request) throw new Error('main sent a malformed request');
        void sessions.handle(request).then(() => {
          if (request.type === 'shutdown') exit({ code: 0, reason: null, error: null });
        });
      },
      onMessage: (listener) => { onMessage = listener; },
      onExit: (listener) => { onExit = listener; },
      kill: () => {
        h.hosts.killed++;
        exit({ code: 1, reason: null, error: null });
      },
    };
  };
  let saved = options.saved ?? DEFAULT_PERSISTED_TERMINALS;
  const backend = createTerminalBackend({
    starters: { startPtyHost: spawnHost },
    platform: options.platform ?? 'win32',
    scriptsDir: SCRIPTS_DIR,
    zshDotDir: 'C:\\Users\\me\\AppData\\Roaming\\Damocles\\shell-integration\\zsh',
    homedir: 'C:\\Users\\me',
    env: {},
    log: (line) => h.logs.push(line),
    copyFiles: (files) => h.copied.push(...files.map(({ dest }) => dest)),
  });
  const workspaces = testWorkspaces({ watchers: createFakePlatform().fileWatchers, terminals: backend });
  const local = { ...workspaces.local, files: { ...workspaces.local.files, isDirectory: (folder: string) => Promise.resolve(h.directories.has(folder)) } };
  const service = new TerminalService({
    workspaces: { ...workspaces, local, forProject: (key) => (options.remote && key?.startsWith('loopback|') ? options.remote() : local) },
    profiles: (key) => (key?.startsWith('loopback|') ? h.hostProfiles.map(detectedProfile) : h.profiles.map((profile) => ('source' in profile ? profile : detectedProfile(profile)))),
    profilesReady: () => h.profilesReady,
    projects: () => h.projects,
    pickerProjects: () => h.projects,
    groupOrder: (groups) => [...h.groupOrder.filter((group) => groups.includes(group)), ...groups.filter((group) => !h.groupOrder.includes(group))],
    hostOf: (authority) => (authority === 'loopback' ? { kind: 'loopback', name: 'Local daemon' } : { kind: 'ssh', name: authority.slice('ssh+'.length), color: 'danger' }),
    reachable: (key) => h.connected.has(key.slice(0, key.indexOf('|'))),
    hostDefaultProfile: (authority) => h.hostDefaults[authority],
    currentProjectKey: () => h.current,
    rootEnv: (key) => h.rootEnv[key] ?? {},
    settings: () => ({ ...SETTINGS, defaultProfile: options.defaultProfile ?? '', ...h.settings }),
    env: async () => h.env,
    gitCredentials: async (projectKey, inherited) => {
      if (h.credentialError) throw h.credentialError;
      if (!h.credentialEnv) return undefined;
      const registration = { projectKey, inherited, disposed: false };
      h.registrations.push(registration);
      return { env: h.credentialEnv, dispose: () => { registration.disposed = true; } };
    },
    osOf: () => 'linux',
    persistRemote: (terminals) => h.remote.push([...terminals]),
    killOnReattach: (authority, id) => h.kills.push([authority, id]),
    screenReader: () => h.screenReader,
    windowsBuild: (projectKey) => (projectKey?.startsWith('loopback|') ? null : 19045),
    // Split Terminal's key passes only for a panel target, the pane keys only for a split one
    passKeys: ({ split, editor }) => ['CmdOrCtrl+P', ...(editor ? [] : ['Ctrl+Shift+5']), ...(split ? ['Alt+Left', 'Alt+Right'] : [])],
    persisted: () => saved,
    persist: (terminals) => {
      saved = terminals;
      h.persisted.push(terminals);
    },
    onDidChange: () => { h.changes++; },
    editorTabsChanged: () => { h.editorTabs++; },
    showEditorTab: (id) => { h.shownTabs.push(id); },
    showPanel: () => { h.panelShown++; },
    spawnFailed: (message) => `The shell could not start: ${message}`,
    launchFailed: (failure) => `The shell could not start: ${JSON.stringify(failure)}`,
    log: (line) => h.logs.push(line),
    platform: options.platform ?? 'win32',
    homedir: 'C:\\Users\\me',
    confirmKill: (entries) => {
      h.asked.push([...entries]);
      return Promise.resolve(h.answer);
    },
    now: () => 1000,
    shutdownTimeoutMs: 1000,
  });
  service.attach({ state: (state) => h.states.push(state), data: (data) => h.data.push(data), screen: (screen) => h.screens.push(screen), focus: (id) => h.focused.push(id) });
  return Object.assign(h, { service, backend });
}

const settle = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const lastState = (h: Harness): TerminalState => h.states.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('create validation', () => {
  it('issues term-<n> ids and starts the profile in the project folder main resolved from the key', async () => {
    const h = harness();
    expect(h.service.create({ profileId: 'git-bash', target: { project: BETA.key } }, false)).toEqual({ ok: true, id: 'term-1' });
    expect(h.service.create({ profileId: null, target: { current: true } }, false)).toEqual({ ok: true, id: 'term-2' });
    await settle();
    expect(h.ptys.map((pty) => [pty.file, pty.args, pty.options.cwd])).toEqual([
      [BASH.file, ['--login', '-i'], BETA.fsPath],
      [PWSH.file, [], ALPHA.fsPath],
    ]);
    expect(h.ptys[0]!.options).toMatchObject({ name: 'xterm-256color', cols: 80, rows: 24, env: { PATH: 'C:\\bin', TERM_TEST: '1' } });
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status, terminal.projectName])).toEqual([['term-1', 'running', 'beta'], ['term-2', 'running', 'alpha']]);
    expect(h.hosts.count).toBe(1);
  });

  it('refuses a profile it did not detect and a project that is not open, and starts nothing', async () => {
    const h = harness();
    expect(h.service.create({ profileId: 'C:\\Windows\\System32\\cmd.exe', target: { project: ALPHA.key } }, false)).toEqual({ ok: false, reason: 'unknownProfile' });
    expect(h.service.create({ profileId: 'pwsh', target: { project: 'C:\\Windows' } }, false)).toEqual({ ok: false, reason: 'unknownProject' });
    expect(h.service.create({ profileId: 'pwsh', target: { project: ALPHA.fsPath } }, false)).toEqual({ ok: false, reason: 'unknownProject' });
    h.profiles = [];
    expect(h.service.create({ profileId: null, target: { current: true } }, false)).toEqual({ ok: false, reason: 'noProfile' });
    expect(h.service.canCreate()).toBe(false);
    await settle();
    expect(h.hosts.count).toBe(0);
    expect(h.ptys).toHaveLength(0);
  });

  it('starts a terminal in the home folder while no project is open, and saves it as a home folder terminal', async () => {
    const h = harness();
    h.projects = [];
    h.current = undefined;
    expect(h.service.canCreate()).toBe(true);
    expect(h.service.projectOptions()).toEqual([]);
    expect(h.service.ensureTerminal()).toBe('term-1');
    await settle();
    expect(h.ptys.map((pty) => pty.options.cwd)).toEqual(['C:\\Users\\me']);
    expect(lastState(h)).toMatchObject({ canCreate: true, terminals: [{ id: 'term-1', projectKey: null, projectName: '', status: 'running' }] });
    expect(panesOf(h.persisted.at(-1)!)).toEqual([stored('pwsh', null)]);
    expect(h.service.linkBase('term-1')).toBeUndefined();
    expect(h.service.authorityOf('term-1')).toBe('local');
    expect(h.service.authorityOf('term-9')).toBeUndefined();
  });

  it('keeps a home folder terminal in the home folder when a project opens, and starts the next terminal in the project', async () => {
    const h = harness();
    h.projects = [];
    h.current = undefined;
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.projects = [ALPHA];
    h.current = ALPHA.key;
    h.service.projectsChanged([ALPHA.key]);
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    await settle();
    expect(h.ptys.map((pty) => [pty.options.cwd, pty.killed])).toEqual([['C:\\Users\\me', false], [ALPHA.fsPath, false], ['C:\\Users\\me', false]]);
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.projectKey])).toEqual([['term-1', null], ['term-3', null], ['term-2', ALPHA.key]]);
    h.projects = [];
    h.current = undefined;
    h.service.projectsChanged([]);
    await settle();
    expect(h.ptys.map((pty) => pty.killed)).toEqual([false, true, false]);
  });

  it('starts a home folder pick in the home folder when a project opened while the pick was showing', async () => {
    const h = harness();
    h.projects = [];
    h.current = undefined;
    let answer!: (value: OverlayAnswer) => void;
    const overlay = { request: () => new Promise<OverlayAnswer>((resolve) => (answer = resolve)) };
    const picked = pickNewTerminal(overlay, new TerminalPickSession(h.service.projectOptions()), undefined);
    h.projects = [ALPHA];
    h.current = ALPHA.key;
    h.service.projectsChanged([ALPHA.key]);
    answer({ kind: 'newTerminal', projectKey: null, profileId: null });
    const pick = (await picked)!;
    expect(pick).toEqual({ profileId: null, target: { home: true } });
    expect(h.service.create(pick, true)).toEqual({ ok: true, id: 'term-1' });
    await settle();
    expect(h.ptys.map((pty) => pty.options.cwd)).toEqual(['C:\\Users\\me']);
    expect(lastState(h).terminals.map((terminal) => terminal.projectKey)).toEqual([null]);
  });

  it('restores a saved home folder terminal in the home folder while projects are open', async () => {
    const h = harness({ saved: singles([stored('pwsh', null), stored('git-bash', ALPHA.key)], 0) });
    h.service.restore([]);
    await settle();
    expect(h.ptys.map((pty) => [pty.file, pty.options.cwd])).toEqual([[PWSH.file, 'C:\\Users\\me'], [BASH.file, ALPHA.fsPath]]);
    expect(lastState(h).terminals.map((terminal) => terminal.projectKey)).toEqual([null, ALPHA.key]);
  });

  it('uses the default profile setting when it names a detected shell, else the first one', () => {
    const h = harness({ defaultProfile: 'git-bash' });
    h.service.create({ profileId: null, target: { current: true } }, false);
    expect(lastState(h).terminals[0]!.profileId).toBe('git-bash');
    expect(h.service.profileOptions().map((option) => [option.id, option.isDefault])).toEqual([['pwsh', false], ['git-bash', true]]);
    const other = harness({ defaultProfile: 'fish' });
    other.service.create({ profileId: null, target: { current: true } }, false);
    expect(lastState(other).terminals[0]!.profileId).toBe('pwsh');
  });

  it('lists the projects in the sidebar\'s order for the quick pick, the current one marked where it stands', () => {
    const h = harness();
    h.current = BETA.key;
    expect(h.service.projectOptions()).toEqual([
      { key: ALPHA.key, name: 'alpha', path: ALPHA.fsPath, current: false, authority: { kind: 'local' }, reachable: true },
      { key: BETA.key, name: 'beta', path: BETA.fsPath, current: true, authority: { kind: 'local' }, reachable: true },
    ]);
  });

  it('lists every host\'s projects grouped in the sidebar\'s host order, each marked reachable while its host is connected', () => {
    const h = harness();
    const prod: TerminalProject = { key: 'ssh+prod|/srv/api', name: 'api', fsPath: '/srv/api' };
    const daemon: TerminalProject = { key: 'loopback|/srv/app', name: 'app', fsPath: '/srv/app' };
    const web: TerminalProject = { key: 'ssh+prod|/srv/web', name: 'web', fsPath: '/srv/web' };
    h.projects = [prod, ALPHA, daemon, web, BETA];
    h.groupOrder = ['ssh+prod', 'local'];
    h.current = daemon.key;
    expect(h.service.projectOptions().map((option) => [option.name, option.authority, option.reachable, option.current])).toEqual([
      ['api', { kind: 'ssh', name: 'prod', color: 'danger' }, false, false],
      ['web', { kind: 'ssh', name: 'prod', color: 'danger' }, false, false],
      ['alpha', { kind: 'local' }, true, false],
      ['beta', { kind: 'local' }, true, false],
      ['app', { kind: 'loopback', name: 'Local daemon' }, true, true],
    ]);
    h.connected.add('ssh+prod');
    expect(h.service.projectOptions().filter((option) => option.reachable).map((option) => option.name)).toEqual(['api', 'web', 'alpha', 'beta', 'app']);
  });

  it('starts each host\'s own default shell: this computer\'s setting, a remote host\'s record, else the host\'s first shell', () => {
    const daemon: TerminalProject = { key: 'loopback|/srv/app', name: 'app', fsPath: '/srv/app' };
    const h = harness({ defaultProfile: 'git-bash' });
    h.projects = [ALPHA, daemon];
    h.hostProfiles = [PWSH, BASH];
    expect(h.service.profileOptions(daemon.key).map((option) => [option.id, option.isDefault])).toEqual([['pwsh', true], ['git-bash', false]]);
    h.hostDefaults = { loopback: 'git-bash' };
    expect(h.service.profileOptions(daemon.key).map((option) => [option.id, option.isDefault])).toEqual([['pwsh', false], ['git-bash', true]]);
    h.settings = { defaultProfile: 'pwsh' };
    expect(h.service.profileOptions(ALPHA.key).map((option) => [option.id, option.isDefault])).toEqual([['pwsh', true], ['git-bash', false]]);
    expect(h.service.profileOptions(daemon.key).find((option) => option.isDefault)?.id).toBe('git-bash');
    h.hostDefaults = { loopback: 'fish' };
    expect(h.service.profileOptions(daemon.key).find((option) => option.isDefault)?.id).toBe('pwsh');
  });

  it('focuses a terminal only when a user action in main created it', () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    expect(h.focused).toEqual([]);
    h.service.create({ profileId: null, target: { current: true } }, true);
    expect(h.focused).toEqual(['term-2']);
  });
});

describe('terminal platform state', () => {
  it('publishes Chromium\'s accessibility support as it changes', () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    expect(lastState(h)).toMatchObject({ screenReader: false });
    h.screenReader = true;
    h.service.publish();
    expect(lastState(h).screenReader).toBe(true);
  });

  it('gives each terminal the Windows build of the host its pty runs on, none for a host off Windows', () => {
    const h = harness();
    const remote: TerminalProject = { key: 'loopback|/srv/app', name: 'app', fsPath: '/srv/app' };
    h.projects = [ALPHA, remote];
    h.service.create({ profileId: null, target: { project: ALPHA.key } }, false);
    h.service.create({ profileId: null, target: { project: remote.key } }, false);
    expect(lastState(h).terminals.map((terminal) => [terminal.projectKey, terminal.windowsBuild])).toEqual([[ALPHA.key, 19045], [remote.key, null]]);
    // the paths a shell prints follow its host's rules: this Windows computer's, and the Linux target's
    expect(lastState(h).terminals.map((terminal) => terminal.pathFlavor)).toEqual(['win32', 'posix']);
  });
});

describe('output batching and flow control', () => {
  it('batches output every 5 ms and sends 64 KB batches at once, never splitting a surrogate pair', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    const pty = h.ptys[0]!;
    pty.emit('a');
    pty.emit('b');
    expect(h.data).toEqual([]);
    await settle(TERMINAL_BATCH_MS);
    expect(h.data).toEqual([{ id: 'term-1', data: 'ab' }]);
    h.data.length = 0;
    pty.emit(`${'x'.repeat(TERMINAL_BATCH_CHARS - 1)}😀tail`);
    expect(h.data.map((batch) => batch.data.length)).toEqual([TERMINAL_BATCH_CHARS - 1, 6]);
    expect(h.data.map((batch) => batch.data).join('')).toBe(`${'x'.repeat(TERMINAL_BATCH_CHARS - 1)}😀tail`);
  });

  it('pauses the pty above 100,000 unacknowledged characters and resumes it below 5,000 as the shell acknowledges', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    const pty = h.ptys[0]!;
    pty.emit('x'.repeat(TERMINAL_HIGH_WATERMARK_CHARS));
    expect(pty.paused).toBe(false);
    pty.emit('y');
    expect(pty.paused).toBe(true);
    h.service.ack('term-1', TERMINAL_HIGH_WATERMARK_CHARS + 1 - TERMINAL_LOW_WATERMARK_CHARS);
    await settle();
    expect(pty.paused).toBe(true);
    h.service.ack('term-1', 1);
    await settle();
    expect(pty.paused).toBe(false);
  });

  it('forgets unacknowledged output when the shell page loads again, which resumes a paused pty', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.ptys[0]!.emit('z'.repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
    expect(h.ptys[0]!.paused).toBe(true);
    h.service.shellLoaded();
    await settle();
    expect(h.ptys[0]!.paused).toBe(false);
    expect(lastState(h).terminals).toHaveLength(1);
  });

  it('forwards input and resizes to a live pty only, and starts a restarted pty at the last size', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.service.input('term-1', 'echo hi\r');
    h.service.resize('term-1', 120, 40);
    h.service.input('term-9', 'nope');
    await settle();
    expect(h.ptys[0]!.written).toEqual(['echo hi\r']);
    expect(h.ptys[0]!.sizes).toEqual([[120, 40]]);
    h.ptys[0]!.exit(0);
    await settle(EXIT_FLUSH_MS);
    h.service.input('term-1', 'late');
    h.service.restart('term-1');
    await settle();
    expect(h.ptys[1]!.options).toMatchObject({ cols: 120, rows: 40 });
    expect(h.ptys[0]!.written).toEqual(['echo hi\r']);
  });

  it('ignores a resize that races the pty\'s exit, and keeps serving the next requests', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.ptys[0]!.resizeError = new Error('Cannot resize a pty that has already exited');
    h.service.resize('term-1', 100, 30);
    h.service.input('term-1', 'still here');
    await settle();
    expect(h.ptys[0]!.written).toEqual(['still here']);
  });
});

describe('exit, kill and restart', () => {
  it('reports a Windows pty running only once its first output brings the pid', async () => {
    const h = harness();
    FakePty.next = 0;
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(lastState(h).terminals[0]!.status).toBe('starting');
    h.ptys[0]!.pid = 4242;
    h.ptys[0]!.emit('Microsoft Windows');
    expect(lastState(h).terminals[0]!.status).toBe('running');
    await settle(TERMINAL_BATCH_MS);
    expect(h.data).toEqual([{ id: 'term-1', data: 'Microsoft Windows' }]);
    FakePty.next = 100;
  });

  it('reports the exit code after the output that followed the exit, and restarts the terminal with its id', async () => {
    const h = harness();
    h.service.create({ profileId: 'git-bash', target: { project: BETA.key } }, false);
    await settle();
    h.ptys[0]!.exit(3);
    h.ptys[0]!.emit('bye');
    await settle(EXIT_FLUSH_MS);
    expect(h.data).toEqual([{ id: 'term-1', data: 'bye' }]);
    expect(lastState(h).terminals[0]).toMatchObject({ id: 'term-1', status: 'exited', exitCode: 3 });
    h.service.restart('term-1');
    expect(lastState(h).terminals[0]).toMatchObject({ id: 'term-1', status: 'starting', exitCode: null });
    await settle();
    expect(lastState(h).terminals[0]).toMatchObject({ id: 'term-1', status: 'running', profileId: 'git-bash', projectKey: BETA.key });
    expect(h.ptys[1]!.options.cwd).toBe(BETA.fsPath);
  });

  it('runs the worktree Setup as a task tab with the worktree env, shows its exit code, never saves it, and Restart asks its owner (rule 23)', async () => {
    const h = harness();
    const worktree: TerminalProject = { key: `${ALPHA.key}\u0000abcd1234`, name: 'alpha', fsPath: 'C:\\worktrees\\abcd1234' };
    h.projects = [ALPHA, BETA, worktree];
    h.rootEnv = { [worktree.key]: { DAMOCLES_PROJECT_FOLDER: ALPHA.fsPath, DAMOCLES_WORKTREE_INDEX: '1' } };
    const exits: Array<number | null> = [];
    let restarts = 0;
    let starts = 0;
    const task = { key: 'setup:abcd1234', name: 'Setup', file: PWSH.file, args: ['-NoLogo', '-EncodedCommand', 'AAAA'], projectKey: worktree.key, cwd: worktree.fsPath, env: { EXTRA: '1' }, onExit: (code: number | null) => exits.push(code), onRestart: () => restarts++, onCommandStart: () => starts++ };
    const id = h.service.runTask(task);
    await settle();
    expect([h.ptys[0]!.file, h.ptys[0]!.args, h.ptys[0]!.options.cwd]).toEqual([PWSH.file, ['-NoLogo', '-EncodedCommand', 'AAAA'], worktree.fsPath]);
    expect(h.ptys[0]!.options.env).toMatchObject({ PATH: 'C:\\bin', DAMOCLES_PROJECT_FOLDER: ALPHA.fsPath, DAMOCLES_WORKTREE_INDEX: '1', EXTRA: '1' });
    expect(lastState(h).terminals.find((terminal) => terminal.id === id)).toMatchObject({ title: 'Setup', icon: 'powershell', running: 'Setup' });
    // the task marks each command's start with the tab's nonce; a mark without it is a command's own output
    h.ptys[0]!.emit(`${osc(`C;${nonceOf(h, 0)}`)}${osc(`D;0;${nonceOf(h, 0)}`)}${osc('C;forged')}${osc(`C;${nonceOf(h, 0)}`)}`);
    await settle(TERMINAL_BATCH_MS);
    expect(starts).toBe(2);
    h.ptys[0]!.exit(2);
    await settle(EXIT_FLUSH_MS);
    expect(exits).toEqual([2]);
    expect(lastState(h).terminals.find((terminal) => terminal.id === id)).toMatchObject({ status: 'exited', exitCode: 2 });
    await h.service.restart(id);
    expect(restarts).toBe(1);
    expect(h.ptys).toHaveLength(1);
    // a second run of the same task stops the first tab's process and reruns in a fresh tab
    const again = h.service.runTask(task);
    await settle();
    expect(lastState(h).terminals.filter((terminal) => terminal.title === 'Setup').map((terminal) => terminal.id)).toEqual([again]);
    expect(panesOf(h.persisted.at(-1)!)).toEqual([]);
    // a terminal opened in the worktree gets the same two variables
    h.service.create({ profileId: 'pwsh', target: { project: worktree.key } }, false);
    await settle();
    expect(h.ptys.at(-1)!.options.env).toMatchObject({ DAMOCLES_PROJECT_FOLDER: ALPHA.fsPath, DAMOCLES_WORKTREE_INDEX: '1' });
    expect(h.ptys.at(-1)!.options.env).not.toHaveProperty('EXTRA');
  });

  it('makes a task tab it runs the command target, over the terminal typed in last', () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.inputFocused('term-1');
    const id = h.service.runTask({ key: 'setup', name: 'Setup', file: PWSH.file, args: [], projectKey: ALPHA.key, cwd: ALPHA.fsPath, env: {}, onExit: () => undefined, onRestart: () => undefined });
    expect(lastState(h).activeId).toBe(id);
    expect(h.service.commandTarget()).toBe(id);
    expect(h.service.target()).toEqual({ id, status: 'starting', placement: 'panel', task: true });
  });

  it('restarts only an exited terminal', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.service.restart('term-1');
    await settle();
    expect(h.ptys).toHaveLength(1);
  });

  it('kills the process when its terminal closes, and the next terminal becomes active', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.select('term-1');
    await settle();
    h.service.kill('term-1');
    await settle();
    expect(h.ptys[0]!.killed).toBe(true);
    expect(h.ptys[1]!.killed).toBe(false);
    expect(lastState(h)).toMatchObject({ activeId: 'term-2' });
    expect(lastState(h).terminals.map((terminal) => terminal.id)).toEqual(['term-2']);
    h.ptys[0]!.emit('after kill');
    await settle(TERMINAL_BATCH_MS);
    expect(h.data).toEqual([]);
  });

  it('kills the terminals of a removed project and drops them from the saved list', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { project: ALPHA.key } }, false);
    h.service.create({ profileId: null, target: { project: BETA.key } }, false);
    await settle();
    h.projects = [BETA];
    h.service.projectsChanged([BETA.key]);
    await settle();
    expect(h.ptys.map((pty) => pty.killed)).toEqual([true, false]);
    expect(lastState(h).terminals.map((terminal) => terminal.projectKey)).toEqual([BETA.key]);
    expect(h.persisted.at(-1)).toEqual(singles([stored('pwsh', BETA.key)], 0, DEFAULT_PERSISTED_TERMINALS.listWidthRem));
  });

  it('publishes the state again when the projects change, though no terminal was killed', () => {
    const h = harness();
    h.service.create({ profileId: null, target: { project: ALPHA.key } }, false);
    const published = h.states.length;
    h.projects = [{ ...ALPHA, name: 'alpha (renamed)' }, BETA];
    h.service.projectsChanged([ALPHA.key, BETA.key]);
    expect(h.states).toHaveLength(published + 1);
    expect(lastState(h).terminals[0]!.projectName).toBe('alpha (renamed)');
  });

  it('kills every terminal when the window closes and keeps the saved list for the next window', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: 'git-bash', target: { project: BETA.key } }, false);
    await settle();
    const saved = h.persisted.at(-1);
    h.service.closeWindow();
    await settle();
    expect(h.ptys.every((pty) => pty.killed)).toBe(true);
    expect(h.persisted.at(-1)).toBe(saved);
    expect(h.service.hasTerminals()).toBe(false);
  });

  it('marks every live terminal exited with no code when the host dies, and the next create starts a new host', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.ptys[1]!.exit(0);
    await settle(EXIT_FLUSH_MS);
    h.crashHost();
    expect(lastState(h).terminals.map((terminal) => [terminal.status, terminal.exitCode])).toEqual([['exited', null], ['exited', 0]]);
    h.service.restart('term-1');
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(h.hosts.count).toBe(2);
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status])).toEqual([['term-1', 'running'], ['term-2', 'exited'], ['term-3', 'running']]);
  });

  it('logs why the host ended: its exit code, the reason Electron gave and the last error it printed', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.crashHost({ code: 1, reason: 'killed', error: 'Error: the pty host received a malformed request\n    at handle (pty-host.js:12:9)' });
    expect(h.logs).toContain('[terminal] the pty host exited with code 1 (killed); last error: "Error: the pty host received a malformed request\\n    at handle (pty-host.js:12:9)"');
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.crashHost({ code: 3, reason: null, error: null });
    expect(h.logs).toContain('[terminal] the pty host exited with code 3');
  });

  it('stops a host that sends a message outside the contract', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.hostSend({ type: 'data', id: 'term-1', data: 'x'.repeat(TERMINAL_BATCH_CHARS + 1) });
    expect(h.hosts.killed).toBe(1);
    expect(lastState(h).terminals[0]).toMatchObject({ status: 'exited', exitCode: null });
  });

  it('shows why a shell could not start and marks its terminal exited', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.hostSend({ type: 'error', id: 'term-1', message: 'File not found' });
    expect(h.data).toEqual([{ id: 'term-1', data: 'The shell could not start: File not found\r\n' }]);
    expect(lastState(h).terminals[0]).toMatchObject({ status: 'exited', exitCode: null });
  });

  it('explains a Windows shell that ends with a CreateProcess error before any output, and no other exit', async () => {
    const h = harness();
    for (let index = 0; index < 4; index++) {
      FakePty.next = 0;
      h.service.create({ profileId: null, target: { current: true } }, false);
      await settle();
    }
    h.ptys[2]!.pid = 4242;
    h.ptys[2]!.emit('PowerShell 7');
    await settle(TERMINAL_BATCH_MS);
    h.ptys[0]!.exit(267);
    h.ptys[1]!.exit(193);
    h.ptys[2]!.exit(267);
    h.ptys[3]!.exit(1);
    await settle(EXIT_FLUSH_MS);
    FakePty.next = 100;
    expect(h.data).toEqual([
      { id: 'term-3', data: 'PowerShell 7' },
      { id: 'term-1', data: `The shell could not start: ${JSON.stringify({ reason: 'invalidDirectory', file: PWSH.file, cwd: ALPHA.fsPath })}\r\n` },
      { id: 'term-2', data: `The shell could not start: ${JSON.stringify({ reason: 'notAnExecutable', file: PWSH.file, cwd: ALPHA.fsPath })}\r\n` },
    ]);
    expect(lastState(h).terminals.map((terminal) => [terminal.status, terminal.exitCode])).toEqual([['exited', 267], ['exited', 193], ['exited', 267], ['exited', 1]]);
    const linux = harness({ platform: 'linux' });
    FakePty.next = 0;
    linux.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    linux.ptys[0]!.exit(267);
    await settle(EXIT_FLUSH_MS);
    FakePty.next = 100;
    expect(linux.data).toEqual([]);
  });

  it('starts a shell without the environment variables the host refuses, naming them in the log, and keeps the host', async () => {
    const h = harness();
    h.env = { PATH: 'C:\\bin', HUGE: 'x'.repeat(MAX_HOST_ENV_CHARS), 'A=B': '1', NUL: 'a\0b', '': 'empty', FITS: 'y'.repeat(MAX_HOST_ENV_CHARS - 4) };
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(h.ptys[0]!.options.env).toEqual({ PATH: 'C:\\bin', FITS: 'y'.repeat(MAX_HOST_ENV_CHARS - 4) });
    expect(lastState(h).terminals[0]!.status).toBe('running');
    expect(h.logs).toContain('[terminal] starting C:\\pwsh\\pwsh.exe without 4 environment variables the pty host refuses: "HUGE", "A=B", "NUL", ""');
    h.env = Object.fromEntries(Array.from({ length: MAX_HOST_ENV_ENTRIES + 2 }, (_, index) => [`V${index}`, '1']));
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(Object.keys(h.ptys[1]!.options.env)).toHaveLength(MAX_HOST_ENV_ENTRIES);
    expect(h.hosts).toEqual({ count: 1, killed: 0 });
  });

  it('gives each local shell process its own git credential registration, appended to the inherited GIT_CONFIG_PARAMETERS, released when the process exits or its tab closes', async () => {
    const h = harness();
    h.env = { PATH: 'C:\\bin', GIT_CONFIG_PARAMETERS: "'core.pager=less'" };
    h.credentialEnv = { GIT_CONFIG_PARAMETERS: "'core.pager=less' 'credential.https://gitlab.com.helper='", DAMOCLES_CREDENTIAL_NONCE: 'a'.repeat(64) };
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(h.registrations).toEqual([
      { projectKey: ALPHA.key, inherited: "'core.pager=less'", disposed: false },
      { projectKey: ALPHA.key, inherited: "'core.pager=less'", disposed: false },
    ]);
    expect(h.ptys[0]!.options.env).toMatchObject(h.credentialEnv);
    h.ptys[0]!.exit(0);
    await settle(EXIT_FLUSH_MS);
    expect(h.registrations.map((registration) => registration.disposed)).toEqual([true, false]);
    // a restart is a new process with a new registration
    await h.service.restart('term-1');
    await settle();
    expect(h.registrations.map((registration) => registration.disposed)).toEqual([true, false, false]);
    h.service.kill('term-2');
    await settle();
    expect(h.registrations.map((registration) => registration.disposed)).toEqual([true, true, false]);
    await h.service.dispose();
    expect(h.registrations.every((registration) => registration.disposed)).toBe(true);
  });

  it('releases a registration that lands after its tab closed', async () => {
    const h = harness();
    h.credentialEnv = { DAMOCLES_CREDENTIAL_NONCE: 'a'.repeat(64) };
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.kill('term-1');
    await settle();
    expect(h.registrations.map((registration) => registration.disposed)).toEqual([true]);
  });

  it('applies no takeover holding a variable the pty host refuses or an empty one, and releases its registration', async () => {
    const h = harness();
    h.credentialEnv = { GIT_CONFIG_PARAMETERS: '', DAMOCLES_CREDENTIAL_NONCE: 'a'.repeat(64) };
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(h.ptys[0]!.options.env).not.toHaveProperty('DAMOCLES_CREDENTIAL_NONCE');
    expect(h.registrations.map((registration) => registration.disposed)).toEqual([true]);
    expect(h.logs).toContain('[terminal] starting C:\\pwsh\\pwsh.exe without the git credential takeover: the pty host refuses GIT_CONFIG_PARAMETERS');
    expect(lastState(h).terminals[0]!.status).toBe('running');
  });

  it('starts the shell without the takeover when its registration fails', async () => {
    const h = harness();
    h.credentialError = new Error('the askpass server could not listen');
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(h.ptys).toHaveLength(1);
    expect(h.ptys[0]!.options.env).not.toHaveProperty('DAMOCLES_CREDENTIAL_NONCE');
    expect(h.logs).toContain('[terminal] starting C:\\pwsh\\pwsh.exe without the git credential takeover: the askpass server could not listen');
    expect(lastState(h).terminals[0]!.status).toBe('running');
  });

  it('appends to an inherited GIT_CONFIG_PARAMETERS of any case on Windows and leaves only the takeover\'s spelling', async () => {
    const h = harness();
    h.env = { PATH: 'C:\\bin', Git_Config_Parameters: "'core.pager=less'" };
    h.credentialEnv = { GIT_CONFIG_PARAMETERS: "'core.pager=less' 'credential.https://gitlab.com.helper='", DAMOCLES_CREDENTIAL_NONCE: 'a'.repeat(64) };
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(h.registrations.map((registration) => registration.inherited)).toEqual(["'core.pager=less'"]);
    const env = h.ptys[0]!.options.env;
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'GIT_CONFIG_PARAMETERS')).toEqual(['GIT_CONFIG_PARAMETERS']);
    expect(env['GIT_CONFIG_PARAMETERS']).toBe(h.credentialEnv['GIT_CONFIG_PARAMETERS']);
  });

  it('releases every registration when the window closes and when the pty host crashes', async () => {
    const h = harness();
    h.credentialEnv = { DAMOCLES_CREDENTIAL_NONCE: 'a'.repeat(64) };
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(h.registrations.map((registration) => registration.disposed)).toEqual([false, false]);
    h.service.closeWindow();
    expect(h.registrations.map((registration) => registration.disposed)).toEqual([true, true]);
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(h.registrations.map((registration) => registration.disposed)).toEqual([true, true, false, false]);
    h.crashHost();
    expect(h.registrations.every((registration) => registration.disposed)).toBe(true);
  });

  it('spaces conpty starts and kills 250 ms apart on Windows', async () => {
    const h = harness({ throttleConpty: true });
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(h.ptys).toHaveLength(1);
    await settle(CONPTY_THROTTLE_MS);
    expect(h.ptys).toHaveLength(1);
    await settle(CONPTY_SPACING_MS);
    expect(h.ptys).toHaveLength(2);
    h.service.kill('term-1');
    await settle();
    expect(h.ptys[0]!.killed).toBe(false);
    await settle(CONPTY_THROTTLE_MS + CONPTY_SPACING_MS);
    expect(h.ptys[0]!.killed).toBe(true);
  });

  it('serves input, resizes and acks of one terminal while another\'s conpty start or kill waits', async () => {
    const h = harness({ throttleConpty: true });
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.input('term-1', 'a');
    h.service.resize('term-1', 100, 30);
    await settle();
    expect(h.ptys).toHaveLength(1);
    expect(h.ptys[0]!.written).toEqual(['a']);
    expect(h.ptys[0]!.sizes).toEqual([[100, 30]]);
    h.ptys[0]!.emit('x'.repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
    expect(h.ptys[0]!.paused).toBe(true);
    h.service.ack('term-1', TERMINAL_HIGH_WATERMARK_CHARS);
    await settle();
    expect(h.ptys[0]!.paused).toBe(false);
    await settle(CONPTY_THROTTLE_MS + CONPTY_SPACING_MS);
    expect(h.ptys).toHaveLength(2);
    h.service.kill('term-2');
    h.service.input('term-1', 'b');
    await settle();
    expect(h.ptys[0]!.written).toEqual(['a', 'b']);
    expect(h.ptys[1]!.killed).toBe(false);
  });

  it('delivers input and a resize sent while a terminal\'s own start waits once it starts, in order, and a kill sent then finds its pty', async () => {
    const h = harness({ throttleConpty: true });
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.input('term-2', 'one');
    h.service.resize('term-2', 90, 20);
    h.service.input('term-2', 'two');
    h.service.kill('term-3');
    await settle(4 * (CONPTY_THROTTLE_MS + CONPTY_SPACING_MS));
    expect(h.ptys).toHaveLength(3);
    expect(h.ptys[1]!.written).toEqual(['one', 'two']);
    expect(h.ptys[1]!.sizes).toEqual([[90, 20]]);
    expect(h.ptys[2]!.killed).toBe(true);
  });

  it('kills every pty at once when the window closes, starts none whose start was waiting, and quits within the shutdown timeout', async () => {
    const h = harness({ throttleConpty: true });
    for (let index = 0; index < 5; index++) h.service.create({ profileId: null, target: { current: true } }, false);
    await settle(4 * (CONPTY_THROTTLE_MS + CONPTY_SPACING_MS));
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    expect(h.ptys).toHaveLength(5);
    h.service.closeWindow();
    await settle();
    expect(h.ptys.every((pty) => pty.killed)).toBe(true);
    const quit = h.service.dispose();
    await settle();
    await quit;
    await settle(CONPTY_THROTTLE_MS + CONPTY_SPACING_MS);
    expect(h.ptys).toHaveLength(5);
    expect(h.hosts.killed).toBe(0);
    expect(h.logs.filter((line) => line.includes('did not end'))).toEqual([]);
  });

  it('reads no foreground process for output in the exit flush window, so a restart in it keeps its own title', async () => {
    const h = harness({ platform: 'linux', readProcessName: true });
    const project: TerminalProject = { key: '/work/alpha', name: 'alpha', fsPath: '/work/alpha' };
    h.projects = [project];
    h.profiles = [{ id: 'bash', name: 'bash', file: '/usr/bin/bash', args: [], icon: 'bash' }];
    h.service.create({ profileId: 'bash', target: { project: project.key } }, false);
    await settle();
    const pty = h.ptys[0]!;
    pty.process = 'vim';
    pty.exit(0);
    await settle(EXIT_FLUSH_MS - 50);
    pty.emit('bye');
    await settle(50);
    expect(lastState(h).terminals[0]!.status).toBe('exited');
    h.service.restart('term-1');
    await settle(PROCESS_NAME_THROTTLE_MS);
    expect(lastState(h).terminals[0]).toMatchObject({ status: 'running', title: 'bash', running: null });
  });

  it('shuts the host down on quit, killing every pty, and kills a host that does not end in time', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    const quit = h.service.dispose();
    await settle();
    await quit;
    expect(h.ptys[0]!.killed).toBe(true);
    expect(h.posted.at(-1)).toEqual({ type: 'shutdown' });
    expect(h.hosts.killed).toBe(0);
  });

  it('ends the host on quit only once a Windows pty killed before its first output has run that kill', async () => {
    const h = harness();
    FakePty.next = 0;
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    FakePty.next = 100;
    const pty = h.ptys[0]!;
    pty.deferKill = true;
    h.service.closeWindow();
    let ended = false;
    const quit = h.service.dispose().then(() => {
      ended = true;
    });
    await settle();
    expect(h.posted.at(-1)).toEqual({ type: 'shutdown' });
    expect(pty.killed).toBe(false);
    expect(ended).toBe(false);
    pty.pid = 4242;
    pty.emit('Microsoft Windows');
    await settle();
    await quit;
    expect(pty.killed).toBe(true);
    expect(h.hosts.killed).toBe(0);
  });
});

describe('remote terminals', () => {
  const REMOTE: TerminalProject = { key: 'loopback|c:\\work\\remote', name: 'remote', fsPath: 'C:\\work\\remote' };

  it('keeps a remote terminal\'s record in remote-state.json, names it by id alone in the layout, and leaves it out of the quit question', async () => {
    const h = harness();
    h.projects = [ALPHA, REMOTE];
    h.credentialEnv = { DAMOCLES_CREDENTIAL_NONCE: 'a'.repeat(64) };
    h.service.create({ profileId: 'pwsh', target: { project: ALPHA.key } }, false);
    const remote = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    await settle();
    if (!remote.ok) throw new Error('no remote terminal');
    // a remote terminal's git uses its daemon's relay, so only the local one registers
    expect(h.registrations.map((registration) => registration.projectKey)).toEqual([ALPHA.key]);
    expect(remote.id).toMatch(/^term-[1-9]\d{14}$/);
    expect(h.persisted.at(-1)).toEqual(singles([stored('pwsh', ALPHA.key), { kind: 'remote', id: remote.id }], 1, DEFAULT_PERSISTED_TERMINALS.listWidthRem));
    expect(h.remote.at(-1)).toEqual([expect.objectContaining({ id: remote.id, projectKey: REMOTE.key, startCwd: REMOTE.fsPath, profile: expect.objectContaining({ id: 'pwsh' }) })]);
    const { nonce } = h.remote.at(-1)![0]!;
    expect(nonce).not.toBe('');
    // the shell-integration nonce stays host-scoped
    expect(JSON.stringify(h.persisted.at(-1))).not.toContain(nonce);
    expect(h.service.quitIds()).toEqual(['term-1']);
  });

  it('detaches from a remote host when the window closes and at quit, killing none of its terminals', async () => {
    const h = harness();
    h.projects = [REMOTE];
    h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    await settle();
    h.posted.length = 0;
    h.service.closeWindow();
    await settle();
    expect(h.posted).toEqual([]);
    expect(h.ptys.every((pty) => !pty.killed)).toBe(true);
    expect(h.hosts.killed).toBe(1);
  });

  it('reattaches the kept terminals the backend still lists, each with its screen, and drops the ones that ended', async () => {
    const h = harness();
    h.projects = [REMOTE];
    const created = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    await settle();
    if (!created.ok) throw new Error('no remote terminal');
    const kept = h.remote.at(-1)!;
    const gone = { ...kept[0]!, id: 'term-123456789012345' };
    const toDaemon: unknown[] = [];
    const backend: TerminalBackend = {
      ...h.backend,
      startHost: () => ({ postMessage: (message: unknown) => toDaemon.push(message), onMessage: () => undefined, onExit: () => undefined, kill: () => undefined }),
      list: async () => [{ id: created.id, pid: 1, cols: 90, rows: 20 }],
    };
    h.service.closeWindow();
    h.service.attach({ state: (state) => h.states.push(state), data: (data) => h.data.push(data), screen: (screen) => h.screens.push(screen), focus: (id) => h.focused.push(id) });
    await h.service.reattach(backend, 'loopback', [...kept, gone], []);
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status, terminal.restoring])).toEqual([[created.id, 'running', true]]);
    // the daemon's screen keeps enough scrollback for this client's view once it attached
    expect(toDaemon).toEqual([{ type: 'clearAck', id: created.id }, { type: 'serialize', id: created.id }, { type: 'scrollback', id: created.id, scrollback: SETTINGS.scrollback }]);
    expect(h.remote.at(-1)!.map((record) => record.id)).toEqual([created.id]);
  });

  it('closes a remote terminal\'s tab and leaves it running on its host when the project goes with Keep running', async () => {
    const h = harness();
    h.projects = [ALPHA, REMOTE];
    const local = h.service.create({ profileId: 'pwsh', target: { project: ALPHA.key } }, false);
    const remote = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    await settle();
    if (!remote.ok || !local.ok) throw new Error('no terminals');
    h.posted.length = 0;
    h.service.detach(remote.id);
    await settle();
    // the daemon stops sending this client that terminal alone
    expect(h.posted).toEqual([{ type: 'detach', id: remote.id }]);
    expect(h.ptys.every((pty) => !pty.killed)).toBe(true);
    expect(lastState(h).terminals.map((terminal) => terminal.id)).toEqual([local.id]);
    expect(() => h.service.detach(local.id)).toThrow();
  });

  it('restores the kept terminals as reconnecting until the host reattaches them, and drops one the daemon lost with its record', async () => {
    const h = harness();
    h.projects = [REMOTE];
    const created = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    await settle();
    if (!created.ok) throw new Error('no remote terminal');
    const kept = h.remote.at(-1)!.map((record) => ({ ...record, name: 'build' }));
    const gone = { ...kept[0]!, id: 'term-123456789012345' };
    h.service.closeWindow();
    h.service.attach({ state: (state) => h.states.push(state), data: (data) => h.data.push(data), screen: (screen) => h.screens.push(screen), focus: (id) => h.focused.push(id) });
    h.posted.length = 0;
    h.service.restore([...kept, gone]);
    await settle();
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status, terminal.title])).toEqual([[created.id, 'reconnecting', 'build'], [gone.id, 'reconnecting', 'build']]);
    // nothing reaches a host while it is away
    expect(h.posted).toEqual([]);
    const backend: TerminalBackend = {
      ...h.backend,
      startHost: () => ({ postMessage: () => undefined, onMessage: () => undefined, onExit: () => undefined, kill: () => undefined }),
      list: async () => [{ id: created.id, pid: 1, cols: 90, rows: 20 }],
    };
    await h.service.reattach(backend, 'loopback', [...kept, gone], []);
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status])).toEqual([[created.id, 'running']]);
    expect(h.remote.at(-1)!.map((record) => record.id)).toEqual([created.id]);
    expect(h.persisted.at(-1)!.groups.map((group) => group.panes)).toEqual([[{ kind: 'remote', id: created.id }]]);
  });

  it('drops a remote terminal\'s record and layout pane when its process exits, and keeps its exited tab with the exit code for the run', async () => {
    const connection = fakeConnection();
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    const first = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    if (!first.ok) throw new Error('no remote terminal');
    await settle();
    connection.daemon({ type: 'ready', id: first.id, pid: 5 });
    await h.service.split(first.id);
    await settle();
    const pane = lastState(h).activeId!;
    connection.daemon({ type: 'ready', id: pane, pid: 6 });
    expect(h.remote.at(-1)!.map((record) => record.id)).toEqual([first.id, pane]);
    connection.daemon({ type: 'exit', id: pane, exitCode: 3 });
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status, terminal.exitCode])).toEqual([[first.id, 'running', null], [pane, 'exited', 3]]);
    expect(lastState(h).groups.map((group) => group.paneIds)).toEqual([[first.id, pane]]);
    expect(h.remote.at(-1)!.map((record) => record.id)).toEqual([first.id]);
    expect(h.persisted.at(-1)!.groups).toEqual([{ panes: [{ kind: 'remote', id: first.id }], activePane: 0, sizes: [1] }]);
    // a later change keeps it out
    h.service.rename(first.id, 'build');
    expect(h.remote.at(-1)!.map((record) => record.id)).toEqual([first.id]);
  });

  it('keeps the record and layout pane of a remote terminal its host is away from: reconnecting after a drop, exited after the connection closed', async () => {
    const connection = fakeConnection();
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    const created = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    if (!created.ok) throw new Error('no remote terminal');
    await settle();
    connection.daemon({ type: 'ready', id: created.id, pid: 5 });
    const [kept] = h.remote.at(-1)!;
    h.service.connectionLost('loopback');
    h.service.rename(created.id, 'build');
    expect(lastState(h).terminals.map((terminal) => terminal.status)).toEqual(['reconnecting']);
    expect(h.remote.at(-1)).toEqual([{ ...kept!, name: 'build' }]);
    h.service.connectionResumed('loopback');
    // a connection that closed without a drop exits the tab, though the terminal still runs on its host
    connection.close('Disconnect Host');
    h.service.rename(created.id, 'server');
    expect(lastState(h).terminals.map((terminal) => terminal.status)).toEqual(['exited']);
    expect(h.remote.at(-1)).toEqual([{ ...kept!, name: 'server' }]);
    expect(h.persisted.at(-1)!.groups.map((group) => group.panes)).toEqual([[{ kind: 'remote', id: created.id }]]);
  });

  it('writes a fresh record, with the new process\'s nonce, when an exited remote terminal restarts', async () => {
    const connection = fakeConnection();
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    const created = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    if (!created.ok) throw new Error('no remote terminal');
    await settle();
    connection.daemon({ type: 'ready', id: created.id, pid: 5 });
    const before = h.remote.at(-1)![0]!;
    connection.daemon({ type: 'exit', id: created.id, exitCode: 0 });
    expect(h.remote.at(-1)).toEqual([]);
    expect(h.persisted.at(-1)!.groups).toEqual([]);
    await h.service.restart(created.id);
    await settle();
    const after = h.remote.at(-1)!;
    expect(after).toEqual([{ ...before, nonce: expect.any(String) }]);
    expect(after[0]!.nonce).not.toBe(before.nonce);
    expect(h.persisted.at(-1)!.groups.map((group) => group.panes)).toEqual([[{ kind: 'remote', id: created.id }]]);
  });
});

// A loopback connection's workspace over a fake endpoint: the daemon's answers, the posts it got and its pushes.
interface FakeConnection {
  readonly workspace: ProjectWorkspace;
  // the requests the client posted to the daemon's pty host, in order
  readonly posts: HostRequest[];
  // the nonce of the last shell-integration injection asked for
  nonce: string;
  daemon(message: HostMessage): void;
  close(reason: string): void;
}

function fakeConnection(live: readonly LiveTerminal[] = []): FakeConnection {
  const events = new Map<string, Set<(payload: unknown) => void>>();
  const closeListeners = new Set<(reason: string) => void>();
  let closed: string | undefined;
  const posts: HostRequest[] = [];
  const answer = (method: string, params: { request?: { nonce: string } }): unknown => {
    switch (method) {
      case 'terminals.environment': return { PATH: '/bin' };
      case 'terminals.injection':
        connection.nonce = params.request!.nonce;
        return { args: ['--init'], env: {} };
      case 'terminals.list': return live;
      case 'files.isDirectory': return true;
      default: throw new Error(`the fake daemon has no answer for ${method}`);
    }
  };
  const endpoint = {
    request: async (method: string, params: { request?: { nonce: string } }) => {
      if (closed !== undefined) throw new Error(`The connection closed: ${closed}`);
      return answer(method, params);
    },
    onEvent: (name: string, listener: (payload: unknown) => void) => {
      const listeners = events.get(name) ?? new Set();
      events.set(name, listeners);
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    emit: (name: string, payload: { request: HostRequest }) => {
      if (name === 'terminals.post') posts.push(payload.request);
    },
  } as unknown as Endpoint<ClientToWorkspace, WorkspaceToClient>;
  const workspace = createRemoteWorkspace({
    endpoint,
    authorityKey: 'loopback',
    projectOfCwd: () => undefined,
    onClose: (listener) => {
      if (closed !== undefined) {
        listener(closed);
        return { dispose: () => undefined };
      }
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    notConnected: () => new NotConnectedError('Local daemon is not connected.'),
    watchReady: false,
    transfers: false,
    rangedReads: false,
    outside: false,
    listing: false,
    openStream: () => { throw new Error('no transfer streams in this suite'); },
    log: () => undefined,
  });
  const connection: FakeConnection = {
    workspace,
    posts,
    nonce: '',
    daemon: (message) => events.get('terminals.message')?.forEach((listener) => listener({ message })),
    close: (reason) => {
      closed = reason;
      for (const listener of [...closeListeners]) listener(reason);
    },
  };
  return connection;
}

describe('remote terminals across connections', () => {
  const REMOTE: TerminalProject = { key: 'loopback|/srv/app', name: 'app', fsPath: '/srv/app' };
  const statusOf = (h: Harness, id: string): string | undefined => lastState(h).terminals.find((terminal) => terminal.id === id)?.status;
  const spawned = (connection: FakeConnection): Array<Extract<HostRequest, { type: 'spawn' }>> => connection.posts.flatMap((request) => (request.type === 'spawn' ? [request] : []));

  it('restarts a remote terminal and its split pane after the connection closed: a start error while it is down, a spawn on the next connection', async () => {
    let connection: FakeConnection | undefined = fakeConnection();
    const h = harness({
      remote: () => {
        if (!connection) throw new Error('Local daemon is not connected.');
        return connection.workspace;
      },
    });
    h.projects = [REMOTE];
    h.settings = { shellIntegration: true };
    const created = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    if (!created.ok) throw new Error('no remote terminal');
    await settle();
    const first = connection;
    first.daemon({ type: 'ready', id: created.id, pid: 5 });
    first.daemon({ type: 'data', id: created.id, data: `\x1b]633;P;Cwd=/srv/app/sub;${first.nonce}\x07` });
    await h.service.split(created.id);
    await settle();
    const pane = lastState(h).activeId!;
    expect(spawned(first).map((request) => [request.id, request.cwd])).toEqual([[created.id, '/srv/app'], [pane, '/srv/app/sub']]);
    first.close('network');
    connection = undefined;
    expect([statusOf(h, created.id), statusOf(h, pane)]).toEqual(['exited', 'exited']);

    await h.service.restart(pane);
    await h.service.restart(created.id);
    await settle();
    expect([statusOf(h, created.id), statusOf(h, pane)]).toEqual(['exited', 'exited']);
    expect(h.data.filter((batch) => batch.data.includes('Local daemon is not connected.')).map((batch) => batch.id)).toEqual([pane, created.id]);

    const second = fakeConnection();
    connection = second;
    await h.service.restart(created.id);
    await settle();
    expect(spawned(second).map((request) => request.id)).toEqual([created.id]);
    second.daemon({ type: 'ready', id: created.id, pid: 7 });
    expect(statusOf(h, created.id)).toBe('running');
  });

  it('lists the current project\'s host\'s shells, and only that host\'s projects, for New Terminal', () => {
    const h = harness({ remote: () => fakeConnection().workspace });
    h.projects = [ALPHA, REMOTE];
    h.hostProfiles = [{ id: 'bash', name: 'bash', file: '/usr/bin/bash', args: [], icon: 'bash' }];
    h.current = REMOTE.key;
    h.service.publish();
    expect(h.service.profileOptions(REMOTE.key).map((profile) => [profile.id, profile.isDefault])).toEqual([['bash', true]]);
    expect(h.service.profileOptions(ALPHA.key).map((profile) => profile.id)).toEqual(['pwsh', 'git-bash']);
    expect(h.service.projectOptions().map((option) => option.key)).toEqual([ALPHA.key, REMOTE.key]);
  });

  it('starts, splits and restarts a remote terminal with its host\'s own shells, while a local project\'s pick lists this computer\'s', async () => {
    const connection = fakeConnection();
    const h = harness({ remote: () => connection.workspace });
    h.projects = [ALPHA, REMOTE];
    h.hostProfiles = [{ id: 'bash', name: 'bash', file: '/usr/bin/bash', args: [], icon: 'bash' }];
    expect(h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false)).toEqual({ ok: false, reason: 'unknownProfile' });
    const created = h.service.create({ profileId: null, target: { project: REMOTE.key } }, false);
    if (!created.ok) throw new Error('no remote terminal');
    await settle();
    connection.daemon({ type: 'ready', id: created.id, pid: 5 });
    await h.service.split(created.id);
    await settle();
    expect(spawned(connection).map((request) => request.file)).toEqual(['/usr/bin/bash', '/usr/bin/bash']);
    connection.daemon({ type: 'exit', id: created.id, exitCode: 0 });
    h.hostProfiles = [];
    await h.service.restart(created.id);
    expect(h.logs).toContain(`[terminal] not restarting ${created.id}: its profile bash is no longer listed`);
    expect(h.service.profileOptions(ALPHA.key).map((profile) => profile.id)).toEqual(['pwsh', 'git-bash']);
  });

  it('puts each terminal a reconnect reattaches back in its exited tab\'s place, its split and its name kept', async () => {
    let connection = fakeConnection();
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    const first = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    if (!first.ok) throw new Error('no remote terminal');
    await settle();
    connection.daemon({ type: 'ready', id: first.id, pid: 5 });
    await h.service.split(first.id);
    await settle();
    const pane = lastState(h).activeId!;
    const last = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    if (!last.ok) throw new Error('no remote terminal');
    await settle();
    h.service.rename(pane, 'server');
    h.service.select(pane);
    const before = lastState(h).groups;
    const kept = h.remote.at(-1)!;
    connection.close('network');
    expect(lastState(h).terminals.map((terminal) => terminal.status)).toEqual(['exited', 'exited', 'exited']);
    connection = fakeConnection([first.id, pane, last.id].map((id) => ({ id, pid: 5, cols: 80, rows: 24 })));
    await h.service.reattach(connection.workspace.terminals, 'loopback', kept, []);
    const after = lastState(h);
    expect(after.groups).toEqual(before);
    expect(after.terminals.map((terminal) => [terminal.id, terminal.status, terminal.name])).toEqual([[first.id, 'running', null], [pane, 'running', 'server'], [last.id, 'running', null]]);
    expect(after.activeId).toBe(pane);
  });

  it('shows a dropped connection\'s terminals reconnecting, running again on a resume, and reattached through serialize after a fresh attach', async () => {
    let connection = fakeConnection();
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    const created = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    if (!created.ok) throw new Error('no remote terminal');
    await settle();
    connection.daemon({ type: 'ready', id: created.id, pid: 5 });
    h.service.connectionLost('ssh+other');
    expect(statusOf(h, created.id)).toBe('running');
    h.service.connectionLost('loopback');
    expect(statusOf(h, created.id)).toBe('reconnecting');
    // the same connection resumed: its replay carries the output on, with no new screen
    h.service.connectionResumed('loopback');
    expect(statusOf(h, created.id)).toBe('running');
    connection.daemon({ type: 'data', id: created.id, data: 'after the resume' });
    h.service.connectionLost('loopback');
    const kept = h.remote.at(-1)!;
    // the daemon no longer held it: the terminal still runs there, so its tab waits for the next connection
    connection.close('the daemon no longer holds this connection');
    expect(statusOf(h, created.id)).toBe('reconnecting');
    connection = fakeConnection([{ id: created.id, pid: 5, cols: 80, rows: 24 }]);
    await h.service.reattach(connection.workspace.terminals, 'loopback', kept, []);
    expect(statusOf(h, created.id)).toBe('running');
    expect(connection.posts.filter((request) => request.type === 'serialize').map((request) => request.id)).toEqual([created.id]);
  });

  it('holds the keys and paste that reach main while the connection is away, and sends them in order on a resume', async () => {
    const connection = fakeConnection();
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    const created = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    if (!created.ok) throw new Error('no remote terminal');
    await settle();
    connection.daemon({ type: 'ready', id: created.id, pid: 5 });
    h.service.input(created.id, 'a');
    h.service.connectionLost('loopback');
    // keys the renderer sent before it saw the tab reconnecting
    h.service.input(created.id, 'b');
    h.service.write(created.id, 'cd');
    const inputs = (): string[] => connection.posts.flatMap((request) => (request.type === 'input' ? [request.data] : []));
    expect(inputs()).toEqual(['a']);
    h.service.connectionResumed('loopback');
    expect(inputs()).toEqual(['a', 'b', 'cd']);
    h.service.input(created.id, 'e');
    expect(inputs()).toEqual(['a', 'b', 'cd', 'e']);
  });

  it('sends what was held after the screen of a fresh connection\'s reattach, and says so when the terminal ended meanwhile', async () => {
    let connection = fakeConnection();
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    const created = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    const ended = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    if (!created.ok || !ended.ok) throw new Error('no remote terminals');
    await settle();
    connection.daemon({ type: 'ready', id: created.id, pid: 5 });
    connection.daemon({ type: 'ready', id: ended.id, pid: 6 });
    const kept = h.remote.at(-1)!;
    h.service.connectionLost('loopback');
    h.service.input(created.id, 'ls');
    h.service.input(ended.id, 'pwd');
    connection.close('the daemon no longer holds this connection');
    connection = fakeConnection([{ id: created.id, pid: 5, cols: 80, rows: 24 }]);
    await h.service.reattach(connection.workspace.terminals, 'loopback', kept, []);
    expect(connection.posts.filter((request) => 'id' in request && request.id === created.id).map((request) => request.type)).toEqual(['clearAck', 'serialize', 'scrollback', 'input']);
    expect(connection.posts.some((request) => 'id' in request && request.id === ended.id)).toBe(false);
    expect(h.logs).toContain(`[terminal] ${ended.id} ended while its host was away; 1 inputs typed meanwhile were not sent`);
    // the tab this run showed stays, exited, and no longer comes back on a relaunch
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status])).toEqual([[created.id, 'running'], [ended.id, 'exited']]);
    expect(h.remote.at(-1)!.map((record) => record.id)).toEqual([created.id]);
    expect(h.persisted.at(-1)!.groups.map((group) => group.panes)).toEqual([[{ kind: 'remote', id: created.id }]]);
  });

  it('counts the shell\'s sequences on from a reattached screen, so the next reload\'s marks land on their commands', async () => {
    const first = fakeConnection();
    let connection = first;
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    const created = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    if (!created.ok) throw new Error('no remote terminal');
    await settle();
    const kept = h.remote.at(-1)!;
    h.service.closeWindow();
    h.service.attach({ state: (state) => h.states.push(state), data: (data) => h.data.push(data), screen: (screen) => h.screens.push(screen), focus: (id) => h.focused.push(id) });
    connection = fakeConnection([{ id: created.id, pid: 5, cols: 80, rows: 24 }]);
    await h.service.reattach(connection.workspace.terminals, 'loopback', kept, []);
    // the daemon's screen holds five sequences the shell printed before this client attached
    connection.daemon({ type: 'screen', id: created.id, data: '$ ', cols: 80, rows: 24, marks: [], sequences: 5 });
    connection.daemon({ type: 'data', id: created.id, data: `\r\n\x1b]633;A;${kept[0]!.nonce}\x07$ ` });
    h.service.shellLoaded();
    connection.daemon({ type: 'screen', id: created.id, data: '$ \r\n$ ', cols: 80, rows: 24, marks: [{ index: 5, line: 1 }], sequences: 6 });
    expect(h.screens.at(-1)!.marks).toEqual([{ line: 1, event: { kind: 'promptStart' } }]);
  });

  it('tells the daemon what another device needs to show a remote terminal, and a local terminal nothing', async () => {
    const connection = fakeConnection();
    const h = harness({ remote: () => connection.workspace });
    h.projects = [ALPHA, REMOTE];
    h.hostProfiles = [{ id: 'bash', name: 'bash', file: '/usr/bin/bash', args: ['-l'], icon: 'bash' }];
    const remote = h.service.create({ profileId: null, target: { project: REMOTE.key } }, false);
    h.service.create({ profileId: 'pwsh', target: { project: ALPHA.key } }, false);
    await settle();
    if (!remote.ok) throw new Error('no remote terminal');
    const nonce = h.remote.at(-1)![0]!.nonce;
    expect(spawned(connection)).toEqual([expect.objectContaining({ id: remote.id, view: { root: '/srv/app', profile: { id: 'bash', name: 'bash', file: '/usr/bin/bash', args: ['-l'], icon: 'bash' }, startCwd: '/srv/app', nonce } })]);
    expect(h.posted.filter((request) => (request as HostRequest).type === 'spawn').every((request) => !('view' in (request as object)))).toBe(true);
  });

  it('opens a terminal another device started: its tab, screen and integration here, input to the daemon, kept in remote-state.json, and closing it detaches this view only', async () => {
    const nonce = 'ab'.repeat(16);
    const id = 'term-111111111111111';
    const live: LiveTerminal = { id, pid: 5, cols: 100, rows: 30, view: { root: '/srv/app', profile: { id: 'bash', name: 'bash', file: '/usr/bin/bash', args: [], icon: 'bash' }, startCwd: '/srv/app', nonce } };
    const connection = fakeConnection([live]);
    const h = harness({ remote: () => connection.workspace });
    h.projects = [];
    // its folder is not open on this device
    expect(h.service.canOpen('loopback', live)).toBe(false);
    await expect(h.service.open(connection.workspace.terminals, 'loopback', id)).rejects.toThrow(/cannot be shown here/);
    h.projects = [REMOTE];
    expect(h.service.canOpen('loopback', live)).toBe(true);
    expect(h.service.canOpen('ssh+other', live)).toBe(false);
    expect(h.service.canOpen('loopback', { id, pid: 5, cols: 100, rows: 30 })).toBe(false);
    await h.service.open(connection.workspace.terminals, 'loopback', id);
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.projectKey, terminal.status, terminal.title])).toEqual([[id, REMOTE.key, 'running', 'bash']]);
    expect(lastState(h).activeId).toBe(id);
    expect(h.focused.at(-1)).toBe(id);
    expect(connection.posts).toEqual([{ type: 'clearAck', id }, { type: 'serialize', id }, { type: 'scrollback', id, scrollback: SETTINGS.scrollback }]);
    expect(h.remote.at(-1)).toEqual([{ id, projectKey: REMOTE.key, profile: live.view!.profile, startCwd: '/srv/app', nonce, name: null, customIcon: null, color: null }]);
    expect(h.service.canOpen('loopback', live)).toBe(false);
    connection.daemon({ type: 'screen', id, data: '$ ', cols: 100, rows: 30, marks: [], sequences: 0 });
    expect(h.screens.at(-1)).toMatchObject({ id, data: '$ ' });
    // the other device's nonce signs the shell's sequences, so this device trusts them too
    connection.daemon({ type: 'data', id, data: `\x1b]633;A;${nonce}\x07$ ` });
    expect(lastState(h).terminals[0]!.integrated).toBe(true);
    h.service.input(id, 'ls');
    expect(connection.posts.at(-1)).toEqual({ type: 'input', id, data: 'ls' });
    // opening it again only selects it
    await h.service.open(connection.workspace.terminals, 'loopback', id);
    expect(connection.posts.filter((request) => request.type === 'serialize')).toHaveLength(1);
    h.service.detach(id);
    expect(connection.posts.at(-1)).toEqual({ type: 'detach', id });
    expect(connection.posts.some((request) => request.type === 'kill')).toBe(false);
    expect(h.remote.at(-1)).toEqual([]);
  });

  it('shows the exit on this device when another device kills a terminal open here', async () => {
    const id = 'term-111111111111111';
    const live: LiveTerminal = { id, pid: 5, cols: 80, rows: 24, view: { root: '/srv/app', profile: { id: 'bash', name: 'bash', file: '/usr/bin/bash', args: [], icon: 'bash' }, startCwd: '/srv/app', nonce: 'cd'.repeat(16) } };
    const connection = fakeConnection([live]);
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    await h.service.open(connection.workspace.terminals, 'loopback', id);
    connection.daemon({ type: 'exit', id, exitCode: 1 });
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status])).toEqual([[id, 'exited']]);
  });

  const keptRecord = (id: string): RemoteTerminalRecord => ({ id, projectKey: REMOTE.key, profile: { id: 'bash', name: 'bash', file: '/usr/bin/bash', args: [], icon: 'bash' }, startCwd: '/srv/app', nonce: 'ab'.repeat(16), name: null, customIcon: null, color: null });
  const liveOf = (...ids: string[]): LiveTerminal[] => ids.map((id) => ({ id, pid: 5, cols: 80, rows: 24 }));
  const kills = (connection: FakeConnection): string[] => connection.posts.flatMap((request) => (request.type === 'kill' ? [request.id] : []));

  it('writes the records of an authority\'s first reattach even when it kept none, so a terminal started before it is kept', async () => {
    const connection = fakeConnection();
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    const created = h.service.create({ profileId: null, target: { project: REMOTE.key } }, false);
    if (!created.ok) throw new Error('no remote terminal');
    await settle();
    const written = h.remote.length;
    await h.service.reattach(connection.workspace.terminals, 'loopback', [], []);
    expect(h.remote).toHaveLength(written + 1);
    expect(h.remote.at(-1)!.map((record) => record.id)).toEqual([created.id]);
  });

  it('ends a remote terminal whose spawn the daemon refused: its record and layout pane go, its tab stays exited', async () => {
    const connection = fakeConnection();
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    const created = h.service.create({ profileId: null, target: { project: REMOTE.key } }, false);
    if (!created.ok) throw new Error('no remote terminal');
    await settle();
    expect(h.remote.at(-1)!.map((record) => record.id)).toEqual([created.id]);
    connection.daemon({ type: 'error', id: created.id, message: 'posix_spawnp failed.' });
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status])).toEqual([[created.id, 'exited']]);
    expect(h.remote.at(-1)).toEqual([]);
    expect(h.persisted.at(-1)!.groups).toEqual([]);
  });

  it('ends a reattached terminal whose screen the daemon answers is not running', async () => {
    const id = 'term-111111111111111';
    const connection = fakeConnection(liveOf(id));
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    await h.service.reattach(connection.workspace.terminals, 'loopback', [keptRecord(id)], []);
    expect(h.remote.at(-1)!.map((record) => record.id)).toEqual([id]);
    connection.daemon({ type: 'error', id, message: `terminal ${id} is not running` });
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status])).toEqual([[id, 'exited']]);
    expect(h.remote.at(-1)).toEqual([]);
    expect(h.persisted.at(-1)!.groups).toEqual([]);
  });

  it('takes a placeholder its daemon no longer lists out of its split group: the sizes shared again, the active pane handed to the pane at its index', async () => {
    const id = 'term-111111111111111';
    const saved: PersistedTerminals = {
      version: 2,
      listWidthRem: 12,
      groups: [{ panes: [stored('pwsh', ALPHA.key), { kind: 'remote', id }, stored('git-bash', ALPHA.key)], activePane: 1, sizes: [0.2, 0.5, 0.3] }],
      active: 0,
      editor: [],
    };
    const connection = fakeConnection();
    const h = harness({ saved, remote: () => connection.workspace });
    h.projects = [ALPHA, REMOTE];
    h.service.restore([keptRecord(id)]);
    expect(groupsOf(h)).toEqual([[['term-1', id, 'term-2'], id, [0.2, 0.5, 0.3]]]);
    await h.service.reattach(connection.workspace.terminals, 'loopback', [keptRecord(id)], []);
    expect(groupsOf(h)).toEqual([[['term-1', 'term-2'], 'term-2', [0.5, 0.5]]]);
    expect(lastState(h).activeId).toBe('term-2');
    expect(h.logs).toContain(`[terminal] not restoring ${id}: it ended while its host was away`);
    expect(h.persisted.at(-1)!.groups).toEqual([{ panes: [stored('pwsh', ALPHA.key), stored('git-bash', ALPHA.key)], activePane: 1, sizes: [0.5, 0.5] }]);
  });

  it('closes the editor tab of a placeholder its daemon no longer lists', async () => {
    const id = 'term-111111111111111';
    const connection = fakeConnection();
    const h = harness({ saved: { ...DEFAULT_PERSISTED_TERMINALS, editor: [{ kind: 'remote', id }] }, remote: () => connection.workspace });
    h.projects = [REMOTE];
    h.service.restore([keptRecord(id)]);
    expect(h.service.tabSource.tabs().map((tab) => tab.id)).toEqual([`terminal:${id}`]);
    const announced = h.editorTabs;
    await h.service.reattach(connection.workspace.terminals, 'loopback', [keptRecord(id)], []);
    expect(h.service.tabSource.tabs()).toEqual([]);
    expect(h.editorTabs).toBe(announced + 1);
    expect(lastState(h).terminals).toEqual([]);
    expect(h.persisted.at(-1)!.editor).toEqual([]);
  });

  it('kills on the daemon a placeholder a Kill closed, once its host reattaches in the same run, and never gives it a tab', async () => {
    const [killed, kept] = ['term-111111111111111', 'term-222222222222222'];
    const connection = fakeConnection(liveOf(killed, kept));
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    h.service.restore([keptRecord(killed), keptRecord(kept)]);
    h.service.kill(killed);
    expect(h.kills).toEqual([['loopback', killed]]);
    expect(lastState(h).terminals.map((terminal) => terminal.id)).toEqual([kept]);
    // remote-state.json may still hold its record when the reattach reads it
    expect(await h.service.reattach(connection.workspace.terminals, 'loopback', [keptRecord(killed), keptRecord(kept)], [])).toEqual([killed]);
    expect(kills(connection)).toEqual([killed]);
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status])).toEqual([[kept, 'running']]);
    expect(h.remote.at(-1)!.map((record) => record.id)).toEqual([kept]);
    // the kill no longer waits
    expect(await h.service.reattach(connection.workspace.terminals, 'loopback', [keptRecord(kept)], [])).toEqual([]);
    expect(kills(connection)).toEqual([killed]);
  });

  it('kills a placeholder a Kill closed when its host reattaches after a relaunch, from what remote-state.json kept', async () => {
    vi.useRealTimers();
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-terminal-kill-'));
    try {
      const [killed, kept] = ['term-111111111111111', 'term-222222222222222'];
      const state = await RemoteState.open(userData, () => undefined);
      await state.setTerminals('loopback', [keptRecord(killed), keptRecord(kept)]);
      const before = harness({ remote: () => fakeConnection().workspace });
      before.projects = [REMOTE];
      before.service.restore(state.terminals('loopback'));
      before.service.kill(killed);
      for (const [authority, id] of before.kills) await state.killOnReattach(authority, id);

      const relaunched = await RemoteState.open(userData, () => undefined);
      expect(relaunched.terminals('loopback')).toEqual([keptRecord(kept)]);
      expect(relaunched.pendingKills('loopback')).toEqual([killed]);
      const connection = fakeConnection(liveOf(killed, kept));
      const h = harness({ remote: () => connection.workspace });
      h.projects = [REMOTE];
      h.service.restore(relaunched.terminals('loopback'));
      expect(lastState(h).terminals.map((terminal) => terminal.id)).toEqual([kept]);
      const done = await h.service.reattach(connection.workspace.terminals, 'loopback', relaunched.terminals('loopback'), relaunched.pendingKills('loopback'));
      expect(kills(connection)).toEqual([killed]);
      expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status])).toEqual([[kept, 'running']]);
      await relaunched.killsDone('loopback', done);
      expect((await RemoteState.open(userData, () => undefined)).pendingKills('loopback')).toEqual([]);
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it('kills on the next connection a terminal killed while its connection was away, reconnecting or exited by the close, and never gives it a tab', async () => {
    const first = fakeConnection();
    let connection = first;
    const h = harness({ remote: () => connection.workspace });
    h.projects = [REMOTE];
    const ids = [0, 1, 2].map(() => {
      const created = h.service.create({ profileId: null, target: { project: REMOTE.key } }, false);
      if (!created.ok) throw new Error('no remote terminal');
      return created.id;
    });
    const [held, kept, closed] = ids as [string, string, string];
    await settle();
    for (const id of ids) first.daemon({ type: 'ready', id, pid: 5 });
    const records = h.remote.at(-1)!;
    h.service.connectionLost('loopback');
    // posted on the held connection, which may never resume
    h.service.kill(held);
    expect(kills(first)).toEqual([held]);
    h.service.connectionResumed('loopback');
    first.close('network');
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status])).toEqual([[kept, 'exited'], [closed, 'exited']]);
    // its shell still runs on the host, which no host of this run can be told now
    h.service.kill(closed);
    expect(h.kills).toEqual([['loopback', held], ['loopback', closed]]);
    connection = fakeConnection(liveOf(...ids));
    expect(await h.service.reattach(connection.workspace.terminals, 'loopback', records, [])).toEqual([held, closed]);
    expect(kills(connection)).toEqual([held, closed]);
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status])).toEqual([[kept, 'running']]);
  });

  it('leaves the terminals of a project that closed while its host was away running there', () => {
    const id = 'term-111111111111111';
    const h = harness({ remote: () => fakeConnection().workspace });
    h.projects = [REMOTE];
    h.service.restore([keptRecord(id)]);
    h.projects = [];
    h.service.projectsChanged([]);
    expect(lastState(h).terminals).toEqual([]);
    expect(h.kills).toEqual([]);
  });

  it('names a placeholder\'s refusals for what they are: a tab it has already, and an editor terminal as a join anchor', async () => {
    const id = 'term-111111111111111';
    const live: LiveTerminal = { id, pid: 5, cols: 80, rows: 24, view: { root: '/srv/app', profile: keptRecord(id).profile, startCwd: '/srv/app', nonce: 'ab'.repeat(16) } };
    const connection = fakeConnection([live]);
    const h = harness({ saved: { ...DEFAULT_PERSISTED_TERMINALS, groups: [{ panes: [{ kind: 'remote', id }], activePane: 0, sizes: [1] }], active: 0 }, remote: () => connection.workspace });
    h.projects = [REMOTE];
    await h.service.open(connection.workspace.terminals, 'loopback', id);
    h.service.restore([keptRecord(id)]);
    expect(h.logs).toContain(`[terminal] not restoring ${id}: it has a tab already`);
    h.service.move({ kind: 'toEditor', id });
    h.service.join(id, []);
    expect(h.logs).toContain(`[terminal] not joining terminals to ${id}: it is in the editor`);
  });
});

describe('a reload of the shell page with several terminals', () => {
  it('gives every live terminal its own screen, an inactive one and one on the alternate screen included, and no output twice', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    const [one, two] = h.ptys;
    one!.emit('normal line\r\n\x1b[?1049h\x1b[Hfull screen');
    two!.emit('second');
    await settle(TERMINAL_BATCH_MS);
    expect(lastState(h).activeId).toBe('term-2');
    h.data.length = 0;
    h.service.shellLoaded();
    await settle(50);
    const screens = new Map(h.screens.map((screen) => [screen.id, screen.data]));
    expect([...screens.keys()].sort()).toEqual(['term-1', 'term-2']);
    expect(screens.get('term-1')).toMatch(/normal line[\s\S]*\[\?1049h[\s\S]*full screen/);
    expect(screens.get('term-2')).toContain('second');
    expect(lastState(h).terminals.map((terminal) => terminal.restoring)).toEqual([false, false]);
    one!.emit(' after');
    await settle(TERMINAL_BATCH_MS);
    expect(h.data.map((batch) => [batch.id, batch.data])).toEqual([['term-1', ' after']]);
  });
});

describe('settings the pty host keeps', () => {
  it('gives each live terminal\'s screen a new scrollback once per change', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    h.posted.length = 0;
    h.settings = { scrollback: 5000 };
    h.service.settingsChanged();
    h.service.settingsChanged();
    expect(h.posted.filter((message) => (message as HostRequest).type === 'scrollback')).toEqual([{ type: 'scrollback', id: 'term-1', scrollback: 5000 }]);
  });
});

describe('window layout', () => {
  it('saves the list, the active terminal and the clamped list width', () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: 'git-bash', target: { project: BETA.key } }, false);
    h.service.select('term-1');
    h.service.setListWidth(1000);
    expect(h.persisted.at(-1)).toEqual(singles([stored('pwsh', ALPHA.key), stored('git-bash', BETA.key)], 0, TERMINAL_LIST_MAX_REM));
    expect(lastState(h)).toMatchObject({ activeId: 'term-1', listWidthRem: TERMINAL_LIST_MAX_REM, canCreate: true, passKeys: ['CmdOrCtrl+P', 'Ctrl+Shift+5'] });
  });

  it('restores the saved terminals without focus, skipping a missing profile or project', async () => {
    const saved = singles([stored('fish', ALPHA.key), { ...stored('git-bash', BETA.key), name: 'build', color: 'green' }, stored('pwsh', 'c:\\gone'), { ...stored('pwsh', ALPHA.key), customIcon: 'rocket' }], 1);
    const h = harness({ saved });
    h.service.restore([]);
    await settle();
    expect(h.focused).toEqual([]);
    expect(lastState(h)).toMatchObject({ activeId: 'term-1', listWidthRem: 12 });
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.profileId, terminal.projectKey, terminal.status])).toEqual([
      ['term-1', 'git-bash', BETA.key, 'running'],
      ['term-2', 'pwsh', ALPHA.key, 'running'],
    ]);
    expect(lastState(h).terminals.map((terminal) => [terminal.title, terminal.name, terminal.customIcon, terminal.color])).toEqual([
      ['build', 'build', null, 'green'],
      ['PowerShell', null, 'rocket', null],
    ]);
    expect(h.persisted.at(-1)).toEqual(singles([{ ...stored('git-bash', BETA.key), name: 'build', color: 'green' }, { ...stored('pwsh', ALPHA.key), customIcon: 'rocket' }], 0));
  });

  // Toggle Terminal can start one before the window page finishes loading, and so before the restore runs.
  it('restores the terminals saved as the window opened ahead of one started before the restore, which stays active', async () => {
    const h = harness({ saved: singles([stored('pwsh', ALPHA.key), stored('git-bash', BETA.key)], 1) });
    expect(h.service.ensureTerminal()).toBe('term-1');
    h.service.restore([]);
    await settle();
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.profileId, terminal.projectKey])).toEqual([
      ['term-2', 'pwsh', ALPHA.key],
      ['term-3', 'git-bash', BETA.key],
      ['term-1', 'pwsh', ALPHA.key],
    ]);
    expect(lastState(h).activeId).toBe('term-1');
    expect(h.persisted.at(-1)).toEqual(singles([stored('pwsh', ALPHA.key), stored('git-bash', BETA.key), stored('pwsh', ALPHA.key)], 2));
    expect(h.ptys).toHaveLength(3);
  });

  it('can create without a project, but not without a detected shell, and says whether detection has settled', () => {
    const h = harness();
    h.projects = [];
    h.current = undefined;
    expect(h.service.state().canCreate).toBe(true);
    h.profiles = [];
    h.profilesReady = false;
    expect(h.service.state()).toMatchObject({ canCreate: false, profilesReady: false });
    h.profilesReady = true;
    expect(h.service.state()).toMatchObject({ canCreate: false, profilesReady: true });
  });
});

describe('rename, icon and color', () => {
  it('trims a name, restores the automatic title for an empty one, and refuses one too long or with control or bidi characters', () => {
    expect(parseTerminalName('  build  ')).toBe('build');
    expect(parseTerminalName('   ')).toBeNull();
    expect(parseTerminalName('')).toBeNull();
    expect(parseTerminalName('x'.repeat(MAX_TERMINAL_NAME_LENGTH))).toBe('x'.repeat(MAX_TERMINAL_NAME_LENGTH));
    expect(parseTerminalName('x'.repeat(MAX_TERMINAL_NAME_LENGTH + 1))).toBeUndefined();
    for (const bad of [
      'a\nb', 'a\u001bb', 'a\u0085b', 'evil\u202Etxt.exe', 'a\u2066b', 'a\u200Bb', 'a\u2028b', 'a\uFEFFb',
      'a\u00ADb', 'a\u180Eb', 'a\u2061b', 'a\u206Ab', 'a\uFFF9b', 'a\u{E0041}b', 'cut \uD83D', '\uDE00 cut', 42, null,
    ]) expect(parseTerminalName(bad), String(bad)).toBeUndefined();
    expect(parseTerminalName('ok 😀')).toBe('ok 😀');
    expect(parseTerminalName('a\u200Cb')).toBe('a\u200Cb');
    expect(parseTerminalName('Δοκιμή 👩‍💻')).toBe('Δοκιμή 👩‍💻');
  });

  it('accepts only the curated icons and the eight colors', () => {
    expect(isTerminalCustomIcon('rocket')).toBe(true);
    expect(isTerminalCustomIcon('powershell')).toBe(false);
    expect(isTerminalCustomIcon('../x')).toBe(false);
    expect(isTerminalColor('magenta')).toBe(true);
    expect(isTerminalColor('#ff0000')).toBe(false);
    expect(isTerminalColor('ansi-1')).toBe(false);
  });

  it('shows a name as the title, keeps the icon and color, and saves all three with the terminal', () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.rename('term-1', 'server');
    h.service.setCustomIcon('term-1', 'server');
    h.service.setColor('term-1', 'cyan');
    expect(lastState(h).terminals[0]).toMatchObject({ title: 'server', name: 'server', icon: 'powershell', customIcon: 'server', color: 'cyan' });
    expect(panesOf(h.persisted.at(-1)!)).toEqual([{ ...stored('pwsh', ALPHA.key), name: 'server', customIcon: 'server', color: 'cyan' }]);
    expect(h.service.appearance('term-1')).toEqual({ icon: 'powershell', customIcon: 'server', color: 'cyan' });
    h.service.rename('term-1', null);
    h.service.setCustomIcon('term-1', null);
    h.service.setColor('term-1', null);
    expect(lastState(h).terminals[0]).toMatchObject({ title: 'PowerShell', name: null, customIcon: null, color: null });
    expect(panesOf(h.persisted.at(-1)!)).toEqual([stored('pwsh', ALPHA.key)]);
    const count = h.persisted.length;
    h.service.rename('term-9', 'nope');
    h.service.setColor('term-9', 'red');
    expect(h.persisted).toHaveLength(count);
    expect(h.service.appearance('term-9')).toBeUndefined();
  });
});

describe('palette actions and state', () => {
  it('walks the list from the active terminal, wrapping, and kills every terminal at once', async () => {
    const h = harness();
    expect(h.service.relative(1)).toBeUndefined();
    for (let index = 0; index < 3; index++) h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.select('term-3');
    expect(h.service.relative(1)).toBe('term-1');
    expect(h.service.relative(-1)).toBe('term-2');
    await settle();
    await h.service.requestKill(h.service.ids());
    await settle();
    expect(h.ptys.every((pty) => pty.killed)).toBe(true);
    expect(lastState(h)).toMatchObject({ terminals: [], activeId: null });
  });

  it('publishes every terminal setting the shell applies, and keeps main-only ones out', () => {
    const h = harness({ defaultProfile: 'git-bash' });
    h.service.create({ profileId: null, target: { current: true } }, false);
    const state = lastState(h);
    expect(state).not.toHaveProperty('profiles');
    expect(state.settings).toEqual({ fontSize: 13, scrollback: 1000, cursorStyle: 'block', fontFamily: 'Cascadia Code', lineHeight: 1.2, cursorBlinking: false, macOptionIsMeta: false, decorationsEnabled: true });
  });

  it('writes a paste larger than one host message in pieces, never splitting a surrogate pair, to a live pty only', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await settle();
    const data = `${'a'.repeat(MAX_TERMINAL_INPUT_CHARS - 1)}😀${'b'.repeat(10)}`;
    h.service.write('term-1', data);
    await settle();
    expect(h.ptys[0]!.written.map((chunk) => chunk.length)).toEqual([MAX_TERMINAL_INPUT_CHARS - 1, 12]);
    expect(h.ptys[0]!.written.join('')).toBe(data);
    h.service.write('term-9', 'nope');
    h.ptys[0]!.exit(0);
    await settle(EXIT_FLUSH_MS);
    h.service.write('term-1', 'late');
    await settle();
    expect(h.ptys[0]!.written.join('')).toBe(data);
  });

  it('resolves links against the project folder, in the path style of the shell', () => {
    const h = harness();
    h.service.create({ profileId: 'git-bash', target: { project: BETA.key } }, false);
    h.profiles = [...h.profiles, { id: 'wsl:Ubuntu', name: 'Ubuntu', file: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'], icon: 'wsl' }];
    h.service.create({ profileId: 'wsl:Ubuntu', target: { project: ALPHA.key } }, false);
    expect(h.service.linkBase('term-1')).toEqual({ project: BETA, baseDir: BETA.fsPath, style: 'win32' });
    expect(h.service.linkBase('term-2')).toEqual({ project: ALPHA, baseDir: ALPHA.fsPath, style: 'wsl' });
    expect(h.service.linkBase('term-9')).toBeUndefined();
    h.profiles = [...h.profiles, { id: 'user:Distro', name: 'Distro', file: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Debian'], icon: 'wsl', source: 'user', customIcon: null, color: null }];
    h.service.create({ profileId: 'user:Distro', target: { project: ALPHA.key } }, false);
    expect(h.service.linkBase('term-3')).toMatchObject({ style: 'wsl' });
    h.projects = [ALPHA];
    expect(h.service.linkBase('term-1')).toBeUndefined();
  });
});

const CMD: TerminalProfile = { id: 'cmd', name: 'Command Prompt', file: 'C:\\Windows\\System32\\cmd.exe', args: [], icon: 'cmd' };
const osc = (body: string): string => `\x1b]633;${body}\x07`;
const nonceOf = (h: Harness, index = 0): string => h.ptys[index]!.options.env['DAMOCLES_NONCE']!;
const ackedByMain = (h: Harness): number => h.posted.filter((message): message is { type: 'ack'; chars: number } => (message as { type: string }).type === 'ack').reduce((sum, message) => sum + message.chars, 0);

async function integrated(): Promise<{ h: Harness; nonce: string; emit: (data: string) => Promise<void> }> {
  const h = harness();
  h.settings = { shellIntegration: true };
  h.service.create({ profileId: 'pwsh', target: { project: ALPHA.key } }, false);
  await settle();
  const emit = async (data: string): Promise<void> => {
    h.ptys[0]!.emit(data);
    await settle(TERMINAL_BATCH_MS);
  };
  return { h, nonce: nonceOf(h), emit };
}

describe('shell integration', () => {
  it('starts pwsh and Git Bash with their scripts from the app folder and a fresh nonce per spawn, and cmd.exe as it is', async () => {
    const h = harness();
    h.settings = { shellIntegration: true };
    h.profiles = [PWSH, BASH, CMD];
    for (const profileId of ['pwsh', 'git-bash', 'cmd']) h.service.create({ profileId, target: { project: ALPHA.key } }, false);
    await settle();
    const [pwsh, bash, cmd] = h.ptys;
    expect(pwsh!.args).toEqual(['-noexit', '-command', 'try { . $env:DAMOCLES_SHELL_INTEGRATION_SCRIPT } catch {}']);
    expect(pwsh!.options.env).toMatchObject({ DAMOCLES_INJECTION: '1', DAMOCLES_SHELL_INTEGRATION_SCRIPT: `${SCRIPTS_DIR}\\shellIntegration.ps1`, PATH: 'C:\\bin' });
    expect(bash!.args).toEqual(['--init-file', `${SCRIPTS_DIR}\\shellIntegration-bash.sh`]);
    expect(bash!.options.env).toMatchObject({ DAMOCLES_SHELL_LOGIN: '1' });
    expect(cmd!.args).toEqual([]);
    expect(cmd!.options.env).toEqual({ PATH: 'C:\\bin', TERM_TEST: '1' });
    expect(nonceOf(h, 0)).toMatch(/^[0-9a-f]{32}$/);
    expect(nonceOf(h, 1)).toMatch(/^[0-9a-f]{32}$/);
    expect(nonceOf(h, 0)).not.toBe(nonceOf(h, 1));
    pwsh!.exit(0);
    await settle(EXIT_FLUSH_MS);
    h.service.restart('term-1');
    await settle();
    expect(nonceOf(h, 3)).toMatch(/^[0-9a-f]{32}$/);
    expect(nonceOf(h, 3)).not.toBe(nonceOf(h, 0));
    expect(JSON.stringify(h.states)).not.toContain(nonceOf(h, 3));
  });

  it('copies zsh\'s startup files into its own ZDOTDIR before it starts, and starts it without integration when that fails', async () => {
    const h = harness({ platform: 'darwin' });
    const project: TerminalProject = { key: '/work/alpha', name: 'alpha', fsPath: '/work/alpha' };
    h.projects = [project];
    h.profiles = [{ id: 'zsh', name: 'zsh', file: '/bin/zsh', args: ['-l'], icon: 'zsh' }];
    h.settings = { shellIntegration: true };
    h.service.create({ profileId: 'zsh', target: { project: project.key } }, false);
    await settle();
    expect(h.ptys[0]!.args).toEqual(['-il']);
    expect(h.ptys[0]!.options.env['ZDOTDIR']).toBe('C:\\Users\\me\\AppData\\Roaming\\Damocles\\shell-integration\\zsh');
    expect(h.copied.map((dest) => dest.split('/').at(-1))).toEqual(['.zshenv', '.zprofile', '.zshrc', '.zlogin']);
    const failing = harness({ platform: 'darwin' });
    failing.projects = h.projects;
    failing.profiles = h.profiles;
    failing.settings = { shellIntegration: true };
    (failing as { copied: string[] }).copied.push = () => {
      throw new Error('EACCES');
    };
    failing.service.create({ profileId: 'zsh', target: { project: project.key } }, false);
    await settle();
    expect(failing.ptys[0]!.args).toEqual(['-l']);
    expect(failing.ptys[0]!.options.env).not.toHaveProperty('DAMOCLES_NONCE');
  });

  it('starts every shell as it is when the setting is off', async () => {
    const h = harness();
    h.service.create({ profileId: 'git-bash', target: { project: ALPHA.key } }, false);
    await settle();
    expect(h.ptys[0]!.args).toEqual(['--login', '-i']);
    expect(h.ptys[0]!.options.env).toEqual({ PATH: 'C:\\bin', TERM_TEST: '1' });
  });

  it('strips every 633 sequence, sends the trusted ones in band at their offsets, and acknowledges what it stripped', async () => {
    const { h, nonce, emit } = await integrated();
    const running = `${osc(`A;${nonce}`)}PS> ${osc(`B;${nonce}`)}npm test\r\n${osc(`E;npm test;${nonce}`)}${osc(`C;${nonce}`)}`;
    const finished = `FAIL\r\n${osc(`D;1;${nonce}`)}${osc(`P;Cwd=C:\\x5cwork\\x5calpha\\x5csrc;${nonce}`)}${osc(`A;${nonce}`)}PS> `;
    await emit(running);
    expect(h.data.at(-1)).toEqual({
      id: 'term-1',
      data: 'PS> npm test\r\n',
      events: [
        { offset: 0, event: { kind: 'promptStart' } },
        { offset: 4, event: { kind: 'commandStart' } },
        { offset: 14, event: { kind: 'commandExecuted', commandId: 1, commandLine: 'npm test', time: 1000 } },
      ],
    });
    expect(lastState(h).terminals[0]).toMatchObject({ title: 'npm test', running: 'npm test', integrated: true, description: null });
    await emit(finished);
    expect(h.data.at(-1)).toEqual({
      id: 'term-1',
      data: 'FAIL\r\nPS> ',
      events: [
        { offset: 6, event: { kind: 'commandFinished', commandId: 1, exitCode: 1, time: 1000 } },
        { offset: 6, event: { kind: 'promptStart' } },
      ],
    });
    expect(lastState(h).terminals[0]).toMatchObject({ title: 'PowerShell', running: null, description: 'src' });
    expect(h.service.commandFacts('term-1', 1)).toEqual({ commandLine: 'npm test', exitCode: 1 });
    expect(h.service.linkBase('term-1')).toMatchObject({ baseDir: 'C:\\work\\alpha\\src' });
    expect(h.service.cwdOf('term-1')).toBe('C:\\work\\alpha\\src');
    const forwarded = h.data.reduce((sum, batch) => sum + batch.data.length, 0);
    expect(ackedByMain(h) + forwarded).toBe(running.length + finished.length);
  });

  it('a page reload replays nothing', async () => {
    const { h, nonce, emit } = await integrated();
    await emit(`${osc(`A;${nonce}`)}PS> ${osc(`B;${nonce}`)}npm test\r\n${osc(`E;npm test;${nonce}`)}${osc(`C;${nonce}`)}FAIL\r\n${osc(`D;1;${nonce}`)}${osc(`A;${nonce}`)}PS> `);
    h.service.shellLoaded();
    await settle(50);
    // the screen kept every payload, all of them output main already parsed
    expect(h.screens.at(-1)!.marks.map(({ event }) => event)).toEqual([
      { kind: 'promptStart' },
      { kind: 'commandStart' },
      { kind: 'commandExecuted', commandId: 1, commandLine: 'npm test', time: 1000 },
      { kind: 'commandFinished', commandId: 1, exitCode: 1, time: 1000 },
      { kind: 'promptStart' },
    ]);
    expect(h.service.commandFacts('term-1', 1)).toEqual({ commandLine: 'npm test', exitCode: 1 });
    expect(h.service.commandFacts('term-1', 2)).toBeUndefined();
    expect(lastState(h).terminals[0]).toMatchObject({ running: null, integrated: true, restoring: false });
  });

  it('changes nothing for a forged sequence without the nonce, with a wrong one or with a wrong field count', async () => {
    const { h, nonce, emit } = await integrated();
    await emit(`out${osc('E;rm -rf ~')}${osc('C')}${osc('P;Cwd=C:\\x5cwork\\x5cbeta')}${osc('E;x;0123456789abcdef0123456789abcdef')}${osc(`C;${nonce};extra`)}${osc(`D;${nonce}`)}${osc(`A;${nonce.slice(1)}`)}end`);
    expect(h.data).toEqual([{ id: 'term-1', data: 'outend' }]);
    expect(lastState(h).terminals[0]).toMatchObject({ title: 'PowerShell', running: null, integrated: false, description: null });
    expect(h.service.linkBase('term-1')).toMatchObject({ baseDir: ALPHA.fsPath });
  });

  it('holds a sequence split across batches, forwards another OSC untouched and leaves no half sequence in the output', async () => {
    const { h, nonce, emit } = await integrated();
    const sequence = osc(`E;ls;${nonce}`) + osc(`C;${nonce}`);
    await emit(`a\x1b]0;title\x07b${sequence.slice(0, 3)}`);
    await emit(sequence.slice(3, 20));
    await emit(`${sequence.slice(20)}c`);
    expect(h.data.map((batch) => batch.data).join('')).toBe('a\x1b]0;title\x07bc');
    expect(h.data.flatMap((batch) => batch.events ?? []).map(({ event }) => event)).toEqual([{ kind: 'commandExecuted', commandId: 1, commandLine: 'ls', time: 1000 }]);
  });

  it('finishes a command whose D never came when the next prompt starts', async () => {
    const { h, nonce, emit } = await integrated();
    await emit(`${osc(`E;sleep 1;${nonce}`)}${osc(`C;${nonce}`)}${osc(`A;${nonce}`)}`);
    expect(h.data.at(-1)!.events!.map(({ event }) => event.kind)).toEqual(['commandExecuted', 'commandFinished', 'promptStart']);
    expect(lastState(h).terminals[0]!.running).toBeNull();
  });

  it('refuses a UNC or relative working directory, which then resolves no relative link', async () => {
    const { h, nonce, emit } = await integrated();
    await emit(osc(`P;Cwd=\\x5c\\x5cserver\\x5cshare;${nonce}`));
    expect(h.service.linkBase('term-1')).toMatchObject({ baseDir: null });
    await emit(osc(`P;Cwd=src;${nonce}`));
    expect(h.service.linkBase('term-1')).toMatchObject({ baseDir: null });
    expect(lastState(h).terminals[0]!.description).toBeNull();
  });

  it('titles a running command by its first line, tabs as spaces, cut to the title length', async () => {
    const { h, nonce, emit } = await integrated();
    await emit(`${osc(`E;echo evil\\x09${'x'.repeat(200)}\\x0asecond;${nonce}`)}${osc(`C;${nonce}`)}`);
    const { title, running } = lastState(h).terminals[0]!;
    expect(title).toBe(`echo evil ${'x'.repeat(89)}…`);
    expect(title).toHaveLength(100);
    expect(running).toBe(title);
  });

  it('drops a command line holding a control or bidi character once unescaped', async () => {
    const { h, nonce, emit } = await integrated();
    await emit(`${osc(`E;a\\x1b]633;A;${nonce}`)}${osc(`C;${nonce}`)}${osc(`E;echo \u202Eevil;${nonce}`)}${osc(`C;${nonce}`)}`);
    expect(h.service.commandFacts('term-1', 1)).toEqual({ commandLine: '', exitCode: null });
    expect(h.service.commandFacts('term-1', 2)).toEqual({ commandLine: '', exitCode: null });
    expect(lastState(h).terminals[0]).toMatchObject({ title: 'PowerShell', running: '' });
  });

  it('titles a macOS or Linux shell without integration by its foreground process, read after output', async () => {
    const h = harness({ platform: 'linux', readProcessName: true });
    const project: TerminalProject = { key: '/work/alpha', name: 'alpha', fsPath: '/work/alpha' };
    h.projects = [project];
    h.profiles = [{ id: 'bash', name: 'bash', file: '/usr/bin/bash', args: [], icon: 'bash' }];
    h.service.create({ profileId: 'bash', target: { project: project.key } }, false);
    await settle();
    const pty = h.ptys[0]!;
    pty.process = '/usr/bin/bash';
    pty.emit('$ ');
    await settle(200);
    expect(lastState(h).terminals[0]).toMatchObject({ title: 'bash', running: null });
    pty.process = 'vim';
    pty.emit('~');
    await settle(199);
    expect(lastState(h).terminals[0]!.title).toBe('bash');
    await settle(1);
    expect(lastState(h).terminals[0]).toMatchObject({ title: 'vim', running: 'vim' });
  });
});

describe('confirm before kill', () => {
  it('asks once about the running terminals, killing only after Terminate; an idle shell and cmd.exe never ask', async () => {
    const h = harness();
    h.settings = { shellIntegration: true };
    h.profiles = [PWSH, CMD];
    h.service.create({ profileId: 'pwsh', target: { project: ALPHA.key } }, false);
    h.service.create({ profileId: 'cmd', target: { project: ALPHA.key } }, false);
    h.service.create({ profileId: 'pwsh', target: { project: ALPHA.key } }, false);
    await settle();
    h.ptys[0]!.emit(`${osc(`E;node -e "setInterval(()=>{},1000)";${nonceOf(h, 0)}`)}${osc(`C;${nonceOf(h, 0)}`)}`);
    await settle(TERMINAL_BATCH_MS);
    h.service.rename('term-1', 'server');
    await h.service.requestKill(['term-3']);
    await h.service.requestKill(['term-2']);
    expect(h.asked).toEqual([]);
    expect(lastState(h).terminals.map((terminal) => terminal.id)).toEqual(['term-1']);
    h.answer = false;
    await h.service.requestKill(h.service.ids());
    expect(h.asked).toEqual([[{ name: 'server', command: 'node -e "setInterval(()=>{},1000)"' }]]);
    expect(lastState(h).terminals.map((terminal) => terminal.id)).toEqual(['term-1']);
    h.answer = true;
    await h.service.requestKill(['term-1']);
    expect(h.asked).toHaveLength(2);
    expect(h.service.hasTerminals()).toBe(false);
  });

  it('asks about every live terminal with always, and about none with never or for an exited one', async () => {
    const h = harness();
    h.profiles = [PWSH, CMD];
    h.service.create({ profileId: 'pwsh', target: { project: ALPHA.key } }, false);
    h.service.create({ profileId: 'cmd', target: { project: BETA.key } }, false);
    await settle();
    h.settings = { confirmOnKill: 'always' };
    h.answer = false;
    expect(await h.service.confirmKill(h.service.ids())).toBe(false);
    expect(h.asked.at(-1)).toEqual([{ name: 'PowerShell', command: null }, { name: 'Command Prompt', command: null }]);
    expect(await h.service.confirmKill(h.service.idsIn(BETA.key))).toBe(false);
    expect(h.asked.at(-1)).toEqual([{ name: 'Command Prompt', command: null }]);
    h.settings = { confirmOnKill: 'never' };
    expect(await h.service.confirmKill(h.service.ids())).toBe(true);
    h.settings = { confirmOnKill: 'always' };
    h.ptys[0]!.exit(0);
    h.ptys[1]!.exit(0);
    await settle(EXIT_FLUSH_MS);
    expect(await h.service.confirmKill(h.service.ids())).toBe(true);
    expect(h.asked).toHaveLength(2);
  });
});

const groupsOf = (h: Harness): Array<[readonly string[], string, readonly number[]]> => lastState(h).groups.map((group) => [group.paneIds, group.activePaneId, group.sizes]);
const idsOf = (h: Harness): string[] => lastState(h).terminals.map((terminal) => terminal.id);

describe('split groups', () => {
  it('starts each new terminal in its own group at the end of the list', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: 'git-bash', target: { project: BETA.key } }, false);
    expect(lastState(h).groups).toEqual([
      { id: 'group-1', paneIds: ['term-1'], activePaneId: 'term-1', sizes: [1] },
      { id: 'group-2', paneIds: ['term-2'], activePaneId: 'term-2', sizes: [1] },
    ]);
  });

  it('puts a split right of its source with the source\'s profile and project, shares the sizes equally and focuses it', async () => {
    const h = harness();
    h.service.create({ profileId: 'git-bash', target: { project: BETA.key } }, false);
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    await settle();
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.profileId, terminal.projectKey])).toEqual([
      ['term-1', 'git-bash', BETA.key],
      ['term-3', 'git-bash', BETA.key],
      ['term-2', 'pwsh', ALPHA.key],
    ]);
    expect(groupsOf(h)).toEqual([[['term-1', 'term-3'], 'term-3', [0.5, 0.5]], [['term-2'], 'term-2', [1]]]);
    expect(lastState(h).activeId).toBe('term-3');
    expect(h.focused).toEqual(['term-3']);
    expect([h.ptys[2]!.file, h.ptys[2]!.args]).toEqual([BASH.file, ['--login', '-i']]);
    await h.service.split('term-1');
    expect(groupsOf(h)[0]).toEqual([['term-1', 'term-4', 'term-3'], 'term-4', [1 / 3, 1 / 3, 1 / 3]]);
  });

  it('starts a split in the folder its source reported, and in the project folder when that was refused or is gone', async () => {
    const { h, nonce, emit } = await integrated();
    const src = 'C:\\work\\alpha\\src';
    h.directories.add(src);
    await emit(osc(`P;Cwd=C:\\x5cwork\\x5calpha\\x5csrc;${nonce}`));
    await h.service.split('term-1');
    await settle();
    expect(h.ptys[1]!.options.cwd).toBe(src);
    await emit(osc(`P;Cwd=\\x5c\\x5cserver\\x5cshare;${nonce}`));
    await h.service.split('term-1');
    await settle();
    expect(h.ptys[2]!.options.cwd).toBe(ALPHA.fsPath);
    await emit(osc(`P;Cwd=C:\\x5cwork\\x5calpha\\x5cgone;${nonce}`));
    await h.service.split('term-1');
    await settle();
    expect(h.ptys[3]!.options.cwd).toBe(ALPHA.fsPath);
    expect(h.logs.some((line) => line.includes('C:\\work\\alpha\\gone'))).toBe(true);
    h.ptys[1]!.exit(0);
    await settle(EXIT_FLUSH_MS);
    h.service.restart('term-2');
    await settle();
    expect(h.ptys[4]!.options.cwd).toBe(src);
  });

  it('restarts a pane in its project folder once the folder it started in is gone', async () => {
    const { h, nonce, emit } = await integrated();
    const src = 'C:\\work\\alpha\\src';
    h.directories.add(src);
    await emit(osc(`P;Cwd=C:\\x5cwork\\x5calpha\\x5csrc;${nonce}`));
    await h.service.split('term-1');
    await settle();
    h.ptys[1]!.exit(0);
    await settle(EXIT_FLUSH_MS);
    h.directories.delete(src);
    h.service.restart('term-2');
    expect(lastState(h).terminals[1]).toMatchObject({ id: 'term-2', status: 'starting' });
    await settle();
    expect(h.ptys[2]!.options.cwd).toBe(ALPHA.fsPath);
    expect(h.logs).toContain(`[terminal] restarting term-2 in its start folder: ${src} no longer exists`);
  });

  it('keeps what is typed and pasted while a restart checks its folder, and sends it to the restarted shell in order', async () => {
    const { h, nonce, emit } = await integrated();
    const src = 'C:\\work\\alpha\\src';
    h.directories.add(src);
    await emit(osc(`P;Cwd=C:\\x5cwork\\x5calpha\\x5csrc;${nonce}`));
    await h.service.split('term-1');
    await settle();
    h.ptys[1]!.exit(0);
    await settle(EXIT_FLUSH_MS);
    h.service.restart('term-2');
    h.service.input('term-2', 'ls');
    h.service.write('term-2', ' -la');
    h.service.input('term-2', '\r');
    await settle();
    expect(h.ptys[2]!.written).toEqual(['ls', ' -la', '\r']);
  });

  it('refuses a split past the pane cap, of an unknown terminal, and of one whose profile is no longer listed', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    for (let index = 1; index < MAX_TERMINAL_GROUP_PANES; index++) await h.service.split('term-1');
    expect(lastState(h).groups[0]!.paneIds).toHaveLength(MAX_TERMINAL_GROUP_PANES);
    const terminals = idsOf(h);
    await h.service.split('term-1');
    await h.service.split('term-99');
    expect(idsOf(h)).toEqual(terminals);
    expect(h.logs).toContain(`[terminal] not splitting term-1: its group has ${MAX_TERMINAL_GROUP_PANES} panes`);
    const other = harness();
    other.service.create({ profileId: 'git-bash', target: { current: true } }, false);
    other.profiles = [PWSH];
    await other.service.split('term-1');
    expect(idsOf(other)).toEqual(['term-1']);
    expect(other.logs.some((line) => line.includes('git-bash'))).toBe(true);
  });

  it('restarts an exited pane only while its profile is still listed', async () => {
    const h = harness();
    h.service.create({ profileId: 'git-bash', target: { current: true } }, false);
    await settle();
    h.ptys[0]!.exit(1);
    await settle(EXIT_FLUSH_MS);
    h.profiles = [PWSH];
    h.service.restart('term-1');
    await settle();
    expect(h.ptys).toHaveLength(1);
    expect(lastState(h).terminals[0]!.status).toBe('exited');
  });

  it('takes a killed pane out of its group, shares the sizes again and activates the pane at its index, else the last', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    await h.service.split('term-2');
    h.service.resizePanes('group-1', [0.5, 0.3, 0.2]);
    h.service.select('term-2');
    h.service.kill('term-2');
    expect(groupsOf(h)).toEqual([[['term-1', 'term-3'], 'term-3', [0.5, 0.5]]]);
    expect(lastState(h).activeId).toBe('term-3');
    h.service.kill('term-3');
    expect(groupsOf(h)).toEqual([[['term-1'], 'term-1', [1]]]);
    h.service.kill('term-1');
    expect(lastState(h)).toMatchObject({ groups: [], terminals: [], activeId: null });
  });

  it('removes a group with its last pane and activates the next group\'s active pane, else the previous one\'s', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.select('term-3');
    h.service.kill('term-3');
    expect(lastState(h).activeId).toBe('term-4');
    h.service.kill('term-4');
    expect(lastState(h).activeId).toBe('term-2');
  });

  it('unsplits a pane into a new group at the end of the list, keeping its process and moving no focus', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.select('term-2');
    await settle();
    h.service.unsplit('term-2');
    await settle();
    expect(idsOf(h)).toEqual(['term-1', 'term-3', 'term-2']);
    expect(groupsOf(h)).toEqual([[['term-1'], 'term-1', [1]], [['term-3'], 'term-3', [1]], [['term-2'], 'term-2', [1]]]);
    expect(lastState(h).activeId).toBe('term-2');
    expect(h.focused).toEqual(['term-2']);
    expect(h.ptys.map((pty) => pty.killed)).toEqual([false, false, false]);
    const before = h.states.length;
    h.service.unsplit('term-3');
    expect(h.states).toHaveLength(before);
  });

  it('makes a selected pane its group\'s active pane and its group the active group', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.select('term-1');
    expect(lastState(h).activeId).toBe('term-1');
    expect(groupsOf(h)[0]![1]).toBe('term-1');
  });

  it('focuses the previous and next pane of the active group, wrapping, and selects it', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    await h.service.split('term-2');
    h.focused.length = 0;
    h.service.focusPane(1);
    h.service.focusPane(-1);
    h.service.focusPane(-1);
    expect(h.focused).toEqual(['term-1', 'term-3', 'term-2']);
    expect(lastState(h).activeId).toBe('term-2');
  });

  it('walks groups for Focus Next and Previous Terminal, landing on each group\'s active pane', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    h.service.create({ profileId: null, target: { current: true } }, false);
    expect(h.service.relative(1)).toBe('term-2');
    expect(h.service.relative(-1)).toBe('term-2');
  });

  it('takes pane sizes within the bounds, rescales a sum within epsilon, and refuses any other', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    await h.service.split('term-2');
    h.service.resizePanes('group-1', [0.5, 0.25, 0.25]);
    expect(groupsOf(h)[0]![2]).toEqual([0.5, 0.25, 0.25]);
    h.service.resizePanes('group-1', [0.5, 0.25, 0.2505]);
    expect(groupsOf(h)[0]![2].reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 12);
    const kept = groupsOf(h)[0]![2];
    for (const sizes of [[0.5, 0.5], [0.5, 0.25, Number.NaN], [0.96, 0.02, 0.02], [0.5, 0.3, 0.3], [1, 0, 0]]) h.service.resizePanes('group-1', sizes);
    h.service.resizePanes('group-9', [1]);
    expect(groupsOf(h)[0]![2]).toEqual(kept);
    expect(MIN_TERMINAL_PANE_FRACTION * MAX_TERMINAL_GROUP_PANES).toBeLessThan(1);
  });

  it('publishes the pane keys only while the active group has more than one pane', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    expect(lastState(h).passKeys).toEqual(['CmdOrCtrl+P', 'Ctrl+Shift+5']);
    expect(h.service.splitActive()).toBe(false);
    await h.service.split('term-1');
    expect(lastState(h).passKeys).toEqual(['CmdOrCtrl+P', 'Ctrl+Shift+5', 'Alt+Left', 'Alt+Right']);
    expect(h.service.splitActive()).toBe(true);
    h.service.create({ profileId: null, target: { current: true } }, false);
    expect(lastState(h).passKeys).toEqual(['CmdOrCtrl+P', 'Ctrl+Shift+5']);
  });
});

describe('split groups in the window layout', () => {
  it('saves each group\'s panes, active pane and sizes, and the active group', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    h.service.create({ profileId: 'git-bash', target: { project: BETA.key } }, false);
    h.service.resizePanes('group-1', [0.7, 0.3]);
    expect(h.persisted.at(-1)).toEqual({
      version: 2,
      listWidthRem: DEFAULT_PERSISTED_TERMINALS.listWidthRem,
      groups: [{ panes: [stored('pwsh', ALPHA.key), stored('pwsh', ALPHA.key)], activePane: 1, sizes: [0.7, 0.3] }, { panes: [stored('git-bash', BETA.key)], activePane: 0, sizes: [1] }],
      active: 1,
      editor: [],
    });
    h.service.select('term-1');
    expect(h.persisted.at(-1)).toMatchObject({ active: 0, groups: [{ activePane: 0 }, { activePane: 0 }] });
  });

  it('restores the groups, their sizes and active panes without focus', async () => {
    const saved: PersistedTerminals = {
      version: 2,
      listWidthRem: 12,
      groups: [{ panes: [stored('pwsh', ALPHA.key), stored('git-bash', ALPHA.key)], activePane: 1, sizes: [0.7, 0.3] }, { panes: [stored('pwsh', BETA.key)], activePane: 0, sizes: [1] }],
      active: 1,
      editor: [],
    };
    const h = harness({ saved });
    h.service.restore([]);
    await settle();
    expect(h.focused).toEqual([]);
    expect(groupsOf(h)).toEqual([[['term-1', 'term-2'], 'term-2', [0.7, 0.3]], [['term-3'], 'term-3', [1]]]);
    expect(lastState(h).activeId).toBe('term-3');
  });

  it('restores a group without a pane whose profile or project is gone, sharing the sizes again', async () => {
    const saved: PersistedTerminals = {
      version: 2,
      listWidthRem: 12,
      groups: [{ panes: [stored('pwsh', ALPHA.key), stored('fish', ALPHA.key), stored('git-bash', ALPHA.key)], activePane: 1, sizes: [0.4, 0.4, 0.2] }, { panes: [stored('pwsh', 'c:\\gone')], activePane: 0, sizes: [1] }],
      active: 0,
      editor: [],
    };
    const h = harness({ saved });
    h.service.restore([]);
    await settle();
    expect(groupsOf(h)).toEqual([[['term-1', 'term-2'], 'term-2', [0.5, 0.5]]]);
    expect(lastState(h).activeId).toBe('term-2');
    expect(h.logs).toContain('[terminal] not restoring a fish terminal: unknownProfile');
  });

  it('keeps a restored group\'s active pane on its terminal when a pane before it is gone', async () => {
    const saved: PersistedTerminals = {
      version: 2,
      listWidthRem: 12,
      groups: [{ panes: [stored('fish', ALPHA.key), stored('pwsh', ALPHA.key), stored('git-bash', ALPHA.key)], activePane: 1, sizes: [0.4, 0.3, 0.3] }, { panes: [stored('pwsh', BETA.key)], activePane: 0, sizes: [1] }],
      active: 1,
      editor: [],
    };
    const h = harness({ saved });
    h.service.restore([]);
    await settle();
    expect(groupsOf(h)).toEqual([[['term-1', 'term-2'], 'term-1', [0.5, 0.5]], [['term-3'], 'term-3', [1]]]);
  });

  it('restores saved groups ahead of a group started before the restore, which stays active', async () => {
    const saved: PersistedTerminals = { version: 2, listWidthRem: 12, groups: [{ panes: [stored('pwsh', ALPHA.key), stored('pwsh', ALPHA.key)], activePane: 0, sizes: [0.5, 0.5] }], active: 0, editor: [] };
    const h = harness({ saved });
    h.service.ensureTerminal();
    h.service.restore([]);
    await settle();
    expect(groupsOf(h)).toEqual([[['term-2', 'term-3'], 'term-2', [0.5, 0.5]], [['term-1'], 'term-1', [1]]]);
    expect(lastState(h).activeId).toBe('term-1');
    expect(h.focused).toEqual([]);
  });
});

describe('moves', () => {
  const REMOTE: TerminalProject = { key: 'loopback|c:\\work\\remote', name: 'remote', fsPath: 'C:\\work\\remote' };
  const paneIds = (h: Harness): string[][] => lastState(h).groups.map((group) => [...group.paneIds]);
  // count terminals, each in its own group: term-1..term-<count>, the last one active
  const singlesOf = (count: number): Harness => {
    const h = harness();
    for (let index = 0; index < count; index++) h.service.create({ profileId: null, target: { current: true } }, false);
    return h;
  };
  // a group of panes split off term-1 (term-1..term-<panes>, in order), then others more terminals in their own groups
  const grouped = async (panes: number, others: number): Promise<Harness> => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    for (let pane = 1; pane < panes; pane++) await h.service.split(`term-${pane}`);
    for (let other = 0; other < others; other++) h.service.create({ profileId: null, target: { current: true } }, false);
    return h;
  };

  it('reorders a pane inside its group before or after the target (moveInstance), sharing the sizes again', async () => {
    const h = await grouped(3, 0);
    h.service.resizePanes('group-1', [0.5, 0.3, 0.2]);
    h.service.move({ kind: 'reorder', id: 'term-3', target: 'term-1', side: 'before' });
    expect(groupsOf(h)).toEqual([[['term-3', 'term-1', 'term-2'], 'term-3', [1 / 3, 1 / 3, 1 / 3]]]);
    expect(idsOf(h)).toEqual(['term-3', 'term-1', 'term-2']);
    h.service.move({ kind: 'reorder', id: 'term-3', target: 'term-2', side: 'after' });
    expect(paneIds(h)).toEqual([['term-1', 'term-2', 'term-3']]);
    expect(lastState(h).activeId).toBe('term-3');
  });

  it('moves a pane\'s whole group before or after the target\'s group (moveGroup)', async () => {
    const h = await grouped(2, 2);
    h.service.move({ kind: 'reorder', id: 'term-4', target: 'term-2', side: 'before' });
    expect(paneIds(h)).toEqual([['term-4'], ['term-1', 'term-2'], ['term-3']]);
    expect(idsOf(h)).toEqual(['term-4', 'term-1', 'term-2', 'term-3']);
    h.service.move({ kind: 'reorder', id: 'term-1', target: 'term-3', side: 'after' });
    expect(paneIds(h)).toEqual([['term-4'], ['term-3'], ['term-1', 'term-2']]);
    expect(lastState(h).activeId).toBe('term-4');
  });

  it('joins a pane to the target\'s group on either side of the target, and the group it left goes with its last pane', () => {
    const h = singlesOf(3);
    h.service.move({ kind: 'join', id: 'term-3', target: 'term-1', side: 'before' });
    expect(groupsOf(h)).toEqual([[['term-3', 'term-1'], 'term-3', [0.5, 0.5]], [['term-2'], 'term-2', [1]]]);
    h.service.move({ kind: 'join', id: 'term-2', target: 'term-1', side: 'after' });
    expect(groupsOf(h)).toEqual([[['term-3', 'term-1', 'term-2'], 'term-3', [1 / 3, 1 / 3, 1 / 3]]]);
    expect(lastState(h).activeId).toBe('term-3');
  });

  it('refuses a join onto itself, into a full group or of an unknown terminal, logging it and publishing nothing', async () => {
    const h = await grouped(MAX_TERMINAL_GROUP_PANES, 1);
    const other = `term-${MAX_TERMINAL_GROUP_PANES + 1}`;
    const published = h.states.length;
    h.service.move({ kind: 'join', id: other, target: 'term-1', side: 'after' });
    h.service.move({ kind: 'join', id: other, target: other, side: 'after' });
    h.service.move({ kind: 'join', id: 'term-99', target: 'term-1', side: 'after' });
    h.service.move({ kind: 'reorder', id: other, target: 'term-99', side: 'after' });
    expect(h.states).toHaveLength(published);
    expect(h.logs).toEqual(expect.arrayContaining([
      `[terminal] not joining ${other} to term-1: its group has ${MAX_TERMINAL_GROUP_PANES} panes`,
      `[terminal] not joining ${other} to ${other}: it is the target`,
      '[terminal] not moving term-99: no such terminal',
      `[terminal] not moving ${other} next to term-99: no such panel terminal`,
    ]));
    // inside the full group a join is a reorder
    h.service.move({ kind: 'join', id: 'term-1', target: 'term-2', side: 'after' });
    expect(paneIds(h)[0]!.slice(0, 2)).toEqual(['term-2', 'term-1']);
  });

  it('detaches a pane into a group of its own at the end, and moves a group of one to the end', async () => {
    const h = await grouped(2, 2);
    h.service.move({ kind: 'detach', id: 'term-1' });
    expect(paneIds(h)).toEqual([['term-2'], ['term-3'], ['term-4'], ['term-1']]);
    h.service.move({ kind: 'detach', id: 'term-3' });
    expect(paneIds(h)).toEqual([['term-2'], ['term-4'], ['term-1'], ['term-3']]);
    const published = h.states.length;
    h.service.move({ kind: 'detach', id: 'term-3' });
    expect(h.states).toHaveLength(published);
    expect(lastState(h).activeId).toBe('term-4');
  });

  it('steps a pane past its neighbour inside the group, and the whole group past the next group at its edge', async () => {
    const h = await grouped(2, 1);
    h.service.move({ kind: 'step', id: 'term-2', delta: 1 });
    expect(paneIds(h)).toEqual([['term-3'], ['term-1', 'term-2']]);
    h.service.move({ kind: 'step', id: 'term-1', delta: 1 });
    expect(paneIds(h)).toEqual([['term-3'], ['term-2', 'term-1']]);
    h.service.move({ kind: 'step', id: 'term-2', delta: -1 });
    expect(paneIds(h)).toEqual([['term-2', 'term-1'], ['term-3']]);
    const published = h.states.length;
    h.service.move({ kind: 'step', id: 'term-2', delta: -1 });
    h.service.move({ kind: 'step', id: 'term-3', delta: 1 });
    expect(h.states).toHaveLength(published);
  });

  it('keeps the moved terminal active, handing its old group\'s active pane over', async () => {
    const h = await grouped(2, 1);
    h.service.select('term-1');
    h.service.move({ kind: 'join', id: 'term-1', target: 'term-3', side: 'before' });
    expect(groupsOf(h)).toEqual([[['term-2'], 'term-2', [1]], [['term-1', 'term-3'], 'term-1', [0.5, 0.5]]]);
    expect(lastState(h).activeId).toBe('term-1');
    // a terminal that is not active joins without taking its new group's active pane
    h.service.move({ kind: 'join', id: 'term-2', target: 'term-3', side: 'after' });
    expect(groupsOf(h)).toEqual([[['term-1', 'term-3', 'term-2'], 'term-1', [1 / 3, 1 / 3, 1 / 3]]]);
  });

  it('joins picked terminals after the anchor group\'s last pane in pick order, up to the cap, activating the first joined (joinInstances)', () => {
    const h = singlesOf(4);
    expect(h.service.joinCandidates('term-1')).toEqual(['term-2', 'term-3', 'term-4']);
    expect(h.service.joinRoom('term-1')).toBe(MAX_TERMINAL_GROUP_PANES - 1);
    h.service.join('term-1', ['term-3', 'term-2', 'term-1']);
    expect(groupsOf(h)).toEqual([[['term-1', 'term-3', 'term-2'], 'term-3', [1 / 3, 1 / 3, 1 / 3]], [['term-4'], 'term-4', [1]]]);
    expect(lastState(h).activeId).toBe('term-3');
    expect(h.logs).toContain('[terminal] not joining term-1 to term-1: it is in the group already');
    expect(h.service.joinCandidates('term-2')).toEqual(['term-4']);
  });

  it('stops a join at the group\'s cap and logs the rest', async () => {
    const h = await grouped(MAX_TERMINAL_GROUP_PANES - 1, 2);
    const [first, second] = [`term-${MAX_TERMINAL_GROUP_PANES}`, `term-${MAX_TERMINAL_GROUP_PANES + 1}`];
    expect(h.service.joinRoom('term-1')).toBe(1);
    h.service.join('term-1', [first, second]);
    expect(paneIds(h)).toEqual([[...Array.from({ length: MAX_TERMINAL_GROUP_PANES - 1 }, (_, index) => `term-${index + 1}`), first], [second]]);
    expect(h.logs).toContain(`[terminal] not joining ${second} to term-1: the group has ${MAX_TERMINAL_GROUP_PANES} panes`);
    expect(h.service.joinRoom('term-1')).toBe(0);
  });

  it('never joins a task tab, which runs alone', () => {
    const h = singlesOf(1);
    h.service.runTask({ key: 'setup', name: 'Setup', file: PWSH.file, args: [], projectKey: ALPHA.key, cwd: ALPHA.fsPath, env: {}, onExit: () => undefined, onRestart: () => undefined });
    expect(h.service.joinCandidates('term-1')).toEqual([]);
    expect(h.service.joinRoom('term-2')).toBe(0);
    h.service.move({ kind: 'join', id: 'term-2', target: 'term-1', side: 'after' });
    h.service.join('term-1', ['term-2']);
    expect(paneIds(h)).toEqual([['term-1'], ['term-2']]);
  });

  it('saves a remote terminal joined into a local group as a remote pane in its slot', async () => {
    const h = harness();
    h.projects = [ALPHA, REMOTE];
    h.service.create({ profileId: 'pwsh', target: { project: ALPHA.key } }, false);
    const remote = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    await settle();
    if (!remote.ok) throw new Error('no remote terminal');
    h.service.move({ kind: 'join', id: remote.id, target: 'term-1', side: 'before' });
    expect(h.persisted.at(-1)).toEqual({
      version: 2,
      listWidthRem: DEFAULT_PERSISTED_TERMINALS.listWidthRem,
      groups: [{ panes: [{ kind: 'remote', id: remote.id }, stored('pwsh', ALPHA.key)], activePane: 0, sizes: [0.5, 0.5] }],
      active: 0,
      editor: [],
    });
  });
});

describe('terminals in the editor', () => {
  const singlesOf = (count: number): Harness => {
    const h = harness();
    for (let index = 0; index < count; index++) h.service.create({ profileId: null, target: { current: true } }, false);
    return h;
  };
  const placements = (h: Harness): Array<[string, string]> => lastState(h).terminals.map((terminal) => [terminal.id, terminal.placement]);
  const tabIds = (h: Harness): string[] => h.service.tabSource.tabs().map((tab) => tab.id);

  it('moves a terminal out of its group into the last editor tab, which the editor shows, listing it after the panel\'s', async () => {
    const h = singlesOf(3);
    await h.service.split('term-1');
    h.service.select('term-2');
    h.service.move({ kind: 'toEditor', id: 'term-1' });
    h.service.move({ kind: 'toEditor', id: 'term-3' });
    expect(groupsOf(h)).toEqual([[['term-4'], 'term-4', [1]], [['term-2'], 'term-2', [1]]]);
    expect(placements(h)).toEqual([['term-4', 'panel'], ['term-2', 'panel'], ['term-1', 'editor'], ['term-3', 'editor']]);
    expect(h.shownTabs).toEqual(['term-1', 'term-3']);
    expect(h.service.tabSource.tabs()).toEqual([
      { id: 'terminal:term-1', kind: 'terminal', terminal: { id: 'term-1' }, title: 'PowerShell', displayPath: 'PowerShell', dirty: false, readOnly: false, conflict: false },
      { id: 'terminal:term-3', kind: 'terminal', terminal: { id: 'term-3' }, title: 'PowerShell', displayPath: 'PowerShell', dirty: false, readOnly: false, conflict: false },
    ]);
    expect(h.service.commandTarget()).toBe('term-3');
    expect(h.service.target()).toEqual({ id: 'term-3', status: 'starting', placement: 'editor', task: false });
    await settle();
    // a title change reaches the editor's tabs; output that changes no title does not
    const announced = h.editorTabs;
    h.service.rename('term-1', 'server');
    expect(h.editorTabs).toBe(announced + 1);
    expect(h.service.tabSource.tabs()[0]!.title).toBe('server');
    h.service.select('term-2');
    expect(h.editorTabs).toBe(announced + 1);
  });

  it('hands the panel\'s active terminal over as a kill does, and leaves none active with only editor terminals', async () => {
    const h = singlesOf(3);
    h.service.select('term-2');
    h.service.move({ kind: 'toEditor', id: 'term-2' });
    expect(lastState(h).activeId).toBe('term-3');
    h.service.move({ kind: 'toEditor', id: 'term-3' });
    expect(lastState(h).activeId).toBe('term-1');
    h.service.move({ kind: 'toEditor', id: 'term-1' });
    expect(lastState(h).activeId).toBeNull();
    expect(lastState(h).groups).toEqual([]);
    expect(h.service.hasTerminals()).toBe(false);
    expect(h.service.commandTarget()).toBe('term-1');
  });

  it('refuses a task terminal and one already in the editor, logging it and publishing nothing', () => {
    const h = singlesOf(1);
    h.service.runTask({ key: 'setup', name: 'Setup', file: PWSH.file, args: [], projectKey: ALPHA.key, cwd: ALPHA.fsPath, env: {}, onExit: () => undefined, onRestart: () => undefined });
    h.service.move({ kind: 'toEditor', id: 'term-1' });
    const published = h.states.length;
    h.service.move({ kind: 'toEditor', id: 'term-2' });
    h.service.move({ kind: 'toEditor', id: 'term-1' });
    expect(h.states).toHaveLength(published);
    expect(h.logs).toEqual(expect.arrayContaining([
      '[terminal] not moving term-2 into the editor: a task stays in the panel',
      '[terminal] not moving term-1 into the editor: it is in the editor already',
    ]));
    expect(lastState(h).terminals.find((terminal) => terminal.id === 'term-2')).toMatchObject({ task: true, placement: 'panel' });
    expect(lastState(h).terminals.find((terminal) => terminal.id === 'term-1')).not.toHaveProperty('task');
  });

  it('brings an editor terminal back: detach appends a group, reorder places one next to the target\'s group, join joins it', () => {
    const h = singlesOf(3);
    h.service.move({ kind: 'toEditor', id: 'term-1' });
    h.service.move({ kind: 'toEditor', id: 'term-2' });
    h.service.move({ kind: 'toEditor', id: 'term-3' });
    h.service.move({ kind: 'detach', id: 'term-2' });
    expect(groupsOf(h)).toEqual([[['term-2'], 'term-2', [1]]]);
    expect([lastState(h).activeId, h.service.commandTarget(), h.panelShown, h.focused.at(-1)]).toEqual(['term-2', 'term-2', 1, 'term-2']);
    h.service.move({ kind: 'reorder', id: 'term-3', target: 'term-2', side: 'before' });
    expect(groupsOf(h)).toEqual([[['term-3'], 'term-3', [1]], [['term-2'], 'term-2', [1]]]);
    h.service.move({ kind: 'join', id: 'term-1', target: 'term-2', side: 'before' });
    expect(groupsOf(h)).toEqual([[['term-3'], 'term-3', [1]], [['term-1', 'term-2'], 'term-1', [0.5, 0.5]]]);
    expect(placements(h)).toEqual([['term-3', 'panel'], ['term-1', 'panel'], ['term-2', 'panel']]);
    expect(lastState(h).activeId).toBe('term-1');
    expect(tabIds(h)).toEqual([]);
  });

  it('refuses a step of an editor terminal, an editor target, and a join into a full group', async () => {
    const h = singlesOf(2);
    for (let pane = 1; pane < MAX_TERMINAL_GROUP_PANES; pane++) await h.service.split('term-1');
    h.service.move({ kind: 'toEditor', id: 'term-2' });
    const editorId = `term-${MAX_TERMINAL_GROUP_PANES + 2}`;
    h.service.create({ profileId: null, target: { current: true } }, false);
    h.service.move({ kind: 'toEditor', id: editorId });
    const published = h.states.length;
    h.service.move({ kind: 'step', id: 'term-2', delta: 1 });
    h.service.move({ kind: 'reorder', id: 'term-2', target: editorId, side: 'after' });
    h.service.move({ kind: 'join', id: 'term-1', target: editorId, side: 'after' });
    h.service.move({ kind: 'join', id: 'term-2', target: 'term-1', side: 'after' });
    expect(h.states).toHaveLength(published);
    expect(h.logs).toEqual(expect.arrayContaining([
      '[terminal] not stepping term-2: it is in the editor',
      `[terminal] not moving term-2 next to ${editorId}: no such panel terminal`,
      `[terminal] not joining term-1 to ${editorId}: no such panel terminal`,
      `[terminal] not joining term-2 to term-1: its group has ${MAX_TERMINAL_GROUP_PANES} panes`,
    ]));
    expect(tabIds(h)).toEqual(['terminal:term-2', `terminal:${editorId}`]);
  });

  it('keeps editor terminals out of the group commands: split, unsplit, Join Terminals and its candidates', async () => {
    const h = singlesOf(3);
    h.service.move({ kind: 'toEditor', id: 'term-3' });
    expect(h.service.joinCandidates('term-1')).toEqual(['term-2']);
    expect(h.service.joinRoom('term-3')).toBe(0);
    await h.service.split('term-3');
    h.service.unsplit('term-3');
    h.service.join('term-1', ['term-3']);
    expect(groupsOf(h).map(([panes]) => panes)).toEqual([['term-1'], ['term-2']]);
    expect(h.logs).toContain('[terminal] not joining term-3 to term-1: no such panel terminal');
    expect(tabIds(h)).toEqual(['terminal:term-3']);
  });

  it('targets the last terminal focused, selected or activated as a tab, falling back to the panel\'s active one once it is gone', async () => {
    const h = singlesOf(2);
    await h.service.split('term-2');
    h.service.move({ kind: 'toEditor', id: 'term-1' });
    h.service.select('term-3');
    expect(h.service.splitActive()).toBe(true);
    const changes = h.changes;
    h.service.inputFocused('term-1');
    expect(h.service.commandTarget()).toBe('term-1');
    expect(h.changes).toBe(changes + 1);
    // the pass keys follow the target's group
    expect(h.service.splitActive()).toBe(false);
    expect(lastState(h).passKeys).toEqual(['CmdOrCtrl+P']);
    expect(lastState(h).activeId).toBe('term-3');
    h.service.inputFocused('term-99');
    expect(h.service.commandTarget()).toBe('term-1');
    h.service.select('term-2');
    expect(h.service.commandTarget()).toBe('term-2');
    h.service.tabSource.activate('terminal:term-1');
    expect(h.service.commandTarget()).toBe('term-1');
    expect(h.focused.at(-1)).toBe('term-1');
    h.service.tabSource.activate('terminal:term-2');
    expect(h.service.commandTarget()).toBe('term-1');
    h.service.kill('term-1');
    expect(h.service.commandTarget()).toBe('term-2');
    expect(tabIds(h)).toEqual([]);
  });

  it('publishes a selection once, though its new target changes the pass keys too', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    h.service.create({ profileId: null, target: { current: true } }, false);
    const [published, changes] = [h.states.length, h.changes];
    h.service.select('term-1');
    expect(h.states).toHaveLength(published + 1);
    expect(h.changes).toBe(changes + 1);
    expect(lastState(h)).toMatchObject({ activeId: 'term-1', passKeys: ['CmdOrCtrl+P', 'Ctrl+Shift+5', 'Alt+Left', 'Alt+Right'] });
  });

  // Split Terminal cannot run for an editor terminal, so its key must reach that terminal's pty
  it('publishes the pass keys again when the target moves between the panel and the editor, its group unchanged', () => {
    const h = singlesOf(2);
    h.service.move({ kind: 'toEditor', id: 'term-1' });
    expect(lastState(h).passKeys).toEqual(['CmdOrCtrl+P']);
    h.service.select('term-2');
    expect(lastState(h).passKeys).toEqual(['CmdOrCtrl+P', 'Ctrl+Shift+5']);
    h.service.inputFocused('term-1');
    expect(lastState(h).passKeys).toEqual(['CmdOrCtrl+P']);
  });

  it('closes terminal tabs as Kill does: one question for them all, nothing killed on Cancel', async () => {
    const h = singlesOf(3);
    h.settings = { confirmOnKill: 'always' };
    h.service.move({ kind: 'toEditor', id: 'term-1' });
    h.service.move({ kind: 'toEditor', id: 'term-2' });
    await settle();
    h.answer = false;
    await h.service.tabSource.close(['terminal:term-1', 'terminal:term-2', 'terminal:term-3', 'term-1']);
    expect(h.asked).toEqual([[{ name: 'PowerShell', command: null }, { name: 'PowerShell', command: null }]]);
    expect(tabIds(h)).toEqual(['terminal:term-1', 'terminal:term-2']);
    h.answer = true;
    await h.service.tabSource.close(['terminal:term-1', 'terminal:term-2']);
    expect(tabIds(h)).toEqual([]);
    expect(idsOf(h)).toEqual(['term-3']);
    expect(h.posted.filter((message) => (message as { type: string }).type === 'kill')).toEqual([{ type: 'kill', id: 'term-1' }, { type: 'kill', id: 'term-2' }]);
  });

  it('saves the editor\'s terminals in tab order, a remote one by id, and restores them as editor tabs without focus', async () => {
    const REMOTE: TerminalProject = { key: 'loopback|c:\\work\\remote', name: 'remote', fsPath: 'C:\\work\\remote' };
    const h = harness();
    h.projects = [ALPHA, BETA, REMOTE];
    h.service.create({ profileId: 'pwsh', target: { project: ALPHA.key } }, false);
    const remote = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    h.service.create({ profileId: 'git-bash', target: { project: BETA.key } }, false);
    await settle();
    if (!remote.ok) throw new Error('no remote terminal');
    h.service.move({ kind: 'toEditor', id: remote.id });
    h.service.move({ kind: 'toEditor', id: 'term-1' });
    h.service.setColor('term-1', 'red');
    const layout = h.persisted.at(-1)!;
    expect(layout).toMatchObject({ groups: [{ panes: [stored('git-bash', BETA.key)] }], active: 0 });
    expect(layout.editor).toEqual([{ kind: 'remote', id: remote.id }, { ...stored('pwsh', ALPHA.key), color: 'red' }]);

    const relaunch = harness({ saved: { ...layout, editor: [{ ...stored('pwsh', ALPHA.key), color: 'red' }, stored('git-bash', BETA.key)] } });
    relaunch.service.restore([]);
    await settle();
    expect(placements(relaunch)).toEqual([['term-1', 'panel'], ['term-2', 'editor'], ['term-3', 'editor']]);
    expect(lastState(relaunch).terminals.find((terminal) => terminal.id === 'term-2')!.color).toBe('red');
    expect(relaunch.focused).toEqual([]);
    expect(relaunch.shownTabs).toEqual([]);
    expect(relaunch.editorTabs).toBeGreaterThan(0);
    expect(lastState(relaunch).activeId).toBe('term-1');
    expect(relaunch.persisted.at(-1)!.editor).toEqual([{ ...stored('pwsh', ALPHA.key), color: 'red' }, stored('git-bash', BETA.key)]);
  });
});

describe('profile options', () => {
  it('lists a user profile with its source, icon and color, and shows paths and args only as cleaned display copies', async () => {
    const h = harness();
    const file = 'C:\\tools\\evil\u202Eexe.txt';
    h.profiles = [PWSH, { id: 'user:Dev', name: 'Dev', file, args: ['-a\u202Eb'], icon: 'powershell', source: 'user', customIcon: 'code', color: 'magenta' }];
    expect(h.service.profileOptions().at(-1)).toEqual({
      id: 'user:Dev', name: 'Dev', path: 'C:\\tools\\evilexe.txt', args: ['-ab'], source: 'user', icon: 'powershell', customIcon: 'code', color: 'magenta', isDefault: false,
    });
    h.service.create({ profileId: 'user:Dev', target: { current: true } }, false);
    await settle();
    expect(h.ptys[0]!.file).toBe(file);
    expect(lastState(h).terminals[0]).toMatchObject({ customIcon: 'code', color: 'magenta' });
  });
});
