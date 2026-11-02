import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { hermeticEnv, REPO_ROOT, type HermeticHome } from './hermetic';

// The development build's Electron, which runs dist/cli.js as Node as resources/bin/damocles runs the installed app's binary.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ELECTRON = require('electron') as unknown as string;
export const CLI_SCRIPT = path.join(REPO_ROOT, 'dist', 'cli.js');

export interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the damocles command on this computer against the test's own app: its --user-data-dir is the hermetic one, so the
 * single-instance lock it reaches is the test app's, and the binary it starts is this checkout's Electron, never an installed
 * Damocles.
 */
export function runLocalCli(home: HermeticHome, args: readonly string[], cwd: string = home.root): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON, [CLI_SCRIPT, '--user-data-dir', home.userData, ...args], { cwd, env: { ...hermeticEnv(home), ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The binary the command starts as the app, which must be this checkout's and never an installed app's. */
export const cliAppBinary = (): string => ELECTRON;
