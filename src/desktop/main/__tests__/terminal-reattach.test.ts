import { describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { HostMessage, HostRequest, KeptShellSequence, ScreenMark } from '../../pty-host/protocol';
import type { TerminalData, TerminalInfo, TerminalScreen, TerminalState } from '../../preload/terminal-channels';
import type { PtyHostExit, PtyHostProcess } from '../../workspace/host-starters';
import { createTerminalBackend, type LiveTerminal, type TerminalBackend } from '../../workspace/terminal/terminal-backend';
import { NONCE_ENV } from '../../workspace/terminal/shell-integration-injection';
import type { RemoteTerminalRecord } from '../remote/remote-state';
import { DEFAULT_PERSISTED_TERMINALS, TerminalService, type TerminalProject, type TerminalServiceSettings } from '../terminal/terminal-service';
import { detectedProfile } from '../terminal/user-profiles';
import { testWorkspaces } from './test-workspaces';

const SETTINGS: TerminalServiceSettings = {
  defaultProfile: '', multiLinePasteWarning: 'auto', fontSize: 13, scrollback: 1000, cursorStyle: 'block', fontFamily: 'Cascadia Code',
  lineHeight: 1.2, cursorBlinking: false, macOptionIsMeta: false, decorationsEnabled: true, shellIntegration: true, confirmOnKill: 'never',
};
const osc = (body: string): string => `\x1b]633;${body}\x07`;

// A pty host the test answers for: every request main posts, and the messages the test sends back.
async function harness() {
  const posted: HostRequest[] = [];
  let receive: (message: unknown) => void = () => undefined;
  let exit: (exit: PtyHostExit) => void = () => undefined;
  const host: PtyHostProcess = {
    postMessage: (message) => posted.push(structuredClone(message)),
    onMessage: (listener) => { receive = listener; },
    onExit: (listener) => { exit = listener; },
    kill: () => undefined,
  };
  const backend = createTerminalBackend({ starters: { startPtyHost: () => host }, platform: 'win32', scriptsDir: 'C:\\scripts', zshDotDir: 'C:\\zsh', homedir: 'C:\\Users\\me', env: {}, log: () => undefined });
  const data: TerminalData[] = [];
  const screens: TerminalScreen[] = [];
  const restoring: boolean[] = [];
  const service = new TerminalService({
    workspaces: { ...testWorkspaces({ watchers: createFakePlatform().fileWatchers, terminals: backend }) },
    profiles: () => [detectedProfile({ id: 'pwsh', name: 'PowerShell', file: 'C:\\pwsh\\pwsh.exe', args: [], icon: 'powershell' })],
    profilesReady: () => true,
    projects: () => [],
    pickerProjects: () => [],
    currentProjectKey: () => undefined,
    rootEnv: () => ({}),
    settings: () => SETTINGS,
    env: async () => ({ PATH: 'C:\\bin' }),
    osOf: () => 'linux',
    persistRemote: () => undefined,
    passKeys: () => [],
    screenReader: () => false,
    windowsBuild: () => 19045,
    persisted: () => DEFAULT_PERSISTED_TERMINALS,
    persist: () => undefined,
    onDidChange: () => undefined,
    spawnFailed: (message) => message,
    launchFailed: (failure) => failure.reason,
    log: () => undefined,
    platform: 'win32',
    homedir: 'C:\\Users\\me',
    confirmKill: async () => true,
  });
  service.attach({
    state: (state) => restoring.push(state.terminals[0]?.restoring ?? false),
    data: (batch) => data.push(batch),
    screen: (screen) => screens.push(screen),
    focus: () => undefined,
  });
  const created = service.create({ profileId: null, target: { home: true } }, false);
  if (!created.ok) throw new Error('no terminal');
  const id = created.id;
  // the spawn waits on the backend's environment, which resolves on a later turn
  const spawn = await vi.waitFor(() => {
    const found = posted.find((request) => request.type === 'spawn');
    if (!found) throw new Error('no spawn yet');
    return found;
  });
  const nonce = spawn.type === 'spawn' ? spawn.env[NONCE_ENV]! : '';
  const send = (message: HostMessage): void => receive(structuredClone(message));
  send({ type: 'ready', id, pid: 7 });
  return { service, id, nonce, posted, data, screens, restoring, send, exit: (code = 1) => exit({ code, reason: null, error: null }) };
}

const REMOTE: TerminalProject = { key: 'loopback|/srv/app', name: 'app', fsPath: '/srv/app' };
const BASH = { id: 'bash', name: 'bash', file: '/usr/bin/bash', args: [], icon: 'bash' } as const;
const record = (id: string, nonce: string): RemoteTerminalRecord => ({ id, projectKey: REMOTE.key, profile: BASH, startCwd: '/srv/app', nonce, name: null, customIcon: null, color: null });

// A daemon's terminals after this app relaunched: its backend lists what still runs, and the test answers for its pty host.
function remoteHarness(live: readonly LiveTerminal[], now?: () => number) {
  const posted: HostRequest[] = [];
  const logs: string[] = [];
  let killed = false;
  let receive: (message: unknown) => void = () => undefined;
  const host: PtyHostProcess = {
    postMessage: (message) => posted.push(structuredClone(message)),
    onMessage: (listener) => { receive = listener; },
    onExit: () => undefined,
    kill: () => { killed = true; },
  };
  const backend: TerminalBackend = {
    ...createTerminalBackend({ starters: { startPtyHost: () => host }, platform: 'linux', scriptsDir: '/scripts', zshDotDir: '/zsh', homedir: '/home/me', env: {}, log: () => undefined }),
    list: async () => live,
  };
  const screens: TerminalScreen[] = [];
  const states: TerminalState[] = [];
  const service = new TerminalService({
    workspaces: testWorkspaces({ watchers: createFakePlatform().fileWatchers, terminals: backend }),
    profiles: () => [detectedProfile(BASH)],
    profilesReady: () => true,
    projects: () => [REMOTE],
    pickerProjects: () => [REMOTE],
    currentProjectKey: () => REMOTE.key,
    rootEnv: () => ({}),
    settings: () => SETTINGS,
    env: async () => ({ PATH: '/bin' }),
    osOf: () => 'linux',
    persistRemote: () => undefined,
    passKeys: () => [],
    screenReader: () => false,
    windowsBuild: () => null,
    persisted: () => DEFAULT_PERSISTED_TERMINALS,
    persist: () => undefined,
    onDidChange: () => undefined,
    spawnFailed: (message) => message,
    launchFailed: (failure) => failure.reason,
    log: (line) => logs.push(line),
    platform: 'win32',
    homedir: 'C:\\Users\\me',
    confirmKill: async () => true,
    ...(now ? { now } : {}),
  });
  service.attach({ state: (state) => states.push(state), data: () => undefined, screen: (screen) => screens.push(screen), focus: () => undefined });
  const info = (id: string): TerminalInfo => states.at(-1)!.terminals.find((terminal) => terminal.id === id)!;
  return { service, backend, posted, screens, info, logs, killed: () => killed, send: (message: HostMessage): void => receive(structuredClone(message)), sendRaw: (message: unknown): void => receive(structuredClone(message)) };
}

// What the pty host's screen kept of a bash session: `echo one`, `cd sub`, then `sleep 120` still running, at the host's times.
const keptSession = (nonce: string): KeptShellSequence[] => [
  `A;${nonce}`, `B;${nonce}`, `E;echo one;${nonce}`, `C;${nonce}`, `D;0;${nonce}`,
  `A;${nonce}`, `B;${nonce}`, `E;cd sub;${nonce}`, `C;${nonce}`, `D;0;${nonce}`, `P;Cwd=/srv/app/sub;${nonce}`,
  `A;${nonce}`, `B;${nonce}`, `E;sleep 120;${nonce}`, `C;${nonce}`,
].map((body, index) => ({ index, body, time: 5000 + index }));
// The rows the screen recorded for each marked sequence of keptSession.
const keptMarks: ScreenMark[] = [
  { index: 0, line: 0 }, { index: 1, line: 0 }, { index: 3, line: 1 }, { index: 4, line: 2 }, { index: 5, line: 2 }, { index: 6, line: 2 },
  { index: 8, line: 3 }, { index: 9, line: 4 }, { index: 11, line: 4 }, { index: 12, line: 4 }, { index: 14, line: 5 },
];
// The restored marks main builds from keptSession at keptMarks.
const keptEvents: TerminalScreen['marks'] = [
  { line: 0, event: { kind: 'promptStart' } },
  { line: 0, event: { kind: 'commandStart' } },
  { line: 1, event: { kind: 'commandExecuted', commandId: 1, commandLine: 'echo one', time: 5003 } },
  { line: 2, event: { kind: 'commandFinished', commandId: 1, exitCode: 0, time: 5004 } },
  { line: 2, event: { kind: 'promptStart' } },
  { line: 2, event: { kind: 'commandStart' } },
  { line: 3, event: { kind: 'commandExecuted', commandId: 2, commandLine: 'cd sub', time: 5008 } },
  { line: 4, event: { kind: 'commandFinished', commandId: 2, exitCode: 0, time: 5009 } },
  { line: 4, event: { kind: 'promptStart' } },
  { line: 4, event: { kind: 'commandStart' } },
  { line: 5, event: { kind: 'commandExecuted', commandId: 3, commandLine: 'sleep 120', time: 5014 } },
];

describe('terminal reattach in main', () => {
  it('asks a reloaded page\'s live terminal for its screen and drops its output until the screen arrives, acking it itself', async () => {
    const h = await harness();
    h.send({ type: 'data', id: h.id, data: 'before\r\n' });
    expect(h.data.map((batch) => batch.data)).toEqual(['before\r\n']);
    h.posted.length = 0;
    h.service.shellLoaded();
    expect(h.posted).toEqual([{ type: 'clearAck', id: h.id }, { type: 'serialize', id: h.id }]);
    expect(h.restoring.at(-1)).toBe(true);
    h.send({ type: 'data', id: h.id, data: 'in the screen' });
    expect(h.data.map((batch) => batch.data)).toEqual(['before\r\n']);
    expect(h.posted.at(-1)).toEqual({ type: 'ack', id: h.id, chars: 'in the screen'.length });
    h.send({ type: 'screen', id: h.id, data: 'before\r\nin the screen', cols: 80, rows: 24, marks: [], sequences: 0 });
    expect(h.screens).toEqual([{ id: h.id, data: 'before\r\nin the screen', cols: 80, rows: 24, marks: [] }]);
    expect(h.restoring.at(-1)).toBe(false);
    h.send({ type: 'data', id: h.id, data: ' after' });
    expect(h.data.map((batch) => batch.data)).toEqual(['before\r\n', ' after']);
  });

  it('maps each mark\'s sequence index to the trusted events main parsed there, and leaves untrusted ones out', async () => {
    const h = await harness();
    // indexes 0: A, 1: forged A, 2: B, 3: E, 4: C, 5: D, 6: C without E, 7: A, before which main finishes the command of 6
    h.send({ type: 'data', id: h.id, data: `${osc(`A;${h.nonce}`)}${osc('A;forged')}$ ${osc(`B;${h.nonce}`)}ls${osc(`E;ls;${h.nonce}`)}\r\n${osc(`C;${h.nonce}`)}out\r\n${osc(`D;0;${h.nonce}`)}` });
    h.send({ type: 'data', id: h.id, data: `${osc(`C;${h.nonce}`)}${osc(`A;${h.nonce}`)}$ ` });
    h.service.shellLoaded();
    h.send({ type: 'screen', id: h.id, data: 'x', cols: 80, rows: 24, marks: [{ index: 0, line: 0 }, { index: 1, line: 0 }, { index: 2, line: 0 }, { index: 4, line: 1 }, { index: 5, line: 2 }, { index: 6, line: 3 }, { index: 7, line: 3 }], sequences: 8 });
    const marks = h.screens[0]!.marks;
    expect(marks.map(({ line, event }) => [line, event.kind])).toEqual([
      [0, 'promptStart'],
      [0, 'commandStart'],
      [1, 'commandExecuted'],
      [2, 'commandFinished'],
      [3, 'commandExecuted'],
      [3, 'commandFinished'],
      [3, 'promptStart'],
    ]);
    expect(marks[2]!.event).toMatchObject({ commandId: 1, commandLine: 'ls' });
    expect(marks[3]!.event).toMatchObject({ commandId: 1, exitCode: 0 });
  });

  it('answers only the last of two reloads, dropping the older screen and the output between them', async () => {
    const h = await harness();
    h.service.shellLoaded();
    h.service.shellLoaded();
    h.send({ type: 'screen', id: h.id, data: 'first', cols: 80, rows: 24, marks: [], sequences: 0 });
    h.send({ type: 'data', id: h.id, data: 'between' });
    h.send({ type: 'screen', id: h.id, data: 'firstbetween', cols: 80, rows: 24, marks: [], sequences: 0 });
    expect(h.screens.map((screen) => screen.data)).toEqual(['firstbetween']);
    expect(h.data).toEqual([]);
  });

  it('stops waiting for a screen once the terminal or its host ended', async () => {
    const h = await harness();
    h.service.shellLoaded();
    h.send({ type: 'exit', id: h.id, exitCode: 0 });
    expect(h.restoring.at(-1)).toBe(false);
    const other = await harness();
    other.service.shellLoaded();
    other.exit();
    expect(other.restoring.at(-1)).toBe(false);
  });

  it('asks no screen of an exited terminal, whose host keeps none', async () => {
    const h = await harness();
    h.send({ type: 'exit', id: h.id, exitCode: 0 });
    h.posted.length = 0;
    h.service.shellLoaded();
    expect(h.posted).toEqual([]);
  });

  it('tells the pty host about the menu\'s Clear', async () => {
    const h = await harness();
    h.service.clear(h.id);
    expect(h.posted.at(-1)).toEqual({ type: 'clear', id: h.id });
  });
});

describe('a remote terminal reattached after a relaunch', () => {
  it('an adopted terminal rebuilds marks, commands, running command, cwd and process name from the screen, and a wrong-nonce payload changes nothing', async () => {
    const nonce = 'ab'.repeat(16);
    const forged = 'cd'.repeat(16);
    const shell = 'term-111111111111111';
    const editor = 'term-222222222222222';
    const h = remoteHarness([{ id: shell, pid: 5, cols: 80, rows: 24 }, { id: editor, pid: 6, cols: 80, rows: 24 }]);
    await h.service.reattach(h.backend, [record(shell, nonce), record(editor, nonce)]);
    expect(h.posted.filter((request) => request.type === 'serialize').map((request) => request.id)).toEqual([shell, editor]);

    // a forged D would finish `sleep 120` and a forged P move the folder
    const forgedTail: KeptShellSequence[] = [{ index: 15, body: `D;1;${forged}`, time: 6000 }, { index: 16, body: `P;Cwd=/etc;${forged}`, time: 6001 }];
    h.send({ type: 'screen', id: shell, data: '$ sleep 120', cols: 80, rows: 24, marks: keptMarks, sequences: 17, shellSequences: [...keptSession(nonce), ...forgedTail], processName: 'sleep' });
    expect(h.screens.at(-1)).toEqual({ id: shell, data: '$ sleep 120', cols: 80, rows: 24, marks: keptEvents });
    expect(h.info(shell)).toMatchObject({ status: 'running', integrated: true, running: 'sleep 120', title: 'sleep 120', description: 'sub', restoring: false });
    expect([1, 2, 3, 4].map((commandId) => h.service.commandFacts(shell, commandId))).toEqual([
      { commandLine: 'echo one', exitCode: 0 },
      { commandLine: 'cd sub', exitCode: 0 },
      { commandLine: 'sleep 120', exitCode: null },
      undefined,
    ]);
    expect(h.service.cwdOf(shell)).toBe('/srv/app/sub');
    // live output goes on from the screen's count
    h.send({ type: 'data', id: shell, data: `\x1b]633;D;0;${nonce}\x07` });
    expect(h.service.commandFacts(shell, 3)).toEqual({ commandLine: 'sleep 120', exitCode: 0 });

    // a terminal with no trusted payload: only its process name, which a Linux host reports as argv[0]
    h.send({ type: 'screen', id: editor, data: '~', cols: 80, rows: 24, marks: [{ index: 0, line: 0 }], sequences: 2, shellSequences: [{ index: 0, body: `A;${forged}`, time: 6000 }, { index: 1, body: `P;Cwd=/etc;${forged}`, time: 6001 }], processName: '/usr/bin/vim' });
    expect(h.screens.at(-1)).toEqual({ id: editor, data: '~', cols: 80, rows: 24, marks: [] });
    expect(h.info(editor)).toMatchObject({ status: 'running', integrated: false, running: 'vim', title: 'vim', description: null });
    expect(h.service.cwdOf(editor)).toBe('/srv/app');
  });

  it('a terminal another device started, opened here, shows its marks', async () => {
    const nonce = 'ef'.repeat(16);
    const id = 'term-333333333333333';
    const h = remoteHarness([{ id, pid: 7, cols: 80, rows: 24, view: { root: '/srv/app', profile: BASH, startCwd: '/srv/app', nonce } }]);
    await h.service.open(h.backend, 'loopback', id);
    h.send({ type: 'screen', id, data: '$ sleep 120', cols: 80, rows: 24, marks: keptMarks, sequences: 15, shellSequences: keptSession(nonce) });
    expect(h.screens.at(-1)!.marks).toEqual(keptEvents);
    expect(h.info(id)).toMatchObject({ integrated: true, running: 'sleep 120', description: 'sub' });
  });

  it('puts replayed command times on this computer\'s clock: now less each payload\'s age on the host\'s clock', async () => {
    const nonce = 'ab'.repeat(16);
    const id = 'term-111111111111111';
    // this computer's clock reads 10 minutes behind the host's
    const h = remoteHarness([{ id, pid: 5, cols: 80, rows: 24 }], () => 1_000_000);
    await h.service.reattach(h.backend, [record(id, nonce)]);
    const hostNow = 5014 + 600_000;
    const ahead = keptSession(nonce).map((kept) => ({ ...kept, time: kept.time + 600_000 }));
    h.send({ type: 'screen', id, data: '$ sleep 120', cols: 80, rows: 24, marks: keptMarks, sequences: 15, shellSequences: ahead, now: hostNow });
    const times = h.screens.at(-1)!.marks.flatMap(({ event }) => ('time' in event ? [event.time] : []));
    expect(times).toEqual([5003, 5004, 5008, 5009, 5014].map((time) => 1_000_000 - (5014 - time)));
  });

  it('gives a payload the host\'s clock dates after the screen\'s serialize this computer\'s now, never a time to come', async () => {
    const nonce = 'ab'.repeat(16);
    const id = 'term-111111111111111';
    const h = remoteHarness([{ id, pid: 5, cols: 80, rows: 24 }], () => 1_000_000);
    await h.service.reattach(h.backend, [record(id, nonce)]);
    // the host's clock stepped back between the C and the serialize
    h.send({ type: 'screen', id, data: '$ sleep 120', cols: 80, rows: 24, marks: keptMarks, sequences: 15, shellSequences: keptSession(nonce), now: 5013 });
    expect(h.screens.at(-1)!.marks.at(-1)!.event).toMatchObject({ kind: 'commandExecuted', time: 1_000_000 });
  });

  it('replays a kept payload only where live output would apply it: one holding DEL, which xterm keeps, is malformed', async () => {
    const nonce = 'ab'.repeat(16);
    const id = 'term-111111111111111';
    const h = remoteHarness([{ id, pid: 5, cols: 80, rows: 24 }]);
    await h.service.reattach(h.backend, [record(id, nonce)]);
    const withDel: KeptShellSequence = { index: 15, body: `P;Cwd=/srv/a\x7fb;${nonce}`, time: 5015 };
    h.send({ type: 'screen', id, data: '$ ', cols: 80, rows: 24, marks: keptMarks, sequences: 16, shellSequences: [...keptSession(nonce), withDel] });
    expect(h.service.cwdOf(id)).toBe('/srv/app/sub');
    h.send({ type: 'data', id, data: `\x1b]633;${withDel.body}\x07` });
    expect(h.service.cwdOf(id)).toBe('/srv/app/sub');
    // a C0 control xterm leaves out of the payload the screen keeps is left out of the live body too
    h.send({ type: 'data', id, data: `\x1b]633;P;Cwd=/srv/\rx;${nonce}\x07` });
    expect(h.service.cwdOf(id)).toBe('/srv/x');
  });

  it('keeps a screen whose optional field breaks the contract without that field, logging it, and keeps the host running', async () => {
    const nonce = 'ab'.repeat(16);
    const id = 'term-111111111111111';
    const h = remoteHarness([{ id, pid: 5, cols: 80, rows: 24 }]);
    await h.service.reattach(h.backend, [record(id, nonce)]);
    h.sendRaw({ type: 'screen', id, data: '$ sleep 120', cols: 80, rows: 24, marks: keptMarks, sequences: 15, shellSequences: [...keptSession(nonce)].reverse(), processName: 'sleep' });
    expect(h.killed()).toBe(false);
    expect(h.screens.at(-1)).toEqual({ id, data: '$ sleep 120', cols: 80, rows: 24, marks: [] });
    expect(h.info(id)).toMatchObject({ status: 'running', integrated: false, title: 'sleep' });
    expect(h.logs).toContain(`[terminal] dropped the shellSequences of ${id}'s screen, which is outside the contract`);
  });
});
