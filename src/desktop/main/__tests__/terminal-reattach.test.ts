import { describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { HostMessage, HostRequest } from '../../pty-host/protocol';
import type { TerminalData, TerminalScreen } from '../../preload/terminal-channels';
import type { PtyHostExit, PtyHostProcess } from '../../workspace/host-starters';
import { createTerminalBackend } from '../../workspace/terminal/terminal-backend';
import { NONCE_ENV } from '../../workspace/terminal/shell-integration-injection';
import { DEFAULT_PERSISTED_TERMINALS, TerminalService, type TerminalServiceSettings } from '../terminal/terminal-service';
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
