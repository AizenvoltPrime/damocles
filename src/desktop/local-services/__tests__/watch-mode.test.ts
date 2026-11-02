import { describe, expect, it } from 'vitest';
import { fileSystemOf, isWsl, isWsl1, watchModeOf, type WatchModeSources } from '../watch-mode';

// /proc/sys/kernel/osrelease samples
const WSL1 = '4.4.0-26100-Microsoft\n';
const WSL2 = '6.18.54.1-microsoft-standard-WSL2\n';
const LINUX = '6.8.0-45-generic\n';

// /proc/self/mountinfo rows as WSL 2, WSL 1 and a plain host write them
const WSL2_MOUNTINFO = [
  '67 59 8:48 / / rw,relatime - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered',
  '72 67 0:56 / /mnt/wsl rw,relatime shared:1 - tmpfs none rw',
  '78 67 0:62 / /mnt/c rw,noatime - 9p C:\\134 rw,dirsync,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=5,wfd=5',
  '80 67 0:64 / /home/me/Windows\\040Docs rw,noatime - 9p C:\\134Users rw,dirsync,aname=drvfs',
].join('\n');
const WSL1_MOUNTINFO = [
  '2 2 0:2 / / rw,noatime - lxfs rootfs rw',
  '7 2 0:5 / /mnt/c rw,noatime - drvfs C:\\ rw,uid=1000,gid=1000',
].join('\n');
const LINUX_MOUNTINFO = [
  '22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw',
  '30 22 8:3 / /home rw,relatime shared:2 - ext4 /dev/sda3 rw',
  '31 30 0:40 / /home/me/nfs rw,relatime - nfs4 server:/export rw',
  '32 30 0:41 / /home/me/nfs rw,relatime - 9p shadow rw',
].join('\n');

const sources = (osrelease: string | undefined, mountinfo: string | undefined): WatchModeSources => ({
  osrelease: () => osrelease,
  mountinfo: () => mountinfo,
  realpath: (root) => root,
  log: () => undefined,
});

describe('watch modes', () => {
  it('tells WSL 1 from WSL 2 and plain Linux by the kernel release', () => {
    expect(isWsl1(WSL1)).toBe(true);
    expect(isWsl1(WSL2)).toBe(false);
    expect(isWsl1(LINUX)).toBe(false);
    expect([isWsl(WSL1), isWsl(WSL2), isWsl(LINUX)]).toEqual([true, true, false]);
  });

  it('finds the file system of the mount holding a path: the longest mount point, the later of two equal ones', () => {
    expect(fileSystemOf(WSL2_MOUNTINFO, '/mnt/c/work/app')).toBe('9p');
    expect(fileSystemOf(WSL2_MOUNTINFO, '/mnt/c')).toBe('9p');
    expect(fileSystemOf(WSL2_MOUNTINFO, '/mnt/cc/app')).toBe('ext4');
    expect(fileSystemOf(WSL2_MOUNTINFO, '/home/me/proj')).toBe('ext4');
    expect(fileSystemOf(WSL2_MOUNTINFO, '/home/me/Windows Docs/a')).toBe('9p');
    expect(fileSystemOf(WSL1_MOUNTINFO, '/mnt/c/work')).toBe('drvfs');
    expect(fileSystemOf(LINUX_MOUNTINFO, '/home/me/nfs/x')).toBe('9p');
    expect(fileSystemOf(LINUX_MOUNTINFO, '/home/me/src')).toBe('ext4');
  });

  it('polls every root on WSL 1, and on WSL 2 or Linux only roots on 9p or drvfs', () => {
    expect(watchModeOf('/home/me/proj', sources(WSL1, WSL1_MOUNTINFO))).toBe('poll');
    expect(watchModeOf('/mnt/c/work', sources(WSL1, WSL1_MOUNTINFO))).toBe('poll');
    expect(watchModeOf('/home/me/proj', sources(WSL2, WSL2_MOUNTINFO))).toBe('inotifyTree');
    expect(watchModeOf('/mnt/c/work/app', sources(WSL2, WSL2_MOUNTINFO))).toBe('poll');
    expect(watchModeOf('/srv/app', sources(LINUX, WSL1_MOUNTINFO.replace('lxfs', 'ext4')))).toBe('inotifyTree');
    expect(watchModeOf('/mnt/c/app', sources(LINUX, WSL1_MOUNTINFO))).toBe('poll');
  });

  it('judges a root by its real path, and keeps the inotify tree when mountinfo cannot be read', () => {
    const logs: string[] = [];
    const linked: WatchModeSources = { ...sources(WSL2, WSL2_MOUNTINFO), realpath: (root) => root.replace('/home/me/link', '/mnt/c/work') };
    expect(watchModeOf('/home/me/link/app', linked)).toBe('poll');
    expect(watchModeOf('/mnt/c/work', { ...sources(WSL2, undefined), log: (line) => logs.push(line) })).toBe('inotifyTree');
    expect(logs).toEqual(['[watcher] /proc/self/mountinfo could not be read; /mnt/c/work uses the inotify tree']);
  });
});
