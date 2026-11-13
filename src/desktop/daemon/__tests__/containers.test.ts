import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KillOptions, LaunchedProcess, ProcessExit } from '../../../core/process-launcher';
import type { StreamChannel } from '../../../remote/mux';
import { CONTAINER_DATA_FOLDER, copyPackageArgs, dataOwnerArgs, devcontainerReadArgs, devcontainerUpArgs } from '../container-commands';
import { cachedPackage, configOf, pipeExec, runCliOn } from '../containers';
import { CLIENT_TO_CONTROL } from '../control-messages';
import { INVALID } from '../../core-protocol/schema';

const ID = '28f4e6f33d7eb0c2fa0a1a525fdb39d5ef72c206dbca3f397ed48e8b10aa3a24';
const KEY = 'c'.repeat(32);

// A started process the test ends: its stdin as written, the kills asked, and its output pushed by hand.
function fakeChild(): { child: LaunchedProcess; stdin: Buffer[]; kills: Array<KillOptions | undefined>; ended: () => boolean; out: (stream: 'stdout' | 'stderr', text: string) => void; exit: (code: number) => void } {
  const listeners = { stdout: [] as Array<(chunk: Buffer) => void>, stderr: [] as Array<(chunk: Buffer) => void> };
  const stdin: Buffer[] = [];
  const kills: Array<KillOptions | undefined> = [];
  let endedStdin = false;
  let finish = (_exit: ProcessExit): void => undefined;
  const exited = new Promise<ProcessExit>((resolve) => {
    finish = resolve;
  });
  return {
    child: {
      pid: Promise.resolve(7),
      onData: (stream, listener) => void listeners[stream].push(listener),
      write: async (chunk) => void stdin.push(Buffer.from(chunk)),
      end: () => {
        endedStdin = true;
      },
      exited,
      closed: exited.then(() => undefined),
      leftRunning: exited.then(() => false),
      kill: (options) => {
        kills.push(options);
        finish({ code: null, signal: 'SIGTERM' });
      },
    },
    stdin,
    kills,
    ended: () => endedStdin,
    out: (stream, text) => listeners[stream].forEach((listener) => listener(Buffer.from(text))),
    exit: (code) => finish({ code, signal: null }),
  };
}

// A client-opened stream: what the daemon wrote, whether it ended it, and the client's data and end pushed by hand; while full
// a write is queued past the window, which drain ends.
function fakeStream(): { stream: StreamChannel; written: string[]; endedByDaemon: () => boolean; clientEnds: (closed?: boolean) => void; clientSends: (text: string) => void; fill: () => void; drain: () => void } {
  const data: Array<(bytes: Uint8Array) => void> = [];
  const ends: Array<() => void> = [];
  const drains: Array<() => void> = [];
  const written: string[] = [];
  let ended = false;
  let closed = false;
  let full = false;
  return {
    stream: {
      id: 3,
      get closed() {
        return closed;
      },
      write: (bytes) => {
        written.push(Buffer.from(bytes).toString('utf8'));
        return !full;
      },
      end: () => {
        ended = true;
      },
      onData: (listener) => {
        data.push(listener);
        return { dispose: () => undefined };
      },
      onEnd: (listener) => {
        ends.push(listener);
        return { dispose: () => void ends.splice(ends.indexOf(listener), 1) };
      },
      onDrain: (listener) => {
        drains.push(listener);
        return { dispose: () => void drains.splice(drains.indexOf(listener), 1) };
      },
      pause: () => undefined,
      resume: () => undefined,
    },
    written,
    fill: () => {
      full = true;
    },
    drain: () => {
      full = false;
      for (const listener of [...drains]) listener();
    },
    endedByDaemon: () => ended,
    clientEnds: (isClosed = false) => {
      closed = isClosed;
      for (const listener of [...ends]) listener();
    },
    clientSends: (text) => data.forEach((listener) => listener(Buffer.from(text))),
  };
}

describe('the daemon\'s devcontainer CLI run', () => {
  it('streams stderr, collects stdout, and ends the stream with the CLI', async () => {
    const { child, out, exit, kills } = fakeChild();
    const { stream, written, endedByDaemon } = fakeStream();
    const running = runCliOn(child, stream, () => undefined);
    out('stderr', '{"type":"raw","text":"step"}\n');
    out('stdout', '{"outcome":"success"}\n');
    exit(0);
    expect(await running).toEqual({ result: 'ran', code: 0, stdout: '{"outcome":"success"}\n' });
    expect(written).toEqual(['{"type":"raw","text":"step"}\n']);
    expect(endedByDaemon()).toBe(true);
    expect(kills).toEqual([]);
  });

  it('drops the stderr that arrives while the stream is past its window, and logs how much once', async () => {
    const { child, out, exit } = fakeChild();
    const { stream, written, fill, drain } = fakeStream();
    const lines: string[] = [];
    const running = runCliOn(child, stream, (line) => lines.push(line));
    fill();
    out('stderr', 'queued\n');
    out('stderr', 'dropped\n');
    out('stderr', 'dropped too\n');
    drain();
    out('stderr', 'sent\n');
    exit(0);
    await running;
    expect(written).toEqual(['queued\n', 'sent\n']);
    expect(lines).toEqual(['[containers] dropped 20 bytes of the devcontainer CLI\'s log while the client read slower than it wrote']);
  });

  it('kills the CLI\'s tree when the client ends the stream first (Cancel), so nothing more runs on the host', async () => {
    const { child, kills } = fakeChild();
    const { stream, clientEnds } = fakeStream();
    const running = runCliOn(child, stream, () => undefined);
    clientEnds();
    expect(kills).toEqual([{ tree: true }]);
    expect((await running).result).toBe('ran');
  });
});

describe('the daemon\'s exec stream', () => {
  it('pipes the stream to stdin and stdout to the stream, ends stdin on the client\'s end and the stream on the exec\'s', async () => {
    const { child, stdin, out, exit, ended, kills } = fakeChild();
    const { stream, written, endedByDaemon, clientSends, clientEnds } = fakeStream();
    pipeExec(child, stream, () => undefined);
    clientSends('stage 1');
    out('stdout', '@@DAMOCLES {"kind":"bridge"}\n');
    await Promise.resolve();
    expect(Buffer.concat(stdin).toString('utf8')).toBe('stage 1');
    expect(written).toEqual(['@@DAMOCLES {"kind":"bridge"}\n']);
    clientEnds();
    expect(ended()).toBe(true);
    expect(kills).toEqual([]);
    exit(0);
    await child.closed;
    await Promise.resolve();
    expect(endedByDaemon()).toBe(true);
  });

  it('kills the exec when the connection is lost, leaving the daemon it started to run', () => {
    const { child, kills } = fakeChild();
    const { stream, clientEnds } = fakeStream();
    pipeExec(child, stream, () => undefined);
    clientEnds(true);
    expect(kills).toHaveLength(1);
  });
});

describe('container commands', () => {
  const target = { workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer/devcontainer.json', enginePath: '/usr/bin/podman' };

  it('builds up with the key\'s data volume and Rebuild\'s flag, and read-configuration with the merged configuration and a fresh id label', () => {
    expect(devcontainerUpArgs(target, KEY, true)).toEqual(['up', '--workspace-folder', '/srv/app', '--config', '/srv/app/.devcontainer/devcontainer.json', '--docker-path', '/usr/bin/podman', '--log-format', 'json', '--mount', `type=volume,source=damocles-data-${KEY},target=${CONTAINER_DATA_FOLDER}`, '--remove-existing-container']);
    expect(devcontainerUpArgs(target, KEY, false)).not.toContain('--remove-existing-container');
    expect(devcontainerReadArgs(target, 'f'.repeat(32))).toEqual(['read-configuration', '--workspace-folder', '/srv/app', '--config', '/srv/app/.devcontainer/devcontainer.json', '--docker-path', '/usr/bin/podman', '--log-format', 'json', '--include-merged-configuration', '--id-label', `damocles.trust-read=${'f'.repeat(32)}`]);
    // recursive, so what an earlier remote user left there is the new one's; -h never follows a link placed in the folder
    expect(dataOwnerArgs(ID, 'node')).toEqual(['exec', '-u', '0', ID, 'chown', '-hR', 'node', CONTAINER_DATA_FOLDER]);
    expect(copyPackageArgs('/cache/damocles-server-3.7.0-alpine-x64.tar.gz', ID, '/tmp/damocles-cache-ab', 'damocles-server-3.7.0-alpine-x64.tar.gz')).toEqual(['cp', '/cache/damocles-server-3.7.0-alpine-x64.tar.gz', `${ID}:/tmp/damocles-cache-ab/damocles-server-3.7.0-alpine-x64.tar.gz`]);
  });

  it('refuses a value that could reach the CLI or the engine as an option or a second line', () => {
    for (const bad of [{ ...target, workspaceFolder: '--build-no-cache' }, { ...target, configPath: 'relative.json' }, { ...target, workspaceFolder: '/srv/a\npp' }, { ...target, enginePath: 'docker' }]) {
      expect(() => devcontainerUpArgs(bad, KEY, false)).toThrow(RangeError);
    }
    expect(() => devcontainerUpArgs(target, 'x', false)).toThrow(RangeError);
    expect(() => devcontainerReadArgs(target, 'not hex')).toThrow(RangeError);
    expect(() => dataOwnerArgs(ID, '--help')).toThrow(RangeError);
    expect(() => copyPackageArgs('/c/p.tar.gz', ID, '/tmp/x', '../../etc/passwd')).toThrow(RangeError);
  });

  it('checks every containers.* parameter on the daemon again', () => {
    const { params } = CLIENT_TO_CONTROL.requests['containers.up'];
    expect(params({ engine: 'docker', workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer.json', dataKey: KEY, removeExisting: false, stream: 16 })).not.toBe(INVALID);
    expect(params({ engine: 'lxc', workspaceFolder: '/srv/app', configPath: '/srv/app/.devcontainer.json', dataKey: KEY, removeExisting: false, stream: 16 })).toBe(INVALID);
    expect(params({ engine: 'docker', workspaceFolder: '-x', configPath: '/srv/app/.devcontainer.json', dataKey: KEY, removeExisting: false, stream: 16 })).toBe(INVALID);
    expect(CLIENT_TO_CONTROL.requests['containers.exec'].params({ engine: 'docker', containerId: ID, user: '-u0', stream: 16 })).toBe(INVALID);
    expect(CLIENT_TO_CONTROL.requests['containers.inspect'].params({ engine: 'docker', ids: [ID, '--format'] })).toBe(INVALID);
    expect(CLIENT_TO_CONTROL.requests['containers.copyPackage'].params({ engine: 'docker', containerId: ID, folder: '/tmp/x', file: 'damocles-server-3.7.0-alpine-x64.tar.gz', sha256: 'a'.repeat(64), size: 10, url: 'file:///etc/passwd' })).toBe(INVALID);
  });
});

describe('a folder\'s devcontainer configuration on the host', () => {
  let folder: string;
  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-config-of-'));
  });
  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('is .devcontainer/devcontainer.json before .devcontainer.json, and none for a folder named so', async () => {
    expect(await configOf(folder)).toBeNull();
    fs.writeFileSync(path.join(folder, '.devcontainer.json'), '{}');
    expect(await configOf(folder)).toBe(path.join(folder, '.devcontainer.json'));
    fs.mkdirSync(path.join(folder, '.devcontainer', 'devcontainer.json'), { recursive: true });
    expect(await configOf(folder)).toBe(path.join(folder, '.devcontainer.json'));
    fs.rmSync(path.join(folder, '.devcontainer'), { recursive: true });
    fs.mkdirSync(path.join(folder, '.devcontainer'));
    fs.writeFileSync(path.join(folder, '.devcontainer', 'devcontainer.json'), '{}');
    expect(await configOf(folder)).toBe(path.join(folder, '.devcontainer', 'devcontainer.json'));
  });
});

describe('the SSH host\'s package cache', () => {
  const FILE = 'damocles-server-3.7.0-alpine-x64.tar.gz';
  const BYTES = Buffer.from('the package bytes');
  const SHA = createHash('sha256').update(BYTES).digest('hex');
  let folder: string;
  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-package-cache-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const fetched = (body: Buffer, status = 200): { fetch: typeof fetch; calls: string[] } => {
    const calls: string[] = [];
    return { calls, fetch: (async (url: string | URL | Request) => { calls.push(String(url)); return new Response(new Uint8Array(body), { status }); }) as typeof fetch };
  };
  const pkg = { file: FILE, sha256: SHA, size: BYTES.length, url: 'https://example.invalid/p.tar.gz' };
  const leftovers = (): string[] => fs.readdirSync(folder).filter((name) => name.endsWith('.partial'));

  it('downloads a missing package, checks it and keeps it readable by every user, and reuses it without a download', async () => {
    const chmod = vi.spyOn(fs.promises, 'chmod');
    const first = fetched(BYTES);
    const target = await cachedPackage({ cacheFolder: folder, fetch: first.fetch, log: () => undefined }, pkg);
    expect(target).toBe(path.join(folder, FILE));
    expect(fs.readFileSync(target!)).toEqual(BYTES);
    expect(first.calls).toEqual([pkg.url]);
    // POSIX modes are not observable on Windows, so the mode given to chmod is what this checks there
    expect(chmod.mock.calls.map(([, mode]) => mode)).toEqual([0o644]);
    if (process.platform !== 'win32') expect(fs.statSync(target!).mode & 0o777).toBe(0o644);
    const again = fetched(Buffer.from('other'));
    expect(await cachedPackage({ cacheFolder: folder, fetch: again.fetch, log: () => undefined }, pkg)).toBe(target);
    expect(again.calls).toEqual([]);
    expect(chmod.mock.calls.map(([file, mode]) => [file, mode])).toEqual([[expect.stringContaining('.partial'), 0o644], [target, 0o644]]);
  });

  it('refuses a download whose size or SHA-256 is not the manifest\'s, removing the partial file, and replaces a cached file that does not match', async () => {
    for (const body of [Buffer.from('short'), Buffer.from('the package bytez')]) {
      const lines: string[] = [];
      expect(await cachedPackage({ cacheFolder: folder, fetch: fetched(body).fetch, log: (line) => lines.push(line) }, pkg)).toBeUndefined();
      expect(lines).toEqual([`[containers] downloading ${FILE} into the package cache failed: the download of ${FILE} is not the package the manifest names`]);
      expect(fs.readdirSync(folder)).toEqual([]);
    }
    fs.writeFileSync(path.join(folder, FILE), 'the package bytez');
    const replaced = fetched(BYTES);
    expect(await cachedPackage({ cacheFolder: folder, fetch: replaced.fetch, log: () => undefined }, pkg)).toBe(path.join(folder, FILE));
    expect(replaced.calls).toHaveLength(1);
    expect(fs.readFileSync(path.join(folder, FILE))).toEqual(BYTES);
    expect(leftovers()).toEqual([]);
  });

  it('removes the partial file and keeps nothing when the download fails', async () => {
    const lines: string[] = [];
    expect(await cachedPackage({ cacheFolder: folder, fetch: fetched(BYTES, 404).fetch, log: (line) => lines.push(line) }, pkg)).toBeUndefined();
    expect(lines).toEqual([`[containers] downloading ${FILE} into the package cache failed: HTTP 404`]);
    const broken = (async () => new Response(new ReadableStream({ start: (controller) => controller.error(new Error('reset')) }))) as unknown as typeof fetch;
    expect(await cachedPackage({ cacheFolder: folder, fetch: broken, log: (line) => lines.push(line) }, pkg)).toBeUndefined();
    expect(lines.at(-1)).toContain('reset');
    expect(fs.readdirSync(folder)).toEqual([]);
  });
});