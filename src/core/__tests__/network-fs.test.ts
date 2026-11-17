import { describe, expect, it } from 'vitest';
import { dosDeviceTargetPath, leavesLocalDrives, networkPathHost } from '../network-fs';
import { mappedDrivePath } from '../mapped-drives';

describe('networkPathHost', () => {
  it.each([
    [String.raw`\\Server\share\f`, 'server'],
    ['//server/share/f', 'server'],
    [String.raw`\/server\share`, 'server'],
    [String.raw`/\server/share`, 'server'],
    [String.raw`\\?\UNC\server\share\f`, 'server'],
    [String.raw`\\.\unc\server\share`, 'server'],
    [String.raw`\??\UNC\server\share`, 'server'],
    ['//?/UNC/server/share', 'server'],
    [String.raw`\\server@SSL\DavWWWRoot\f`, 'server'],
    [String.raw`\\server@SSL@8443\DavWWWRoot`, 'server'],
    [String.raw`\\wsl$\Ubuntu\home`, 'wsl$'],
    [String.raw`\\wsl$@80\Ubuntu`, 'wsl$'],
    ['//', ''],
    [String.raw`\\\server\share`, ''],
  ])('reads the host of %s', (target, host) => {
    expect(networkPathHost(target)).toBe(host);
  });

  it.each([[String.raw`\\?\C:\x`], [String.raw`\\.\pipe\x`], [String.raw`\??\C:\x`], ['C:\\x'], ['/home/u'], ['src/a.ts'], ['\\x']])('names no host in %s', (target) => {
    expect(networkPathHost(target)).toBeUndefined();
  });

  // Windows' WebDAV redirector reads only `@SSL`, `@<port>` and `@SSL@<port>` after the server; any other `@` names no known host.
  it.each([
    [String.raw`\\server@ssl\DavWWWRoot`, 'server'],
    [String.raw`\\server@8080\DavWWWRoot`, 'server'],
    [String.raw`\\Server@Ssl@443\DavWWWRoot`, 'server'],
    [String.raw`\\?\UNC\server@SSL\DavWWWRoot`, 'server'],
    [String.raw`\\nas@evil\s`, ''],
    [String.raw`\\nas@evil.com\s`, ''],
    [String.raw`\\nas@SSL@evil\s`, ''],
    [String.raw`\\nas@8080@SSL\s`, ''],
    [String.raw`\\nas@\s`, ''],
    [String.raw`\\@SSL\s`, ''],
    [String.raw`\\?\UNC\nas@evil\s`, ''],
  ])('reads only the WebDAV suffixes after an `@` in %s', (target, host) => {
    expect(networkPathHost(target)).toBe(host);
  });
});

describe('leavesLocalDrives', () => {
  const allowed = new Set(['files']);

  it.each([
    [String.raw`\\evil\s\f`],
    ['//evil/s/f'],
    [String.raw`\\?\UNC\evil\s`],
    [String.raw`\\.\UNC\evil\s`],
    [String.raw`\??\UNC\evil\s`],
    [String.raw`\\evil@SSL\DavWWWRoot`],
    [String.raw`\\evil\pipe\name`],
    [String.raw`\\?\C:\Windows`],
    [String.raw`\\.\C:\Windows`],
    [String.raw`\\.\pipe\name`],
    [String.raw`\\?\GLOBALROOT\Device\Mup\evil\s`],
    [String.raw`\??\C:\x`],
    ['//'],
    [String.raw`\\localhost\C$\x`],
    [String.raw`\\wsl.localhost@SSL\Ubuntu\x`],
    [String.raw`\\wsl$@80\Ubuntu\x`],
  ])('leaves for %s', (target) => {
    expect(leavesLocalDrives(target, allowed)).toBe(true);
  });

  it.each([
    [String.raw`\\files\proj\a.ts`],
    [String.raw`\\FILES\proj\a.ts`],
    [String.raw`\\?\UNC\files\proj`],
    ['//files/proj'],
    [String.raw`\\wsl$\Ubuntu\home`],
    [String.raw`\\wsl.localhost\Ubuntu\home`],
    ['C:\\Users\\u\\a.ts'],
    ['/home/u/a.ts'],
    ['src/a.ts'],
    ['\\Windows'],
  ])('stays local for %s', (target) => {
    expect(leavesLocalDrives(target, allowed)).toBe(false);
  });

  it.each([
    [String.raw`\\files@evil\proj`],
    [String.raw`\\files@SSL@evil\proj`],
    [String.raw`\\?\UNC\files@evil\proj`],
    [String.raw`\\wsl$@evil\Ubuntu`],
  ])('leaves for %s, whose server has an `@` the WebDAV redirector does not read, though its text before the `@` is allowed', (target) => {
    expect(leavesLocalDrives(target, allowed)).toBe(true);
  });

  it.each([[String.raw`\\files@SSL\DavWWWRoot`], [String.raw`\\FILES@443\DavWWWRoot`], [String.raw`\\files@ssl@8443\DavWWWRoot`]])('stays on an allowed host reached over WebDAV in %s', (target) => {
    expect(leavesLocalDrives(target, allowed)).toBe(false);
  });
});

describe('dosDeviceTargetPath', () => {
  it.each([
    // the form QueryDosDeviceW gives for a share's sub-folder mapped with net use
    [String.raw`\Device\LanmanRedirector\;Z:000000000004111a\192.0.2.10\data\team\sub`, String.raw`\\192.0.2.10\data\team\sub`],
    [String.raw`\Device\Mup\;LanmanRedirector\;Z:000000000004111a\nas\data`, String.raw`\\nas\data`],
    [String.raw`\Device\WebDavRedirector\;Y:0000000000012345\live.example.com@SSL\DavWWWRoot\tools`, String.raw`\\live.example.com@SSL\DavWWWRoot\tools`],
    [String.raw`\Device\RdpDr\;X:1\tsclient\C`, String.raw`\\tsclient\C`],
    [String.raw`\Device\P9Rdr\;W:00000000000a1b2c\wsl.localhost\Ubuntu`, String.raw`\\wsl.localhost\Ubuntu`],
    [String.raw`\Device\VBoxMiniRdr\;E:\vboxsvr\share`, String.raw`\\vboxsvr\share`],
    [String.raw`\Device\Mup\evil\s`, String.raw`\\evil\s`],
    [String.raw`\Device\LanmanRedirector\evil\s`, String.raw`\\evil\s`],
    [String.raw`\Device\LanmanRedirector\;Z:0\nas\data\;x`, String.raw`\\nas\data\;x`],
    [String.raw`\??\C:\work\dir`, String.raw`C:\work\dir`],
    [String.raw`\??\d:`, 'd:\\'],
    [String.raw`\??\UNC\nas\data\dir`, String.raw`\\nas\data\dir`],
    [String.raw`\??\Volume{0b1c}\dir`, String.raw`\\?\Volume{0b1c}\dir`],
    [String.raw`\GLOBAL??\UNC\evil\s`, String.raw`\\evil\s`],
    [String.raw`\DosDevices\C:\work`, String.raw`C:\work`],
  ])('reads %s as %s', (target, mapped) => {
    expect(dosDeviceTargetPath(target)).toBe(mapped);
  });

  it.each([
    [String.raw`\Device\LanmanRedirector\;Z:000000000004111a`],
    ['\\Device\\LanmanRedirector\\;Z:000000000004111a\\'],
    [String.raw`\Device\Mup`],
    [String.raw`\Device\Mup\;Z:0`],
    [String.raw`\BaseNamedObjects\x`],
    [String.raw`\GLOBALROOT\Device\Mup\evil\s`],
  ])('reads a network drive whose server it cannot read, or a target outside \\Device\\ and the DOS devices folder, %s, as a device path naming no host', (target) => {
    const mapped = dosDeviceTargetPath(target)!;
    expect(mapped).toBe(`\\\\?\\GLOBALROOT${target}`);
    expect(networkPathHost(mapped)).toBeUndefined();
    expect(leavesLocalDrives(mapped, new Set())).toBe(true);
  });

  it.each([
    [String.raw`\Device\HarddiskVolume2`],
    [String.raw`\Device\CdRom0`],
    [String.raw`\Device\Floppy0`],
    [String.raw`\Device\ImDisk0`],
    [String.raw`\Device\VeraCryptVolumeV`],
    [String.raw`\Device\Harddisk1\Partition1`],
  ])('reads %s as a local volume', (target) => {
    expect(dosDeviceTargetPath(target)).toBeNull();
  });
});

describe.runIf(process.platform === 'win32')('mappedDrivePath (win32)', () => {
  it('asks Windows, which maps the system drive to a local volume', () => {
    expect(mappedDrivePath(`${process.env['SystemDrive'] ?? 'C:'}\\`)).toBeNull();
  });
});
