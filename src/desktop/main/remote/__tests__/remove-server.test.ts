import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runProcess, type RunOutput } from '../../../../core/process-launcher';
import { findOnAbsolutePathAsync } from '../../../../core/system-tools';
import { buildPosixRemoval, buildWindowsRemoval, removalOutcome, removeServer, REMOVAL_CLOSE_WAIT_MS, REMOVAL_FEATURE, type RemovalParameters } from '../remove-server';
import { powerShell, runPowerShell, runSh, scratchDir, shellPath } from '../bootstrap/__tests__/shells';
import { LOCK_STALE_MS, REMOVAL_SHUTDOWN_MAX_MS } from '../../../daemon/lock-timing';

const RUN_KEY = '0123456789abcdef';
// a pid no process holds: above Linux's PID_MAX_LIMIT (2^22), and not a multiple of 4, as every Windows process id is
const DEAD_PID = 4_194_305;
// pinned as scripts/server-targets.ts ALPINE_TARGET_IMAGE pins it
const ALPINE = 'alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a';
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
    expect(removalOutcome([versionKept, '{"kind":"removed"}'], 0, 'posix')).toEqual({ ok: true, notices: [{ code: 'versionKept', params: { version: '3.6.0', machine: 'lab-2' } }] });
    expect(removalOutcome(['{"kind":"notice","code":"floorKept","params":{"folder":"/home/dev/.damocles/server","files":"both"}}', '{"kind":"removed"}'], 0, 'posix')).toEqual({ ok: true, notices: [{ code: 'floorKept', params: { folder: '/home/dev/.damocles/server', files: 'both' } }] });
    // floorKept names the files it keeps, which pick its text
    expect(removalOutcome(['{"kind":"notice","code":"floorKept","params":{"folder":"/home/dev/.damocles/server"}}', '{"kind":"removed"}'], 0, 'posix')).toEqual({ ok: false, code: 'stageFailed', params: { code: 'protocol' } });
    expect(removalOutcome(['{"kind":"removed"}'], 1, 'posix')).toEqual({ ok: false, code: 'stageFailed', params: { code: 'exit', exitCode: '1' } });
    expect(removalOutcome([versionKept], 0, 'posix')).toEqual({ ok: false, code: 'stageFailed', params: { code: 'exit', exitCode: '0' } });
    expect(removalOutcome([versionKept], null, 'posix')).toEqual({ ok: false, code: 'stageFailed', params: { code: 'killed' } });
    expect(removalOutcome(['{"kind":"fail","code":"daemonRunning","params":{}}'], 1, 'posix')).toEqual({ ok: false, code: 'daemonRunning', params: {} });
    expect(removalOutcome(['{"kind":"notice","code":"evil","params":{}}', '{"kind":"removed"}'], 0, 'posix')).toEqual({ ok: false, code: 'stageFailed', params: { code: 'protocol' } });
    expect(removalOutcome(['not json'], 0, 'posix')).toEqual({ ok: false, code: 'stageFailed', params: { code: 'protocol' } });
  });

  it('takes daemonRunning with no params, whatever the target put in them, and no failure code main adds', () => {
    expect(removalOutcome(['{"kind":"fail","code":"daemonRunning","params":{"extra":"x"}}'], 1, 'posix')).toEqual({ ok: false, code: 'daemonRunning', params: {} });
    for (const code of ['notConnected', 'unsupported']) {
      expect(removalOutcome([`{"kind":"fail","code":"${code}","params":{}}`], 1, 'posix')).toEqual({ ok: false, code: 'stageFailed', params: { code: 'protocol' } });
    }
  });

  it('takes only the stageFailed codes the scripts send, and nothing else the target put beside them', () => {
    for (const code of ['keyFile', 'runKey', 'userName']) {
      expect(removalOutcome([`{"kind":"fail","code":"stageFailed","params":{"code":"${code}","extra":"x"}}`], 1, 'posix')).toEqual({ ok: false, code: 'stageFailed', params: { code } });
    }
    for (const params of ['{"code":"exit"}', '{"code":"evil"}', '{}']) {
      expect(removalOutcome([`{"kind":"fail","code":"stageFailed","params":${params}}`], 1, 'posix')).toEqual({ ok: false, code: 'stageFailed', params: { code: 'protocol' } });
    }
  });

  it('takes terminalHostRunning with the pids of the hosts that still run, only decimal pids, and the host\'s OS main ran the stage for', () => {
    expect(removalOutcome(['{"kind":"fail","code":"terminalHostRunning","params":{"pids":"4242"}}'], 1, 'posix')).toEqual({ ok: false, code: 'terminalHostRunning', params: { pids: '4242', os: 'posix' } });
    // PowerShell's ConvertTo-Json may order the keys differently
    expect(removalOutcome(['{"params":{"pids":"4242"},"code":"terminalHostRunning","kind":"fail"}'], 1, 'win32')).toEqual({ ok: false, code: 'terminalHostRunning', params: { pids: '4242', os: 'win32' } });
    // the OS is main's, never the target's
    expect(removalOutcome(['{"kind":"fail","code":"terminalHostRunning","params":{"pids":"4242 977","os":"win32","extra":"x"}}'], 1, 'posix')).toEqual({ ok: false, code: 'terminalHostRunning', params: { pids: '4242 977', os: 'posix' } });
    for (const params of ['{}', '{"pids":""}', '{"pids":"0"}', '{"pids":"42 "}', '{"pids":"42  43"}', '{"pids":"-1"}', '{"pids":"42,43"}', '{"pids":"12345678901"}', '{"pids":42}']) {
      expect(removalOutcome([`{"kind":"fail","code":"terminalHostRunning","params":${params}}`], 1, 'posix')).toEqual({ ok: false, code: 'stageFailed', params: { code: 'protocol' } });
    }
  });
});

describe('removeServer', () => {
  it('waits for the daemon\'s close at least as long as a removal\'s shutdown may take, so the stage never meets its lock still held', () => {
    expect(REMOVAL_CLOSE_WAIT_MS).toBeGreaterThanOrEqual(REMOVAL_SHUTDOWN_MAX_MS);
  });

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

// The security floor in two install folders, each beside a raise's temporary file and lock: stale in the first, and held by a
// live raise (proper-lockfile refreshes it every 5 s) in the second, which it answers.
function securityFloors(stale: string, held: string): string {
  for (const folder of [stale, held]) {
    mkdirSync(path.join(folder, 'security-floor.lock'), { recursive: true });
    writeFileSync(path.join(folder, 'security-floor'), '3.9.0\n');
    writeFileSync(path.join(folder, `security-floor.${'a'.repeat(12)}.tmp`), '3.9.1\n');
  }
  minutesAgo(path.join(stale, 'security-floor.lock'), 1);
  return held;
}

describe('the POSIX removal stage in a real sh', { timeout: 120_000 }, async () => {
  const docker = await findOnAbsolutePathAsync(process.platform === 'win32' ? 'docker.exe' : 'docker', process.platform, process.env);
  const linuxDocker = docker !== undefined && (await runProcess({ file: docker, args: ['info', '--format', '{{.OSType}}'], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: 30_000 })).stdout.toString('utf8').trim() === 'linux';
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
      { kind: 'notice', code: 'floorKept', params: { folder: shellPath(server), files: 'marker' } },
      { kind: 'notice', code: 'floorKept', params: { folder: shellPath(install), files: 'marker' } },
      { kind: 'notice', code: 'serverFolderKept', params: {} },
      { kind: 'removed' },
    ]);
    // every install folder that held a server keeps the removed marker, the one stage 1 uses and ~/.damocles/server here
    expect(readdirSync(server).sort()).toEqual(['3.6.0-linux-x64', ...LOOK_ALIKES, 'removed', `run-${OTHER_RUN}`].sort());
    expect(readdirSync(install).sort()).toEqual([...LOOK_ALIKES, 'removed'].sort());
    expect(readdirSync(folder).sort()).toEqual(['README', 'dev']);
  });

  it('deletes ~/.damocles/server when nothing else is left, keeps <folder>/<user> for its removed marker alone, and never deletes <folder>', async () => {
    const home = scratchDir('remove-home-');
    const server = path.join(home, '.damocles', 'server');
    mkdirSync(path.join(server, `run-${RUN_KEY}`), { recursive: true });
    const folder = path.join(home, 'tools');
    mkdirSync(path.join(folder, 'dev', '3.7.0-linux-x64'), { recursive: true });
    writeFileSync(path.join(folder, 'dev', '3.7.0-linux-x64', 'server-package.json'), '{}');
    const output = await run(home, { runKey: RUN_KEY, installFolder: shellPath(folder), disableLinger: false }, 'id() { echo dev; }');
    expect(lines(output)).toEqual([{ kind: 'notice', code: 'floorKept', params: { folder: shellPath(path.join(folder, 'dev')), files: 'marker' } }, { kind: 'removed' }]);
    expect(existsSync(server)).toBe(false);
    expect(existsSync(path.join(home, '.damocles'))).toBe(true);
    expect(readdirSync(folder)).toEqual(['dev']);
    expect(readdirSync(path.join(folder, 'dev'))).toEqual(['removed']);
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

  it('stops with terminalHostRunning naming each live terminal host of this machine, kills none, and names the daemon first when it runs too', async () => {
    const { home, server } = targetHome();
    const runDir = path.join(server, `run-${RUN_KEY}`);
    mkdirSync(path.join(runDir, 'terminal-hosts'));
    // two live processes stand in for hosts that run from an install; a third record names a pid no process has
    const prelude = [
      ID_DEV,
      `hosts='${shellPath(path.join(runDir, 'terminal-hosts'))}'`,
      'sleep 30 >/dev/null 2>&1 & first=$!; sleep 30 >/dev/null 2>&1 & second=$!',
      'for pid in "$first" "$second"; do printf \'{"version":"3.6.0","pid":%s,"hostname":"box","endpoint":"/tmp/damocles-x/host.sock","socketFolder":"/tmp/damocles-x","updatedAt":1}\' "$pid" > "$hosts/$pid.json"; done',
      `printf '{"version":"3.6.0","pid":${DEAD_PID}}' > "$hosts/${DEAD_PID}.json"`,
      `printf '%s %s' "$first" "$second" > '${shellPath(path.join(home, 'pids'))}'`,
    ].join('\n');
    const fromInstall = (script: string): string => script.replace('# BEGIN MAIN', 'runs_from_install() { return 0; }\n# BEGIN MAIN');
    // the stage's own end: both still run there, so the stage killed neither
    const alive = shellPath(path.join(home, 'alive'));
    const output = await run(home, { runKey: RUN_KEY, disableLinger: false }, `${prelude}\ntrap 'kill -0 "$first" && kill -0 "$second" && printf yes > '"'"'${alive}'"'"'; kill "$first" "$second"' EXIT`, fromInstall);
    expect(readFileSync(path.join(home, 'alive'), 'utf8')).toBe('yes');
    const pids = readFileSync(path.join(home, 'pids'), 'utf8').split(' ');
    const [message] = lines(output) as Array<{ kind: string; code: string; params: { pids: string } }>;
    expect(lines(output)).toHaveLength(1);
    expect(message).toMatchObject({ kind: 'fail', code: 'terminalHostRunning' });
    expect(message!.params.pids).toMatch(/^[1-9][0-9]{0,9}( [1-9][0-9]{0,9})*$/);
    expect(message!.params.pids.split(' ').sort()).toEqual([...pids].sort());
    expect(readdirSync(runDir).sort()).toEqual(['logs', 'terminal-hosts']);
    expect(readdirSync(path.join(runDir, 'terminal-hosts')).sort()).toEqual([...pids.map((pid) => `${pid}.json`), `${DEAD_PID}.json`].sort());
    const daemonToo = await run(home, { runKey: RUN_KEY, disableLinger: false }, `${prelude}\ntrap 'kill "$first" "$second"' EXIT\nprintf '{"pid":%s}' "$$" > '${shellPath(path.join(runDir, 'daemon.pid'))}'`, fromInstall);
    expect(lines(daemonToo)).toEqual([{ kind: 'fail', code: 'daemonRunning', params: {} }]);
  });

  // main refuses a parameter past 500 characters, and 40 pids of 10 digits and their spaces fit
  it('names at most 40 live terminal hosts', async () => {
    const { home, server } = targetHome();
    const hosts = path.join(server, `run-${RUN_KEY}`, 'terminal-hosts');
    mkdirSync(hosts);
    const pids = Array.from({ length: 45 }, (_, index) => 1_000_000_001 + index);
    for (const pid of pids) writeFileSync(path.join(hosts, `${pid}.json`), `{"version":"3.6.0","pid":${pid},"hostname":"box"}`);
    // every record names a live process that runs from an install
    const live = (script: string): string => script.replace('# BEGIN MAIN', 'kill() { return 0; }\nruns_from_install() { return 0; }\n# BEGIN MAIN');
    const output = await run(home, { runKey: RUN_KEY, disableLinger: false }, ID_DEV, live);
    const [message] = lines(output) as Array<{ code: string; params: { pids: string } }>;
    expect(message?.code).toBe('terminalHostRunning');
    expect(message!.params.pids.split(' ')).toEqual(pids.slice(0, 40).map(String));
    expect(message!.params.pids.length).toBeLessThanOrEqual(500);
  });

  it('removes an ended terminal host\'s socket folder, and takes neither a record whose pid another program took nor a file that is no <pid>.json for a running host', async () => {
    const { home, server } = targetHome();
    const tmp = scratchDir('remove-tmp-');
    const absolute = (file: string): string => shellPath(file).replace(/^([A-Za-z]):/, (_drive, letter: string) => `/${letter.toLowerCase()}`);
    const made = (name: string): string => {
      mkdirSync(path.join(tmp, name));
      for (const file of ['host.sock', 'token']) writeFileSync(path.join(tmp, name, file), '');
      return absolute(path.join(tmp, name));
    };
    const hosts = path.join(server, `run-${RUN_KEY}`, 'terminal-hosts');
    mkdirSync(hosts);
    const record = (pid: string, folder: string): string => `{"version":"3.6.0","pid":${pid},"hostname":"box","endpoint":"${folder}/host.sock","socketFolder":"${folder}","updatedAt":1}`;
    writeFileSync(path.join(hosts, '77.json'), record(String(DEAD_PID), made('damocles-ended')));
    // a relative folder is never one a host made
    mkdirSync(path.join(home, 'damocles-relative'));
    writeFileSync(path.join(hosts, '78.json'), record(String(DEAD_PID), 'damocles-relative'));
    const strayFolder = made('damocles-stray');
    // this shell's own pid is a live process that runs from no install
    const prelude = [
      ID_DEV,
      `cd '${shellPath(home)}'`,
      `printf '%s' '${record('PID', made('damocles-reused'))}' | sed "s/PID/$$/" > '${shellPath(path.join(hosts, '79.json'))}'`,
      `printf '%s' '${record('PID', strayFolder)}' | sed "s/PID/$$/" > '${shellPath(path.join(hosts, 'notes.json'))}'`,
    ].join('\n');
    const output = await run(home, { runKey: RUN_KEY, disableLinger: false }, prelude);
    expect(lines(output).at(-1)).toEqual({ kind: 'removed' });
    expect(existsSync(path.join(server, `run-${RUN_KEY}`))).toBe(false);
    expect(readdirSync(tmp)).toEqual(['damocles-stray']);
    expect(existsSync(path.join(home, 'damocles-relative'))).toBe(true);
  });

  it.skipIf(!linuxDocker)('stops before deleting anything while a terminal host of this machine runs from an install (needs Docker with Linux containers)', async () => {
    // a sleep copied into a version folder stands in for the terminal host's Node
    const script = [
      'HOME=/root; run="$HOME/.damocles/server/run-0123456789abcdef"; version="$HOME/.damocles/server/3.6.0-linux-x64"',
      'mkdir -p "$run/terminal-hosts" "$version/node" /tmp/damocles-host',
      ': > "$version/server-package.json"; : > /tmp/damocles-host/host.sock; : > /tmp/damocles-host/token',
      'cp /bin/busybox "$version/node/sleep"',
      '"$version/node/sleep" 300 &',
      'host=$!',
      'printf \'host=%s\\n\' "$host"',
      'printf \'{"version":"3.6.0","pid":%s,"hostname":"box","endpoint":"/tmp/damocles-host/host.sock","socketFolder":"/tmp/damocles-host","updatedAt":1}\' "$host" > "$run/terminal-hosts/$host.json"',
      `( ${buildPosixRemoval({ runKey: RUN_KEY, disableLinger: false })}\n)`,
      'printf \'left=%s,%s\\n\' "$(ls "$run")" "$(ls /tmp/damocles-host | tr "\\n" " ")"',
      'kill "$host"; wait "$host" 2>/dev/null',
      `( ${buildPosixRemoval({ runKey: RUN_KEY, disableLinger: false })}\n)`,
      'printf \'after=%s,%s\\n\' "$(ls "$HOME/.damocles" 2>/dev/null)" "$(ls /tmp | tr "\\n" " ")"',
    ].join('\n');
    const output = await runProcess({ file: docker!, args: ['run', '--rm', '-i', ALPINE, 'sh', '-s'], windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, { input: script, timeoutMs: 180_000 });
    const text = output.stdout.toString('utf8');
    const host = /^host=(\d+)$/m.exec(text)?.[1];
    expect(lines(output)).toEqual([{ kind: 'fail', code: 'terminalHostRunning', params: { pids: host } }, { kind: 'notice', code: 'floorKept', params: { folder: '/root/.damocles/server', files: 'marker' } }, { kind: 'removed' }]);
    expect(text).toContain('left=terminal-hosts,host.sock token');
    // ~/.damocles/server stays for the removed marker alone
    expect(text).toContain('after=server,');
  }, 200_000);

  it('keeps a version another machine\'s terminal host names', async () => {
    const { home, server } = targetHome();
    rmSync(path.join(server, `run-${OTHER_RUN}`, 'daemon.pid'));
    mkdirSync(path.join(server, `run-${OTHER_RUN}`, 'terminal-hosts'));
    writeFileSync(path.join(server, `run-${OTHER_RUN}`, 'terminal-hosts', '4242.json'), JSON.stringify({ version: '3.6.0', pid: 4242, hostname: 'lab-2', endpoint: '/tmp/damocles-x/host.sock', socketFolder: '/tmp/damocles-x', updatedAt: 1 }));
    installVersions(server, ['3.6.0-linux-x64', '3.7.0-linux-x64']);
    const output = await run(home, { runKey: RUN_KEY, disableLinger: false }, 'id() { echo dev; }');
    expect(lines(output)).toEqual([
      { kind: 'notice', code: 'versionKept', params: { version: '3.6.0', machine: 'lab-2' } },
      { kind: 'notice', code: 'floorKept', params: { folder: shellPath(server), files: 'marker' } },
      { kind: 'notice', code: 'serverFolderKept', params: {} },
      { kind: 'removed' },
    ]);
    expect(readdirSync(server).sort()).toEqual(['3.6.0-linux-x64', ...LOOK_ALIKES, 'removed', `run-${OTHER_RUN}`].sort());
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

  it('deletes the socket folders the run folder records, a crashed daemon\'s agent, relay and CLI folders included, and only Damocles\' own', async () => {
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
    const cli = made('damocles-cli', [`cli-${'b'.repeat(24)}.sock`, `cli-${'c'.repeat(24)}.sock`]);
    const crowded = made('damocles-crowded', ['askpass.sock', 'notes.txt']);
    const other = made('other-tool', ['askpass.sock']);
    const runDir = path.join(server, `run-${RUN_KEY}`);
    writeFileSync(path.join(runDir, 'daemon.pid'), JSON.stringify({ version: '3.7.0', pid: DEAD_PID, endpoint: `${endpoint}/daemon.sock`, socketFolder: endpoint }));
    writeFileSync(path.join(runDir, 'socket-folders'), [agent, relay, cli, crowded, other, 'relative/damocles-x', ''].join('\n'));
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

  it('deletes builds\' folders as version folders, and keeps the build another machine\'s live daemon names', async () => {
    const { home, server } = targetHome();
    const kept = '3.6.0+aaaaaaaaaaaa';
    writeFileSync(path.join(server, `run-${OTHER_RUN}`, 'daemon.pid'), JSON.stringify({ version: kept, pid: 1, hostname: 'lab-2', endpoint: '/x', socketFolder: null, updatedAt: 1 }));
    installVersions(server, [`${kept}-linux-x64`, '3.7.0+bbbbbbbbbbbb-linux-x64', '3.7.0-linux-x64']);
    const output = await run(home, { runKey: RUN_KEY, disableLinger: false }, 'id() { echo dev; }');
    expect(lines(output)).toEqual([
      { kind: 'notice', code: 'versionKept', params: { version: kept, machine: 'lab-2' } },
      { kind: 'notice', code: 'floorKept', params: { folder: shellPath(server), files: 'marker' } },
      { kind: 'notice', code: 'serverFolderKept', params: {} },
      { kind: 'removed' },
    ]);
    expect(readdirSync(server).sort()).toEqual([`${kept}-linux-x64`, ...LOOK_ALIKES, 'removed', `run-${OTHER_RUN}`].sort());
  });

  it('keeps a version only another machine\'s recently touched pid file names', async () => {
    const { home, server } = targetHome();
    installVersions(server, ['3.6.0-linux-x64']);
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(path.join(server, `run-${OTHER_RUN}`, 'daemon.pid'), stale, stale);
    await run(home, { runKey: RUN_KEY, disableLinger: false }, 'id() { echo dev; }');
    expect(existsSync(path.join(server, '3.6.0-linux-x64'))).toBe(false);
  });

  it('keeps the security floor, and sweeps a crashed raise\'s temporary files and stale lock, but not while a raise holds the lock', async () => {
    const { home, server } = targetHome();
    const folder = path.join(home, 'tools');
    const install = securityFloors(server, path.join(folder, 'dev'));
    const output = await run(home, { runKey: RUN_KEY, installFolder: shellPath(folder), disableLinger: false }, ID_DEV);
    expect(lines(output)).toEqual([
      { kind: 'notice', code: 'floorKept', params: { folder: shellPath(server), files: 'floor' } },
      { kind: 'notice', code: 'floorKept', params: { folder: shellPath(install), files: 'both' } },
      { kind: 'notice', code: 'serverFolderKept', params: {} },
      { kind: 'removed' },
    ]);
    expect(readdirSync(server).sort()).toEqual([`run-${OTHER_RUN}`, 'security-floor']);
    expect(readFileSync(path.join(server, 'security-floor'), 'utf8')).toBe('3.9.0\n');
    expect(readdirSync(install).sort()).toEqual(['removed', 'security-floor', `security-floor.${'a'.repeat(12)}.tmp`, 'security-floor.lock']);
  });

  it('says ~/.damocles/server stays for its security floor and removed marker alone when nothing else is left in it', async () => {
    const home = scratchDir('remove-home-');
    const server = path.join(home, '.damocles', 'server');
    mkdirSync(path.join(server, `run-${RUN_KEY}`), { recursive: true });
    writeFileSync(path.join(server, 'security-floor'), '3.9.0\n');
    const output = await run(home, { runKey: RUN_KEY, disableLinger: false }, ID_DEV);
    expect(lines(output)).toEqual([{ kind: 'notice', code: 'floorKept', params: { folder: shellPath(server), files: 'both' } }, { kind: 'removed' }]);
    expect(readdirSync(server).sort()).toEqual(['removed', 'security-floor']);
  });

  it.skipIf(!linuxDocker)('takes a process of this user whose program it cannot read, such as a zombie, for no terminal host (needs Docker with Linux containers)', async () => {
    const script = [
      'HOME=/root; run="$HOME/.damocles/server/run-0123456789abcdef"',
      'mkdir -p "$run/terminal-hosts"',
      // the exec'd sleep never reaps the child it inherits
      `sh -c 'sleep 0 & echo $! > /tmp/zombie; exec sleep 300' &`,
      'sleep 1; zombie=$(cat /tmp/zombie)',
      'printf \'state=%s\\n\' "$(cut -d " " -f 3 "/proc/$zombie/stat")"',
      'printf \'{"version":"3.6.0","pid":%s,"hostname":"box"}\' "$zombie" > "$run/terminal-hosts/$zombie.json"',
      `( ${buildPosixRemoval({ runKey: RUN_KEY, disableLinger: false })}\n)`,
    ].join('\n');
    const output = await runProcess({ file: docker!, args: ['run', '--rm', '-i', ALPINE, 'sh', '-s'], windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, { input: script, timeoutMs: 180_000 });
    expect(output.stdout.toString('utf8')).toContain('state=Z');
    expect(lines(output)).toEqual([{ kind: 'notice', code: 'floorKept', params: { folder: '/root/.damocles/server', files: 'marker' } }, { kind: 'removed' }]);
  }, 200_000);
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
      { kind: 'notice', code: 'floorKept', params: { folder: server, files: 'marker' } },
      { kind: 'notice', code: 'floorKept', params: { folder: path.join(folder, 'dev'), files: 'marker' } },
      { kind: 'notice', code: 'serverFolderKept', params: {} },
      { kind: 'removed' },
    ]);
    // every install folder that held a server keeps the removed marker, the one stage 1 uses and ~/.damocles/server here
    expect(readdirSync(server).sort()).toEqual(['3.6.0-win32-x64', ...LOOK_ALIKES, 'removed', `run-${OTHER_RUN}`].sort());
    expect(readdirSync(path.join(folder, 'dev')).sort()).toEqual([...LOOK_ALIKES, 'removed'].sort());
    expect(readdirSync(folder).sort()).toEqual(['README', 'dev']);
  });

  it.skipIf(shell === undefined)('deletes builds\' folders as version folders, and keeps the build another machine\'s live daemon names', async () => {
    const { home, server } = targetHome();
    const kept = '3.6.0+aaaaaaaaaaaa';
    writeFileSync(path.join(server, `run-${OTHER_RUN}`, 'daemon.pid'), JSON.stringify({ version: kept, pid: 1, hostname: 'lab-2', endpoint: '/x', socketFolder: null, updatedAt: 1 }));
    installVersions(server, [`${kept}-win32-x64`, '3.7.0+bbbbbbbbbbbb-win32-x64', '3.7.0-win32-x64']);
    const output = await run(home, path.join(home, 'ProgramData'), { runKey: RUN_KEY, disableLinger: false });
    expect(lines(output)).toEqual([
      { kind: 'notice', code: 'versionKept', params: { version: kept, machine: 'lab-2' } },
      { kind: 'notice', code: 'floorKept', params: { folder: server, files: 'marker' } },
      { kind: 'notice', code: 'serverFolderKept', params: {} },
      { kind: 'removed' },
    ]);
    expect(readdirSync(server).sort()).toEqual([`${kept}-win32-x64`, ...LOOK_ALIKES, 'removed', `run-${OTHER_RUN}`].sort());
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

  it.skipIf(shell === undefined || process.platform !== 'win32')('stops before deleting anything while a terminal host of this machine runs from an install, and not for a record whose pid another program took', async () => {
    const { home, server } = targetHome();
    const runDir = path.join(server, `run-${RUN_KEY}`);
    const hosts = path.join(runDir, 'terminal-hosts');
    mkdirSync(hosts);
    const record = (pid: number): string => JSON.stringify({ version: '3.6.0', pid, hostname: 'box', endpoint: `\\\\.\\pipe\\damocles-terminals-${'a'.repeat(32)}`, socketFolder: null, updatedAt: 1 });
    // a copy of this Node in a version folder stands in for the terminal host
    const version = path.join(scratchDir('remove-install-'), '3.6.0-win32-x64');
    mkdirSync(path.join(version, 'node'), { recursive: true });
    writeFileSync(path.join(version, 'server-package.json'), '{}');
    copyFileSync(process.execPath, path.join(version, 'node', 'node.exe'));
    const host = spawn(path.join(version, 'node', 'node.exe'), ['-e', 'setTimeout(() => undefined, 600000)'], { stdio: 'ignore', windowsHide: true });
    const ended = new Promise((resolve) => host.once('exit', resolve));
    try {
      await new Promise((resolve, reject) => host.once('spawn', resolve).once('error', reject));
      writeFileSync(path.join(hosts, `${host.pid}.json`), record(host.pid!));
      writeFileSync(path.join(hosts, `${host.pid}.token`), 'a'.repeat(64));
      // no <pid>.json: no daemon reads it, so it holds no removal
      writeFileSync(path.join(hosts, 'notes.json'), record(host.pid!));
      const live = await run(home, path.join(home, 'ProgramData'), { runKey: RUN_KEY, disableLinger: false });
      expect(lines(live)).toEqual([{ kind: 'fail', code: 'terminalHostRunning', params: { pids: String(host.pid) } }]);
      expect(readdirSync(hosts).sort()).toEqual([`${host.pid}.json`, `${host.pid}.token`, 'notes.json'].sort());
      expect(readdirSync(runDir).sort()).toEqual(['logs', 'terminal-hosts']);
    } finally {
      host.kill();
      await ended;
    }
    // this test's own process is live and runs from no install
    writeFileSync(path.join(hosts, `${process.pid}.json`), record(process.pid));
    const reused = await run(home, path.join(home, 'ProgramData'), { runKey: RUN_KEY, disableLinger: false });
    expect(lines(reused).at(-1)).toEqual({ kind: 'removed' });
    expect(existsSync(runDir)).toBe(false);
  });

  // main refuses a parameter past 500 characters, and 40 pids of 10 digits and their spaces fit
  it.skipIf(shell === undefined)('names at most 40 live terminal hosts', async () => {
    const { home, server } = targetHome();
    const hosts = path.join(server, `run-${RUN_KEY}`, 'terminal-hosts');
    mkdirSync(hosts);
    const pids = Array.from({ length: 45 }, (_, index) => 1_000_000_001 + index);
    for (const pid of pids) writeFileSync(path.join(hosts, `${pid}.json`), JSON.stringify({ version: '3.6.0', pid, hostname: 'box' }));
    // every record names a live process that runs from an install
    const live = 'function Get-DamoclesRecordProcess([string]$file) { return [pscustomobject]@{ Id = [int64][IO.Path]::GetFileNameWithoutExtension($file); Path = $null } }\nfunction Test-DamoclesRunsFromInstall($process) { return $true }\n# BEGIN MAIN';
    const output = await runPowerShell(shell!, ['$DamoclesOut = [Console]::OpenStandardOutput()', `$env:USERPROFILE = '${home}'`, "$env:USERNAME = 'dev'", buildWindowsRemoval({ runKey: RUN_KEY, disableLinger: false }).replace('# BEGIN MAIN', live), ''].join('\n'));
    const [message] = lines(output) as Array<{ code: string; params: { pids: string } }>;
    expect(message?.code, output.stderr.toString('utf8')).toBe('terminalHostRunning');
    expect(message!.params.pids.split(' ')).toEqual(pids.slice(0, 40).map(String));
  });

  it.skipIf(shell === undefined)('keeps a version another machine\'s terminal host names', async () => {
    const { home, server } = targetHome();
    rmSync(path.join(server, `run-${OTHER_RUN}`, 'daemon.pid'));
    mkdirSync(path.join(server, `run-${OTHER_RUN}`, 'terminal-hosts'));
    writeFileSync(path.join(server, `run-${OTHER_RUN}`, 'terminal-hosts', '4242.json'), JSON.stringify({ version: '3.6.0', pid: 4242, hostname: 'lab-2', endpoint: 'x', socketFolder: null, updatedAt: 1 }));
    installVersions(server, ['3.6.0-win32-x64', '3.7.0-win32-x64']);
    const output = await run(home, path.join(home, 'ProgramData'), { runKey: RUN_KEY, disableLinger: false });
    expect(lines(output)).toEqual([
      { kind: 'notice', code: 'versionKept', params: { version: '3.6.0', machine: 'lab-2' } },
      { kind: 'notice', code: 'floorKept', params: { folder: server, files: 'marker' } },
      { kind: 'notice', code: 'serverFolderKept', params: {} },
      { kind: 'removed' },
    ]);
    expect(readdirSync(server).sort()).toEqual(['3.6.0-win32-x64', ...LOOK_ALIKES, 'removed', `run-${OTHER_RUN}`].sort());
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

  it.skipIf(shell === undefined)('keeps the security floor, and sweeps a crashed raise\'s temporary files and stale lock, but not while a raise holds the lock', async () => {
    const { home, server } = targetHome();
    const folder = path.join(home, 'tools');
    const install = securityFloors(server, path.join(folder, 'dev'));
    const output = await run(home, path.join(home, 'ProgramData'), { runKey: RUN_KEY, installFolder: folder, disableLinger: false });
    expect(lines(output), output.stderr.toString('utf8')).toEqual([
      { kind: 'notice', code: 'floorKept', params: { folder: server, files: 'floor' } },
      { kind: 'notice', code: 'floorKept', params: { folder: install, files: 'both' } },
      { kind: 'notice', code: 'serverFolderKept', params: {} },
      { kind: 'removed' },
    ]);
    expect(readdirSync(server).sort()).toEqual([`run-${OTHER_RUN}`, 'security-floor']);
    expect(readFileSync(path.join(server, 'security-floor'), 'utf8')).toBe('3.9.0\n');
    expect(readdirSync(install).sort()).toEqual(['removed', 'security-floor', `security-floor.${'a'.repeat(12)}.tmp`, 'security-floor.lock']);
  });

  it.skipIf(shell === undefined)('says ~/.damocles/server stays for its security floor and removed marker alone when nothing else is left in it', async () => {
    const home = scratchDir('remove-home-');
    const server = path.join(home, '.damocles', 'server');
    mkdirSync(path.join(server, `run-${RUN_KEY}`), { recursive: true });
    writeFileSync(path.join(server, 'security-floor'), '3.9.0\n');
    const output = await run(home, path.join(home, 'ProgramData'), { runKey: RUN_KEY, disableLinger: false });
    expect(lines(output), output.stderr.toString('utf8')).toEqual([{ kind: 'notice', code: 'floorKept', params: { folder: server, files: 'both' } }, { kind: 'removed' }]);
    expect(readdirSync(server).sort()).toEqual(['removed', 'security-floor']);
  });

  // Windows has no kill -0: another user's process, lsass's here, hides its program as it hides its owner
  it.skipIf(shell === undefined || process.platform !== 'win32')('counts a process whose program it cannot read as a terminal host only when it is this user\'s', async () => {
    const { home, server } = targetHome();
    const hosts = path.join(server, `run-${RUN_KEY}`, 'terminal-hosts');
    mkdirSync(hosts);
    const unread = (id: string): string => `$(Test-DamoclesRunsFromInstall ([pscustomobject]@{ Id = ${id}; Path = $null }))`;
    const probe = `[Console]::Out.Write("${unread('$PID')}|${unread('(Get-Process -Name lsass).Id')}|${unread(String(DEAD_PID))}"); exit 0\n# BEGIN MAIN`;
    const checked = await runPowerShell(shell!, ['$DamoclesOut = [Console]::OpenStandardOutput()', buildWindowsRemoval({ runKey: RUN_KEY, disableLinger: false }).replace('# BEGIN MAIN', probe), ''].join('\n'));
    expect(checked.stdout.toString('utf8'), checked.stderr.toString('utf8')).toBe('True|False|False');
    const output = await runWith(home, [`$lsass = (Get-Process -Name lsass).Id; [IO.File]::WriteAllText("${hosts}\\$lsass.json", (ConvertTo-Json -Compress -InputObject @{ version = '3.6.0'; pid = $lsass }))`], { runKey: RUN_KEY, disableLinger: false });
    expect(lines(output).at(-1), output.stderr.toString('utf8')).toEqual({ kind: 'removed' });
    expect(existsSync(path.join(server, `run-${RUN_KEY}`))).toBe(false);
  });
});
