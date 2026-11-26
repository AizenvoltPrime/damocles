import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { compareIdentity, createStartIdentity, startIdentity, type IdentityReads, type ToolOutput } from '../process-identity';

const enoent = (file: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
const BOOT_ID = '0f5a7c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b';

// /proc/<pid>/stat with starttime (field 22) at 4242 and the given command name, which may hold spaces and ')'
const stat = (pid: number, comm: string, starttime = '4242', state = 'S'): string => `${pid} (${comm}) ${state} 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${starttime} 1000 200 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n`;

function reads(overrides: Partial<IdentityReads>): IdentityReads & { readonly runs: string[] } {
  const runs: string[] = [];
  return {
    platform: 'linux',
    readFile: (file) => Promise.reject(enoent(file)),
    run: (file, args, env) => {
      runs.push(`${file} ${args.join(' ')}${env ? ` ${JSON.stringify(env)}` : ''}`);
      return Promise.resolve({ code: 1, signal: null, stdout: '', stderr: '' });
    },
    exists: () => false,
    ps: () => Promise.resolve('/bin/ps'),
    windowsCreated: () => {
      throw new Error('no Windows read on this platform');
    },
    ...overrides,
    runs,
  };
}

const answering = (output: ToolOutput): IdentityReads['run'] => () => Promise.resolve(output);

describe('a process\'s start identity on Linux', () => {
  const files = (pid: number, comm: string): Map<string, string> => new Map([[`/proc/${pid}/stat`, stat(pid, comm)], ['/proc/sys/kernel/random/boot_id', `${BOOT_ID}\n`]]);
  const linux = (known: Map<string, string>, running: readonly number[] = []): IdentityReads => reads({ readFile: (file) => (known.has(file) ? Promise.resolve(known.get(file)!) : Promise.reject(enoent(file))), exists: (pid) => running.includes(pid) });

  it('is the boot id and the start time the stat file names after the command name, under the Linux scheme', async () => {
    expect(await createStartIdentity(linux(files(812, 'bash')))(812)).toBe(`linux1:${BOOT_ID}:4242`);
  });

  it('reads the start time after the last parenthesis, whatever the command name holds', async () => {
    expect(await createStartIdentity(linux(files(813, 'evil) S 1 2 3 (x) 99 98')))(813)).toBe(`linux1:${BOOT_ID}:4242`);
    expect(await createStartIdentity(linux(files(814, 'a b  c)')))(814)).toBe(`linux1:${BOOT_ID}:4242`);
  });

  it('is undefined for a pid no process has', async () => {
    expect(await createStartIdentity(linux(files(812, 'bash')))(99_999)).toBeUndefined();
  });

  // a zombie keeps its pid until its parent reaps it, which a parent that does not reap never does
  it('is undefined for a zombie, which has ended', async () => {
    const zombie = new Map([['/proc/817/stat', stat(817, 'a) Z (b', '4242', 'Z')], ['/proc/sys/kernel/random/boot_id', BOOT_ID]]);
    expect(await createStartIdentity(linux(zombie, [817]))(817)).toBeUndefined();
  });

  // a /proc mounted with hidepid, or another pid namespace's, hides a process that still runs
  it('fails when the stat file is missing while the pid still runs', async () => {
    await expect(createStartIdentity(linux(files(812, 'bash'), [99_999]))(99_999)).rejects.toThrow('/proc/99999/stat is missing while the pid 99999 runs');
  });

  it('fails when the stat file does not parse or the boot id cannot be read', async () => {
    const short = new Map([['/proc/815/stat', '815 (sh) S 1 2'], ['/proc/sys/kernel/random/boot_id', BOOT_ID]]);
    await expect(createStartIdentity(linux(short))(815)).rejects.toThrow(/does not parse/);
    const noBoot = new Map([['/proc/816/stat', stat(816, 'sh')]]);
    await expect(createStartIdentity(linux(noBoot))(816)).rejects.toThrow(/ENOENT/);
  });

  it('refuses a pid that names no single process', async () => {
    for (const pid of [0, -1, 1.5]) await expect(createStartIdentity(linux(files(812, 'bash')))(pid)).rejects.toThrow(/pid/);
  });

});

describe('this machine\'s own reads', { timeout: 30_000 }, () => {
  it('read this process\'s identity the same way twice, and none for a pid no process has', async () => {
    const first = await startIdentity(process.pid);
    expect(first).toMatch(process.platform === 'linux' ? /^linux1:[0-9a-f-]{36}:\d+$/ : process.platform === 'win32' ? /^win1:\d+$/ : /^darwin1:[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}$/);
    expect(await startIdentity(process.pid)).toBe(first);
    // above Linux's PID_MAX_LIMIT (2^22), and not a multiple of 4, as every Windows process id is
    expect(await startIdentity(4_194_305)).toBeUndefined();
  });

  it('read a child\'s identity while it runs, and none once it exited', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.once("data", () => process.exit(0))'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => child.once('spawn', resolve));
    const running = await startIdentity(child.pid!);
    expect(running).toMatch(/^(linux1|win1|darwin1):/);
    child.stdin!.end('x');
    await exited;
    expect(await startIdentity(child.pid!)).toBeUndefined();
  });
});

describe('a process\'s start identity on macOS', () => {
  it('is ps\'s lstart in the C locale with runs of spaces collapsed', async () => {
    const macos = reads({ platform: 'darwin', run: answering({ code: 0, signal: null, stdout: 'Ss+  Mon Jun  3 09:04:05 2024\n', stderr: '' }) });
    expect(await createStartIdentity(macos)(812)).toBe('darwin1:Mon Jun 3 09:04:05 2024');
    const recorded = reads({ platform: 'darwin' });
    await createStartIdentity(recorded)(812);
    // lstart is local time, so a zone change would make a live process read as another
    expect(recorded.runs).toEqual(['/bin/ps -o stat=,lstart= -p 812 {"LC_ALL":"C","TZ":"UTC0"}']);
  });

  // a shell killed under a stopped terminal host stays its zombie until the host is ended
  it('is undefined for a zombie, which has ended', async () => {
    expect(await createStartIdentity(reads({ platform: 'darwin', run: answering({ code: 0, signal: null, stdout: 'Z+   Mon Jun  3 09:04:05 2024\n', stderr: '' }) }))(812)).toBeUndefined();
  });

  it('is undefined when ps lists no such process, and fails when ps fails or is missing', async () => {
    expect(await createStartIdentity(reads({ platform: 'darwin', run: answering({ code: 1, signal: null, stdout: '', stderr: '' }) }))(812)).toBeUndefined();
    await expect(createStartIdentity(reads({ platform: 'darwin', run: answering({ code: 1, signal: null, stdout: '', stderr: 'ps: illegal option' }) }))(812)).rejects.toThrow(/illegal option/);
    await expect(createStartIdentity(reads({ platform: 'darwin', run: answering({ code: 0, signal: null, stdout: 'Ss\n', stderr: '' }) }))(812)).rejects.toThrow('ps printed no start time for 812: Ss');
    await expect(createStartIdentity(reads({ platform: 'darwin', run: answering({ code: null, signal: null, stdout: '', stderr: '' }) }))(812)).rejects.toThrow('ps did not finish within 5000 ms');
    await expect(createStartIdentity(reads({ platform: 'darwin', run: answering({ code: null, signal: 'SIGSEGV', stdout: '', stderr: '' }) }))(812)).rejects.toThrow('ps ended by SIGSEGV');
    await expect(createStartIdentity(reads({ platform: 'darwin', ps: () => Promise.resolve(undefined) }))(812)).rejects.toThrow(/no ps/);
  });
});

describe('a process\'s start identity on Windows', () => {
  it('is the creation time in FILETIME UTC ticks, and starts no process', async () => {
    const windows = reads({ platform: 'win32', windowsCreated: (pid) => (pid === 812 ? 133617006451234567n : undefined) });
    expect(await createStartIdentity(windows)(812)).toBe('win1:133617006451234567');
    expect(windows.runs).toEqual([]);
  });

  it('is undefined for a pid no live process has, and fails when the process cannot be read', async () => {
    expect(await createStartIdentity(reads({ platform: 'win32', windowsCreated: () => undefined }))(812)).toBeUndefined();
    const denied = reads({ platform: 'win32', windowsCreated: () => { throw new Error('OpenProcess(812) failed with Win32 error 5'); } });
    await expect(createStartIdentity(denied)(812)).rejects.toThrow('OpenProcess(812) failed with Win32 error 5');
  });
});

// a recorded identity of another scheme comes from another reader, so it can neither match nor differ
describe('comparing a recorded start identity with the one read now', () => {
  it('is the same process only for an equal identity of the same scheme, another one for a different value of it', () => {
    expect(compareIdentity('linux1:boot:42', 'linux1:boot:42')).toBe('same');
    expect(compareIdentity('linux1:boot:41', 'linux1:boot:42')).toBe('other');
    expect(compareIdentity('win1:133617006451234567', 'win1:133617006451234568')).toBe('other');
  });

  it('proves nothing for a recorded identity of an unknown or another scheme, or of none', () => {
    for (const recorded of ['linux2:boot:42', 'darwin1:Mon Jun 3 09:04:05 2024', 'boot:42', '133617006451234567', ':42']) {
      expect(compareIdentity(recorded, 'linux1:boot:42')).toBe('incomparable');
    }
    expect(compareIdentity('linux1:boot:42', 'boot:42')).toBe('incomparable');
  });
});
