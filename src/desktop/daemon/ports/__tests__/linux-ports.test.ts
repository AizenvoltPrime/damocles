import { describe, expect, it } from 'vitest';
import { decodeAddress, loopbackOf, parseProcNetTcp, parseStat, scanLinuxListeners, type ProcFs } from '../linux-ports';

// /proc/net/tcp as a little-endian kernel writes it: 0.0.0.0:8000 and 127.0.0.1:5173 listening as uid 1000, a listener of
// uid 0 (sshd) and an established connection of uid 1000
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41001 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41002 1 0000000000000000 100 0 0 10 0
   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 900 1 0000000000000000 100 0 0 10 0
   3: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 41003 1 0000000000000000 20 4 30 10 -1
`;
// /proc/net/tcp6: [::]:3000 and [::1]:9229 of uid 1000
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41004 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:240D 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41005 1 0000000000000000 100 0 0 10 0
`;

function procFs(files: Record<string, string>, dirs: Record<string, readonly string[]>, links: Record<string, string>): ProcFs {
  const missing = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    readFile: async (path) => {
      if (files[path] === undefined) throw missing(path);
      return files[path]!;
    },
    readdir: async (path) => {
      if (dirs[path] === undefined) throw missing(path);
      return dirs[path]!;
    },
    readlink: async (path) => {
      if (links[path] === undefined) throw missing(path);
      return links[path]!;
    },
  };
}

describe('Linux listening sockets from /proc', () => {
  it('decodes the kernel\'s host-order address words and the port', () => {
    expect(decodeAddress('0100007F', true)).toBe('127.0.0.1');
    expect(decodeAddress('7F000001', false)).toBe('127.0.0.1');
    expect(decodeAddress('00000000000000000000000001000000', true)).toBe('::1');
    expect(decodeAddress('0000000000000000FFFF00000100007F', true)).toBe('::ffff:127.0.0.1');
    expect(decodeAddress('B80D0120000000000000000001000000', true)).toBe('2001:db8::1');
    expect(decodeAddress('not hex!', true)).toBeUndefined();
  });

  it('keeps LISTEN rows the user owns', () => {
    expect(parseProcNetTcp(TCP, 4, 1000, true)).toEqual([
      { port: 8000, bindAddress: '0.0.0.0', family: 4, inode: '41001' },
      { port: 5173, bindAddress: '127.0.0.1', family: 4, inode: '41002' },
    ]);
    expect(parseProcNetTcp(TCP6, 6, 1000, true).map((row) => [row.bindAddress, row.port])).toEqual([['::', 3000], ['::1', 9229]]);
    expect(parseProcNetTcp(TCP, 4, 1001, true)).toEqual([]);
  });

  it('reads a stat line whose name holds spaces and parentheses', () => {
    expect(parseStat('4242 (node (vite) x) S 4200 4242 4242 0 -1')).toEqual({ ppid: 4200, name: 'node (vite) x' });
  });

  it('connects the loopback form of the bound address', () => {
    expect(loopbackOf('0.0.0.0', 4)).toBe('127.0.0.1');
    expect(loopbackOf('::', 6)).toBe('::1');
    expect(loopbackOf('::ffff:127.0.0.1', 6)).toBe('127.0.0.1');
    expect(loopbackOf('192.168.1.5', 4)).toBe('192.168.1.5');
  });

  it('maps each socket inode to its process through the fd links, and labels it by its program and the command the shell started', async () => {
    const proc = procFs(
      {
        '/proc/net/tcp': TCP,
        '/proc/net/tcp6': TCP6,
        '/proc/100/stat': '100 (bash) S 1 100 100 0',
        '/proc/200/stat': '200 (npm run dev) S 100 200 100 0',
        '/proc/300/stat': '300 (sh) S 200 300 100 0',
        '/proc/400/stat': '400 (MainThread) S 300 400 100 0',
        '/proc/500/stat': '500 (python3) S 100 500 100 0',
        '/proc/100/cmdline': 'bash\0',
        '/proc/200/cmdline': 'npm\0run\0dev\0',
        '/proc/300/cmdline': 'sh\0-c\0vite\0',
        '/proc/400/cmdline': 'node\0/srv/app/node_modules/.bin/vite\0',
        '/proc/500/cmdline': 'python3\0-m\0http.server\u00008000\0',
      },
      { '/proc': ['self', '1', '100', '200', '300', '400', '500'], '/proc/400/fd': ['0', '1', '21'], '/proc/500/fd': ['3'] },
      { '/proc/400/fd/21': 'socket:[41002]', '/proc/400/fd/0': '/dev/pts/0', '/proc/500/fd/3': 'socket:[41001]' },
    );
    const found = await scanLinuxListeners(proc, 1000, true);
    expect(found).toEqual([
      { port: 8000, bindAddress: '0.0.0.0', family: 4, host: '127.0.0.1', pid: 500, process: { name: 'python3', command: 'python3 -m http.server 8000' } },
      { port: 5173, bindAddress: '127.0.0.1', family: 4, host: '127.0.0.1', pid: 400, process: { name: 'node', command: 'npm run dev' } },
      { port: 3000, bindAddress: '::', family: 6, host: '::1' },
      { port: 9229, bindAddress: '::1', family: 6, host: '::1' },
    ]);
  });

  it('lists nothing and reads no process when the user listens on nothing', async () => {
    const read: string[] = [];
    const proc = procFs({ '/proc/net/tcp': TCP, '/proc/net/tcp6': TCP6 }, {}, {});
    const counting: ProcFs = { ...proc, readdir: async (path) => { read.push(path); return proc.readdir(path); } };
    expect(await scanLinuxListeners(counting, 4242, true)).toEqual([]);
    expect(read).toEqual([]);
  });
});
