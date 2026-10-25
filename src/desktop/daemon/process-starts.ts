// The daemon's starts outside the process launcher (docs/perf.md "Starts outside the launcher"): its forked children, whose
// IPC channel belongs to the thread that forked, and the bridge's detached daemon start. Each runs under the spawn lock.
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, readdirSync, readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { withSpawnLock } from '../../core/process-launcher';
import { windowsPowerShell } from '../../core/system-tools';

// characters of a child's stderr kept for the exit report
const MAX_STDERR_CHARS = 4000;
// how long an exited child's stderr may still deliver its tail
const STDERR_TAIL_MS = 200;
const WMI_TIMEOUT_MS = 30_000;
// the fd numbers a detached daemon got from its starter by mistake, comma-separated
const INHERITED_FDS_ENV = 'DAMOCLES_INHERITED_FDS';
// O_CLOEXEC in the octal flags of /proc/<pid>/fdinfo
const O_CLOEXEC = 0o2000000;

// Linux: this process's fds above stdio that survive an exec. Electron main's Chromium fds lack FD_CLOEXEC and libuv closes
// nothing above a child's stdio, so the bridge holds them; macOS libuv spawns with POSIX_SPAWN_CLOEXEC_DEFAULT.
function inheritableFds(): number[] {
  if (process.platform !== 'linux') return [];
  const fds: number[] = [];
  // eslint-disable-next-line damocles/no-sync -- the bridge's one daemon start reads its fds under the spawn lock, right before the spawn
  for (const name of readdirSync('/proc/self/fd')) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd < 3) continue;
    try {
      // eslint-disable-next-line damocles/no-sync -- part of the same read before the bridge's one daemon start
      const flags = /^flags:\s*([0-7]+)$/m.exec(readFileSync(`/proc/self/fdinfo/${name}`, 'utf8'))?.[1];
      if (flags !== undefined && (parseInt(flags, 8) & O_CLOEXEC) === 0) fds.push(fd);
    } catch {
      // closed since the listing, the listing's own fd among them
    }
  }
  return fds;
}

/**
 * The detached daemon's first step: closes the fds its starter named. Every child of the daemon would hold them too, so
 * Electron main's sockets (its DevTools connection among them) would never close for their peers after the app quits.
 */
export function closeInheritedFds(): void {
  const named = process.env[INHERITED_FDS_ENV];
  delete process.env[INHERITED_FDS_ENV];
  // An inherited fd holds its number from the exec on, so nothing this process opened can have one of these numbers.
  for (const fd of (named ?? '').split(',').filter((text) => text !== '').map(Number)) {
    if (!Number.isInteger(fd) || fd < 3) continue;
    try {
      // eslint-disable-next-line damocles/no-sync -- the daemon's first step, before it serves anything
      closeSync(fd);
    } catch {
      // not open
    }
  }
}

export interface ForkedChild {
  // undefined when the fork failed to spawn
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  // code: the exit code, or 1 for a signal; error: the tail of its stderr
  onExit(listener: (exit: { readonly code: number; readonly signal: string | null; readonly error: string | null }) => void): void;
  kill(): void;
}

/** Forks a Node child of the daemon's main thread with advanced serialization, so a Uint8Array crosses whole. */
export function forkChild(entry: string, args: readonly string[], env: Readonly<Record<string, string>>, cwd?: string): ForkedChild {
  const child: ChildProcess = withSpawnLock(() => fork(entry, [...args], {
    env: { ...env },
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    ...(cwd !== undefined ? { cwd } : {}),
  }));
  const decoder = new StringDecoder('utf8');
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + decoder.write(chunk)).slice(-MAX_STDERR_CHARS);
  });
  let spawnError: string | null = null;
  child.on('error', (err) => {
    spawnError = err.message;
  });
  type Exit = Parameters<Parameters<ForkedChild['onExit']>[0]>[0];
  const exited = new Promise<Exit>((resolve) => {
    const report = (code: number | null, signal: NodeJS.Signals | null): void => {
      const text = stderr.trim();
      resolve({ code: code ?? 1, signal, error: spawnError ?? (text === '' ? null : text) });
    };
    // 'close' waits for every holder of the stderr pipe, a grandchild that outlived the child included
    child.once('exit', (code, signal) => {
      const timer = setTimeout(() => report(code, signal), STDERR_TAIL_MS);
      child.stderr?.once('close', () => {
        clearTimeout(timer);
        report(code, signal);
      });
    });
    // a start that failed may report no exit
    child.once('close', report);
  });
  return {
    pid: child.pid,
    postMessage: (message) => {
      if (child.connected) child.send(message as never);
    },
    onMessage: (listener) => {
      child.on('message', listener);
    },
    onExit: (listener) => {
      void exited.then(listener);
    },
    kill: () => {
      child.kill();
    },
  };
}

// One argument as CommandLineToArgvW reads it back.
function windowsArgument(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// The data arrives as JSON on stdin; no path or environment value is ever part of the script.
const WMI_CREATE = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$request = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = [string[]]$request.environment; ShowWindow = [uint16]0 }',
  '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = [string]$request.commandLine; CurrentDirectory = [string]$request.cwd; ProcessStartupInformation = $startup }',
  '[Console]::Out.Write("$($result.ReturnValue) $($result.ProcessId)")',
].join('; ');

/**
 * Starts the daemon outside the caller's session: detached (setsid) on POSIX; through WMI on Windows, whose
 * Win32_Process.Create runs it outside the caller's job object with env in Win32_ProcessStartup.EnvironmentVariables.
 * Resolves once the start was handed to the OS.
 */
export function startDaemonDetached(file: string, args: readonly string[], env: Readonly<Record<string, string>>, cwd: string): Promise<void> {
  if (process.platform !== 'win32') {
    const child = withSpawnLock(() => spawn(file, [...args], { detached: true, stdio: 'ignore', env: { ...env, [INHERITED_FDS_ENV]: inheritableFds().join(',') }, cwd }));
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
  const request = JSON.stringify({
    commandLine: [file, ...args].map(windowsArgument).join(' '),
    cwd,
    environment: Object.entries(env).map(([key, value]) => `${key}=${value}`),
  });
  const shell = withSpawnLock(() => spawn(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WMI_CREATE], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    shell.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    shell.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS); });
    const timer = setTimeout(() => {
      shell.kill();
      reject(new Error(`the WMI start did not finish within ${WMI_TIMEOUT_MS} ms`));
    }, WMI_TIMEOUT_MS);
    shell.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    shell.once('close', (code) => {
      clearTimeout(timer);
      const [returnValue, pid] = stdout.trim().split(' ');
      if (code === 0 && returnValue === '0' && Number(pid) > 0) resolve();
      else reject(new Error(`Win32_Process.Create failed (exit ${String(code)}, ReturnValue ${returnValue ?? 'none'}): ${stderr.trim()}`));
    });
    shell.stdin.end(request);
  });
}
