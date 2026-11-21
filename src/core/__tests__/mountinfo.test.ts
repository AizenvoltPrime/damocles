import { describe, expect, it } from 'vitest';
import { mountRows, windowsDriveMounts } from '../mountinfo';

// /proc/self/mountinfo rows as WSL 2 (9p), WSL 1 (drvfs) and WSL's virtiofs mode write them
const WSL2_DRIVE = '135 85 0:70 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,cache=0x5,access=client,msize=65536,trans=fd,rfd=6,wfd=6';
const WSL2_DRIVERS = '120 85 0:60 / /usr/lib/wsl/drivers ro,nosuid,nodev,noatime - 9p drivers ro,dirsync,aname=drivers;fmask=222;dmask=222,mmap,access=client,msize=65536,trans=fd,rfd=7,wfd=7';
const MOUNTINFO = [
  '67 59 8:48 / / rw,relatime - ext4 /dev/sdd rw,discard,errors=remount-ro,data=ordered',
  WSL2_DRIVERS,
  WSL2_DRIVE,
  '136 85 0:71 / /mnt/my\\040drive rw,noatime - 9p D:\\134 rw,aname=drvfs;path=D:\\;uid=1000',
  '7 2 0:5 / /mnt/e rw,noatime - drvfs E:\\ rw,uid=1000,gid=1000',
  '140 85 0:80 / /mnt/f rw,relatime - virtiofs drvfs rw',
  '141 85 0:81 / /mnt/g rw,relatime - virtiofs drvfsa rw',
  '142 85 0:82 / /mnt/share rw,relatime - virtiofs other rw',
  '143 85 0:83 / /home/me/nfs rw,relatime - 9p shadow rw,aname=drvfsx',
].join('\n');

describe('mountinfo', () => {
  it('reads each row\'s mount point, root, type, source and super options, unescaping octal escapes', () => {
    expect(mountRows(WSL2_DRIVE)).toEqual([{ root: '/', mountPoint: '/mnt/c', type: '9p', source: 'C:\\', superOptions: 'rw,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,cache=0x5,access=client,msize=65536,trans=fd,rfd=6,wfd=6' }]);
    expect(mountRows('no separator here\n\n').length).toBe(0);
  });

  it('names the mount points of Windows drives: drvfs, 9p from drvfs and virtiofs tagged drvfs or drvfsa', () => {
    expect(windowsDriveMounts(MOUNTINFO).map((drive) => drive.mountPoint)).toEqual(['/mnt/c', '/mnt/my drive', '/mnt/e', '/mnt/f', '/mnt/g']);
  });

  it('names the drive folder each mount shows: 9p\'s path=, drvfs\'s source, then the mount\'s root, and a drive root otherwise', () => {
    expect(windowsDriveMounts([
      WSL2_DRIVE,
      // Docker Desktop's mount of a drive's subfolder, with optional fields before the separator
      '150 85 0:90 / /Docker/host rw,noatime shared:1 master:2 - 9p C:\\134Program\\040Files\\134Docker\\134Docker\\134resources rw,dirsync,aname=drvfs;path=C:\\Program Files\\Docker\\Docker\\resources;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=3,wfd=3',
      // a bind of /mnt/c/Users/me/AppData elsewhere
      '151 85 0:70 /Users/me/AppData /home/me/ad rw,noatime shared:1 - 9p C:\\134 rw,aname=drvfs;path=C:\\;uid=1000',
      '152 85 0:5 / /mnt/w rw,noatime - drvfs C:\\134Program\\040Files rw,uid=1000',
      '153 85 0:5 / /mnt/x rw,noatime - drvfs C: rw,uid=1000',
      '154 85 0:91 / /mnt/y rw,noatime - 9p Y:\\134 rw,aname=drvfs;uid=1000',
      '155 85 0:92 / /mnt/share rw,noatime - drvfs \\134\\134srv\\134share rw,uid=1000',
      '156 85 0:80 /data /mnt/v rw,relatime - virtiofs drvfs rw',
    ].join('\n'))).toEqual([
      { mountPoint: '/mnt/c', prefix: [] },
      { mountPoint: '/Docker/host', prefix: ['Program Files', 'Docker', 'Docker', 'resources'] },
      { mountPoint: '/home/me/ad', prefix: ['Users', 'me', 'AppData'] },
      { mountPoint: '/mnt/w', prefix: ['Program Files'] },
      { mountPoint: '/mnt/x', prefix: [] },
      { mountPoint: '/mnt/y', prefix: [] },
      { mountPoint: '/mnt/share', prefix: [] },
      { mountPoint: '/mnt/v', prefix: ['data'] },
    ]);
  });

  it('leaves WSL\'s drivers share, another 9p server and a virtiofs share of another tag', () => {
    expect(windowsDriveMounts([WSL2_DRIVERS, '142 85 0:82 / /mnt/share rw - virtiofs other rw', '143 85 0:83 / /x rw - 9p shadow rw,aname=drvfsx'].join('\n'))).toEqual([]);
  });
});
