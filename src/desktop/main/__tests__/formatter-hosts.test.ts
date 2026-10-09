import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormatterHosts, HOST_IDLE_MS, HOST_STARTUP_MS, type HostProcess } from '../formatting/formatter-hosts';
import { MAX_HOST_MESSAGE_CHARS, MAX_HOST_PATH_CHARS, parseHostReply, parseHostRequest, type HostRequest } from '../../formatter-host/protocol';
import { EDITOR_FORMAT_TIMEOUT_MS, MAX_EDITOR_TEXT_CHARS } from '../../preload/shell-channels';
import { hostEnvironment } from '../formatting/formatter-process';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

class FakeHost implements HostProcess {
  readonly sent: HostRequest[] = [];
  killed = false;
  private message: ((message: unknown) => void) | undefined;
  private exit: ((code: number) => void) | undefined;
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  postMessage(message: HostRequest): void { this.sent.push(message); }
  onMessage(listener: (message: unknown) => void): void { this.message = listener; }
  onExit(listener: (code: number) => void): void { this.exit = listener; }
  kill(): void { this.killed = true; }
  reply(message: unknown): void { this.message?.(message); }
  exited(code: number): void { this.exit?.(code); }
}

const ROOT = { key: 'c:\\work\\alpha', root: 'C:\\work\\alpha' };
const REQUEST = { prettier: 'C:\\work\\alpha\\node_modules\\prettier\\index.cjs', config: 'C:\\work\\alpha\\.prettierrc', file: 'C:\\work\\alpha\\a.ts', text: 'a' };

let spawned: FakeHost[];
let watchers: Array<{ root: string; change: () => void; disposed: boolean }>;
let lines: string[];
let hosts: FormatterHosts;

beforeEach(() => {
  vi.useFakeTimers();
  spawned = [];
  watchers = [];
  lines = [];
  hosts = new FormatterHosts({
    spawn: (root) => {
      const host = new FakeHost(root);
      spawned.push(host);
      return host;
    },
    watch: (root, change) => {
      const watcher = { root, change, disposed: false };
      watchers.push(watcher);
      return { dispose: () => { watcher.disposed = true; } };
    },
    log: (line) => lines.push(line),
  });
});

afterEach(() => vi.useRealTimers());

describe('FormatterHosts', () => {
  it('starts one host per root on first use, sends the request and maps each reply kind', async () => {
    expect(spawned).toHaveLength(0);
    const formatted = hosts.format(ROOT, REQUEST);
    const ignored = hosts.format(ROOT, REQUEST);
    const failed = hosts.format(ROOT, REQUEST);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.root).toBe(ROOT.root);
    const [a, b, c] = spawned[0]!.sent;
    expect(a).toEqual({ id: a!.id, ...REQUEST });
    spawned[0]!.reply({ id: b!.id, kind: 'ignored' });
    spawned[0]!.reply({ id: a!.id, kind: 'formatted', text: 'b' });
    spawned[0]!.reply({ id: c!.id, kind: 'error', message: 'SyntaxError' });
    expect(await formatted).toEqual({ kind: 'formatted', text: 'b' });
    expect(await ignored).toEqual({ kind: 'ignored' });
    expect(await failed).toEqual({ kind: 'error', message: 'SyntaxError' });
    expect(hosts.running(ROOT.key)).toBe(true);
    expect(watchers.map((watcher) => watcher.root)).toEqual([ROOT.root]);
  });

  it('answers a timeout 3 s after Prettier loaded and kills the host; the next format starts a new one', async () => {
    const slow = hosts.format(ROOT, REQUEST);
    const other = hosts.format(ROOT, REQUEST);
    for (const sent of spawned[0]!.sent) spawned[0]!.reply({ id: sent.id, kind: 'loaded' });
    await vi.advanceTimersByTimeAsync(EDITOR_FORMAT_TIMEOUT_MS - 1);
    expect(spawned[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await slow).toEqual({ kind: 'timeout', starting: false });
    expect(await other).toEqual({ kind: 'error', message: 'The formatter process was stopped because it timed out.' });
    expect(spawned[0]!.killed).toBe(true);
    expect(watchers[0]!.disposed).toBe(true);
    expect(hosts.running(ROOT.key)).toBe(false);
    // A late reply of the killed host reaches nobody.
    spawned[0]!.reply({ id: spawned[0]!.sent[0]!.id, kind: 'formatted', text: 'late' });
    void hosts.format(ROOT, REQUEST);
    expect(spawned).toHaveLength(2);
  });

  it('starts the budget once Prettier loaded, so a slow start still formats', async () => {
    const pending = hosts.format(ROOT, REQUEST);
    const id = spawned[0]!.sent[0]!.id;
    await vi.advanceTimersByTimeAsync(EDITOR_FORMAT_TIMEOUT_MS - 1);
    spawned[0]!.reply({ id, kind: 'loaded' });
    await vi.advanceTimersByTimeAsync(EDITOR_FORMAT_TIMEOUT_MS - 1);
    spawned[0]!.reply({ id, kind: 'formatted', text: 'b' });
    expect(await pending).toEqual({ kind: 'formatted', text: 'b' });
    expect(spawned[0]!.killed).toBe(false);
  });

  it('answers a start past the budget and keeps the host loading, so the next format finds it warm', async () => {
    const cold = hosts.format(ROOT, REQUEST);
    const id = spawned[0]!.sent[0]!.id;
    await vi.advanceTimersByTimeAsync(EDITOR_FORMAT_TIMEOUT_MS);
    expect(await cold).toEqual({ kind: 'timeout', starting: true });
    expect(spawned[0]!.killed).toBe(false);
    // The abandoned request finishes warming: its replies reach nobody and stop nothing.
    spawned[0]!.reply({ id, kind: 'loaded' });
    spawned[0]!.reply({ id, kind: 'formatted', text: 'late' });
    expect(spawned[0]!.killed).toBe(false);
    const warm = hosts.format(ROOT, REQUEST);
    expect(spawned).toHaveLength(1);
    const next = spawned[0]!.sent[1]!.id;
    spawned[0]!.reply({ id: next, kind: 'loaded' });
    spawned[0]!.reply({ id: next, kind: 'formatted', text: 'b' });
    expect(await warm).toEqual({ kind: 'formatted', text: 'b' });
  });

  it('kills a host that has not loaded Prettier within its own startup bound', async () => {
    const cold = hosts.format(ROOT, REQUEST);
    await vi.advanceTimersByTimeAsync(EDITOR_FORMAT_TIMEOUT_MS);
    expect(await cold).toEqual({ kind: 'timeout', starting: true });
    await vi.advanceTimersByTimeAsync(HOST_STARTUP_MS - EDITOR_FORMAT_TIMEOUT_MS - 1);
    expect(spawned[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned[0]!.killed).toBe(true);
    expect(lines).toContain(`[format] stopping the formatter for ${ROOT.root}: it took longer than ${HOST_STARTUP_MS / 1000} s to load Prettier`);
  });

  it('never rejects: a host that cannot start or take the request answers an error', async () => {
    const quiet = { watch: () => ({ dispose: () => undefined }), log: (line: string) => lines.push(line) };
    const unstartable = new FormatterHosts({
      ...quiet,
      spawn: () => {
        throw new Error('spawn EMFILE');
      },
    });
    expect(await unstartable.format(ROOT, REQUEST)).toEqual({ kind: 'error', message: 'The formatter process could not start: spawn EMFILE' });

    const gone = new FakeHost(ROOT.root);
    gone.postMessage = () => {
      throw new Error('the process is gone');
    };
    const unsent = new FormatterHosts({ ...quiet, spawn: () => gone });
    expect(await unsent.format(ROOT, REQUEST)).toEqual({ kind: 'error', message: 'The formatter process was stopped because the request could not be sent (the process is gone).' });
    expect(gone.killed).toBe(true);
  });

  it('maps a refusal to load a module outside the root', async () => {
    const pending = hosts.format(ROOT, REQUEST);
    spawned[0]!.reply({ id: spawned[0]!.sent[0]!.id, kind: 'refused', path: 'C:\\work\\node_modules\\plugin\\index.js' });
    expect(await pending).toEqual({ kind: 'refused', path: 'C:\\work\\node_modules\\plugin\\index.js' });
  });

  it('stops a host that replies outside the contract or for no pending request', async () => {
    const pending = hosts.format(ROOT, REQUEST);
    spawned[0]!.reply({ id: 999, kind: 'formatted', text: 'x' });
    expect(await pending).toEqual({ kind: 'error', message: 'The formatter process was stopped because it sent a message outside the contract.' });
    expect(spawned[0]!.killed).toBe(true);

    const next = hosts.format(ROOT, REQUEST);
    spawned[1]!.reply({ id: spawned[1]!.sent[0]!.id, kind: 'formatted', text: 7 });
    expect(await next).toMatchObject({ kind: 'error' });
    expect(spawned[1]!.killed).toBe(true);

    // loaded comes once per request, before its reply.
    const twice = hosts.format(ROOT, REQUEST);
    const id = spawned[2]!.sent[0]!.id;
    spawned[2]!.reply({ id, kind: 'loaded' });
    spawned[2]!.reply({ id, kind: 'loaded' });
    expect(await twice).toMatchObject({ kind: 'error' });
    expect(spawned[2]!.killed).toBe(true);
  });

  it('fails the pending requests of a host that exits', async () => {
    const pending = hosts.format(ROOT, REQUEST);
    spawned[0]!.exited(1);
    expect(await pending).toEqual({ kind: 'error', message: 'The formatter process exited with code 1.' });
    expect(hosts.running(ROOT.key)).toBe(false);
  });

  it('kills a host after 5 minutes idle, on project removal and when package.json or the lockfile changes', async () => {
    const first = hosts.format(ROOT, REQUEST);
    spawned[0]!.reply({ id: spawned[0]!.sent[0]!.id, kind: 'ignored' });
    await first;
    await vi.advanceTimersByTimeAsync(HOST_IDLE_MS - 1);
    expect(spawned[0]!.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned[0]!.killed).toBe(true);

    const other = { key: 'c:\\work\\beta', root: 'C:\\work\\beta' };
    void hosts.format(ROOT, REQUEST);
    void hosts.format(other, REQUEST);
    hosts.retain([other.key]);
    expect(spawned[1]!.killed).toBe(true);
    expect(spawned[2]!.killed).toBe(false);
    watchers[2]!.change();
    expect(spawned[2]!.killed).toBe(true);
    expect(lines.some((line) => line.includes('package.json or the lockfile changed'))).toBe(true);
  });

  it('dispose kills every host', () => {
    void hosts.format(ROOT, REQUEST);
    hosts.dispose();
    expect(spawned[0]!.killed).toBe(true);
  });
});

describe('host message contract', () => {
  it('takes a request with an id, bounded paths, a config path or null, and bounded text, and nothing else', () => {
    expect(parseHostRequest({ id: 1, ...REQUEST, extra: true })).toEqual({ id: 1, ...REQUEST });
    expect(parseHostRequest({ id: 1, ...REQUEST, config: null })).toEqual({ id: 1, ...REQUEST, config: null });
    for (const bad of [
      null,
      { ...REQUEST },
      { id: -1, ...REQUEST },
      { id: 1.5, ...REQUEST },
      { id: 1, ...REQUEST, prettier: '' },
      { id: 1, ...REQUEST, file: 'a\0b' },
      { id: 1, prettier: REQUEST.prettier, file: REQUEST.file, text: 'a' },
      { id: 1, ...REQUEST, config: '' },
      { id: 1, ...REQUEST, config: 'x'.repeat(MAX_HOST_PATH_CHARS + 1) },
      { id: 1, ...REQUEST, file: 'x'.repeat(MAX_HOST_PATH_CHARS + 1) },
      { id: 1, ...REQUEST, text: 'x'.repeat(MAX_EDITOR_TEXT_CHARS + 1) },
      { id: 1, ...REQUEST, text: 3 },
    ]) expect(parseHostRequest(bad)).toBeUndefined();
  });

  it('takes the reply kinds within bounds, and nothing else', () => {
    expect(parseHostReply({ id: 2, kind: 'loaded', text: 'b' })).toEqual({ id: 2, kind: 'loaded' });
    expect(parseHostReply({ id: 2, kind: 'refused', path: 'C:\\p.js' })).toEqual({ id: 2, kind: 'refused', path: 'C:\\p.js' });
    expect(parseHostReply({ id: 2, kind: 'formatted', text: 'b' })).toEqual({ id: 2, kind: 'formatted', text: 'b' });
    expect(parseHostReply({ id: 2, kind: 'ignored', text: 'b' })).toEqual({ id: 2, kind: 'ignored' });
    expect(parseHostReply({ id: 2, kind: 'error', message: 'm' })).toEqual({ id: 2, kind: 'error', message: 'm' });
    for (const bad of [
      'formatted',
      [2, 'ignored'],
      { kind: 'ignored' },
      { id: 2, kind: 'done' },
      { id: 2, kind: 'formatted' },
      { id: 2, kind: 'formatted', text: 'x'.repeat(MAX_EDITOR_TEXT_CHARS + 1) },
      { id: 2, kind: 'error', message: 'x'.repeat(MAX_HOST_MESSAGE_CHARS + 1) },
      { id: '2', kind: 'ignored' },
      { id: 2, kind: 'refused' },
      { id: 2, kind: 'refused', path: 'x'.repeat(MAX_HOST_PATH_CHARS + 1) },
    ]) expect(parseHostReply(bad)).toBeUndefined();
  });
});

describe('hostEnvironment', () => {
  it('passes the merged login environment without any ELECTRON_ variable', () => {
    expect(hostEnvironment({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', electron_enable_logging: '1', HOME: '/h', ELECTRONISH: 'kept', UNSET: undefined })).toEqual({ PATH: '/usr/bin', HOME: '/h', ELECTRONISH: 'kept' });
  });
});

describe('spawnFormatterHost', () => {
  it('forks the host script with the root as cwd, no ELECTRON_ variable and no stdio', async () => {
    const { utilityProcess } = await import('electron');
    const child = { on: vi.fn(), postMessage: vi.fn(), kill: vi.fn() };
    vi.mocked(utilityProcess.fork).mockReturnValue(child as never);
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    const { spawnFormatterHost } = await import('../formatting/formatter-process');
    const host = spawnFormatterHost('/app/dist/formatter-host.js', ROOT.root);
    const [script, args, options] = vi.mocked(utilityProcess.fork).mock.calls[0]!;
    expect(script).toBe('/app/dist/formatter-host.js');
    expect(args).toEqual([]);
    expect(options).toMatchObject({ cwd: ROOT.root, stdio: 'ignore', serviceName: 'Damocles Formatter' });
    expect(Object.keys(options!.env!).some((key) => /^ELECTRON_/i.test(key))).toBe(false);
    host.postMessage({ id: 1, ...REQUEST });
    expect(child.postMessage).toHaveBeenCalledWith({ id: 1, ...REQUEST });
    host.kill();
    expect(child.kill).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
