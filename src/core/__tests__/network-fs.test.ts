import { describe, expect, it } from 'vitest';
import { leavesLocalDrives, networkPathHost } from '../network-fs';

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
});
