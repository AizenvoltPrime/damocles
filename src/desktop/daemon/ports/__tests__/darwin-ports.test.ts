import { describe, expect, it } from 'vitest';
import type { RunOutput, SpawnSpec } from '../../../../core/process-launcher';
import { parseLsof, parsePs, scanDarwinListeners } from '../darwin-ports';

// `lsof -nP -iTCP -sTCP:LISTEN -a -u 501 -Fpcn` on macOS 14: one p/c pair per process, an f and an n line per socket
const LSOF = ['p812', 'cnode', 'f23', 'n*:5173', 'f24', 'n[::1]:24678', 'p901', 'cPython', 'f3', 'n127.0.0.1:8000', 'p902', 'cnode', 'f19', 'n*:5173', ''].join('\n');
const PS = ['    1     0 /sbin/launchd', '  700     1 /bin/zsh -l', '  780   700 npm run dev', '  812   780 /usr/local/bin/node /Users/me/app/node_modules/.bin/vite', '  901   700 /usr/bin/python3 -m http.server 8000', ''].join('\n');

const output = (stdout: string, code = 0): RunOutput => ({ exit: { code, signal: null } as RunOutput['exit'], stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });

describe('macOS listening sockets from lsof', () => {
  it('reads lsof\'s -F fields: the pid and command, and each socket\'s address and port', () => {
    expect(parseLsof(LSOF)).toEqual([
      { pid: 812, name: 'node', port: 5173, bindAddress: '0.0.0.0', family: 4 },
      { pid: 812, name: 'node', port: 24678, bindAddress: '::1', family: 6 },
      { pid: 901, name: 'Python', port: 8000, bindAddress: '127.0.0.1', family: 4 },
      { pid: 902, name: 'node', port: 5173, bindAddress: '0.0.0.0', family: 4 },
    ]);
  });

  it('reads ps rows whose command line holds spaces', () => {
    expect(parsePs(PS).get(780)).toEqual({ pid: 780, ppid: 700, name: 'npm', command: 'npm run dev' });
  });

  it('runs lsof and ps at absolute paths for the user, and lists each socket once with its label', async () => {
    const runs: SpawnSpec[] = [];
    const run = async (spec: SpawnSpec): Promise<RunOutput> => {
      runs.push(spec);
      return output(spec.file === '/usr/sbin/lsof' ? LSOF : PS);
    };
    const found = await scanDarwinListeners({ run, ps: async () => '/bin/ps', uid: 501 });
    expect(runs.map((spec) => [spec.file, ...spec.args])).toEqual([
      ['/usr/sbin/lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-u', '501', '-Fpcn'],
      ['/bin/ps', '-o', 'pid=,ppid=,args=', '-U', '501'],
    ]);
    expect(found).toEqual([
      { port: 5173, bindAddress: '0.0.0.0', family: 4, host: '127.0.0.1', pid: 812, process: { name: 'node', command: 'npm run dev' } },
      { port: 24678, bindAddress: '::1', family: 6, host: '::1', pid: 812, process: { name: 'node', command: 'npm run dev' } },
      { port: 8000, bindAddress: '127.0.0.1', family: 4, host: '127.0.0.1', pid: 901, process: { name: 'Python', command: '/usr/bin/python3 -m http.server 8000' } },
    ]);
  });

  it('labels many sockets of many processes without copying the process table per socket', async () => {
    const count = 5000;
    const lsof = Array.from({ length: count }, (_, index) => `p${index + 2}\ncnode\nn*:${index + 1}`).join('\n');
    const ps = Array.from({ length: count }, (_, index) => `${index + 2} 1 node server-${index}.js`).join('\n');
    const run = async (spec: SpawnSpec): Promise<RunOutput> => output(spec.file === '/usr/sbin/lsof' ? lsof : ps);
    const started = performance.now();
    const found = await scanDarwinListeners({ run, ps: async () => '/bin/ps', uid: 501 });
    expect(performance.now() - started).toBeLessThan(500);
    expect(found).toHaveLength(count);
    expect(found[0]!.process).toEqual({ name: 'node' });
  });

  it('takes lsof\'s exit 1 with no output as no socket, and runs no ps then', async () => {
    const runs: string[] = [];
    const found = await scanDarwinListeners({ run: async (spec) => { runs.push(spec.file); return output('', 1); }, ps: async () => '/bin/ps', uid: 501 });
    expect(found).toEqual([]);
    expect(runs).toEqual(['/usr/sbin/lsof']);
  });
});
