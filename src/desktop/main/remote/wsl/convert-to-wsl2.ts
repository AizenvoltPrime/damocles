// Convert to WSL 2 (docs/invariants.md "Desktop host", user-run exceptions): after the user confirmed the listed work, the
// distro's daemon shuts down, `wsl.exe --set-version <distro> 2` runs with its output shown as it comes, and the distro
// connects again. A failed conversion, wsl.exe's start included, leaves the distro on WSL 1, connects it again, and shows
// wsl.exe's own message.
import { StringDecoder } from 'node:string_decoder';
import { processLauncher, type Launcher } from '../../../../core/process-launcher';
import { windowsSystemTool } from '../../../../core/system-tools';
import { MAX_WSL_CONVERSION_OUTPUT_LINES, type PasswordlessStepState, type WslConversionRun, type WslConversionStep } from '../../../preload/overlay-channels';
import { isWslDistroName } from './distro-name';
import { wslExeEnvironment } from './wsl-list';

const MAX_LINE_CHARS = 500;
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;

export interface ConversionDeps {
  // control.shutdownNow, settled once the daemon ended its connection; the host stays disconnected afterwards
  readonly shutDown: () => Promise<void>;
  // wsl.exe --set-version <distro> 2; each line of its output as it arrives; resolves its exit code
  readonly setVersion: (distro: string, line: (text: string) => void) => Promise<number | null>;
  // resolves once the distro connected again, rejecting with the attempt's failure
  readonly reconnect: () => Promise<void>;
  readonly log: (line: string) => void;
}

export type ConversionResult = NonNullable<WslConversionRun['result']>;

const pending: PasswordlessStepState = 'pending';
export const INITIAL_CONVERSION: WslConversionRun = { steps: { stopping: pending, converting: pending, reconnecting: pending }, output: [] };

/** The conversion run: each step's state and every output line reach progress as they change. */
export async function convertToWsl2(deps: ConversionDeps, distro: string, progress: (run: WslConversionRun) => void): Promise<ConversionResult> {
  let run = INITIAL_CONVERSION;
  const step = (name: WslConversionStep, state: PasswordlessStepState): void => {
    run = { ...run, steps: { ...run.steps, [name]: state } };
    progress(run);
  };
  step('stopping', 'running');
  try {
    await deps.shutDown();
  } catch (err) {
    deps.log(`[wsl] stopping the daemon of ${distro} for the conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    step('stopping', 'failed');
    return { ok: false, code: 'shutdownFailed' };
  }
  step('stopping', 'done');
  step('converting', 'running');
  let converted = false;
  try {
    const code = await deps.setVersion(distro, (text) => {
      run = { ...run, output: [...run.output, text].slice(-MAX_WSL_CONVERSION_OUTPUT_LINES) };
      progress(run);
    });
    converted = code === 0;
    deps.log(`[wsl] wsl.exe --set-version ${distro} 2 exited with ${String(code)}`);
  } catch (err) {
    deps.log(`[wsl] wsl.exe --set-version ${distro} 2 did not run: ${err instanceof Error ? err.message : String(err)}`);
  }
  step('converting', converted ? 'done' : 'failed');
  // the distro connects again either way: on WSL 2, or still on WSL 1 after a failure
  step('reconnecting', 'running');
  let reconnected = true;
  try {
    await deps.reconnect();
  } catch (err) {
    reconnected = false;
    deps.log(`[wsl] connecting ${distro} after the conversion failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  step('reconnecting', reconnected ? 'done' : 'failed');
  if (!converted) return { ok: false, code: 'setVersionFailed', message: run.output.join('\n') };
  return reconnected ? { ok: true } : { ok: false, code: 'reconnectFailed' };
}

/** wsl.exe --set-version through the launcher: its UTF-16LE output split into lines, control characters dropped. */
export function systemSetVersion(launcher: () => Launcher = processLauncher, env: NodeJS.ProcessEnv = process.env): ConversionDeps['setVersion'] {
  return async (distro, line) => {
    if (!isWslDistroName(distro)) throw new RangeError('Not a WSL distro name');
    const child = launcher().launch({ file: windowsSystemTool('wsl', env), args: ['--set-version', distro, '2'], env: wslExeEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const decoders = { stdout: new StringDecoder('utf16le'), stderr: new StringDecoder('utf16le') };
    const partial = { stdout: '', stderr: '' };
    const take = (stream: 'stdout' | 'stderr', text: string): void => {
      const lines = (partial[stream] + text.replaceAll('\0', '')).split(/\r?\n/);
      partial[stream] = lines.pop()!;
      for (const each of lines) {
        const shown = each.replace(UNSAFE, ' ').trim().slice(0, MAX_LINE_CHARS);
        if (shown !== '') line(shown);
      }
    };
    child.onData('stdout', (chunk) => take('stdout', decoders.stdout.write(chunk)));
    child.onData('stderr', (chunk) => take('stderr', decoders.stderr.write(chunk)));
    const [exit] = await Promise.all([child.exited, child.closed]);
    take('stdout', `${decoders.stdout.end()}\n`);
    take('stderr', `${decoders.stderr.end()}\n`);
    return exit.code;
  };
}
