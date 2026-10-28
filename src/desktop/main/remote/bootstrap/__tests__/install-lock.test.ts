import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { powerShell, runPowerShell, runSh, scratchDir, shellPath, stageMessages, withPosixDefinitions, withWindowsDefinitions } from './shells';

// a pid no process holds: above Linux's PID_MAX_LIMIT (2^22), and not a multiple of 4, as every Windows process id is
const DEAD_PID = 4_194_305;

function lockIn(dir: string, owner: string, ageMinutes = 0): string {
  const lock = path.join(dir, 'install.lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'owner'), `${owner}\n`);
  const at = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(lock, at, at);
  return lock;
}

describe('install.lock in a real sh', { timeout: 120_000 }, () => {
  const stale = async (dir: string): Promise<string> =>
    (await runSh(withPosixDefinitions(`lock='${shellPath(path.join(dir, 'install.lock'))}'; if lock_is_stale; then echo stale; else echo live; fi`))).stdout.toString('utf8').trim();

  it('is stale when its pid is gone on this host, and the next stage takes it over', async () => {
    const dir = scratchDir('lock-');
    const lock = lockIn(dir, 'placeholder 1');
    // sh writes the owner line, so it names this host as uname -n does
    await runSh(`printf '%s %s\\n' "$(uname -n)" ${DEAD_PID} > '${shellPath(path.join(lock, 'owner'))}'`);
    expect(await stale(dir)).toBe('stale');
    const { stdout } = await runSh(withPosixDefinitions(`lock='${shellPath(lock)}'; takeover="$lock.takeover"; take_lock; echo "taken $$"`));
    const [, pid] = /taken (\d+)/.exec(stdout.toString('utf8'))!;
    expect(readFileSync(path.join(lock, 'owner'), 'utf8').trim()).toMatch(new RegExp(` ${pid}$`));
    expect(existsSync(`${lock}.takeover`)).toBe(false);
  });

  it('is live while its pid runs on this host, and a waiting stage gives up with installLocked', async () => {
    const dir = scratchDir('lock-');
    const lock = path.join(dir, 'install.lock');
    const body = `lock='${shellPath(lock)}'; takeover="$lock.takeover"; mkdir "$lock"; sleep 30 & holder=$!; printf '%s %s\\n' "$(uname -n)" "$holder" > "$lock/owner"
if lock_is_stale; then echo stale; else echo live; fi
LOCK_WAIT_S=1; (take_lock); kill "$holder"`;
    const output = await runSh(withPosixDefinitions(body));
    expect(output.stdout.toString('utf8')).toMatch(/^live\n/);
    expect(stageMessages(output)).toEqual([{ kind: 'fail', code: 'unknown', params: { reason: 'installLocked' } }]);
  });

  it('is stale after 30 minutes when another host took it, and live before', async () => {
    const dir = scratchDir('lock-');
    lockIn(dir, 'other-machine 1', 29);
    expect(await stale(dir)).toBe('live');
    const aged = scratchDir('lock-');
    lockIn(aged, 'other-machine 1', 31);
    expect(await stale(aged)).toBe('stale');
  });

  it('waits, then gives up with installLocked, when a stale lock cannot be removed', async () => {
    const dir = scratchDir('lock-');
    const lock = path.join(dir, 'install.lock');
    const body = `lock='${shellPath(lock)}'; takeover="$lock.takeover"; mkdir "$lock"; printf '%s %s\\n' "$(uname -n)" ${DEAD_PID} > "$lock/owner"
rm() { return 1; }
LOCK_WAIT_S=2; take_lock`;
    const output = await runSh(withPosixDefinitions(body));
    expect(stageMessages(output)).toEqual([{ kind: 'fail', code: 'unknown', params: { reason: 'installLocked' } }]);
  });

  it('removes .staging-* folders older than one day and keeps newer ones and other entries', async () => {
    const dir = scratchDir('staging-');
    for (const name of ['.staging-old', '.staging-new', 'keep-old']) mkdirSync(path.join(dir, name));
    const old = new Date(Date.now() - 25 * 3600_000);
    utimesSync(path.join(dir, '.staging-old'), old, old);
    utimesSync(path.join(dir, 'keep-old'), old, old);
    await runSh(withPosixDefinitions(`remove_old_staging '${shellPath(dir)}'`));
    expect(readdirSync(dir).sort()).toEqual(['.staging-new', 'keep-old']);
  });

  it('prunes all but the current version, the versions live pid files name, and the newest previous one', async () => {
    const home = scratchDir('prune-home-');
    const install = path.join(home, '.damocles', 'server');
    const versions = ['1.0.0-linux-x64', '2.0.0-linux-x64', '3.0.0-linux-x64', '4.0.0-linux-x64', '5.0.0-linux-x64'];
    versions.forEach((name, index) => {
      mkdirSync(path.join(install, name), { recursive: true });
      writeFileSync(path.join(install, name, 'server-package.json'), '{}');
      const at = new Date(Date.now() - (versions.length - index) * 3600_000);
      utimesSync(path.join(install, name), at, at);
    });
    // only look like versions (no version name, or no package manifest), one newer than every version, the rest older
    const lookAlikes = ['node-v20.11.0-linux-x64', 'MyApp-linux-x64', 'notes-linux-x64', '0.9.0-linux-x64'];
    lookAlikes.forEach((name, index) => {
      mkdirSync(path.join(install, name));
      const at = new Date(Date.now() - (index === 0 ? 0 : 48 * 3600_000));
      utimesSync(path.join(install, name), at, at);
    });
    mkdirSync(path.join(install, 'run-0123456789abcdef'));
    writeFileSync(path.join(install, 'run-0123456789abcdef', 'daemon.pid'), JSON.stringify({ version: '1.0.0', pid: 1, hostname: 'nfs-peer', endpoint: '/tmp/x', socketFolder: '/tmp', updatedAt: 0 }));
    mkdirSync(path.join(install, 'run-fedcba9876543210'));
    writeFileSync(path.join(install, 'run-fedcba9876543210', 'daemon.pid'), JSON.stringify({ version: '2.0.0', pid: 1 }));
    const stale = new Date(Date.now() - 26 * 3600_000);
    utimesSync(path.join(install, 'run-fedcba9876543210', 'daemon.pid'), stale, stale);
    await runSh(withPosixDefinitions(`HOME='${shellPath(home)}'; prune '${shellPath(install)}' '${shellPath(path.join(install, '5.0.0-linux-x64'))}'`));
    expect(readdirSync(install).sort()).toEqual(['1.0.0-linux-x64', '4.0.0-linux-x64', '5.0.0-linux-x64', ...lookAlikes, 'run-0123456789abcdef', 'run-fedcba9876543210'].sort());
  });
});

describe('install.lock in a real PowerShell', { timeout: 120_000 }, async () => {
  const shell = await powerShell();
  const stale = async (dir: string): Promise<string> =>
    (await runPowerShell(shell!, withWindowsDefinitions(`if (Test-DamoclesLockStale '${path.join(dir, 'install.lock')}') { [Console]::Out.Write('stale') } else { [Console]::Out.Write('live') }`))).stdout.toString('utf8');

  it.skipIf(shell === undefined)('is stale when its pid is gone on this host, and Enter-DamoclesLock takes it over', async () => {
    const dir = scratchDir('lock-');
    const lock = lockIn(dir, 'placeholder 1');
    // PowerShell writes the owner line, so it names this host as [Environment]::MachineName does
    const script = [
      `[IO.File]::WriteAllText('${path.join(lock, 'owner')}', "$([Environment]::MachineName) ${DEAD_PID}")`,
      `$before = Test-DamoclesLockStale '${lock}'`,
      `Enter-DamoclesLock '${lock}'`,
      '[Console]::Out.Write("$before $([Environment]::MachineName) $PID")',
    ].join('\n');
    const [before, machine, pid] = (await runPowerShell(shell!, withWindowsDefinitions(script))).stdout.toString('utf8').split(' ');
    expect(before).toBe('True');
    expect(readFileSync(path.join(lock, 'owner'), 'utf8').trim()).toBe(`${machine} ${pid}`);
  });

  it.skipIf(shell === undefined)('is live while its pid runs on this host', async () => {
    const dir = scratchDir('lock-');
    const lock = lockIn(dir, 'placeholder 1');
    const script = [
      `[IO.File]::WriteAllText('${path.join(lock, 'owner')}', "$([Environment]::MachineName) $PID")`,
      `if (Test-DamoclesLockStale '${lock}') { [Console]::Out.Write('stale') } else { [Console]::Out.Write('live') }`,
    ].join('\n');
    expect((await runPowerShell(shell!, withWindowsDefinitions(script))).stdout.toString('utf8')).toBe('live');
  });

  it.skipIf(shell === undefined)('prunes all but the current version, the versions live pid files name, and the newest previous one, never a look-alike', async () => {
    const home = scratchDir('prune-home-');
    const install = path.join(home, '.damocles', 'server');
    const versions = ['1.0.0-win32-x64', '2.0.0-win32-x64', '3.0.0-win32-x64', '4.0.0-win32-x64'];
    versions.forEach((name, index) => {
      mkdirSync(path.join(install, name), { recursive: true });
      writeFileSync(path.join(install, name, 'server-package.json'), '{}');
      const at = new Date(Date.now() - (versions.length - index) * 3600_000);
      utimesSync(path.join(install, name), at, at);
    });
    // only look like versions, one newer than every version, the rest older
    const lookAlikes = ['node-v20.11.0-win32-x64', 'MyApp-win32-x64', 'notes-win32-x64', '0.9.0-win32-x64'];
    lookAlikes.forEach((name, index) => {
      mkdirSync(path.join(install, name));
      const at = new Date(Date.now() - (index === 0 ? 0 : 48 * 3600_000));
      utimesSync(path.join(install, name), at, at);
    });
    mkdirSync(path.join(install, 'run-0123456789abcdef'));
    writeFileSync(path.join(install, 'run-0123456789abcdef', 'daemon.pid'), JSON.stringify({ version: '1.0.0', pid: 1, hostname: 'nfs-peer' }));
    await runPowerShell(shell!, withWindowsDefinitions(`$env:USERPROFILE = '${home}'\nInvoke-DamoclesPrune '${install}' '${path.join(install, '4.0.0-win32-x64')}'`));
    expect(readdirSync(install).sort()).toEqual(['1.0.0-win32-x64', '3.0.0-win32-x64', '4.0.0-win32-x64', ...lookAlikes, 'run-0123456789abcdef'].sort());
  });

  it.skipIf(shell === undefined)('reads an owner file it cannot read as no owner, judging the lock by its age', async () => {
    const dir = scratchDir('lock-');
    const lock = path.join(dir, 'install.lock');
    // an owner that is a folder fails the read as a file a releasing stage removed meanwhile does
    mkdirSync(path.join(lock, 'owner'), { recursive: true });
    expect(await stale(dir)).toBe('live');
  });

  it.skipIf(shell === undefined)('is stale after 30 minutes when another host took it, and live before', async () => {
    const fresh = scratchDir('lock-');
    lockIn(fresh, 'other-machine 1', 29);
    expect(await stale(fresh)).toBe('live');
    const aged = scratchDir('lock-');
    lockIn(aged, 'other-machine 1', 31);
    expect(await stale(aged)).toBe('stale');
  });
});
