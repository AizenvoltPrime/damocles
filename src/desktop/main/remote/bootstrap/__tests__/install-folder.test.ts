import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findOnAbsolutePathAsync } from '../../../../../core/system-tools';
import { runProcess } from '../../../../../core/process-launcher';
import { buildPosixStage1 } from '../stage1';
import { powerShell, runPowerShell, runSh, scratchDir, shellPath, stageMessages, withPosixDefinitions, withWindowsDefinitions } from './shells';

// pinned as scripts/server-targets.mjs ALPINE_TARGET_IMAGE pins it
const ALPINE = 'alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a';

const ago = (file: string, minutes: number): void => {
  const at = new Date(Date.now() - minutes * 60_000);
  utimesSync(file, at, at);
};

function versionFolder(folder: string, name: string): void {
  mkdirSync(path.join(folder, name, 'bin'), { recursive: true });
  writeFileSync(path.join(folder, name, 'server-package.json'), '{}');
}

// Damocles' entries for target in a previous <install>, beside folders that only look like them: a Node or
// electron-packager download, a version-named folder without the package's manifest, and the user's own files.
function previousInstall(target: 'linux-x64' | 'win32-x64'): string {
  const folder = scratchDir('previous-');
  for (const name of [`3.6.0-${target}`, `3.5.0-${target}`]) versionFolder(folder, name);
  for (const dir of ['.staging-abc123', 'run-0123456789abcdef', 'shared-tool', '3.6.0-notes', `node-v20.11.0-${target}`, `MyApp-${target}`, `notes-${target}`, `3.4.0-${target}`]) mkdirSync(path.join(folder, dir));
  // a lock another host took 31 minutes ago and a takeover lock a stage died holding, both stale
  mkdirSync(path.join(folder, 'install.lock'));
  writeFileSync(path.join(folder, 'install.lock', 'owner'), 'other-machine 1\n');
  ago(path.join(folder, 'install.lock'), 31);
  mkdirSync(path.join(folder, 'install.lock.takeover'));
  ago(path.join(folder, 'install.lock.takeover'), 2);
  writeFileSync(path.join(folder, '.exec-test-zzz'), '');
  ago(path.join(folder, '.exec-test-zzz'), 2);
  writeFileSync(path.join(folder, 'README'), 'shared');
  return folder;
}
const leftAlone = (target: string): string[] => ['3.4.0', '3.6.0-notes', 'MyApp', 'README', 'node-v20.11.0', 'notes', 'run-0123456789abcdef', 'shared-tool']
  .map((name) => (/^(3\.4\.0|MyApp|node-v20\.11\.0|notes)$/.test(name) ? `${name}-${target}` : name)).sort();

describe('the install folder in a real sh', { timeout: 120_000 }, () => {
  // df as POSIX -P prints it, with this much free space: Git for Windows' df visits every drive, network ones included
  const df = (freeKb: number): string => `df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/sda1 100 50 ${freeKb} 50%% /\\n'; }`;
  const sh = async (body: string, home: string, freeKb = 10_000_000, input?: string) => runSh(withPosixDefinitions(`HOME='${shellPath(home)}'\n${df(freeKb)}\n${body}`), input);
  const posixOnly = process.platform === 'win32';

  it('is <folder>/<user> with ~ as the target home, and ~/.damocles/server without a setting', async () => {
    const home = scratchDir('home-');
    const { stdout } = await sh(`install_dir '~' dev; echo; install_dir '~/tools' dev; echo; install_dir "/opt/my 'x' \\$y" dev; echo; install_dir '' dev`, home);
    expect(stdout.toString('utf8').split('\n').slice(0, 4)).toEqual([`${shellPath(home)}/dev`, `${shellPath(home)}/tools/dev`, "/opt/my 'x' $y/dev", `${shellPath(home)}/.damocles/server`]);
  });

  it('creates a missing <install> and leaves no exec test behind', async () => {
    const home = scratchDir('home-');
    const install = path.join(home, 'a b', 'dev');
    expect(stageMessages(await sh(`prepare_install '${shellPath(install)}' '${shellPath(path.dirname(install))}'; say '{"kind":"settled"}'`, home))).toEqual([{ kind: 'settled' }]);
    expect(readdirSync(install)).toEqual([]);
  });

  it.skipIf(posixOnly)('creates a missing configured folder with the user\'s umask and only <install> private', async () => {
    const home = scratchDir('home-');
    const folder = path.join(home, 'shared', 'tools');
    await sh(`umask 022; prepare_install '${folder}/dev' '${folder}'`, home);
    expect(statSync(folder).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(home, 'shared')).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(folder, 'dev')).mode & 0o777).toBe(0o700);
  });

  it.skipIf(posixOnly)('refuses an existing <install> of a configured folder other users may write, and takes one only its owner may', async () => {
    const home = scratchDir('home-');
    const install = path.join(home, 'dev');
    mkdirSync(install, { mode: 0o700 });
    expect(stageMessages(await sh(`prepare_install '${install}' '${home}'; say '{"kind":"settled"}'`, home))).toEqual([{ kind: 'settled' }]);
    for (const mode of ['g+w', 'o+w']) {
      const output = await sh(`chmod 700 '${install}'; chmod ${mode} '${install}'; prepare_install '${install}' '${home}'; say '{"kind":"settled"}'`, home);
      expect(stageMessages(output)).toEqual([{ kind: 'fail', code: 'installFolderUnsafe', params: { folder: install } }]);
    }
  });

  it('stops with lowSpace naming the folder when it has less free space than needed', async () => {
    const home = scratchDir('home-');
    const messages = stageMessages(await sh(`prepare_install '${shellPath(home)}' ''`, home, 200 * 1024));
    expect(messages).toEqual([{ kind: 'fail', code: 'lowSpace', params: { folder: shellPath(home), freeMb: 200, neededMb: 300 } }]);
  });

  it('removes Damocles\' own entries from the previous <install> and never the folder itself or anything else in it', async () => {
    const home = scratchDir('home-');
    const previous = previousInstall('linux-x64');
    const current = path.join(home, 'current');
    mkdirSync(current);
    expect(stageMessages(await sh(`clean_previous '${shellPath(previous)}' '${shellPath(current)}'`, home))).toEqual([{ kind: 'settled' }]);
    expect(readdirSync(previous).sort()).toEqual(leftAlone('linux-x64'));
  });

  it('takes a previous folder spelled differently, with a trailing slash or a .. part, as the current one', async () => {
    const home = scratchDir('home-');
    const current = path.join(home, 'current');
    versionFolder(current, '3.7.0-linux-x64');
    for (const spelled of [`${shellPath(current)}/`, `${shellPath(home)}/./x/../current`]) {
      expect(stageMessages(await sh(`clean_previous '${spelled}' '${shellPath(current)}'`, home))).toEqual([{ kind: 'settled' }]);
      expect(readdirSync(current)).toEqual(['3.7.0-linux-x64']);
    }
  });

  it('keeps a version another machine\'s live pid file names and defers settled, but not one this machine\'s names', async () => {
    const home = scratchDir('home-');
    const previous = previousInstall('linux-x64');
    const runs = path.join(home, '.damocles', 'server');
    mkdirSync(path.join(runs, 'run-fedcba9876543210'), { recursive: true });
    writeFileSync(path.join(runs, 'run-fedcba9876543210', 'daemon.pid'), JSON.stringify({ version: '3.6.0', pid: 1, hostname: 'nfs-peer' }));
    mkdirSync(path.join(runs, 'run-0123456789abcdef'), { recursive: true });
    const own = shellPath(path.join(runs, 'run-0123456789abcdef', 'daemon.pid'));
    const output = await sh(`printf '{"version":"3.5.0","pid":1,"hostname":"%s"}' "$(uname -n)" > '${own}'\nclean_previous '${shellPath(previous)}' '${shellPath(path.join(home, 'current'))}'`, home);
    expect(stageMessages(output)).toEqual([]);
    expect(readdirSync(previous).sort()).toEqual([...leftAlone('linux-x64'), '3.6.0-linux-x64'].sort());
  });

  it('leaves the previous <install> alone and defers settled while a live stage holds its lock', async () => {
    const home = scratchDir('home-');
    const previous = previousInstall('linux-x64');
    const lock = shellPath(path.join(previous, 'install.lock'));
    const output = await sh(`sleep 30 & holder=$!; printf '%s %s\\n' "$(uname -n)" "$holder" > '${lock}/owner'
clean_previous '${shellPath(previous)}' '${shellPath(path.join(home, 'current'))}'; kill "$holder"`, home);
    expect(stageMessages(output)).toEqual([]);
    expect(readdirSync(previous)).toEqual(expect.arrayContaining(['3.5.0-linux-x64', '3.6.0-linux-x64', '.staging-abc123', 'install.lock']));
  });

  it.skipIf(posixOnly || !existsSync('/proc/self/exe'))('defers while this machine\'s daemon runs from the previous folder, however it is spelled', async () => {
    const home = scratchDir('home-');
    const previous = previousInstall('linux-x64');
    const bin = path.join(previous, '3.6.0-linux-x64', 'bin');
    const pidFile = path.join(home, '.damocles', 'server', 'run-0123456789abcdef', 'daemon.pid');
    mkdirSync(path.dirname(pidFile), { recursive: true });
    const output = await sh(`cp "$(command -v sleep)" '${bin}/damocles-sleep'; '${bin}/damocles-sleep' 30 & daemon=$!
printf '{"version":"3.6.0","pid":%s,"hostname":"%s"}' "$daemon" "$(uname -n)" > '${pidFile}'
clean_previous '${previous}/' '${home}/current'; kill "$daemon"`, home);
    expect(stageMessages(output)).toEqual([]);
    expect(existsSync(bin)).toBe(true);
  });

  it.skipIf(posixOnly || process.platform !== 'linux')('stops before choosing <install> when the user name is empty', async () => {
    const home = scratchDir('home-');
    const stage = buildPosixStage1({ manifest: { version: '3.7.0', protocolVersion: 1, packages: {} }, releasesUrl: 'https://example.invalid/releases', installFolder: shellPath(home) });
    const output = await runSh(`HOME='${shellPath(home)}'\nid() { :; }\n${stage}`);
    expect(stageMessages(output)).toEqual([{ kind: 'step', step: 'checking' }, { kind: 'fail', code: 'unknown', params: { reason: 'noUserName' } }]);
    expect(readdirSync(home)).toEqual([]);
  });

  describe('install_version', () => {
    // a package whose self-test copies its stdin to a file, so a test sees what the protocol channel lost to it
    async function packageFixture(home: string): Promise<{ archive: string; sha: string; size: number }> {
      const pkg = path.join(home, 'pkg');
      mkdirSync(path.join(pkg, 'bin'), { recursive: true });
      writeFileSync(path.join(pkg, 'bin', 'damocles-server'), `#!/bin/sh\ncat > '${shellPath(path.join(home, 'self-test-stdin'))}'\nexit 0\n`, { mode: 0o755 });
      writeFileSync(path.join(pkg, 'server-package.json'), '{}');
      const archive = path.join(home, 'package.tar.gz');
      await runSh(`${tarPrelude}\ncd '${shellPath(pkg)}' && tar -czf '${shellPath(archive)}' bin server-package.json`);
      const bytes = readFileSync(archive);
      return { archive, sha: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    }
    // Git for Windows' GNU tar reads C:/x as a remote host's file
    const tarPrelude = process.platform === 'win32' ? 'tar() { command tar --force-local "$@"; }' : '';
    const installBody = (home: string, fixture: { archive: string; sha: string; size: number }, extra = ''): string => [
      tarPrelude,
      `install='${shellPath(path.join(home, 'install'))}'; mkdir -p "$install"`,
      'version_dir="$install/3.7.0-linux-x64"; lock="$install/install.lock"; takeover="$install/install.lock.takeover"',
      `package_file=package.tar.gz; package_sha=${fixture.sha}; package_size=${fixture.size}; package_url=unused`,
      `download() { cp '${shellPath(fixture.archive)}' "$1"; }`,
      extra,
      'install_version; say \'{"kind":"settled"}\'; printf "rest=%s\\n" "$(cat)"',
    ].join('\n');

    it('replaces an incomplete folder of the version, gives the self-test no stdin and releases the lock', async () => {
      const home = scratchDir('home-');
      const fixture = await packageFixture(home);
      const versionDir = path.join(home, 'install', '3.7.0-linux-x64');
      mkdirSync(path.join(versionDir, 'node'), { recursive: true });
      writeFileSync(path.join(versionDir, 'stray'), 'left by a failed removal');
      const output = await sh(installBody(home, fixture), home, 10_000_000, 'PROTOCOL BYTES');
      expect(stageMessages(output)).toEqual([{ kind: 'step', step: 'installing' }, { kind: 'settled' }]);
      expect(readdirSync(versionDir).sort()).toEqual(['bin', 'server-package.json']);
      expect(readdirSync(path.join(home, 'install'))).toEqual(['3.7.0-linux-x64']);
      expect(readFileSync(path.join(home, 'self-test-stdin'), 'utf8')).toBe('');
      expect(output.stdout.toString('utf8')).toContain('rest=PROTOCOL BYTES');
    });

    it('fails with notWritable, releasing the lock, when the staging folder cannot be made', async () => {
      const home = scratchDir('home-');
      const fixture = await packageFixture(home);
      const output = await sh(installBody(home, fixture, 'mktemp() { return 1; }'), home);
      expect(stageMessages(output)).toEqual([{ kind: 'step', step: 'installing' }, { kind: 'fail', code: 'noexec', params: { folder: shellPath(path.join(home, 'install')), reason: 'notWritable' } }]);
      expect(readdirSync(path.join(home, 'install'))).toEqual([]);
    });
  });
});

describe('the noexec check in a Linux container', async () => {
  const docker = await findOnAbsolutePathAsync(process.platform === 'win32' ? 'docker.exe' : 'docker', process.platform, process.env);
  const linux = docker !== undefined && (await runProcess({ file: docker, args: ['info', '--format', '{{.OSType}}'], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: 30_000 })).stdout.toString('utf8').trim() === 'linux';

  it.skipIf(!linux)('stops with noexec on a folder mounted noexec (needs Docker with Linux containers)', async () => {
    const script = withPosixDefinitions("prepare_install /work/install ''; say '{\"kind\":\"settled\"}'");
    const output = await runProcess({ file: docker!, args: ['run', '--rm', '-i', '--tmpfs', '/work:rw,noexec,size=512m', ALPINE, 'sh', '-s'], windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, { input: script, timeoutMs: 180_000 });
    expect(stageMessages(output)).toEqual([{ kind: 'fail', code: 'noexec', params: { folder: '/work/install' } }]);
  }, 200_000);
});

describe('the install folder in a real PowerShell', { timeout: 120_000 }, async () => {
  const shell = await powerShell();
  const ps = async (body: string, home: string, input?: string) => runPowerShell(shell!, withWindowsDefinitions(`$env:USERPROFILE = '${home}'\n${body}`), input);
  const windowsOnly = shell === undefined || process.platform !== 'win32';

  it.skipIf(shell === undefined)('is <folder>\\<user> with ~ as the home, and ~\\.damocles\\server without a setting', async () => {
    const home = scratchDir('home-');
    const { stdout } = await ps("[Console]::Out.Write((@((Get-DamoclesInstallDir '~\\tools' 'dev'), (Get-DamoclesInstallDir 'D:\\it''s $x' 'dev'), (Get-DamoclesInstallDir '' 'dev')) -join '|'))", home);
    expect(stdout.toString('utf8').split('|')).toEqual([path.join(home, 'tools', 'dev'), "D:\\it's $x\\dev", path.join(home, '.damocles', 'server')]);
  });

  it.skipIf(shell === undefined)('stops with lowSpace naming the folder', async () => {
    const home = scratchDir('home-');
    const messages = stageMessages(await ps(`$NEEDED_MB = 999999999; Initialize-DamoclesInstall '${path.join(home, 'install')}' $true`, home));
    expect(messages[0]).toMatchObject({ kind: 'fail', code: 'lowSpace', params: { folder: path.join(home, 'install'), neededMb: 999999999 } });
  });

  it.skipIf(windowsOnly)('creates a missing <install> granting only the user and SYSTEM, inheriting nothing', async () => {
    const home = scratchDir('home-');
    const install = path.join(home, 'tools', 'dev');
    const script = [
      `Initialize-DamoclesInstall '${install}' $true`,
      `$acl = New-Object Security.AccessControl.DirectorySecurity('${install}', [Security.AccessControl.AccessControlSections]::Access)`,
      "$sids = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value + ':' + $_.IsInherited }) | Sort-Object -Unique",
      '[Console]::Out.Write("$($acl.AreAccessRulesProtected)|$($sids -join \',\')|$(Get-DamoclesUserSid)")',
    ].join('\n');
    const [isProtected, sids, user] = (await ps(script, home)).stdout.toString('utf8').split('|');
    expect(isProtected).toBe('True');
    expect(sids!.split(',').sort()).toEqual([`${user}:False`, 'S-1-5-18:False'].sort());
  });

  it.skipIf(windowsOnly)('refuses an existing <install> another user may change, and takes a private one', async () => {
    const home = scratchDir('home-');
    const install = path.join(home, 'dev');
    mkdirSync(install);
    const icacls = (args: string): string => `[void](Invoke-DamoclesTool (Join-Path $env:SystemRoot 'System32\\icacls.exe') @('${install}', ${args}))`;
    const privateOne = [
      icacls("'/inheritance:r', '/grant:r', \"*$(Get-DamoclesUserSid):(OI)(CI)F\", '*S-1-5-32-544:(OI)(CI)F'"),
      `Initialize-DamoclesInstall '${install}' $true; Send-DamoclesLine '{"kind":"settled"}'`,
    ].join('\n');
    expect(stageMessages(await ps(privateOne, home))).toEqual([{ kind: 'settled' }]);
    // Authenticated Users, as a drive root grants it to what is made inside
    const output = await ps([icacls("'/grant', '*S-1-5-11:(OI)(CI)(IO)M'"), `Initialize-DamoclesInstall '${install}' $true`].join('\n'), home);
    expect(stageMessages(output)).toEqual([{ kind: 'fail', code: 'installFolderUnsafe', params: { folder: install } }]);
    // the default folder lives in the user's profile, whose ACL is the user's
    expect(stageMessages(await ps(`Initialize-DamoclesInstall '${install}' $false; Send-DamoclesLine '{"kind":"settled"}'`, home))).toEqual([{ kind: 'settled' }]);
  });

  it.skipIf(shell === undefined)('removes Damocles\' own entries from the previous <install> and never the folder itself', async () => {
    const home = scratchDir('home-');
    const previous = previousInstall('win32-x64');
    expect(stageMessages(await ps(`Clear-DamoclesPrevious '${previous}' '${path.join(home, 'current')}'`, home))).toEqual([{ kind: 'settled' }]);
    expect(readdirSync(previous).sort()).toEqual([...leftAlone('win32-x64'), '.exec-test-zzz'].sort());
  });

  it.skipIf(shell === undefined)('takes a previous folder spelled with forward slashes or a trailing separator as the current one', async () => {
    const home = scratchDir('home-');
    const current = path.join(home, 'current');
    versionFolder(current, '3.7.0-win32-x64');
    for (const spelled of [`${shellPath(current)}`, `${current}\\`]) {
      expect(stageMessages(await ps(`Clear-DamoclesPrevious '${spelled}' '${current}'`, home))).toEqual([{ kind: 'settled' }]);
      expect(readdirSync(current)).toEqual(['3.7.0-win32-x64']);
    }
  });

  it.skipIf(shell === undefined)('keeps a version another machine\'s live pid file names and defers settled, but not one this machine\'s names', async () => {
    const home = scratchDir('home-');
    const previous = previousInstall('win32-x64');
    const other = path.join(home, '.damocles', 'server', 'run-fedcba9876543210');
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'daemon.pid'), JSON.stringify({ version: '3.6.0', pid: 1, hostname: 'nfs-peer' }));
    const output = await ps([
      '$own = Join-Path $env:USERPROFILE ".damocles\\server\\run-$(Get-DamoclesRunKey)"',
      '[void](New-Item -ItemType Directory -Path $own -Force)',
      "[IO.File]::WriteAllText((Join-Path $own 'daemon.pid'), '{\"version\":\"3.5.0\",\"pid\":1}')",
      `Clear-DamoclesPrevious '${previous}' '${path.join(home, 'current')}'`,
    ].join('\n'), home);
    expect(stageMessages(output)).toEqual([]);
    expect(readdirSync(previous).sort()).toEqual([...leftAlone('win32-x64'), '.exec-test-zzz', '3.6.0-win32-x64'].sort());
  });

  it.skipIf(shell === undefined)('leaves the previous <install> alone and defers settled while a live stage holds its lock', async () => {
    const home = scratchDir('home-');
    const previous = previousInstall('win32-x64');
    const output = await ps([
      `[IO.File]::WriteAllText('${path.join(previous, 'install.lock', 'owner')}', "$([Environment]::MachineName) $PID")`,
      `Clear-DamoclesPrevious '${previous}' '${path.join(home, 'current')}'`,
    ].join('\n'), home);
    expect(stageMessages(output)).toEqual([]);
    expect(readdirSync(previous)).toEqual(expect.arrayContaining(['3.5.0-win32-x64', '3.6.0-win32-x64', '.staging-abc123', 'install.lock']));
  });

  it.skipIf(windowsOnly)('replaces an incomplete folder of the version and gives tools no stdin', async () => {
    const home = scratchDir('home-');
    const pkg = path.join(home, 'pkg');
    mkdirSync(path.join(pkg, 'node'), { recursive: true });
    mkdirSync(path.join(pkg, 'dist'));
    writeFileSync(path.join(pkg, 'node', 'node.exe'), 'not run');
    writeFileSync(path.join(pkg, 'dist', 'daemon.js'), '');
    writeFileSync(path.join(pkg, 'server-package.json'), '{}');
    const install = path.join(home, 'install');
    const versionDir = path.join(install, '3.7.0-win32-x64');
    mkdirSync(path.join(versionDir, 'node'), { recursive: true });
    writeFileSync(path.join(versionDir, 'stray'), 'left by a failed removal');
    const archive = path.join(home, 'package.tar');
    const script = [
      `[void](Invoke-DamoclesTool (Join-Path $env:SystemRoot 'System32\\tar.exe') @('-cf', '${archive}', '-C', '${pkg}', 'node', 'dist', 'server-package.json'))`,
      // the self-test runs the package's node.exe, which this fixture only names
      '$realTool = ${function:Invoke-DamoclesTool}',
      "function Invoke-DamoclesTool([string]$file, [string[]]$arguments, [string]$cwd = '') { if ($file -like '*\\node\\node.exe') { return 0 }; return & $realTool $file $arguments $cwd }",
      `function Invoke-DamoclesDownload([string]$url, [string]$file, [int64]$size) { Copy-Item -LiteralPath '${archive}' -Destination $file; return $true }`,
      `$install = '${install}'; $versionDir = '${versionDir}'; $lock = Join-Path $install 'install.lock'`,
      `$packageFile = 'package.tar'; $packageSha = (Get-FileHash -LiteralPath '${archive}' -Algorithm SHA256).Hash.ToLowerInvariant(); $packageSize = (Get-Item -LiteralPath '${archive}').Length; $packageUrl = 'unused'`,
      'Install-DamoclesVersion',
      // sort reads its stdin to the end: given the protocol channel, it would take the bytes after the stage
      "[void](Invoke-DamoclesTool (Join-Path $env:SystemRoot 'System32\\sort.exe') @())",
      'Send-DamoclesLine \'{"kind":"settled"}\'',
      '$rest = (New-Object IO.StreamReader $DamoclesIn).ReadToEnd()',
      '[Console]::Out.Write("rest=$rest")',
    ].join('\n');
    const output = await ps(script, home, 'PROTOCOL BYTES');
    expect(stageMessages(output)).toEqual([{ kind: 'step', step: 'installing' }, { kind: 'settled' }]);
    expect(readdirSync(versionDir).sort()).toEqual(['dist', 'node', 'server-package.json']);
    expect(readdirSync(install)).toEqual(['3.7.0-win32-x64']);
    expect(output.stdout.toString('utf8')).toContain('rest=PROTOCOL BYTES');
  });

  it.skipIf(windowsOnly)('takes a previous folder reached through a junction as the current one, and leaves it alone', async () => {
    const home = scratchDir('home-');
    const current = path.join(home, 'current');
    versionFolder(current, '3.7.0-win32-x64');
    const junction = path.join(home, 'through-junction');
    symlinkSync(current, junction, 'junction');
    expect(stageMessages(await ps(`Clear-DamoclesPrevious '${junction}' '${current}'`, home))).toEqual([{ kind: 'settled' }]);
    expect(readdirSync(current)).toEqual(['3.7.0-win32-x64']);
  });

  it.skipIf(windowsOnly)('finds a daemon running from a folder named through a junction or an 8.3 name', async () => {
    const home = scratchDir('home-');
    // this PowerShell stands in for the daemon: its pid file names it, and it runs from the junction's target
    const junction = path.join(home, 'ps-home');
    symlinkSync(path.dirname(shell!), junction, 'junction');
    const script = [
      '$run = Join-Path $env:USERPROFILE ".damocles\\server\\run-0123456789abcdef"',
      '[void](New-Item -ItemType Directory -Path $run -Force)',
      "[IO.File]::WriteAllText((Join-Path $run 'daemon.pid'), \"{`\"pid`\":$PID}\")",
      `$short = (New-Object -ComObject Scripting.FileSystemObject).GetFolder('${home}').ShortPath`,
      `$same = (Get-DamoclesFinalPath $short) -eq (Get-DamoclesFinalPath '${home}')`,
      `[Console]::Out.Write("$(Test-DamoclesDaemonRunsFrom '${junction}')|$(Test-DamoclesDaemonRunsFrom '${home}')|$same")`,
    ].join('\n');
    expect((await ps(script, home)).stdout.toString('utf8')).toBe('True|False|True');
  });

  it.skipIf(windowsOnly)('loads its own modules under a PSModulePath from the other edition, and starts the daemon with the inherited one', async () => {
    const home = scratchDir('home-');
    // modules PowerShell 7 ships, marked Core-only, ahead of 5.1's own: 5.1 finds them first and cannot load them
    const foreign = scratchDir('ps7-modules-');
    for (const [name, exports] of [['Microsoft.PowerShell.Utility', "'Get-FileHash', 'ConvertTo-Json'"], ['CimCmdlets', "'New-CimInstance', 'Invoke-CimMethod'"]] as const) {
      mkdirSync(path.join(foreign, name));
      writeFileSync(path.join(foreign, name, `${name}.psd1`), `@{ GUID = '1da87e53-152b-403e-98dc-74d7b4d63d59'; ModuleVersion = '7.0.0.0'; CompatiblePSEditions = @('Core'); PowerShellVersion = '3.0'; CmdletsToExport = @(${exports}); NestedModules = @('Microsoft.PowerShell.Commands.Utility.dll') }`);
    }
    const inherited = `${foreign};${path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')}`;
    const file = path.join(home, 'package.tar');
    writeFileSync(file, 'package bytes');
    const script = [
      `$hash = (Get-FileHash -LiteralPath '${file}' -Algorithm SHA256).Hash.ToLowerInvariant()`,
      "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
      'Send-DamoclesLine (ConvertTo-Json -Compress -InputObject @{ kind = \'settled\' })',
      '[Console]::Out.Write("hash=$hash|$($startup.ShowWindow)|$(Get-DamoclesInheritedModulePathEntry)")',
    ].join('\n');
    const output = await runPowerShell(shell!, withWindowsDefinitions(`$env:USERPROFILE = '${home}'\n${script}`), undefined, { psModulePath: inherited });
    expect(output.stderr.toString('utf8')).toBe('');
    expect(stageMessages(output)).toEqual([{ kind: 'settled' }]);
    // 5.1 adds its Program Files folder to the value it inherited before the stage reads it
    expect(output.stdout.toString('utf8')).toContain(`hash=${createHash('sha256').update('package bytes').digest('hex')}|0|PSModulePath=${foreign};`);
  });
});
