import { mkdirSync, mkdtempSync, statSync, symlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlFolders, controlMasterPlan, controlPathFits, exitControlMaster, parseControlConfig, systemControlMasterDeps, type ControlMasterDeps, type ControlMasterPlan } from '../control-master';
import { buildSshArgs, buildSshControlArgs, FIXED_SSH_OPTIONS } from '../ssh-args';

const destination = { kind: 'alias' as const, alias: 'prod-1' };
const HOME_FOLDER = '/home/u/.damocles/ssh/cm';

function deps(options: { sshG?: string; folders?: string[]; platform?: NodeJS.Platform; refuse?: string[]; run?: ControlMasterDeps['run'] } = {}): ControlMasterDeps & { calls: string[][]; made: string[]; logs: string[] } {
  const calls: string[][] = [];
  const made: string[] = [];
  const logs: string[] = [];
  return {
    calls,
    made,
    logs,
    platform: options.platform ?? 'linux',
    folders: options.folders ?? [HOME_FOLDER],
    resolveSsh: async () => '/usr/bin/ssh',
    run: options.run ?? (async (_file, args) => {
      calls.push([...args]);
      if (args.includes('-G')) return { code: 0, stdout: options.sshG ?? 'user u\ncontrolmaster false\ncontrolpersist no\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }),
    makePrivateFolder: async (folder) => {
      made.push(folder);
      return !(options.refuse ?? []).includes(folder);
    },
    log: (line) => { logs.push(line); },
  };
}

describe('parseControlConfig', () => {
  it('reads controlmaster and controlpath as ssh -G prints them', () => {
    expect(parseControlConfig('controlmaster false\ncontrolpersist no\n')).toEqual({ master: 'false', path: undefined });
    expect(parseControlConfig('controlmaster auto\ncontrolpath /tmp/cm-%C\n')).toEqual({ master: 'auto', path: '/tmp/cm-%C' });
    expect(parseControlConfig('controlmaster no\ncontrolpath none\n')).toEqual({ master: 'no', path: undefined });
  });
});

describe('controlPathFits', () => {
  // the folder, a slash, %C's 40 hex digits and the 17-byte suffix the master binds first must stay under sun_path's NUL
  it('takes a folder of at most 45 bytes on macOS and 49 elsewhere', () => {
    expect(controlPathFits('/'.padEnd(45, 'a'), 'darwin')).toBe(true);
    expect(controlPathFits('/'.padEnd(46, 'a'), 'darwin')).toBe(false);
    expect(controlPathFits('/'.padEnd(49, 'a'), 'linux')).toBe(true);
    expect(controlPathFits('/'.padEnd(50, 'a'), 'linux')).toBe(false);
  });

  it('counts bytes, not characters', () => {
    expect(controlPathFits(`/${'é'.repeat(24)}`, 'linux')).toBe(true);
    expect(controlPathFits(`/${'é'.repeat(25)}`, 'linux')).toBe(false);
  });

  it('refuses the default folder for a home of 30 bytes on macOS and of 33 on Linux', () => {
    expect(controlPathFits('/Users/alexandrosstefanopoulos/.damocles/ssh/cm', 'darwin')).toBe(false);
    expect(controlPathFits('/Users/alexandrosstefanop/.damocles/ssh/cm', 'darwin')).toBe(true);
    expect(controlPathFits('/home/john.smith@corp.example.com/.damocles/ssh/cm', 'linux')).toBe(false);
  });
});

describe('controlFolders', () => {
  it('tries Damocles\' folder, then the runtime folder, then a per-user folder in the temp folder and in /tmp', () => {
    expect(controlFolders(HOME_FOLDER, { XDG_RUNTIME_DIR: '/run/user/1000' }, '/tmp', 1000)).toEqual([HOME_FOLDER, '/run/user/1000/damocles-cm', '/tmp/damocles-cm-1000']);
    expect(controlFolders(HOME_FOLDER, {}, '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T', 501)).toEqual([HOME_FOLDER, '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/damocles-cm-501', '/tmp/damocles-cm-501']);
    expect(controlFolders(HOME_FOLDER, { XDG_RUNTIME_DIR: 'relative' }, '/tmp', 1000)).toEqual([HOME_FOLDER, '/tmp/damocles-cm-1000']);
  });
});

describe('controlMasterPlan', () => {
  it('adds its own master under Damocles\' folder only when the user\'s config does not multiplex', async () => {
    const own = deps();
    expect(await controlMasterPlan(own, destination, undefined)).toEqual({ kind: 'damocles', controlPath: `${HOME_FOLDER}/%C` });
    expect(own.made).toEqual([HOME_FOLDER]);
    expect(own.calls[0]).toEqual(['-G', '--', 'prod-1']);
    expect(await controlMasterPlan(deps({ sshG: 'controlmaster auto\ncontrolpath ~/.ssh/cm-%r@%h:%p\n' }), destination, undefined)).toEqual({ kind: 'none' });
    expect(await controlMasterPlan(deps({ sshG: 'controlmaster false\ncontrolpath ~/.ssh/cm-%C\n' }), destination, undefined)).toEqual({ kind: 'none' });
  });

  it('leaves a ControlMaster the user set without a ControlPath as it is', async () => {
    const auto = deps({ sshG: 'controlmaster auto\n' });
    expect(await controlMasterPlan(auto, destination, undefined)).toEqual({ kind: 'none' });
    expect(auto.made).toEqual([]);
  });

  it('turns multiplexing off on Windows without asking ssh -G', async () => {
    const windows = deps({ platform: 'win32' });
    expect(await controlMasterPlan(windows, destination, undefined)).toEqual({ kind: 'off' });
    expect(windows.calls).toEqual([]);
  });

  it('moves to a shorter private folder when Damocles\' is too long for sun_path, and to the next when one is not private', async () => {
    const long = '/Users/alexandrosstefanopoulos/.damocles/ssh/cm';
    const shorter = deps({ platform: 'darwin', folders: [long, '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/damocles-cm-501', '/tmp/x-501', '/tmp/damocles-cm-501'], refuse: ['/tmp/x-501'] });
    expect(await controlMasterPlan(shorter, destination, undefined)).toEqual({ kind: 'damocles', controlPath: '/tmp/damocles-cm-501/%C' });
    expect(shorter.made).toEqual(['/tmp/x-501', '/tmp/damocles-cm-501']);
  });

  it('uses no master, and says so, when no folder fits', async () => {
    const none = deps({ platform: 'darwin', folders: ['/Users/alexandrosstefanopoulos/.damocles/ssh/cm'] });
    expect(await controlMasterPlan(none, destination, undefined)).toEqual({ kind: 'none' });
    expect(none.made).toEqual([]);
    expect(none.logs.some((line) => line.includes('short enough'))).toBe(true);
  });

  it('doubles a % in the folder, which ssh would read as a token', async () => {
    const percent = deps({ folders: ['/home/100%u/.damocles/ssh/cm'] });
    expect(await controlMasterPlan(percent, destination, undefined)).toEqual({ kind: 'damocles', controlPath: '/home/100%%u/.damocles/ssh/cm/%C' });
  });

  it('uses no master when ssh -G fails or cannot start', async () => {
    const failed = deps({ run: async () => ({ code: 255, stdout: '', stderr: '' }) });
    expect(await controlMasterPlan(failed, destination, undefined)).toEqual({ kind: 'none' });
    const unstartable = deps({ run: async () => { throw Object.assign(new Error('spawn ssh EACCES'), { code: 'EACCES' }); } });
    expect(await controlMasterPlan(unstartable, destination, undefined)).toEqual({ kind: 'none' });
    expect(unstartable.logs.some((line) => line.includes('spawn ssh EACCES'))).toBe(true);
  });
});

describe('the ControlMaster options', () => {
  it('puts the plan\'s options right after the fixed set, before the one ForwardAgent and the destination', () => {
    const fixedEnd = FIXED_SSH_OPTIONS.length;
    const own = buildSshArgs({ destination, forwardAgent: false, command: 'true', controlMaster: { kind: 'damocles', controlPath: `${HOME_FOLDER}/%C` } });
    expect(own.slice(fixedEnd, fixedEnd + 6)).toEqual(['-o', 'ControlMaster=auto', '-o', `ControlPath="${HOME_FOLDER}/%C"`, '-o', 'ControlPersist=10m']);
    expect(own.slice(fixedEnd + 6)).toEqual(['-o', 'ForwardAgent=no', '--', 'prod-1', 'true']);
    const off = buildSshArgs({ destination, forwardAgent: false, command: 'true', controlMaster: { kind: 'off' } });
    expect(off.slice(fixedEnd, fixedEnd + 4)).toEqual(['-o', 'ControlMaster=no', '-o', 'ControlPath=none']);
    for (const plan of [undefined, { kind: 'none' as const }]) {
      expect(buildSshArgs({ destination, forwardAgent: false, command: 'true', ...(plan ? { controlMaster: plan } : {}) }).some((arg) => arg.startsWith('Control'))).toBe(false);
    }
    expect(buildSshControlArgs(destination, undefined, '/a b/%C')).toEqual(['-o', 'ControlPath="/a b/%C"', '-O', 'exit', '--', 'prod-1']);
  });
});

describe('exitControlMaster', () => {
  it('ends Damocles\' master and never touches a master the user\'s config sets up', async () => {
    const own = deps();
    await exitControlMaster(own, destination, undefined, { kind: 'damocles', controlPath: `${HOME_FOLDER}/%C` });
    expect(own.calls).toEqual([['-o', `ControlPath="${HOME_FOLDER}/%C"`, '-O', 'exit', '--', 'prod-1']]);
    for (const plan of [{ kind: 'none' }, { kind: 'off' }] as ControlMasterPlan[]) {
      const other = deps();
      await exitControlMaster(other, destination, undefined, plan);
      expect(other.calls).toEqual([]);
    }
  });

  it('logs an ssh that cannot start instead of rejecting', async () => {
    const unstartable = deps({ run: async () => { throw new Error('spawn ssh ENOENT'); } });
    await expect(exitControlMaster(unstartable, destination, undefined, { kind: 'damocles', controlPath: `${HOME_FOLDER}/%C` })).resolves.toBeUndefined();
    expect(unstartable.logs.some((line) => line.includes('spawn ssh ENOENT'))).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('the private ControlPath folder on a POSIX client', () => {
  it('makes a folder this user owns 0700, and refuses a link', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cm-'));
    const { makePrivateFolder } = systemControlMasterDeps(path.join(root, 'cm'), () => undefined);
    mkdirSync(path.join(root, 'cm'), { mode: 0o755 });
    expect(await makePrivateFolder(path.join(root, 'cm'))).toBe(true);
    expect(statSync(path.join(root, 'cm')).mode & 0o777).toBe(0o700);
    mkdirSync(path.join(root, 'elsewhere'), { mode: 0o755 });
    symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'link'));
    expect(await makePrivateFolder(path.join(root, 'link'))).toBe(false);
    expect(statSync(path.join(root, 'elsewhere')).mode & 0o777).toBe(0o755);
  });
});
