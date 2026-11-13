import { describe, expect, it } from 'vitest';
import type { LaunchedProcess, Launcher, ProcessExit } from '../../../../../core/process-launcher';
import type { SpawnSpec } from '../../../../../core/process-launcher/protocol';
import type { WslConversionRun } from '../../../../preload/overlay-channels';
import { convertToWsl2, systemSetVersion, type ConversionDeps } from '../convert-to-wsl2';

// A fake wsl.exe: what the launcher was asked to start, and the UTF-16LE output and exit code it gives back in chunks.
function fakeWsl(output: readonly string[], code: number): { readonly launcher: () => Launcher; readonly started: SpawnSpec[] } {
  const started: SpawnSpec[] = [];
  const launch = (spec: SpawnSpec): LaunchedProcess => {
    started.push(spec);
    const listeners: Array<(chunk: Buffer) => void> = [];
    let finish = (_exit: ProcessExit): void => undefined;
    const exited = new Promise<ProcessExit>((resolve) => {
      finish = resolve;
    });
    queueMicrotask(() => {
      const bytes = Buffer.from(output.join(''), 'utf16le');
      // split mid-character, as a pipe may deliver it
      for (let at = 0; at < bytes.length; at += 3) for (const listener of listeners) listener(bytes.subarray(at, at + 3));
      finish({ code, signal: null } as ProcessExit);
    });
    return {
      pid: Promise.resolve(4242),
      onData: (stream, listener) => {
        if (stream === 'stdout') listeners.push(listener);
      },
      write: async () => undefined,
      end: () => undefined,
      exited,
      closed: exited.then(() => undefined),
      leftRunning: exited.then(() => false),
      kill: () => undefined,
    };
  };
  return { launcher: () => ({ launch, createSessionJob: () => { throw new Error('no jobs'); }, dispose: async () => undefined }), started };
}

const CONVERTED = ['Conversion in progress, this may take a few minutes.\r\n', 'The operation completed successfully.\r\n'];
// wsl.exe's own text when virtualization is off in the firmware
const REFUSED = ['Conversion in progress, this may take a few minutes.\r\n', 'Please enable the Virtual Machine Platform Windows feature and ensure virtualization is enabled in the BIOS.\r\n', 'Error code: Wsl/Service/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED\r\n'];

function deps(output: readonly string[], code: number, overrides: Partial<ConversionDeps> = {}) {
  const order: string[] = [];
  const wsl = fakeWsl(output, code);
  const setVersion = systemSetVersion(wsl.launcher, { SystemRoot: 'C:\\Windows' });
  const made: ConversionDeps = {
    shutDown: async () => void order.push('shut down'),
    setVersion: async (distro, line) => {
      order.push('convert');
      return setVersion(distro, line);
    },
    reconnect: async () => void order.push('reconnect'),
    log: () => undefined,
    ...overrides,
  };
  return { made, order, started: wsl.started };
}

describe('Convert to WSL 2', () => {
  it('shuts the daemon down, converts with wsl.exe, streams its output and reconnects, in that order', async () => {
    const { made, order, started } = deps(CONVERTED, 0);
    const runs: WslConversionRun[] = [];
    const result = await convertToWsl2(made, 'damocles-e2e-wsl1', (run) => runs.push(run));
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['shut down', 'convert', 'reconnect']);
    expect(started.map((spec) => [spec.file, ...spec.args])).toEqual([['C:\\Windows\\System32\\wsl.exe', '--set-version', 'damocles-e2e-wsl1', '2']]);
    expect(runs.at(-1)).toEqual({
      steps: { stopping: 'done', converting: 'done', reconnecting: 'done' },
      output: ['Conversion in progress, this may take a few minutes.', 'The operation completed successfully.'],
    });
    // the timeline saw each line while converting ran
    expect(runs.find((run) => run.output.length === 1)?.steps.converting).toBe('running');
  });

  it('keeps the distro on WSL 1 when wsl.exe fails, shows its message and connects the distro again', async () => {
    const { made, order } = deps(REFUSED, 1);
    const runs: WslConversionRun[] = [];
    const result = await convertToWsl2(made, 'damocles-e2e-wsl1', (run) => runs.push(run));
    expect(result).toEqual({ ok: false, code: 'setVersionFailed', message: REFUSED.map((line) => line.trim()).join('\n') });
    expect(order).toEqual(['shut down', 'convert', 'reconnect']);
    expect(runs.at(-1)?.steps).toEqual({ stopping: 'done', converting: 'failed', reconnecting: 'done' });
  });

  it('fails the conversion, logged, and still connects the distro again when wsl.exe cannot be run', async () => {
    const logs: string[] = [];
    const { made, order } = deps([], 0, {
      setVersion: async () => {
        order.push('convert');
        throw new Error('the launcher worker died');
      },
      log: (line) => logs.push(line),
    });
    const runs: WslConversionRun[] = [];
    const result = await convertToWsl2(made, 'damocles-e2e-wsl1', (run) => runs.push(run));
    expect(result).toEqual({ ok: false, code: 'setVersionFailed', message: '' });
    expect(order).toEqual(['shut down', 'convert', 'reconnect']);
    expect(runs.at(-1)?.steps).toEqual({ stopping: 'done', converting: 'failed', reconnecting: 'done' });
    expect(logs).toContain('[wsl] wsl.exe --set-version damocles-e2e-wsl1 2 did not run: the launcher worker died');
  });

  it('converts nothing when the daemon does not shut down, and reports a reconnect that fails', async () => {
    const stuck = deps(CONVERTED, 0, { shutDown: () => Promise.reject(new Error('the connection closed')) });
    expect(await convertToWsl2(stuck.made, 'damocles-e2e-wsl1', () => undefined)).toEqual({ ok: false, code: 'shutdownFailed' });
    expect(stuck.started).toEqual([]);
    const offline = deps(CONVERTED, 0, { reconnect: () => Promise.reject(new Error('timedOut')) });
    expect(await convertToWsl2(offline.made, 'damocles-e2e-wsl1', () => undefined)).toEqual({ ok: false, code: 'reconnectFailed' });
  });

  it('runs wsl.exe without WSL_UTF8, so its output is the UTF-16LE it is decoded as', async () => {
    const wsl = fakeWsl(CONVERTED, 0);
    const lines: string[] = [];
    await systemSetVersion(wsl.launcher, { SystemRoot: 'C:\\Windows', WSL_UTF8: '1', PATH: 'C:\\bin' })('Ubuntu', (line) => lines.push(line));
    expect(wsl.started[0]?.env).toEqual({ SystemRoot: 'C:\\Windows', PATH: 'C:\\bin' });
    expect(lines).toEqual(['Conversion in progress, this may take a few minutes.', 'The operation completed successfully.']);
  });

  it('starts wsl.exe only for a distro name it can take', async () => {
    const { launcher, started } = fakeWsl([], 0);
    await expect(systemSetVersion(launcher)('-d', () => undefined)).rejects.toThrow(RangeError);
    expect(started).toEqual([]);
  });
});
