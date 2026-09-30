import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable } from 'node:stream';

export type StartupLog = (line: string) => void;

export type GitProbe = { readonly available: true } | { readonly available: false; readonly reason: string };

// A login shell that sources a slow profile (nvm, conda) can take seconds; VS Code allows 10.
const SHELL_ENV_TIMEOUT_MS = 10_000;
const GIT_PROBE_TIMEOUT_MS = 5_000;
// An environment dump is tens of KB; a profile that prints megabytes is broken, not a bigger environment.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
// Set by this probe or describing only the probe's own shell process, never the user's environment.
const DROPPED_KEYS = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'SHLVL', 'PWD', 'OLDPWD', '_'];

/** POSIX single quoting; fish reads `'\''` the same way. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellArgs(shell: string, command: string): string[] {
  // csh and tcsh accept -l only as the sole flag, so they run interactive but not as a login shell.
  return /^t?csh$/.test(path.basename(shell)) ? ['-ic', command] : ['-l', '-i', '-c', command];
}

export type EnvDumpResult = { readonly env: Record<string, string> } | { readonly error: string };

/**
 * Reads the environment the probe prints between two markers from its stdout, settling once: with the environment as soon as
 * the closing marker arrives (a profile's background job may hold stdout open long after), or with an error when stdout
 * passes maxBytes. The stream is decoded as UTF-8 across reads, so a character split between two reads stays whole.
 */
export function collectEnvDump(stdout: Readable, marker: string, maxBytes: number, settle: (result: EnvDumpResult) => void): void {
  let text = '';
  let bytes = 0;
  let settled = false;
  const finish = (result: EnvDumpResult): void => {
    if (settled) return;
    settled = true;
    stdout.removeListener('data', onData);
    settle(result);
  };
  const onData = (chunk: string): void => {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > maxBytes) {
      finish({ error: `printed more than ${maxBytes} bytes` });
      return;
    }
    text += chunk;
    const start = text.indexOf(marker);
    const end = start === -1 ? -1 : text.indexOf(marker, start + marker.length);
    if (end === -1) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start + marker.length, end));
    } catch (err) {
      finish({ error: `printed an environment that does not parse: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      finish({ error: 'printed an environment that is not an object' });
      return;
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') env[key] = value;
    finish({ env });
  };
  stdout.setEncoding('utf8');
  stdout.on('data', onData);
}

function readShellEnv(shell: string, timeoutMs: number): Promise<Record<string, string>> {
  const marker = `__DAMOCLES_ENV_${randomUUID().replace(/-/g, '')}__`;
  // The command names only this binary and a random marker; no environment value enters it.
  const script = `process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(process.env) + ${JSON.stringify(marker)})`;
  const command = `${quote(process.execPath)} -e ${quote(script)}`;
  return new Promise((resolve, reject) => {
    const child = spawn(shell, shellArgs(shell, command), {
      cwd: os.homedir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so an interactive shell's job control never reaches the app's terminal.
      detached: true,
    });
    let stderr = '';
    let settled = false;
    // Settles the promise however the shell ends; a process that left the group can hold the pipes open.
    const abandon = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let killFailure = '';
      if (child.pid !== undefined) {
        try {
          // The whole group: a profile can hang in a grandchild (a prompt, a network call in an init script).
          process.kill(-child.pid, 'SIGKILL');
        } catch (err) {
          // ESRCH: the group is already empty, though a process that left it may still hold the pipes.
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') killFailure = ` (killing its process group failed: ${String(err)})`;
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(`${shell} ${reason}${killFailure}`));
    };
    const timer = setTimeout(() => abandon(`did not print its environment within ${timeoutMs} ms`), timeoutMs);
    collectEnvDump(child.stdout, marker, MAX_STDOUT_BYTES, (result) => {
      if ('error' in result) {
        abandon(result.error);
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The environment is complete; whatever the profile left running keeps its own lifetime, as it would in a terminal.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result.env);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${shell} exited (${code ?? signal}) without printing its environment: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

/**
 * On macOS and Linux, merge the user's login shell environment into `process.env`, as a terminal would
 * give it: an app started from the Dock or a desktop entry inherits a minimal PATH. Runs once, before any
 * child process or network client exists. Windows GUI apps already inherit the user's environment.
 */
export async function mergeLoginShellEnv(log: StartupLog, timeoutMs: number = SHELL_ENV_TIMEOUT_MS): Promise<void> {
  if (process.platform === 'win32') return;
  const shell = process.env['SHELL'] || os.userInfo().shell;
  if (!shell || !path.isAbsolute(shell)) {
    log(`[shell-env] no absolute login shell (SHELL=${shell ?? ''}); keeping the launch environment`);
    return;
  }
  const started = Date.now();
  try {
    const env = await readShellEnv(shell, timeoutMs);
    for (const key of DROPPED_KEYS) delete env[key];
    Object.assign(process.env, env);
    log(`[shell-env] merged ${Object.keys(env).length} variables from ${shell} in ${Date.now() - started} ms`);
  } catch (err) {
    log(`[shell-env] keeping the launch environment: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Whether `git` runs from the resolved PATH; the reason is a localized sentence the user can act on. */
export function probeGit(log: StartupLog, t: (message: string, ...args: string[]) => string): Promise<GitProbe> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: GIT_PROBE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (!err) {
        log(`[git] ${stdout.trim()}`);
        resolve({ available: true });
        return;
      }
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      log(`[git] ${missing ? 'not found on PATH' : `could not run: ${err.message}`}`);
      const reason = missing
        ? t('Git was not found on PATH, so checkpoints and rewind are turned off. Install Git and restart Damocles.')
        : t('Git could not run ({0}), so checkpoints and rewind are turned off.', err.message);
      resolve({ available: false, reason });
    });
  });
}
