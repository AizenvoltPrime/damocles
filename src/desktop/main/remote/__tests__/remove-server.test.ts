import { chmodSync, existsSync, mkdirSync, realpathSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunOutput } from '../../../../core/process-launcher';
import { buildPosixRemoval, buildWindowsRemoval, removalOutcome, removeServer, REMOVAL_FEATURE, type RemovalParameters } from '../remove-server';
import { powerShell, runPowerShell, runSh, scratchDir, shellPath } from '../bootstrap/__tests__/shells';
import { LOCK_STALE_MS } from '../../../daemon/lock-timing';

const RUN_KEY = '0123456789abcdef';
// a pid no process holds: above Linux's PID_MAX_LIMIT (2^22), and not a multiple of 4, as every Windows process id is
const DEAD_PID = 4_194_305;
// the user name the removal reads, as `id -un` prints it; `id -u` stays the real one
const ID_DEV = 'id() { if [ "$1" = -un ]; then echo dev; else command id "$@"; fi; }';
const OTHER_RUN = 'fedcba9876543210';
const ENTRY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)}`;
const OTHER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBB other@host';
// folders that only look like version folders: no version name, or no package manifest
const LOOK_ALIKES = ['3.8.0-linux-x64', '3.8.0-win32-x64', '3.9.0-linux-x64-copy', 'MyApp-linux-x64', 'MyApp-win32-x64', 'node-v20.11.0-linux-x64', 'node-v20.11.0-win32-x64', 'notes-linux-x64', 'notes-win32-x64'];

const lines = (output: RunOutput): unknown[] => output.stdout.toString('utf8').split(/\r?\n/).flatMap((line) => {
  const at = line.indexOf('@@DAMOCLES ');
  return at < 0 ? [] : [JSON.parse(line.slice(at + '@@DAMOCLES '.length)) as unknown];
});

describe('the removal stage text', () => {
  it('fills the parameter block with quoted literals only, a folder holding a space, a quote and $ included', () => {
    const params: RemovalParameters = { runKey: RUN_KEY, installFolder: "/opt/it's $x", key: { entry: ENTRY, file: '/home/dev/.ssh/authorized_keys' }, disableLinger: true };
    const posix = buildPosixRemoval(params);
    expect(posix).toContain(`D_RUN_KEY='${RUN_KEY}'\nD_INSTALL_FOLDER='/opt/it'\\''s $x'\nD_PREVIOUS_FOLDER=''\nD_KEY='${ENTRY}'\nD_KEY_FILE='/home/dev/.ssh/authorized_keys'\nD_DISABLE_LINGER='1'\n# END PARAMETERS`);
    const windows = buildWindowsRemoval({ runKey: RUN_KEY, installFolder: "D:\\it's $x", disableLinger: false });
    expect(windows).toContain(`$D_RUN_KEY = '${RUN_KEY}'\n$D_INSTALL_FOLDER = 'D:\\it''s $x'\n$D_PREVIOUS_FOLDER = ''\n$D_KEY = ''\n$D_KEY_FILE = ''\n# END PARAMETERS`);
  });

  it('leaves the key out and linger off unless asked', () => {
    const posix = buildPosixRemoval({ runKey: RUN_KEY, disableLinger: false });
    expect(posix).toContain("D_KEY=''\nD_KEY_FILE=''\nD_DISABLE_LINGER='0'");
  });

  it('refuses parameters that are not what the host store records', () => {
    expect(() => buildPosixRemoval({ runKey: '../x', disableLinger: false })).toThrow(RangeError);
    expect(() => buildPosixRemoval({ runKey: RUN_KEY, installFolder: 'relative', disableLinger: false })).toThrow(RangeError);
    expect(() => buildPosixRemoval({ runKey: RUN_KEY, key: { entry: `${ENTRY} comment`, file: '/k' }, disableLinger: false })).toThrow(RangeError);
    expect(() => buildPosixRemoval({ runKey: RUN_KEY, key: { entry: ENTRY, file: '/k\n/x' }, disableLinger: false })).toThrow(RangeError);
    expect(() => buildPosixRemoval({ runKey: RUN_KEY, previousInstallFolder: '/opt/a\rb', disableLinger: false })).toThrow(RangeError);
    expect(() => buildWindowsRemoval({ runKey: RUN_KEY, disableLinger: true })).toThrow('no linger');
  });
});

describe('the removal stage outcome', () => {
  it('is removed with its notices only once the stage said so and exited 0', () => {
    const versionKept = '{"kind":"notice","code":"versionKept","params":{"version":"3.6.0","machine":"lab-2"}}';
    expect(removalOutcome([versionKept, '{"kind":"removed"}'], 0)).toEqual({ ok: true, notices: [{ code: 'versionKept', params: { version: '3.6.0', machine: 'lab-2' } }] });
    expect(removalOutcome(['{"kind":"removed"}'], 1)).toEqual({ ok: false, code: 'stageFailed', params: { code: 'exit', exitCode: '1' } });
    expect(removalOutcome([versionKept], 0)).toEqual({ ok: false, code: 'stageFailed', params: { code: 'exit', exitCode: '0' } });
    expect(removalOutcome([versionKept], null)).toEqual({ ok: false, code: 'stageFailed', params: { code: 'killed' } });
    expect(removalOutcome(['{"kind":"fail","code":"daemonRunning","params":{}}'], 1)).toEqual({ ok: false, code: 'daemonRunning', params: {} });
    expect(removalOutcome(['{"kind":"notice","code":"evil","params":{}}', '{"kind":"removed"}'], 0)).toEqual({ ok: false, code: 'stageFailed', params: { code: 'protocol' } });
    expect(removalOutcome(['not json'], 0)).toEqual({ ok: false, code: 'stageFailed', params: { code: 'protocol' } });
  });

  it('takes only the stageFailed codes the scripts send, and nothing else the target put beside them', () => {
    for (const code of ['keyFile', 'runKey', 'userName']) {
      expect(removalOutcome([`{"kind":"fail","code":"stageFailed","params":{"code":"${code}","extra":"x"}}`], 1)).toEqual({ ok: false, code: 'stageFailed', params: { code } });
    }
    for (const params of ['{"code":"exit"}', '{"code":"evil"}', '{}']) {
      expect(removalOutcome([`{"kind":"fail","code":"stageFailed","params":${params}}`], 1)).toEqual({ ok: false, code: 'stageFailed', params: { code: 'protocol' } });
    }
  });
});

describe('removeServer', () => {
  function daemon(features: readonly string[] = [REMOVAL_FEATURE]) {
    const order: string[] = [];
    let close!: () => void;
    const connection = {
      features,
      shutdownForRemoval: vi.fn(async () => {
        order.push('shutdown');
        return { runKey: RUN_KEY, closed: new Promise<void>((resolve) => { close = () => { order.push('closed'); resolve(); }; }) };
      }),
    };
    const runStage = vi.fn(async (script: string) => {
      order.push('stage');
      return { code: 0, lines: ['{"kind":"removed"}'], script };
    });
    return { connection, runStage, order, close: () => close() };
  }

  it('runs the stage only after the daemon ended its connection, with the run key it answered', async () => {
    const { connection, runStage, order, close } = daemon();
    const removal = removeServer({ connected: () => connection, os: 'posix', installFolder: '/opt/tools', runStage, log: () => undefined }, { disableLinger: false });
    await vi.waitFor(() => expect(order).toEqual(['shutdown']));
    expect(runStage).not.toHaveBeenCalled();
    close();
    expect(await removal).toEqual({ ok: true, notices: [] });
    expect(order).toEqual(['shutdown', 'closed', 'stage']);
    const script = runStage.mock.calls[0]![0];
    expect(script).toContain(`D_RUN_KEY='${RUN_KEY}'`);
    expect(script).toContain("D_INSTALL_FOLDER='/opt/tools'");
    expect(script).toContain("D_KEY=''");
  });

  it('runs the stage, which checks the daemon\'s lock, once the daemon has not ended its connection within the bound', async () => {
    vi.useFakeTimers();
    try {
      const { connection, runStage, order } = daemon();
      const lines: string[] = [];
      const removal = removeServer({ connected: () => connection, os: 'posix', runStage, log: (line) => lines.push(line), closeWaitMs: 1000 }, { disableLinger: false });
      await vi.advanceTimersByTimeAsync(999);
      expect(runStage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await removal).toEqual({ ok: true, notices: [] });
      expect(order).toEqual(['shutdown', 'stage']);
      expect(lines[0]).toContain('did not end its connection within 1000 ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('touches nothing on a host that is not connected or whose daemon cannot shut down for it', async () => {
    const runStage = vi.fn();
    expect(await removeServer({ connected: () => undefined, os: 'posix', runStage, log: () => undefined }, { disableLinger: false })).toEqual({ ok: false, code: 'notConnected', params: {} });
    const old = daemon(['linger']);
    expect(await removeServer({ connected: () => old.connection, os: 'posix', runStage, log: () => undefined }, { disableLinger: false })).toEqual({ ok: false, code: 'unsupported', params: {} });
    expect(old.connection.shutdownForRemoval).not.toHaveBeenCalled();
    expect(runStage).not.toHaveBeenCalled();
  });
});

// A target home as a removal finds it: this machine's run folder, another machine's live daemon on 3.6.0, installed versions,
// and folders that only look like Damocles' own.
function targetHome(): { readonly home: string; readonly server: string } {
  const home = scratchDir('remove-home-');
  const server = path.join(home, '.damocles', 'server');
  mkdirSync(path.join(server, `run-${RUN_KEY}`, 'logs'), { recursive: true });
  writeFileSync(path.join(server, `run-${RUN_KEY}`, 'logs', 'daemon.log'), 'x');
  mkdirSync(path.join(server, `run-${OTHER_RUN}`), { recursive: true });
  writeFileSync(path.join(server, `run-${OTHER_RUN}`, 'daemon.pid'), JSON.stringify({ version: '3.6.0', pid: 1, hostname: 'lab-2', endpoint: '/x', socketFolder: null, updatedAt: 1 }));
  return { home, server };
}

function installVersions(folder: string, targets: readonly string[]): void {
  for (const name of targets) {
    mkdirSync(path.join(folder, name, 'bin'), { recursive: true });
    writeFileSync(path.join(folder, name, 'server-package.json'), '{}');
  }
  // look-alikes the removal leaves: no version name, or no package marker
  for (const name of LOOK_ALIKES) mkdirSync(path.join(folder, name), { recursive: true });
  mkdirSync(path.join(folder, '.staging-abc'), { recursive: true });
  // a lock another host left 31 minutes ago, and an exec test a stage died before deleting
  mkdirSync(path.join(folder, 'install.lock'), { recursive: true });
  writeFileSync(path.join(folder, 'install.lock', 'owner'), 'other-machine 1\n');
  minutesAgo(path.join(folder, 'install.lock'), 31);
  writeFileSync(path.join(folder, '.exec-test-1'), '');
  minutesAgo(path.join(folder, '.exec-test-1'), 2);
}

function minutesAgo(file: string, minutes: number): void {
  const at = new Date(Date.now() - minutes * 60_000);
  utimesSync(file, at, at);
}

describe('the POSIX removal stage in a real sh', { timeout: 120_000 }, () => {
  const run = (home: string, params: RemovalParameters, prelude = '', edit: (script: string) => string = (script) => script) =>
    runSh(`HOME='${shellPath(home)}'\n${prelude}\n${edit(buildPosixRemoval(params))}`);
  const posixOnly = process.platform === 'win32';

  it('deletes this machine\'s run folder and every version no other live daemon names, keeps the rest, and the custom folder stays', async () => {
    const { home, server } = targetHome();
    installVersions(server, ['3.6.0-linux-x64', '3.7.0-linux-x64']);
    const folder = path.join(home, 'shared tools');
    const install = path.join(folder, 'dev');
    installVersions(install, ['3.7.0-alpine-x64']);
    writeFileSync(path.join(folder, 'README'), 'shared');
    const output = await run(home, { runKey: RUN_KEY, installFolder: shellPath(folder), disableLinger: false }, 'id() { echo dev; }');
    expect(lines(output)).toEqual([
      { kind: 'notice', code: 'versionKept', params: { version: '3.6.0', machine: 'lab-2' } },
      { kind: 'notice', code: 'serverFolderKept', params: {} },
      { kind: 'removed' },
    ]);
    expect(readdirSync(server).sort()).toEqual(['3.6.0-linux-x64', ...LOOK_ALIKES, `run-${OTHER_RUN}`].sort());
    expect(readdirSync(install).sort()).toEqual([...LOOK_ALIKES].sort());
    expect(readdirSync(folder).sort()).toEqual(['README', 'dev']);
  });

  it('deletes ~/.damocles/server when nothing else is left, and an emptied <folder>/<user> but never <folder>', async () => {
    const home = scratchDir('remove-home-');
    const server = path.join(home, '.damocles', 'server');
    mkdirSync(path.join(server, `run-${RUN_KEY}`), { recursive: true });
    const folder = path.join(home, 'tools');
    mkdirSync(path.join(folder, 'dev', '3.7.0-linux-x64'), { recursive: true });
    writeFileSync(path.join(folder, 'dev', '3.7.0-linux-x64', 'server-package.json'), '{}');
    const output = await run(home, { runKey: RUN_KEY, installFolder: shellPath(folder), disableLinger: false }, 'id() { echo dev; }');
    expect(lines(output)).toEqual([{ kind: 'removed' }]);
    expect(existsSync(server)).toBe(false);
    expect(existsSync(path.join(home, '.damocles'))).toBe(true);
    expect(readdirSync(folder)).toEqual([]);
  });

  it('removes the key line only when asked, keeping every other line, and runs loginctl disable-linger only when asked', async () => {
    const { home } = targetHome();
    const keys = path.join(home, '.ssh', 'authorized_keys');
    mkdirSync(path.dirname(keys));
    writeFileSync(keys, `${OTHER_KEY}\n${ENTRY} damocles@laptop\n`);
    // loginctl at a fixed folder; one the shell would find by name records nothing
    const bin = path.join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'loginctl'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$HOME/loginctl-args"\n', { mode: 0o755 });
    const prelude = 'loginctl() { echo bare > "$HOME/loginctl-bare"; }\nid() { echo dev; }';
    const folders = (script: string): string => script.replace("LOGINCTL_FOLDERS='/bin /usr/bin'", `LOGINCTL_FOLDERS='/nonexistent ${shellPath(bin)}'`);
    const untouched = await run(home, { runKey: RUN_KEY, disableLinger: false }, prelude, folders);
    expect(lines(untouched).at(-1)).toEqual({ kind: 'removed' });
    expect(readFileSync(keys, 'utf8')).toBe(`${OTHER_KEY}\n${ENTRY} damocles@laptop\n`);
    expect(existsSync(path.join(home, 'loginctl-args'))).toBe(false);
    const asked = await run(home, { runKey: RUN_KEY, key: { entry: ENTRY, file: shellPath(keys) }, disableLinger: true }, prelude, folders);
    expect(lines(asked).at(-1)).toEqual({ kind: 'removed' });
    expect(readFileSync(keys, 'utf8')).toBe(`${OTHER_KEY}\n`);
    expect(readFileSync(path.join(home, 'loginctl-args'), 'utf8').trim()).toBe('--no-ask-password disable-linger dev');
    expect(existsSync(path.join(home, 'loginctl-bare'))).toBe(false);
    const missing = await run(home, { runKey: RUN_KEY, disableLinger: true }, prelude, (script) => script.replace("LOGINCTL_FOLDERS='/bin /usr/bin'", "LOGINCTL_FOLDERS='/nonexistent'"));
    expect(lines(missing).slice(-2)).toEqual([{ kind: 'notice', code: 'lingerFailed', params: {} }, { kind: 'removed' }]);
    expect(existsSync(path.join(home, 'loginctl-bare'))).toBe(false);
  });

  it('fails with keyFile when the key file cannot be read, and keeps the kept lines when it cannot be rewritten', async () => {
    const { home } = targetHome();
    const keys = path.join(home, '.ssh', 'authorized_keys');
    mkdirSync(path.dirname(keys));
    writeFileSync(keys, `${OTHER_KEY}\n${ENTRY} damocles@laptop\n`);
    const params: RemovalParameters = { runKey: RUN_KEY, key: { entry: ENTRY, file: shellPath(keys) }, disableLinger: false };
    // grep's status 2 is a read error, which is no "key not found"
    const unreadable = await run(home, params, `id() { echo dev; }\ngrep() { case "$*" in *authorized_keys*) return 2 ;; esac; command grep "$@"; }`);
    expect(lines(unreadable).at(-1)).toEqual({ kind: 'fail', code: 'stageFailed', params: { code: 'keyFile' } });
    const unwritable = await run(home, params, 'id() { echo dev; }\ncat() { return 1; }');
    expect(lines(unwritable).at(-1)).toEqual({ kind: 'fail', code: 'stageFailed', params: { code: 'keyFile' } });
    const kept = readdirSync(path.dirname(keys)).filter((name) => name.startsWith('.damocles-keys-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(path.join(path.dirname(keys), kept[0]!), 'utf8')).toBe(`${OTHER_KEY}\n`);
  });

  it('stops before deleting anything when this machine\'s daemon runs again', async () => {
    const { home, server } = targetHome();
    // this shell's own pid is a live process
    const output = await run(home, { runKey: RUN_KEY, disableLinger: false }, `printf '{"pid":%s}' "$$" > '${shellPath(path.join(server, `run-${RUN_KEY}`, 'daemon.pid'))}'`);
    expect(lines(output)).toEqual([{ kind: 'fail', code: 'daemonRunning', params: {} }]);
    expect(readdirSync(path.join(server, `run-${RUN_KEY}`)).sort()).toEqual(['daemon.pid', 'logs']);
  });

  it('stops before deleting anything while a daemon holds its lock, and takes over a lock no daemon refreshed', async () => {
    const { home, server } = targetHome();
    const runDir = path.join(server, `run-${RUN_KEY}`);
    // a daemon in its shutdown: the pid file is gone, the lock is not
    mkdirSync(path.join(runDir, 'daemon.lock'));
    const held = await run(home, { runKey: RUN_KEY, disableLinger: false }, 'id() { echo dev; }');
    expect(lines(held)).toEqual([{ kind: 'fail', code: 'daemonRunning', params: {} }]);
    expect(readdirSync(runDir).sort()).toEqual(['daemon.lock', 'logs']);
    minutesAgo(path.join(runDir, 'daemon.lock'), 1);
    const stale = await run(home, { runKey: RUN_KEY, disableLinger: false }, 'id() { echo dev; }');
    expect(lines(stale).at(-1)).toEqual({ kind: 'removed' });
    expect(existsSync(runDir)).toBe(false);
  });

  it('stops while a fresh daemon lock\'s owner runs, and takes the lock at once when its owner is gone from this host', async () => {
    const { home, server } = targetHome();
    const runDir = path.join(server, `run-${RUN_KEY}`);
    mkdirSync(path.join(runDir, 'daemon.lock'));
    const owner = shellPath(path.join(runDir, 'daemon.lock.owner'));
    const live = await run(home, { runKey: RUN_KEY, disableLinger: false }, `${ID_DEV}\nsleep 30 & holder=$!; trap 'kill "$holder"' EXIT; printf '%s %s\\n' "$(uname -n)" "$holder" > '${owner}'`);
    expect(lines(live)).toEqual([{ kind: 'fail', code: 'daemonRunning', params: {} }]);
    expect(readdirSync(runDir).sort()).toEqual(['daemon.lock', 'daemon.lock.owner', 'logs']);
    const gone = await run(home, { runKey: RUN_KEY, disableLinger: false }, `${ID_DEV}\nprintf '%s %s\\n' "$(uname -n)" ${DEAD_PID} > '${owner}'`);
    expect(lines(gone).at(-1)).toEqual({ kind: 'removed' });
    expect(existsSync(runDir)).toBe(false);
  });

  it('refuses a run key that is not 16 hex digits, and an empty user name', async () => {
    const { home, server } = targetHome();
    for (const key of ['0123456789abcde', '0123456789abcdef0']) {
      const output = await run(home, { runKey: RUN_KEY, disableLinger: false }, '', (script) => script.replace(`D_RUN_KEY='${RUN_KEY}'`, `D_RUN_KEY='${key}'`));
      expect(lines(output)).toEqual([{ kind: 'fail', code: 'stageFailed', params: { code: 'runKey' } }]);
    }
    const nameless = await run(home, { runKey: RUN_KEY, installFolder: shellPath(home), disableLinger: false }, 'id() { :; }');
    expect(lines(nameless)).toEqual([{ kind: 'fail', code: 'stageFailed', params: { code: 'userName' } }]);
    expect(existsSync(path.join(server, `run-${RUN_KEY}`))).toBe(true);
  });

  it('leaves a folder where a live stage installs, removing only staging folders too old to be in use', async () => {
    const { home } = targetHome();
    const install = path.join(home, 'tools', 'dev');
    installVersions(install, ['3.7.0-linux-x64']);
    mkdirSync(path.join(install, '.staging-old'));
    minutesAgo(path.join(install, '.staging-old'), 25 * 60);
    const owner = shellPath(path.join(install, 'install.lock', 'owner'));
    const output = await run(home, { runKey: RUN_KEY, installFolder: shellPath(path.join(home, 'tools')), disableLinger: false }, `id() { echo dev; }\nsleep 30 & holder=$!; trap 'kill "$holder"' EXIT; printf '%s %s\\n' "$(uname -n)" "$holder" > '${owner}'`);
    expect(lines(output)).toContainEqual({ kind: 'notice', code: 'installInProgress', params: { folder: shellPath(install) } });
    expect(readdirSync(install)).toEqual(expect.arrayContaining(['3.7.0-linux-x64', '.staging-abc', 'install.lock']));
    expect(readdirSync(install)).not.toContain('.staging-old');
  });

  it('deletes the socket folders the run folder records, a crashed daemon\'s agent and relay folders included, and only Damocles\' own', async () => {
    const { home, server } = targetHome();
    const tmp = scratchDir('remove-tmp-');
    // an absolute path as the target's daemon writes one: Git for Windows' sh reads C:\x as /c/x
    const absolute = (file: string): string => shellPath(file).replace(/^([A-Za-z]):/, (_drive, letter: string) => `/${letter.toLowerCase()}`);
    const made = (name: string, files: readonly string[]): string => {
      mkdirSync(path.join(tmp, name));
      for (const file of files) writeFileSync(path.join(tmp, name, file), '');
      return absolute(path.join(tmp, name));
    };
    const endpoint = made('damocles-endpoint', ['daemon.sock', 'token']);
    const agent = made('damocles-agent', [`agent-${'a'.repeat(24)}.sock`]);
    const relay = made('damocles-relay', ['askpass.sock']);
    const crowded = made('damocles-crowded', ['askpass.sock', 'notes.txt']);
    const other = made('other-tool', ['askpass.sock']);
    const runDir = path.join(server, `run-${RUN_KEY}`);
    writeFileSync(path.join(runDir, 'daemon.pid'), JSON.stringify({ version: '3.7.0', pid: DEAD_PID, endpoint: `${endpoint}/daemon.sock`, socketFolder: endpoint }));
    writeFileSync(path.join(runDir, 'socket-folders'), [agent, relay, crowded, other, 'relative/damocles-x', ''].join('\n'));
    const output = await run(home, { runKey: RUN_KEY, disableLinger: false }, ID_DEV);
    expect(lines(output)).toContainEqual({ kind: 'notice', code: 'deleteFailed', params: { entry: crowded } });
    expect(lines(output).at(-1)).toEqual({ kind: 'removed' });
    expect(readdirSync(tmp).sort()).toEqual(['damocles-crowded', 'other-tool']);
    expect(readdirSync(path.join(tmp, 'damocles-crowded'))).toEqual(['notes.txt']);
    expect(readdirSync(path.join(tmp, 'other-tool'))).toEqual(['askpass.sock']);
  });

  it.skipIf(posixOnly)('reports an entry it cannot delete and carries on', async () => {
    const { home, server } = targetHome();
    installVersions(server, ['3.7.0-linux-x64']);
    const locked = path.join(server, '3.7.0-linux-x64', 'bin');
    writeFileSync(path.join(locked, 'damocles-server'), '');
    chmodSync(locked, 0o500);
    try {
      const output = await run(home, { runKey: RUN_KEY, disableLinger: false }, 'id() { echo dev; }');
      expect(lines(output)).toContainEqual({ kind: 'notice', code: 'deleteFailed', params: { entry: path.join(server, '3.7.0-linux-x64') } });
      expect(lines(output).at(-1)).toEqual({ kind: 'removed' });
      expect(existsSync(path.join(server, `run-${RUN_KEY}`))).toBe(false);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('keeps its daemon lock fresh while it deletes the run folder, however long each delete takes', async () => {
    const { home, server } = targetHome();
    const runDir = path.join(server, `run-${RUN_KEY}`);
    mkdirSync(path.join(runDir, 'state'));
    writeFileSync(path.join(runDir, 'state', 'values.json'), '{}');
    writeFileSync(path.join(runDir, 'token'), '');
    const lock = shellPath(path.join(runDir, 'daemon.lock'));
    const age = path.join(home, 'lock-age');
    // each delete leaves the lock as old as a slow file system would, and the lock's age is read as it goes
    const prelude = [
      ID_DEV,
      `rm() { command rm "$@"; if [ -d '${lock}' ]; then touch -t 200001010000 '${lock}'; fi; }`,
      `rmdir() { if [ "$1" = '${lock}' ]; then seconds_since_change "$1" > '${shellPath(age)}'; fi; command rmdir "$@"; }`,
    ].join('\n');
    const output = await run(home, { runKey: RUN_KEY, disableLinger: false }, prelude);
    expect(lines(output).at(-1)).toEqual({ kind: 'removed' });
    expect(existsSync(runDir)).toBe(false);
    expect(Number(readFileSync(age, 'utf8'))).toBeLessThanOrEqual(LOCK_STALE_MS / 1000);
  });

  it('keeps a version only another machine\'s recently touched pid file names', async () => {
    const { home, server } = targetHome();
    installVersions(server, ['3.6.0-linux-x64']);
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(path.join(server, `run-${OTHER_RUN}`, 'daemon.pid'), stale, stale);
    await run(home, { runKey: RUN_KEY, disableLinger: false }, 'id() { echo dev; }');
    expect(existsSync(path.join(server, '3.6.0-linux-x64'))).toBe(false);
  });
});

describe('the Windows removal stage in a real PowerShell', { timeout: 120_000 }, async () => {
  const shell = await powerShell();
  const run = (home: string, programData: string, params: RemovalParameters) => runPowerShell(shell!, [
    '$DamoclesOut = [Console]::OpenStandardOutput()',
    `$env:USERPROFILE = '${home}'`,
    `$env:ProgramData = '${programData}'`,
    "$env:USERNAME = 'dev'",
    buildWindowsRemoval(params),
    '',
  ].join('\n'));

  it.skipIf(shell === undefined)('deletes this machine\'s run folder and the versions no other live daemon names, and the custom folder stays', async () => {
    const { home, server } = targetHome();
    installVersions(server, ['3.6.0-win32-x64', '3.7.0-win32-arm64']);
    const folder = path.join(home, 'shared tools');
    installVersions(path.join(folder, 'dev'), ['3.7.0-win32-x64']);
    writeFileSync(path.join(folder, 'README'), 'shared');
    const output = await run(home, path.join(home, 'ProgramData'), { runKey: RUN_KEY, installFolder: folder, disableLinger: false });
    expect(lines(output)).toEqual([
      { kind: 'notice', code: 'versionKept', params: { version: '3.6.0', machine: 'lab-2' } },
      { kind: 'notice', code: 'serverFolderKept', params: {} },
      { kind: 'removed' },
    ]);
    expect(readdirSync(server).sort()).toEqual(['3.6.0-win32-x64', ...LOOK_ALIKES, `run-${OTHER_RUN}`].sort());
    expect(readdirSync(path.join(folder, 'dev')).sort()).toEqual([...LOOK_ALIKES].sort());
    expect(readdirSync(folder).sort()).toEqual(['README', 'dev']);
  });

  it.skipIf(shell === undefined)('removes the key line only from the file the install wrote, never another one', async () => {
    const { home } = targetHome();
    const programData = path.join(home, 'ProgramData');
    const adminKeys = path.join(programData, 'ssh', 'administrators_authorized_keys');
    const userKeys = path.join(home, '.ssh', 'authorized_keys');
    mkdirSync(path.dirname(adminKeys), { recursive: true });
    mkdirSync(path.dirname(userKeys), { recursive: true });
    writeFileSync(adminKeys, `${OTHER_KEY}\r\n${ENTRY} damocles@laptop\r\n`);
    writeFileSync(userKeys, `${ENTRY} damocles@laptop\r\n`);
    const output = await run(home, programData, { runKey: RUN_KEY, key: { entry: ENTRY, file: adminKeys }, disableLinger: false });
    expect(lines(output).at(-1)).toEqual({ kind: 'removed' });
    expect(readFileSync(adminKeys, 'utf8')).toBe(`${OTHER_KEY}\r\n`);
    expect(readFileSync(userKeys, 'utf8')).toBe(`${ENTRY} damocles@laptop\r\n`);
  });

  it.skipIf(shell === undefined)('stops before deleting anything while a daemon holds its lock, and takes over a lock no daemon refreshed', async () => {
    const { home, server } = targetHome();
    const runDir = path.join(server, `run-${RUN_KEY}`);
    mkdirSync(path.join(runDir, 'daemon.lock'));
    const held = await run(home, path.join(home, 'ProgramData'), { runKey: RUN_KEY, disableLinger: false });
    expect(lines(held)).toEqual([{ kind: 'fail', code: 'daemonRunning', params: {} }]);
    expect(readdirSync(runDir).sort()).toEqual(['daemon.lock', 'logs']);
    minutesAgo(path.join(runDir, 'daemon.lock'), 1);
    const stale = await run(home, path.join(home, 'ProgramData'), { runKey: RUN_KEY, disableLinger: false });
    expect(lines(stale).at(-1)).toEqual({ kind: 'removed' });
    expect(existsSync(runDir)).toBe(false);
  });

  it.skipIf(shell === undefined)('stops while a fresh daemon lock\'s owner runs, and takes the lock at once when its owner is gone from this host', async () => {
    const { home, server } = targetHome();
    const runDir = path.join(server, `run-${RUN_KEY}`);
    const lock = path.join(runDir, 'daemon.lock');
    mkdirSync(lock);
    writeFileSync(`${lock}.owner`, `${os.hostname()} ${process.pid}\n`);
    const live = await run(home, path.join(home, 'ProgramData'), { runKey: RUN_KEY, disableLinger: false });
    expect(lines(live)).toEqual([{ kind: 'fail', code: 'daemonRunning', params: {} }]);
    expect(readdirSync(runDir).sort()).toEqual(['daemon.lock', 'daemon.lock.owner', 'logs']);
    writeFileSync(`${lock}.owner`, `${os.hostname()} ${DEAD_PID}\n`);
    const gone = await run(home, path.join(home, 'ProgramData'), { runKey: RUN_KEY, disableLinger: false });
    expect(lines(gone).at(-1)).toEqual({ kind: 'removed' });
    expect(existsSync(runDir)).toBe(false);
  });

  it.skipIf(shell === undefined || process.platform !== 'win32')('reports an entry it cannot delete and carries on to the key line', async () => {
    const { home, server } = targetHome();
    installVersions(server, ['3.7.0-win32-x64']);
    const busy = path.join(server, '3.7.0-win32-x64', 'bin', 'node.exe');
    writeFileSync(busy, '');
    const keys = path.join(home, '.ssh', 'authorized_keys');
    mkdirSync(path.dirname(keys), { recursive: true });
    writeFileSync(keys, `${OTHER_KEY}\r\n${ENTRY} damocles@laptop\r\n`);
    const output = await runPowerShell(shell!, [
      '$DamoclesOut = [Console]::OpenStandardOutput()',
      `$env:USERPROFILE = '${home}'`,
      "$env:USERNAME = 'dev'",
      // a running node.exe holds its file open as this does
      `$held = [IO.File]::Open('${busy}', 'Open', 'Read', 'None')`,
      buildWindowsRemoval({ runKey: RUN_KEY, key: { entry: ENTRY, file: keys }, disableLinger: false }),
      '',
    ].join('\n'));
    // the folder listing names the long form of an 8.3 temp path
    expect(lines(output)).toContainEqual({ kind: 'notice', code: 'deleteFailed', params: { entry: path.join(realpathSync.native(server), '3.7.0-win32-x64') } });
    expect(lines(output).at(-1)).toEqual({ kind: 'removed' });
    expect(readFileSync(keys, 'utf8')).toBe(`${OTHER_KEY}\r\n`);
    expect(existsSync(path.join(server, `run-${RUN_KEY}`))).toBe(false);
  });

  const runWith = (home: string, prelude: readonly string[], params: RemovalParameters) => runPowerShell(shell!, [
    '$DamoclesOut = [Console]::OpenStandardOutput()',
    `$env:USERPROFILE = '${home}'`,
    "$env:USERNAME = 'dev'",
    ...prelude,
    buildWindowsRemoval(params),
    '',
  ].join('\n'));

  it.skipIf(shell === undefined || process.platform !== 'win32')('fails with keyFile when the key file cannot be read, and keeps the kept lines beside it when it cannot be rewritten', async () => {
    const { home } = targetHome();
    const keys = path.join(home, '.ssh', 'authorized_keys');
    mkdirSync(path.dirname(keys), { recursive: true });
    writeFileSync(keys, `${OTHER_KEY}\r\n${ENTRY} damocles@laptop\r\n`);
    const params: RemovalParameters = { runKey: RUN_KEY, key: { entry: ENTRY, file: keys }, disableLinger: false };
    // another process holding the file with no sharing, as an editor or a backup tool can
    const unreadable = await runWith(home, [`$held = [IO.File]::Open('${keys}', 'Open', 'Read', 'None')`], params);
    expect(lines(unreadable).at(-1)).toEqual({ kind: 'fail', code: 'stageFailed', params: { code: 'keyFile' } });
    expect(unreadable.stderr.toString('utf8')).toContain(`[remove] reading ${keys} failed`);
    const unwritable = await runWith(home, [`[IO.File]::SetAttributes('${keys}', 'ReadOnly')`], params);
    try {
      expect(lines(unwritable).at(-1)).toEqual({ kind: 'fail', code: 'stageFailed', params: { code: 'keyFile' } });
      expect(readFileSync(keys, 'utf8')).toBe(`${OTHER_KEY}\r\n${ENTRY} damocles@laptop\r\n`);
      const kept = readdirSync(path.dirname(keys)).filter((name) => name.startsWith('.damocles-keys-'));
      expect(kept).toHaveLength(1);
      expect(readFileSync(path.join(path.dirname(keys), kept[0]!), 'utf8')).toBe(`${OTHER_KEY}\r\n`);
    } finally {
      chmodSync(keys, 0o666);
    }
  });

  it.skipIf(shell === undefined)('keeps its daemon lock fresh while it deletes the run folder, however long each delete takes', async () => {
    const { home, server } = targetHome();
    const runDir = path.join(server, `run-${RUN_KEY}`);
    mkdirSync(path.join(runDir, 'state'));
    writeFileSync(path.join(runDir, 'state', 'values.json'), '{}');
    writeFileSync(path.join(runDir, 'token'), '');
    const lock = path.join(runDir, 'daemon.lock');
    const age = path.join(home, 'lock-age');
    // each delete leaves the lock as old as a slow file system would, and the lock's age is read as it goes
    const output = await runWith(home, [
      'function Remove-Item {',
      '  [CmdletBinding()] param([string]$LiteralPath, [switch]$Recurse, [switch]$Force)',
      `  if ($LiteralPath -eq '${lock}') { [IO.File]::WriteAllText('${age}', [string][int]((Get-Date) - (Get-Item -LiteralPath $LiteralPath -Force).LastWriteTime).TotalSeconds) }`,
      '  Microsoft.PowerShell.Management\\Remove-Item @PSBoundParameters',
      `  if (Test-Path -LiteralPath '${lock}') { [IO.Directory]::SetLastWriteTime('${lock}', [DateTime]'2000-01-01') }`,
      '}',
    ], { runKey: RUN_KEY, disableLinger: false });
    expect(lines(output).at(-1)).toEqual({ kind: 'removed' });
    expect(existsSync(runDir)).toBe(false);
    expect(Number(readFileSync(age, 'utf8'))).toBeLessThanOrEqual(LOCK_STALE_MS / 1000);
  });

  it.skipIf(shell === undefined)('leaves a folder where a live stage installs, removing only staging folders too old to be in use', async () => {
    const { home } = targetHome();
    const install = path.join(home, 'tools', 'dev');
    installVersions(install, ['3.7.0-win32-x64']);
    mkdirSync(path.join(install, '.staging-old'));
    minutesAgo(path.join(install, '.staging-old'), 25 * 60);
    const output = await runPowerShell(shell!, [
      '$DamoclesOut = [Console]::OpenStandardOutput()',
      `$env:USERPROFILE = '${home}'`,
      "$env:USERNAME = 'dev'",
      `[IO.File]::WriteAllText('${path.join(install, 'install.lock', 'owner')}', "$([Environment]::MachineName) $PID")`,
      buildWindowsRemoval({ runKey: RUN_KEY, installFolder: path.join(home, 'tools'), disableLinger: false }),
      '',
    ].join('\n'));
    expect(lines(output)).toContainEqual({ kind: 'notice', code: 'installInProgress', params: { folder: install } });
    expect(readdirSync(install)).toEqual(expect.arrayContaining(['3.7.0-win32-x64', '.staging-abc', 'install.lock']));
    expect(readdirSync(install)).not.toContain('.staging-old');
  });
});
