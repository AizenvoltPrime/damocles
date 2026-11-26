import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOutput } from '../../../../../core/process-launcher';
import { psQuote } from '../quote';
import REMOVE_POSIX from '../remove-posix.sh';
import REMOVE_WINDOWS from '../remove-windows.ps1';
import { stageDefinitions } from '../stage1';
import { powerShell, runPowerShell, runSh, scratchDir, shellPath, stageMessages, withPosixDefinitions, withWindowsDefinitions } from './shells';

const VERSION = '3.7.0+0123456789ab';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\r?\n$/;

// An install folder holding Remove Damocles server's marker, and the version folder stage 1 needs when installed is set.
function installFolder(target: string, options: { readonly marked: boolean; readonly installed: boolean }): { readonly install: string; readonly versionDir: string } {
  const install = scratchDir('removed-install-');
  const versionDir = path.join(install, `${VERSION}-${target}`);
  if (options.marked) writeFileSync(path.join(install, 'removed'), '2026-01-02T03:04:05Z\n');
  if (options.installed) {
    mkdirSync(path.join(versionDir, 'bin'), { recursive: true });
    mkdirSync(path.join(versionDir, 'node'), { recursive: true });
    writeFileSync(path.join(versionDir, 'server-package.json'), '{}');
    writeFileSync(path.join(versionDir, 'bin', 'damocles-server'), '#!/bin/sh\n');
    chmodSync(path.join(versionDir, 'bin', 'damocles-server'), 0o755);
    writeFileSync(path.join(versionDir, 'node', 'node.exe'), '');
  }
  return { install, versionDir };
}

// The removal stage's status lines: its notices and its end, which the stage 1 parser does not know.
function removalLines(output: RunOutput): unknown[] {
  return output.stdout.toString('utf8').split(/\r?\n/).flatMap((line) => (line.startsWith('@@DAMOCLES ') ? [JSON.parse(line.slice('@@DAMOCLES '.length)) as unknown] : []));
}

describe('stage 1 after Remove Damocles server, in a real sh', { timeout: 120_000 }, () => {
  // install_version with a fetch that records it ran and fails, and an upload that fails
  const install = (folder: string, versionDir: string, automatic: '0' | '1'): Promise<RunOutput> => runSh(withPosixDefinitions(`D_AUTOMATIC='${automatic}'
install='${shellPath(folder)}'; version_dir='${shellPath(versionDir)}'; lock="$install/install.lock"; takeover="$install/install.lock.takeover"
package_file=pkg.tar.gz; package_sha=0; package_size=1; package_url=-
fetch_package() { : > "$install/fetched"; return 1; }
upload() { return 1; }
forget_removal
install_version
echo proceeded`));

  it('fails an automatic connect with serverRemoved under the install lock, before anything is fetched, when the version is not installed', async () => {
    const { install: folder, versionDir } = installFolder('linux-x64', { marked: true, installed: false });
    const output = await install(folder, versionDir, '1');
    expect(stageMessages(output)).toEqual([{ kind: 'fail', code: 'serverRemoved', params: {} }]);
    expect(existsSync(path.join(folder, 'fetched'))).toBe(false);
    expect(existsSync(path.join(folder, 'install.lock'))).toBe(false);
    expect(readFileSync(path.join(folder, 'removed'), 'utf8')).toBe('2026-01-02T03:04:05Z\n');
  });

  it('lets an automatic connect proceed, the marker kept, when a removal left the version installed for another computer', async () => {
    const { install: folder, versionDir } = installFolder('linux-x64', { marked: true, installed: true });
    const output = await install(folder, versionDir, '1');
    expect(stageMessages(output)).toEqual([]);
    expect(output.stdout.toString('utf8')).toContain('proceeded');
    expect(existsSync(path.join(folder, 'removed'))).toBe(true);
  });

  it('deletes the marker for a connect the user started, and installs as without it', async () => {
    const { install: folder, versionDir } = installFolder('linux-x64', { marked: true, installed: false });
    const output = await install(folder, versionDir, '0');
    expect(stageMessages(output)).toEqual([{ kind: 'step', step: 'installing' }, { kind: 'fail', code: 'downloadAndUploadFailed', params: {} }]);
    expect(existsSync(path.join(folder, 'fetched'))).toBe(true);
    expect(existsSync(path.join(folder, 'removed'))).toBe(false);
  });

  it('deletes again under the install lock a marker a removal wrote after the user\'s connect first deleted it', async () => {
    const { install: folder, versionDir } = installFolder('linux-x64', { marked: true, installed: false });
    const output = await runSh(withPosixDefinitions(`D_AUTOMATIC='0'
install='${shellPath(folder)}'; version_dir='${shellPath(versionDir)}'; lock="$install/install.lock"; takeover="$install/install.lock.takeover"
package_file=pkg.tar.gz; package_sha=0; package_size=1; package_url=-
fetch_package() { return 1; }
upload() { return 1; }
install_version`));
    expect(stageMessages(output)).toEqual([{ kind: 'step', step: 'installing' }, { kind: 'fail', code: 'downloadAndUploadFailed', params: {} }]);
    expect(existsSync(path.join(folder, 'removed'))).toBe(false);
  });

  it('deletes the marker for a connect the user started even when the version is installed', async () => {
    const { install: folder, versionDir } = installFolder('linux-x64', { marked: true, installed: true });
    await install(folder, versionDir, '0');
    expect(existsSync(path.join(folder, 'removed'))).toBe(false);
  });
});

describe.skipIf(process.platform !== 'win32')('Windows stage 1 after Remove Damocles server, under a real PowerShell', { timeout: 120_000 }, async () => {
  const shell = (await powerShell())!;
  const install = (folder: string, versionDir: string, automatic: '0' | '1'): Promise<RunOutput> => runPowerShell(shell, withWindowsDefinitions([
    `$D_AUTOMATIC = '${automatic}'`,
    `$install = ${psQuote(folder)}`,
    `$versionDir = ${psQuote(versionDir)}`,
    "$lock = Join-Path $install 'install.lock'",
    "$packageFile = 'pkg.zip'; $packageSha = '0'; $packageSize = 1; $packageUrl = '-'",
    "function Invoke-DamoclesDownload([string]$url, [string]$file, [int64]$size) { [IO.File]::WriteAllText((Join-Path $install 'fetched'), ''); return $false }",
    'function Receive-DamoclesUpload([string]$file, [int64]$size) { return $false }',
    'Clear-DamoclesRemoval',
    'Install-DamoclesVersion',
    "[Console]::Out.WriteLine('proceeded')",
  ].join('\n')));

  it('fails an automatic connect with serverRemoved before anything is fetched, when the version is not installed', async () => {
    const { install: folder, versionDir } = installFolder('win32-x64', { marked: true, installed: false });
    const output = await install(folder, versionDir, '1');
    expect(stageMessages(output)).toEqual([{ kind: 'fail', code: 'serverRemoved', params: {} }]);
    expect(existsSync(path.join(folder, 'fetched'))).toBe(false);
    expect(existsSync(path.join(folder, 'install.lock'))).toBe(false);
    expect(existsSync(path.join(folder, 'removed'))).toBe(true);
  });

  it('lets an automatic connect proceed, the marker kept, when the version is installed', async () => {
    const { install: folder, versionDir } = installFolder('win32-x64', { marked: true, installed: true });
    const output = await install(folder, versionDir, '1');
    expect(stageMessages(output)).toEqual([]);
    expect(output.stdout.toString('utf8')).toContain('proceeded');
    expect(existsSync(path.join(folder, 'removed'))).toBe(true);
  });

  it('deletes the marker for a connect the user started, and installs as without it', async () => {
    const { install: folder, versionDir } = installFolder('win32-x64', { marked: true, installed: false });
    const output = await install(folder, versionDir, '0');
    expect(stageMessages(output)).toEqual([{ kind: 'step', step: 'installing' }, { kind: 'fail', code: 'downloadAndUploadFailed', params: {} }]);
    expect(existsSync(path.join(folder, 'fetched'))).toBe(true);
    expect(existsSync(path.join(folder, 'removed'))).toBe(false);
  });
});

describe('the POSIX removal stage\'s marker, in a real sh', { timeout: 120_000 }, () => {
  const remove = (folder: string, mark: string): Promise<RunOutput> => runSh(`${stageDefinitions(REMOVE_POSIX)}\nremove_entries '${shellPath(folder)}' '' '${mark}'\n`);

  it('writes removed beside the security floor in the install folder it marks, owner-only, holding the UTC time, and names both as kept', async () => {
    const folder = scratchDir('removal-');
    mkdirSync(path.join(folder, `${VERSION}-linux-x64`));
    writeFileSync(path.join(folder, `${VERSION}-linux-x64`, 'server-package.json'), '{}');
    writeFileSync(path.join(folder, 'security-floor'), '3.6.0\n');
    const output = await remove(folder, 'mark');
    expect(readFileSync(path.join(folder, 'removed'), 'utf8')).toMatch(ISO_UTC);
    if (process.platform !== 'win32') expect(statSync(path.join(folder, 'removed')).mode & 0o777).toBe(0o600);
    expect(readdirSync(folder).sort()).toEqual(['removed', 'security-floor']);
    expect(removalLines(output)).toEqual([{ kind: 'notice', code: 'floorKept', params: { folder: shellPath(folder), files: 'both' } }]);
  });

  it('writes no marker in a folder it does not mark that held no server, and names the floor alone as kept', async () => {
    const folder = scratchDir('removal-');
    writeFileSync(path.join(folder, 'security-floor'), '3.6.0\n');
    const output = await remove(folder, '');
    expect(readdirSync(folder)).toEqual(['security-floor']);
    expect(removalLines(output)).toEqual([{ kind: 'notice', code: 'floorKept', params: { folder: shellPath(folder), files: 'floor' } }]);
  });

  it('marks every folder that held a server, the one stage 1 uses or not, and sweeps a dead marker write\'s leftover', async () => {
    const folder = scratchDir('removal-');
    mkdirSync(path.join(folder, `${VERSION}-linux-x64`));
    writeFileSync(path.join(folder, `${VERSION}-linux-x64`, 'server-package.json'), '{}');
    writeFileSync(path.join(folder, '.removed-deadbeef'), '');
    utimesSync(path.join(folder, '.removed-deadbeef'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    const output = await remove(folder, '');
    expect(readdirSync(folder)).toEqual(['removed']);
    expect(removalLines(output)).toEqual([{ kind: 'notice', code: 'floorKept', params: { folder: shellPath(folder), files: 'marker' } }]);
  });

  it('marks a folder whose install lock a live stage holds, so that stage\'s successors find the marker', async () => {
    const folder = scratchDir('removal-');
    mkdirSync(path.join(folder, `${VERSION}-linux-x64`));
    writeFileSync(path.join(folder, `${VERSION}-linux-x64`, 'server-package.json'), '{}');
    const output = await runSh(`${stageDefinitions(REMOVE_POSIX)}\nmkdir '${shellPath(path.join(folder, 'install.lock'))}'; printf '%s %s\\n' "$(uname -n)" "$$" > '${shellPath(path.join(folder, 'install.lock', 'owner'))}'\nremove_entries '${shellPath(folder)}' '' ''\n`);
    expect(readFileSync(path.join(folder, 'removed'), 'utf8')).toMatch(ISO_UTC);
    expect(readdirSync(folder).sort()).toEqual([`${VERSION}-linux-x64`, 'install.lock', 'removed']);
    expect(removalLines(output)).toEqual([{ kind: 'notice', code: 'installInProgress', params: { folder: shellPath(folder) } }]);
  });

  it('counts the marker with the floor, not as an entry the server folder keeps besides them', async () => {
    const folder = scratchDir('removal-');
    writeFileSync(path.join(folder, 'security-floor'), '3.6.0\n');
    writeFileSync(path.join(folder, 'removed'), '2026-01-02T03:04:05Z\n');
    const output = await runSh(`${stageDefinitions(REMOVE_POSIX)}\nif holds_besides_markers '${shellPath(folder)}'; then echo holds; else echo empty; fi\n`);
    expect(output.stdout.toString('utf8').trim()).toBe('empty');
  });
});

describe.skipIf(process.platform !== 'win32')('the Windows removal stage\'s marker, under a real PowerShell', { timeout: 120_000 }, async () => {
  const shell = (await powerShell())!;

  it('writes removed beside the security floor in the install folder it marks, holding the UTC time, and names both as kept', async () => {
    const folder = scratchDir('removal-');
    mkdirSync(path.join(folder, `${VERSION}-win32-x64`));
    writeFileSync(path.join(folder, `${VERSION}-win32-x64`, 'server-package.json'), '{}');
    writeFileSync(path.join(folder, 'security-floor'), '3.6.0\n');
    const script = ["$ErrorActionPreference = 'Stop'", '$DamoclesOut = [Console]::OpenStandardOutput()', stageDefinitions(REMOVE_WINDOWS), `Remove-DamoclesEntries ${psQuote(folder)} @() $true`, ''].join('\n');
    const output = await runPowerShell(shell, script);
    expect(output.exit?.code, output.stderr.toString('utf8')).toBe(0);
    expect(readFileSync(path.join(folder, 'removed'), 'utf8')).toMatch(ISO_UTC);
    expect(readdirSync(folder).sort()).toEqual(['removed', 'security-floor']);
    expect(removalLines(output)).toEqual([{ kind: 'notice', code: 'floorKept', params: { folder, files: 'both' } }]);
  });
});
