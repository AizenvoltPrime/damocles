import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { LaunchedProcess, Launcher, ProcessExit } from '../../../../../core/process-launcher';
import type { SpawnSpec } from '../../../../../core/process-launcher/protocol';
import { SshConnectError } from '../../ssh/ssh-transport';
import type { ServerManifest } from '../../server-manifest-format';
import { startWslTransport, wslStageArgs, type WslTransportOptions } from '../wsl-transport';

const CACHE = 'C:\\Users\\me\\AppData\\Roaming\\Damocles\\server-cache\\3.7.0';
const manifest: ServerManifest = {
  version: '3.7.0',
  packages: { 'linux-x64': { file: 'damocles-server-3.7.0-linux-x64.tar.gz', sha256: 'a'.repeat(64), size: 10, serverVersion: '3.7.0+0123456789ab' } },
} as unknown as ServerManifest;

// wsl.exe as the launcher starts it: what it was given on stdin, stage 1's status lines it answers with, its stderr and kills.
function fakeWsl(answer: (stdin: string, emit: (line: string) => void, exit: (code: number) => void, stderr: (chunk: Buffer) => void) => void): { readonly launcher: () => Launcher; readonly started: SpawnSpec[]; readonly stdin: () => string; readonly kills: () => number } {
  const started: SpawnSpec[] = [];
  let written = '';
  let kills = 0;
  const launch = (spec: SpawnSpec): LaunchedProcess => {
    started.push(spec);
    const listeners: Record<'stdout' | 'stderr', Array<(chunk: Buffer) => void>> = { stdout: [], stderr: [] };
    let finish = (_exit: ProcessExit): void => undefined;
    const exited = new Promise<ProcessExit>((resolve) => {
      finish = resolve;
    });
    const emit = (line: string): void => {
      for (const listener of listeners.stdout) listener(Buffer.from(`${line}\n`));
    };
    const stderr = (chunk: Buffer): void => {
      for (const listener of listeners.stderr) listener(chunk);
    };
    return {
      pid: Promise.resolve(1),
      onData: (stream, listener) => {
        if (stream === 'stdout' || stream === 'stderr') listeners[stream].push(listener);
      },
      write: async (chunk) => {
        written += Buffer.from(chunk).toString('utf8');
        answer(written, emit, (code) => finish({ code, signal: null } as ProcessExit), stderr);
      },
      end: () => undefined,
      exited,
      closed: exited.then(() => undefined),
      leftRunning: exited.then(() => false),
      kill: () => {
        kills++;
        finish({ code: null, signal: 'SIGTERM' } as ProcessExit);
      },
    };
  };
  return { launcher: () => ({ launch, createSessionJob: () => { throw new Error('no jobs'); }, dispose: async () => undefined }), started, stdin: () => written, kills: () => kills };
}

// stage 1 as far as the bridge, asking for no cache
function bridged(): (stdin: string, emit: (line: string) => void) => void {
  let done = false;
  return (stdin, emit) => {
    if (done || !stdin.includes('BEGIN MAIN')) return;
    done = true;
    emit('@@DAMOCLES {"kind":"probe","target":"linux-x64","install":"/root/.damocles/server"}');
    emit('@@DAMOCLES {"kind":"bridge"}');
  };
}

function options(packagePath: () => Promise<string>, overrides: Partial<WslTransportOptions> = {}): WslTransportOptions {
  return {
    distro: 'damocles-e2e-alpine',
    listed: async () => 'listed',
    signal: new AbortController().signal,
    hooks: { step: () => undefined, progress: () => undefined, notice: () => undefined },
    installFolderSettled: async () => undefined,
    manifest,
    releasesUrl: 'https://example.invalid/releases',
    artifacts: { packageFolder: () => CACHE, packagePath },
    log: () => undefined,
    ...overrides,
  };
}

describe('the WSL transport', () => {
  it('runs stage 0 with /bin/sh in the distro, in its home, with no login shell', () => {
    expect(wslStageArgs('Ubuntu-24.04')).toEqual(['-d', 'Ubuntu-24.04', '--cd', '~', '--exec', '/bin/sh', '-c', 'IFS= read -r n; s=$(dd bs=1 count="$n" 2>/dev/null); eval "$s"']);
    expect(() => wslStageArgs('--shutdown')).toThrow(RangeError);
  });

  it('gives stage 1 the cache folder, fills the cache when the stage asks, and answers ready only for that folder', async () => {
    let answered = '';
    const wsl = fakeWsl((stdin, emit) => {
      if (stdin.endsWith('\n# END PARAMETERS') || !stdin.includes('# END PARAMETERS')) return;
      if (answered === '' && stdin.includes('BEGIN MAIN')) {
        answered = 'asked';
        emit('@@DAMOCLES {"kind":"probe","target":"linux-x64","install":"/root/.damocles/server"}');
        emit('@@DAMOCLES {"kind":"cache"}');
        return;
      }
      if (stdin.endsWith('ready\n') && answered === 'asked') {
        answered = 'ready';
        emit('@@DAMOCLES {"kind":"bridge"}');
      }
    });
    const result = await startWslTransport(options(async () => path.win32.join(CACHE, 'damocles-server-3.7.0-linux-x64.tar.gz')), { launcher: wsl.launcher, env: { SystemRoot: 'C:\\Windows' } });
    expect(wsl.started[0]?.file).toBe('C:\\Windows\\System32\\wsl.exe');
    expect(wsl.stdin()).toContain(`D_WSL_CACHE='${CACHE}'\n`);
    expect(answered).toBe('ready');
    expect(result.platform).toEqual({ os: 'linux' });
    expect(result.probe).toEqual({ target: 'linux-x64', installDir: '/root/.damocles/server', notices: [] });
    result.dispose();
  });

  it('gives stage 1 no cache for a cache folder wslpath cannot map, so the stage downloads or uploads instead of failing', async () => {
    const unc = '\\\\fileserver\\profiles\\me\\Damocles\\server-cache\\3.7.0';
    const wsl = fakeWsl((stdin, emit) => {
      if (stdin.includes('BEGIN MAIN')) emit('@@DAMOCLES {"kind":"bridge"}');
    });
    const logs: string[] = [];
    const failure = await startWslTransport(options(async () => '', { artifacts: { packageFolder: () => unc, packagePath: async () => '' }, log: (line) => logs.push(line) }), { launcher: wsl.launcher, env: {} }).catch((err: unknown) => err);
    expect(wsl.stdin()).toContain("D_WSL_CACHE=''\n");
    // the bridge before a probe is the stage's own failure, past the parameters
    expect(failure).toMatchObject({ code: 'bridgeFailed' });
    expect(logs.some((line) => line.includes(unc))).toBe(true);
  });

  it('answers none when the package cannot be cached, so the stage reports its failure', async () => {
    const wsl = fakeWsl((stdin, emit) => {
      if (stdin.includes('BEGIN MAIN') && !stdin.endsWith('none\n') && !stdin.includes('asked')) {
        emit('@@DAMOCLES {"kind":"probe","target":"linux-x64","install":"/root/.damocles/server"}');
        emit('@@DAMOCLES {"kind":"cache"}');
      }
      if (stdin.endsWith('none\n')) emit('@@DAMOCLES {"kind":"fail","code":"downloadAndUploadFailed","params":{}}');
    });
    const failure = await startWslTransport(options(() => Promise.reject(new Error('offline'))), { launcher: wsl.launcher, env: {} }).catch((err: unknown) => err);
    expect(wsl.stdin().endsWith('none\n')).toBe(true);
    expect(failure).toBeInstanceOf(SshConnectError);
    expect((failure as SshConnectError).code).toBe('downloadAndUploadFailed');
  });

  it('starts no wsl.exe for a distro wsl.exe no longer lists, or when the list failed, and says which', async () => {
    const wsl = fakeWsl(() => undefined);
    const gone = await startWslTransport(options(async () => '', { listed: async () => 'notListed' }), { launcher: wsl.launcher, env: {} }).catch((err: unknown) => err);
    expect(gone).toMatchObject({ code: 'distroNotListed', params: { distro: 'damocles-e2e-alpine' } });
    // a list that failed proves nothing either way, so the next attempt asks again
    const unknown = await startWslTransport(options(async () => '', { listed: async () => 'listFailed' }), { launcher: wsl.launcher, env: {} }).catch((err: unknown) => err);
    expect(unknown).toMatchObject({ code: 'unknown', params: { reason: 'wslList' } });
    expect(wsl.started).toEqual([]);
  });

  it('fails as wslExited with wsl.exe\'s exit code, read as the signed number Windows means, when it ends before the bridge', async () => {
    const own = fakeWsl((_stdin, _emit, exit) => exit(4294967295));
    expect(await startWslTransport(options(async () => ''), { launcher: own.launcher, env: {} }).catch((err: unknown) => err)).toMatchObject({ code: 'unknown', params: { reason: 'wslExited', exitCode: -1 } });
    const shell = fakeWsl((_stdin, _emit, exit) => exit(127));
    expect(await startWslTransport(options(async () => ''), { launcher: shell.launcher, env: {} }).catch((err: unknown) => err)).toMatchObject({ code: 'unknown', params: { reason: 'wslExited', exitCode: 127 } });
  });

  it('refuses a distro name wsl.exe could take as an option before listing or starting anything', async () => {
    const wsl = fakeWsl(() => undefined);
    const listed = vi.fn(async () => 'listed' as const);
    const logs: string[] = [];
    await expect(startWslTransport(options(async () => '', { distro: '--shutdown', listed, log: (line) => logs.push(line) }), { launcher: wsl.launcher, env: {} })).rejects.toThrow(RangeError);
    expect(listed).not.toHaveBeenCalled();
    expect(wsl.started).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('starts wsl.exe with WSL_UTF8=1 in place of an inherited one in any case, so its own messages are UTF-8', async () => {
    const wsl = fakeWsl(bridged());
    const result = await startWslTransport(options(async () => ''), { launcher: wsl.launcher, env: { SystemRoot: 'C:\\Windows', wsl_utf8: '0', PATH: 'C:\\bin' } });
    expect(wsl.started[0]?.env).toEqual({ SystemRoot: 'C:\\Windows', PATH: 'C:\\bin', WSL_UTF8: '1' });
    result.dispose();
  });

  it('reads an inbox wsl.exe\'s UTF-16LE message and the distro\'s UTF-8 alike, in the log and the stderr tail', async () => {
    // a localized wsl.exe that ignores WSL_UTF8
    const message = 'Σφάλμα: δεν υπάρχει διανομή με το όνομα που δόθηκε.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n';
    const fromDistro = Buffer.from('sh: αρχείο: not found\n', 'utf8');
    const wsl = fakeWsl((_stdin, _emit, exit, stderr) => {
      // a UTF-8 character split across two chunks
      stderr(fromDistro.subarray(0, 5));
      stderr(fromDistro.subarray(5));
      stderr(Buffer.from(message, 'utf16le'));
      exit(4294967295);
    });
    const logs: string[] = [];
    const failure = await startWslTransport(options(async () => '', { log: (line) => logs.push(line) }), { launcher: wsl.launcher, env: {} }).catch((err: unknown) => err);
    expect(logs).toEqual(expect.arrayContaining(['sh: αρχείο: not found', 'Σφάλμα: δεν υπάρχει διανομή με το όνομα που δόθηκε.', 'Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND']));
    expect((failure as SshConnectError).stderrTail).toBe(`sh: αρχείο: not found\n${message}`);
  });

  it('kills wsl.exe and rejects with cancelled on an abort before or during the stage, and dispose kills it once connected', async () => {
    const before = new AbortController();
    const listing = fakeWsl(() => undefined);
    const abortWhileListing = async (): Promise<'listed'> => {
      before.abort();
      return 'listed';
    };
    await expect(startWslTransport(options(async () => '', { signal: before.signal, listed: abortWhileListing }), { launcher: listing.launcher, env: {} })).rejects.toMatchObject({ code: 'cancelled' });
    expect(listing.started).toEqual([]);

    const during = new AbortController();
    const running = fakeWsl((stdin, emit) => {
      if (!stdin.includes('BEGIN MAIN') || during.signal.aborted) return;
      emit('@@DAMOCLES {"kind":"step","step":"checking"}');
      during.abort();
    });
    await expect(startWslTransport(options(async () => '', { signal: during.signal }), { launcher: running.launcher, env: {} })).rejects.toMatchObject({ code: 'cancelled' });
    expect(running.started).toHaveLength(1);
    expect(running.kills()).toBeGreaterThan(0);

    const connected = fakeWsl(bridged());
    const result = await startWslTransport(options(async () => ''), { launcher: connected.launcher, env: {} });
    expect(connected.kills()).toBe(0);
    result.dispose();
    expect(connected.kills()).toBe(1);
  });
});
