// The theme validator's launcher, which cli.ts runs: it starts host.js under the Electron this checkout pins, so the store
// decodes a file as the app does, and answers the exit code. Exit 0 accepted, 1 refused, 2 a usage or internal error.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** What the launcher touches outside itself; a test replaces them. */
export interface LauncherDeps {
  // the checkout's Electron binary; throws when it is not installed
  binary(): string;
  // the host's own folder, removed when it ends
  makeWork(): string;
  removeWork(dir: string): void;
  // the host: its exit code or the signal that ended it, and everything it printed on stdout
  runHost(binary: string, args: readonly string[]): Promise<{ readonly code: number | null; readonly signal: string | null; readonly stdout: string }>;
  out(text: string): void;
  err(text: string): void;
}

// The binary electron's index.js names (dist/<path.txt>), read without requiring it: that downloads a missing binary and says
// so on stdout, which carries only the verdict.
function electronBinary(): string {
  const dir = path.dirname(require.resolve('electron/package.json'));
  const pathFile = path.join(dir, 'path.txt');
  const binary = existsSync(pathFile) ? path.join(dir, 'dist', readFileSync(pathFile, 'utf8').trim()) : undefined;
  if (binary === undefined || binary === path.join(dir, 'dist') || !existsSync(binary)) throw new Error('Electron is not installed in this checkout; run `npx install-electron` first');
  return binary;
}

function runHost(binary: string, args: readonly string[]): Promise<{ readonly code: number | null; readonly signal: string | null; readonly stdout: string }> {
  const env = { ...process.env };
  delete env['ELECTRON_RUN_AS_NODE'];
  const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'inherit'], env, windowsHide: true });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(chunks).toString('utf8') }));
  });
}

const realDeps = (host: string): LauncherDeps & { readonly host: string } => ({
  host,
  binary: electronBinary,
  makeWork: () => mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-validate-')),
  removeWork: (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
  runHost,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});

/**
 * The launcher's exit code for a host that ended with `code` having printed `stdout`: 0 or 1 only when what it printed is a
 * verdict that says the same, since Electron itself can exit 1 without ever running the host. Anything else is 2.
 */
export function exitCodeOf(code: number | null, stdout: string): 0 | 1 | 2 {
  if (code !== 0 && code !== 1) return 2;
  try {
    const verdict: unknown = JSON.parse(stdout);
    return typeof verdict === 'object' && verdict !== null && (verdict as { ok?: unknown }).ok === (code === 0) ? code : 2;
  } catch {
    return 2;
  }
}

/** Runs the host on `argv` and answers the exit code; a failure of the launcher itself is told on stderr and is 2. Never rejects. */
export async function launch(argv: readonly string[], host: string, deps: LauncherDeps = realDeps(host)): Promise<0 | 1 | 2> {
  let work: string | undefined;
  try {
    const binary = deps.binary();
    work = deps.makeWork();
    const { code, signal, stdout } = await deps.runHost(binary, [host, ...argv, '--work', work]);
    if (signal !== null) deps.err(`theme-validate: Electron ended on ${signal}\n`);
    const exit = exitCodeOf(code, stdout);
    // stdout carries a verdict or nothing: what an unconfirmed run printed goes to stderr
    if (exit !== 2) deps.out(stdout);
    else if (code === 0 || code === 1) deps.err(`theme-validate: Electron exited ${code} without printing a verdict that says so\n${stdout}`);
    return exit;
  } catch (err) {
    deps.err(`theme-validate failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    return 2;
  } finally {
    if (work !== undefined) {
      try {
        deps.removeWork(work);
      } catch (err) {
        deps.err(`theme-validate: could not remove ${work}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
}
