import type { RemoteTerminalRecord } from '../remote/remote-state';
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
import { pickNewTerminal } from '../terminal-pick';
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
  type PersistedTerminal,
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
const stored = (profileId: string, projectKey: string | null): PersistedTerminal => ({ profileId, projectKey, name: null, customIcon: null, color: null });

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
  // each list of remote terminals main gave remote-state.json
  readonly remote: RemoteTerminalRecord[][];
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
  readonly logs: string[];
  // the environment main reads at each spawn
  env: Record<string, string>;
  // Chromium's accessibility support, which each published state reads
  screenReader: boolean;
  // variables a root's terminals add, by root key
  rootEnv: Record<string, Record<string, string>>;
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
    remote: [],
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
    logs: [],
    env: { PATH: 'C:\\bin', TERM_TEST: '1' },
    screenReader: false,
    rootEnv: {},
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
    currentProjectKey: () => h.current,
    rootEnv: (key) => h.rootEnv[key] ?? {},
    settings: () => ({ ...SETTINGS, defaultProfile: options.defaultProfile ?? '', ...h.settings }),
    env: async () => h.env,
    osOf: () => 'linux',
    persistRemote: (terminals) => h.remote.push([...terminals]),
    screenReader: () => h.screenReader,
    windowsBuild: (projectKey) => (projectKey?.startsWith('loopback|') ? null : 19045),
    passKeys: (splitActive) => (splitActive ? ['CmdOrCtrl+P', 'Alt+Left', 'Alt+Right'] : ['CmdOrCtrl+P']),
    persisted: () => saved,
    persist: (terminals) => {
      saved = terminals;
      h.persisted.push(terminals);
    },
    onDidChange: () => undefined,
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
    expect(h.persisted.at(-1)!.terminals).toEqual([stored('pwsh', null)]);
    expect(h.service.linkBase('term-1')).toBeUndefined();
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
    const picked = pickNewTerminal(overlay, h.service.profileOptions(), h.service.projectOptions(), undefined);
    h.projects = [ALPHA];
    h.current = ALPHA.key;
    h.service.projectsChanged([ALPHA.key]);
    answer({ kind: 'newTerminal', profileId: 'pwsh', projectKey: null });
    const pick = (await picked)!;
    expect(pick.target).toEqual({ home: true });
    expect(h.service.create(pick, true)).toEqual({ ok: true, id: 'term-1' });
    await settle();
    expect(h.ptys.map((pty) => pty.options.cwd)).toEqual(['C:\\Users\\me']);
    expect(lastState(h).terminals.map((terminal) => terminal.projectKey)).toEqual([null]);
  });

  it('restores a saved home folder terminal in the home folder while projects are open', async () => {
    const saved: PersistedTerminals = { terminals: [stored('pwsh', null), stored('git-bash', ALPHA.key)], active: 0, listWidthRem: 12, groups: [{ panes: 1, activePane: 0, sizes: [1] }, { panes: 1, activePane: 0, sizes: [1] }] };
    const h = harness({ saved });
    h.service.restore();
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

  it('lists the current project first for the quick pick', () => {
    const h = harness();
    h.current = BETA.key;
    expect(h.service.projectOptions()).toEqual([
      { key: BETA.key, name: 'beta', path: BETA.fsPath, current: true },
      { key: ALPHA.key, name: 'alpha', path: ALPHA.fsPath, current: false },
    ]);
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
    expect(h.persisted.at(-1)?.terminals).toEqual([]);
    // a terminal opened in the worktree gets the same two variables
    h.service.create({ profileId: 'pwsh', target: { project: worktree.key } }, false);
    await settle();
    expect(h.ptys.at(-1)!.options.env).toMatchObject({ DAMOCLES_PROJECT_FOLDER: ALPHA.fsPath, DAMOCLES_WORKTREE_INDEX: '1' });
    expect(h.ptys.at(-1)!.options.env).not.toHaveProperty('EXTRA');
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
    expect(h.persisted.at(-1)).toEqual({ terminals: [{ profileId: 'pwsh', projectKey: BETA.key, name: null, customIcon: null, color: null }], active: 0, listWidthRem: DEFAULT_PERSISTED_TERMINALS.listWidthRem, groups: [{ panes: 1, activePane: 0, sizes: [1] }] });
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

  it('keeps a remote terminal in remote-state.json only, with a daemon-unique id, and leaves it out of the quit question', async () => {
    const h = harness();
    h.projects = [ALPHA, REMOTE];
    h.service.create({ profileId: 'pwsh', target: { project: ALPHA.key } }, false);
    const remote = h.service.create({ profileId: 'pwsh', target: { project: REMOTE.key } }, false);
    await settle();
    if (!remote.ok) throw new Error('no remote terminal');
    expect(remote.id).toMatch(/^term-[1-9]\d{14}$/);
    expect(h.persisted.at(-1)!.terminals).toEqual([stored('pwsh', ALPHA.key)]);
    expect(h.persisted.at(-1)!.groups).toHaveLength(1);
    expect(h.remote.at(-1)).toEqual([expect.objectContaining({ id: remote.id, projectKey: REMOTE.key, startCwd: REMOTE.fsPath, profile: expect.objectContaining({ id: 'pwsh' }) })]);
    expect(h.remote.at(-1)![0]!.nonce).not.toBe('');
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
    await h.service.reattach(backend, [...kept, gone]);
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.status, terminal.restoring])).toEqual([[created.id, 'running', true]]);
    // the daemon's screen keeps enough scrollback for this client's view once it attached
    expect(toDaemon).toEqual([{ type: 'clearAck', id: created.id }, { type: 'serialize', id: created.id }, { type: 'scrollback', id: created.id, scrollback: SETTINGS.scrollback }]);
    expect(h.remote.at(-1)!.map((record) => record.id)).toEqual([created.id]);
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
    expect(lastState(h).profiles.map((profile) => [profile.id, profile.isDefault])).toEqual([['bash', true]]);
    expect(h.service.profileOptions(REMOTE.key).map((profile) => profile.id)).toEqual(['bash']);
    expect(h.service.projectOptions().map((option) => option.key)).toEqual([REMOTE.key]);
    h.current = ALPHA.key;
    h.service.publish();
    expect(lastState(h).profiles.map((profile) => profile.id)).toEqual(['pwsh', 'git-bash']);
    expect(h.service.projectOptions().map((option) => option.key)).toEqual([ALPHA.key]);
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
    expect(lastState(h).profiles.map((profile) => profile.id)).toEqual(['pwsh', 'git-bash']);
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
    await h.service.reattach(connection.workspace.terminals, kept);
    const after = lastState(h);
    expect(after.groups).toEqual(before);
    expect(after.terminals.map((terminal) => [terminal.id, terminal.status, terminal.name])).toEqual([[first.id, 'running', null], [pane, 'running', 'server'], [last.id, 'running', null]]);
    expect(after.activeId).toBe(pane);
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
    await h.service.reattach(connection.workspace.terminals, kept);
    // the daemon's screen holds five sequences the shell printed before this client attached
    connection.daemon({ type: 'screen', id: created.id, data: '$ ', cols: 80, rows: 24, marks: [], sequences: 5 });
    connection.daemon({ type: 'data', id: created.id, data: `\r\n\x1b]633;A;${kept[0]!.nonce}\x07$ ` });
    h.service.shellLoaded();
    connection.daemon({ type: 'screen', id: created.id, data: '$ \r\n$ ', cols: 80, rows: 24, marks: [{ index: 5, line: 1 }], sequences: 6 });
    expect(h.screens.at(-1)!.marks).toEqual([{ line: 1, event: { kind: 'promptStart' } }]);
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
    expect(h.persisted.at(-1)).toEqual({
      terminals: [{ profileId: 'pwsh', projectKey: ALPHA.key, name: null, customIcon: null, color: null }, { profileId: 'git-bash', projectKey: BETA.key, name: null, customIcon: null, color: null }],
      active: 0,
      listWidthRem: TERMINAL_LIST_MAX_REM,
      groups: [{ panes: 1, activePane: 0, sizes: [1] }, { panes: 1, activePane: 0, sizes: [1] }],
    });
    expect(lastState(h)).toMatchObject({ activeId: 'term-1', listWidthRem: TERMINAL_LIST_MAX_REM, canCreate: true, passKeys: ['CmdOrCtrl+P'] });
  });

  it('restores the saved terminals without focus, skipping a missing profile or project', async () => {
    const saved: PersistedTerminals = {
      terminals: [stored('fish', ALPHA.key), { ...stored('git-bash', BETA.key), name: 'build', color: 'green' }, stored('pwsh', 'c:\\gone'), { ...stored('pwsh', ALPHA.key), customIcon: 'rocket' }],
      active: 1,
      listWidthRem: 12,
      groups: [{ panes: 1, activePane: 0, sizes: [1] }, { panes: 1, activePane: 0, sizes: [1] }, { panes: 1, activePane: 0, sizes: [1] }, { panes: 1, activePane: 0, sizes: [1] }],
    };
    const h = harness({ saved });
    h.service.restore();
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
    expect(h.persisted.at(-1)).toEqual({ terminals: [{ ...stored('git-bash', BETA.key), name: 'build', color: 'green' }, { ...stored('pwsh', ALPHA.key), customIcon: 'rocket' }], active: 0, listWidthRem: 12, groups: [{ panes: 1, activePane: 0, sizes: [1] }, { panes: 1, activePane: 0, sizes: [1] }] });
  });

  // Toggle Terminal can start one before the window page finishes loading, and so before the restore runs.
  it('restores the terminals saved as the window opened ahead of one started before the restore, which stays active', async () => {
    const saved: PersistedTerminals = { terminals: [stored('pwsh', ALPHA.key), stored('git-bash', BETA.key)], active: 1, listWidthRem: 12, groups: [{ panes: 1, activePane: 0, sizes: [1] }, { panes: 1, activePane: 0, sizes: [1] }] };
    const h = harness({ saved });
    expect(h.service.ensureTerminal()).toBe('term-1');
    h.service.restore();
    await settle();
    expect(lastState(h).terminals.map((terminal) => [terminal.id, terminal.profileId, terminal.projectKey])).toEqual([
      ['term-2', 'pwsh', ALPHA.key],
      ['term-3', 'git-bash', BETA.key],
      ['term-1', 'pwsh', ALPHA.key],
    ]);
    expect(lastState(h).activeId).toBe('term-1');
    expect(h.persisted.at(-1)).toEqual({ terminals: [stored('pwsh', ALPHA.key), stored('git-bash', BETA.key), stored('pwsh', ALPHA.key)], active: 2, listWidthRem: 12, groups: [{ panes: 1, activePane: 0, sizes: [1] }, { panes: 1, activePane: 0, sizes: [1] }, { panes: 1, activePane: 0, sizes: [1] }] });
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
    expect(h.persisted.at(-1)!.terminals).toEqual([{ ...stored('pwsh', ALPHA.key), name: 'server', customIcon: 'server', color: 'cyan' }]);
    expect(h.service.appearance('term-1')).toEqual({ icon: 'powershell', customIcon: 'server', color: 'cyan' });
    h.service.rename('term-1', null);
    h.service.setCustomIcon('term-1', null);
    h.service.setColor('term-1', null);
    expect(lastState(h).terminals[0]).toMatchObject({ title: 'PowerShell', name: null, customIcon: null, color: null });
    expect(h.persisted.at(-1)!.terminals).toEqual([stored('pwsh', ALPHA.key)]);
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

  it('publishes the detected profiles and every terminal setting the shell applies, and keeps main-only ones out', () => {
    const h = harness({ defaultProfile: 'git-bash' });
    h.service.create({ profileId: null, target: { current: true } }, false);
    const state = lastState(h);
    expect(state.profiles.map((profile) => [profile.id, profile.isDefault])).toEqual([['pwsh', false], ['git-bash', true]]);
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
    expect(lastState(h).passKeys).toEqual(['CmdOrCtrl+P']);
    expect(h.service.splitActive()).toBe(false);
    await h.service.split('term-1');
    expect(lastState(h).passKeys).toEqual(['CmdOrCtrl+P', 'Alt+Left', 'Alt+Right']);
    expect(h.service.splitActive()).toBe(true);
    h.service.create({ profileId: null, target: { current: true } }, false);
    expect(lastState(h).passKeys).toEqual(['CmdOrCtrl+P']);
  });
});

describe('split groups in the window layout', () => {
  it('saves each group\'s pane count, active pane and sizes with the list', async () => {
    const h = harness();
    h.service.create({ profileId: null, target: { current: true } }, false);
    await h.service.split('term-1');
    h.service.create({ profileId: 'git-bash', target: { project: BETA.key } }, false);
    h.service.resizePanes('group-1', [0.7, 0.3]);
    expect(h.persisted.at(-1)).toEqual({
      terminals: [stored('pwsh', ALPHA.key), stored('pwsh', ALPHA.key), stored('git-bash', BETA.key)],
      active: 2,
      listWidthRem: DEFAULT_PERSISTED_TERMINALS.listWidthRem,
      groups: [{ panes: 2, activePane: 1, sizes: [0.7, 0.3] }, { panes: 1, activePane: 0, sizes: [1] }],
    });
    h.service.select('term-1');
    expect(h.persisted.at(-1)).toMatchObject({ active: 0, groups: [{ panes: 2, activePane: 0 }, { panes: 1, activePane: 0 }] });
  });

  it('restores the groups, their sizes and active panes without focus', async () => {
    const saved: PersistedTerminals = {
      terminals: [stored('pwsh', ALPHA.key), stored('git-bash', ALPHA.key), stored('pwsh', BETA.key)],
      active: 2,
      listWidthRem: 12,
      groups: [{ panes: 2, activePane: 1, sizes: [0.7, 0.3] }, { panes: 1, activePane: 0, sizes: [1] }],
    };
    const h = harness({ saved });
    h.service.restore();
    await settle();
    expect(h.focused).toEqual([]);
    expect(groupsOf(h)).toEqual([[['term-1', 'term-2'], 'term-2', [0.7, 0.3]], [['term-3'], 'term-3', [1]]]);
    expect(lastState(h).activeId).toBe('term-3');
  });

  it('restores a group without a pane whose profile or project is gone, sharing the sizes again', async () => {
    const saved: PersistedTerminals = {
      terminals: [stored('pwsh', ALPHA.key), stored('fish', ALPHA.key), stored('git-bash', ALPHA.key), stored('pwsh', 'c:\\gone')],
      active: 1,
      listWidthRem: 12,
      groups: [{ panes: 3, activePane: 1, sizes: [0.4, 0.4, 0.2] }, { panes: 1, activePane: 0, sizes: [1] }],
    };
    const h = harness({ saved });
    h.service.restore();
    await settle();
    expect(groupsOf(h)).toEqual([[['term-1', 'term-2'], 'term-2', [0.5, 0.5]]]);
    expect(lastState(h).activeId).toBe('term-2');
  });

  it('keeps a restored group\'s active pane on its terminal when a pane before it is gone', async () => {
    const saved: PersistedTerminals = {
      terminals: [stored('fish', ALPHA.key), stored('pwsh', ALPHA.key), stored('git-bash', ALPHA.key), stored('pwsh', BETA.key)],
      active: 3,
      listWidthRem: 12,
      groups: [{ panes: 3, activePane: 1, sizes: [0.4, 0.3, 0.3] }, { panes: 1, activePane: 0, sizes: [1] }],
    };
    const h = harness({ saved });
    h.service.restore();
    await settle();
    expect(groupsOf(h)).toEqual([[['term-1', 'term-2'], 'term-1', [0.5, 0.5]], [['term-3'], 'term-3', [1]]]);
  });

  it('restores saved groups ahead of a group started before the restore, which stays active', async () => {
    const saved: PersistedTerminals = {
      terminals: [stored('pwsh', ALPHA.key), stored('pwsh', ALPHA.key)],
      active: 0,
      listWidthRem: 12,
      groups: [{ panes: 2, activePane: 0, sizes: [0.5, 0.5] }],
    };
    const h = harness({ saved });
    h.service.ensureTerminal();
    h.service.restore();
    await settle();
    expect(groupsOf(h)).toEqual([[['term-2', 'term-3'], 'term-2', [0.5, 0.5]], [['term-1'], 'term-1', [1]]]);
    expect(lastState(h).activeId).toBe('term-1');
    expect(h.focused).toEqual([]);
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
