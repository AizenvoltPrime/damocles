import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { GitVersion } from '../../core/scm/git-runner';
import { parseGitVersion } from '../../core/scm/git-version';
import { resolveGitExecutable } from '../../core/git-executable';
import { runProcess, type Launcher } from '../../core/process-launcher';

export type StartupLog = (line: string) => void;

export type GitProbe = { readonly available: true; readonly path: string; readonly version: GitVersion } | { readonly available: false; readonly reason: string };

// A login shell that sources a slow profile (nvm, conda) can take seconds; VS Code allows 10.
export const SHELL_ENV_TIMEOUT_MS = 10_000;
const GIT_PROBE_TIMEOUT_MS = 5_000;
// An environment dump is tens of KB; a profile that prints megabytes is broken, not a bigger environment.
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const OUTPUT_IDLE_AFTER_EXIT_MS = 1_000;
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
 * Reads the environment the probe prints between two markers from the stdout chunks it is fed, settling once: with the
 * environment as soon as the closing marker arrives (a profile's background job may hold stdout open long after), or with an
 * error when stdout passes maxBytes. The output is decoded as UTF-8 across chunks, so a character split between two stays whole.
 */
export function collectEnvDump(marker: string, maxBytes: number, settle: (result: EnvDumpResult) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder('utf8');
  let text = '';
  let bytes = 0;
  let settled = false;
  const finish = (result: EnvDumpResult): void => {
    settled = true;
    settle(result);
  };
  return (chunk) => {
    if (settled) return;
    bytes += chunk.length;
    if (bytes > maxBytes) {
      finish({ error: `printed more than ${maxBytes} bytes` });
      return;
    }
    text += decoder.write(chunk);
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
}

function readShellEnv(launcher: Launcher, shell: string, timeoutMs: number): Promise<Record<string, string>> {
  const marker = `__DAMOCLES_ENV_${randomUUID().replace(/-/g, '')}__`;
  // The command names only this binary and a random marker; no environment value enters it.
  const script = `process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(process.env) + ${JSON.stringify(marker)})`;
  const command = `${quote(process.execPath)} -e ${quote(script)}`;
  return new Promise((resolve, reject) => {
    const child = launcher.launch({
      file: shell,
      args: shellArgs(shell, command),
      cwd: os.homedir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so an interactive shell's job control never reaches the app's terminal.
      detached: true,
      // A process the profile left running may hold the output open; once the shell is gone, a silent output is let go.
      exitOutputIdleMs: OUTPUT_IDLE_AFTER_EXIT_MS,
    });
    let stderr = '';
    let settled = false;
    // Settles the promise however the shell ends; a process that left the group can hold the pipes open.
    const abandon = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The whole group: a profile can hang in a grandchild (a prompt, a network call in an init script).
      child.kill({ tree: true });
      reject(new Error(`${shell} ${reason}`));
    };
    const timer = setTimeout(() => abandon(`did not print its environment within ${timeoutMs} ms`), timeoutMs);
    child.onData('stdout', collectEnvDump(marker, MAX_STDOUT_BYTES, (result) => {
      if ('error' in result) {
        abandon(result.error);
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The environment is complete; whatever the profile left running keeps its own lifetime, as it would in a terminal.
      resolve(result.env);
    }));
    const decoder = new StringDecoder('utf8');
    child.onData('stderr', (chunk) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += decoder.write(chunk).slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    Promise.all([child.exited, child.closed]).then(([{ code, signal }]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${shell} exited (${code ?? signal}) without printing its environment: ${stderr.trim().slice(0, 500)}`));
    }, (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * On macOS and Linux, merge the user's login shell environment into `process.env`, as a terminal would
 * give it: an app started from the Dock or a desktop entry inherits a minimal PATH. Runs once, before any
 * other child process or network client exists. Windows GUI apps already inherit the user's environment.
 */
export async function mergeLoginShellEnv(launcher: Launcher, log: StartupLog, timeoutMs: number = SHELL_ENV_TIMEOUT_MS): Promise<void> {
  if (process.platform === 'win32') return;
  const shell = process.env['SHELL'] || os.userInfo().shell;
  if (!shell || !path.isAbsolute(shell)) {
    log(`[shell-env] no absolute login shell (SHELL=${shell ?? ''}); keeping the launch environment`);
    return;
  }
  const started = Date.now();
  try {
    const env = await readShellEnv(launcher, shell, timeoutMs);
    for (const key of DROPPED_KEYS) delete env[key];
    Object.assign(process.env, env);
    log(`[shell-env] merged ${Object.keys(env).length} variables from ${shell} in ${Date.now() - started} ms`);
  } catch (err) {
    log(`[shell-env] keeping the launch environment: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The git `resolveGitExecutable` finds on the resolved PATH, with its version: source control spawns that absolute path,
 * never a bare name, whose relative PATH entries would resolve against the repository folder. The reason is a localized
 * sentence the user can act on.
 */
export async function probeGit(log: StartupLog, t: (message: string, ...args: string[]) => string, timeoutMs: number = GIT_PROBE_TIMEOUT_MS): Promise<GitProbe> {
  const gitPath = resolveGitExecutable();
  if (gitPath === undefined) {
    log('[git] not found on PATH');
    return { available: false, reason: t('Git was not found on PATH, so source control, checkpoints and rewind are turned off. Install Git and restart Damocles.') };
  }
  let stdout = '';
  let failure: string | undefined;
  try {
    // Startup waits on it before the window exists; a timeout kills the tree and settles at once, though a git.exe wrapper's
    // child still holds the output.
    const { exit, stdout: output } = await runProcess({ file: gitPath, args: ['--version'], windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }, { timeoutMs });
    stdout = output.toString('utf8');
    if (exit === null) failure = `no answer within ${timeoutMs} ms`;
    else if (exit.code !== 0) failure = `exit code ${exit.code ?? 'none'}`;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  const version = failure === undefined ? parseGitVersion(stdout) : undefined;
  if (version) {
    log(`[git] ${stdout.trim()} at ${gitPath}`);
    return { available: true, path: gitPath, version };
  }
  const message = failure ?? `unreadable version ${JSON.stringify(stdout.trim().slice(0, 100))}`;
  log(`[git] could not run: ${message}`);
  return { available: false, reason: t('Git could not run ({0}), so source control, checkpoints and rewind are turned off.', message) };
}

