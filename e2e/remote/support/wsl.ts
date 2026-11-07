import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ElectronApplication } from '@playwright/test';
import { clampLoadAlign } from '../../../scripts/elf-load-align.ts';
import { seedStubModel, type HermeticHome } from '../../desktop/support/hermetic';
import { STUB_MODEL_ID } from '../../desktop/support/openai-stub';
import { control, expect } from './remote';
import { runProgram } from './sshd';

// The WSL suite: the app against this computer's WSL distros through wsl.exe (Windows only, never a Docker fixture).
// scripts/test-remote.ts reads it from Playwright's listing: a spec carrying it builds the Linux and Alpine packages and starts no container.
export const WSL_TAG = '@wsl';

// The distros the suite may use, by role; a name wsl.exe does not list skips that distro's cases with the reason.
export const UBUNTU = process.env['DAMOCLES_E2E_WSL_UBUNTU'] ?? 'Ubuntu-24.04';
export const ALPINE = process.env['DAMOCLES_E2E_WSL_ALPINE'] ?? 'damocles-e2e-alpine';
export const WSL1 = process.env['DAMOCLES_E2E_WSL1'] ?? 'damocles-e2e-wsl1';

const WSL_EXE = `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\wsl.exe`;
const WSL_TIMEOUT_MS = 10 * 60_000;

export interface ListedDistro {
  readonly name: string;
  readonly state: string;
  readonly version: number;
}

/** The distros `wsl.exe --list --verbose` names, read from its UTF-16LE output; none off Windows or without wsl.exe. */
export async function listedDistros(): Promise<ListedDistro[]> {
  if (process.platform !== 'win32') return [];
  const listed = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(WSL_EXE, ['--list', '--verbose'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', reject);
    child.once('close', () => resolve(Buffer.concat(chunks)));
  });
  return listed.toString('utf16le').replaceAll('\0', '').split(/\r?\n/).slice(1).flatMap((row) => {
    const words = row.replace(/^\s*\*?\s*/, '').trim().split(/\s+/);
    return words.length >= 3 ? [{ name: words[0]!, state: words.slice(1, -1).join(' '), version: Number(words.at(-1)) }] : [];
  });
}

/** Why the distro's cases cannot run here, or undefined when wsl.exe lists it. */
export async function missingDistro(distro: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return 'WSL distros run only on a Windows computer';
  return (await listedDistros()).some((listed) => listed.name === distro) ? undefined : `wsl.exe --list does not name ${distro} (set DAMOCLES_E2E_WSL_* to a distro it lists)`;
}

/** The distro's state as `wsl.exe --list --verbose` shows it, which starts no instance. */
export async function distroState(distro: string): Promise<string | undefined> {
  return (await listedDistros()).find((listed) => listed.name === distro)?.state;
}

/** A /bin/sh script in the distro as its default user; rejects with its output when it exits non-zero. */
export async function inDistro(distro: string, script: string, user?: 'root'): Promise<string> {
  const result = await runProgram(WSL_EXE, ['-d', distro, ...(user ? ['-u', user] : []), '--cd', '~', '--exec', '/bin/sh', '-c', script], undefined, WSL_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(`${script} in ${distro} exited with ${result.code}: ${result.stdout}${result.stderr}`);
  return result.stdout;
}

// The argv of every process a server package starts: <install>/<version>-<target>/node/node <same>/dist/<entry>.js
const SERVER_PROCESS = /\/node\/node .*\/dist\/(daemon|core-host|pty-host|formatter-host)\.js\b/;

/** The server package's processes in the distro: the daemon and its bridge, core, the pty and formatter hosts. */
export async function serverProcesses(distro: string): Promise<string[]> {
  const listed = await inDistro(distro, 'for p in /proc/[0-9]*; do tr "\\0" " " < "$p/cmdline" 2>/dev/null; echo; done');
  return listed.split('\n').filter((line) => SERVER_PROCESS.test(line));
}

/** Ends the distro host's daemon with control.shutdownNow and waits until none of its processes is left. */
export async function shutdownDistroDaemon(app: ElectronApplication, hostId: string, distro: string): Promise<void> {
  await control(app, hostId, 'shutdownNow');
  await expect.poll(() => serverProcesses(distro), { timeout: 60_000 }).toEqual([]);
}

/** Ends the daemon in the distro with no app to ask, and waits until none of its processes is left. */
export async function endDistroDaemon(distro: string): Promise<void> {
  await inDistro(distro, 'for p in /proc/[0-9]*; do [ "${p#/proc/}" = "$$" ] && continue; case "$(tr "\\0" " " < "$p/cmdline" 2>/dev/null)" in *"/dist/daemon.js serve"*) kill "${p#/proc/}";; esac; done');
  await expect.poll(() => serverProcesses(distro), { timeout: 60_000 }).toEqual([]);
}

/**
 * Ends the daemon a case started: through the app while it runs, else in the distro. appProcess is read at launch, since
 * Playwright's handle answers nothing once the app has closed.
 */
export async function endCaseDaemon(app: ElectronApplication, appProcess: ChildProcess, hostId: string, distro: string): Promise<void> {
  if (appProcess.exitCode === null && appProcess.signalCode === null) await shutdownDistroDaemon(app, hostId, distro);
  else await endDistroDaemon(distro);
}

/**
 * Ends the distro's instance. A Windows process that read the distro through \\wsl.localhost leaves the 9P redirector's
 * connection behind, which keeps the instance running long after that process exited (over 9 minutes, measured on WSL
 * 3.0.3); only the instance's end drops it.
 */
export async function terminateDistro(distro: string): Promise<void> {
  const result = await runProgram(WSL_EXE, ['--terminate', distro], undefined, WSL_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(`wsl.exe --terminate ${distro} exited with ${result.code}`);
}

/**
 * Writes content to $HOME/<file> in the distro for one case, moving a file already there aside. The returned restore removes the
 * case's file, puts the user's back, and removes the folders the write made while they hold nothing else.
 */
export async function replaceDistroFile(distro: string, file: string, content: string): Promise<() => Promise<void>> {
  const home = (relative: string): string => `"$HOME"/${shQuote(relative)}`;
  const kept = `${file}.damocles-e2e-${process.pid}`;
  const parts = file.split('/').slice(0, -1);
  const folders = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
  const made = (await inDistro(distro, [...folders.map((folder) => `[ -e ${home(folder)} ] || echo ${shQuote(folder)}`), 'true'].join('; '))).split('\n').filter((line) => line !== '');
  await inDistro(distro, [
    `if [ -e ${home(file)} ] || [ -L ${home(file)} ]; then mv ${home(file)} ${home(kept)}; fi`,
    ...(parts.length > 0 ? [`mkdir -p ${home(parts.join('/'))}`] : []),
    `printf '%s' ${shQuote(content)} > ${home(file)}`,
  ].join(' && '));
  return async () => {
    await inDistro(distro, [
      `rm -f ${home(file)}`,
      `if [ -e ${home(kept)} ] || [ -L ${home(kept)} ]; then mv ${home(kept)} ${home(file)}; fi`,
      ...made.reverse().map((folder) => `if [ -d ${home(folder)} ] && [ -z "$(ls -A ${home(folder)})" ]; then rmdir ${home(folder)}; fi`),
    ].join(' && '));
  };
}

/** The distro's home, as its default user's shell names it. */
export async function distroHome(distro: string): Promise<string> {
  return (await inDistro(distro, 'printf %s "$HOME"')).trim();
}

/** Adds Alpine's packages a case needs (the test distros are bare minirootfs images), once per distro and run. */
const installed = new Map<string, Promise<string>>();
export function apkAdd(distro: string, packages: string): Promise<string> {
  const key = `${distro} ${packages}`;
  let done = installed.get(key);
  if (!done) {
    done = inDistro(distro, `apk add --no-cache ${packages}`, 'root');
    installed.set(key, done);
  }
  return done;
}

/**
 * Lets a WSL 1 distro run its own Node, which Alpine builds with a PT_LOAD aligned past 4 KiB that WSL 1's loader refuses:
 * clamps /usr/bin/node with the module the server build clamps the packages' Node with. Resolves the version it reports.
 */
export async function clampDistroNode(distro: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'damocles-wsl1-node-'));
  try {
    const copy = path.join(dir, 'node');
    const shared = (await inDistro(distro, `wslpath -u ${shQuote(copy)}`)).trim();
    await inDistro(distro, `cp /usr/bin/node ${shQuote(shared)}`, 'root');
    await fs.promises.writeFile(copy, clampLoadAlign(await fs.promises.readFile(copy), `${distro} /usr/bin/node`));
    await inDistro(distro, `install -m 0755 ${shQuote(shared)} /usr/bin/node`, 'root');
    return (await inDistro(distro, 'node --version')).trim();
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

export interface DistroModelStub {
  // the streamed requests the distro's agent made, sub-calls (a title) left out
  turns(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * The model stub's provider for a distro's agent, on the distro's own loopback: a WSL 2 distro in NAT mode reaches no server
 * on this computer. This computer holds the key, which the token broker supplies; its own provider entry names an address it
 * never calls and that is no loopback one, so the target's model stays available. Resolves the stub's port and the restore of
 * the distro user's own models.json.
 */
export async function prepareDistroModel(distro: string, home: HermeticHome): Promise<{ readonly port: number; readonly restore: () => Promise<void> }> {
  seedStubModel(home, 'http://damocles-wsl-stub.invalid/v1');
  const port = 20_000 + (process.pid % 10_000);
  const models = { providers: { openai: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', models: [{ id: STUB_MODEL_ID, name: 'Stub model', reasoning: false, input: ['text'], contextWindow: 272000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } };
  return { port, restore: await replaceDistroFile(distro, '.damocles/pi/agent/models.json', JSON.stringify(models)) };
}

/** Runs the stub on `port` with `node` (the distro's, or a given one) from `dir`, which stop removes. */
export async function startDistroModelStub(distro: string, port: number, dir: string, replies: readonly unknown[], node = 'node'): Promise<DistroModelStub> {
  const script = (await inDistro(distro, `wslpath -u ${shQuote(path.join(import.meta.dirname, 'wsl-model-stub.cjs'))}`)).trim();
  await inDistro(distro, [
    `mkdir -p ${shQuote(dir)}`,
    `printf '%s' ${shQuote(JSON.stringify(replies))} > ${shQuote(`${dir}/replies.json`)}`,
    `: > ${shQuote(`${dir}/requests.log`)}`,
  ].join(' && '));
  const ready = `const deadline = Date.now() + 15000; const go = () => require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => (Date.now() > deadline ? process.exit(1) : setTimeout(go, 100))); go();`;
  // the starting session stays until the stub listens, so its setsid has run before wsl.exe ends the session
  await inDistro(distro, `(setsid ${shQuote(node)} ${shQuote(script)} ${port} ${shQuote(`${dir}/replies.json`)} ${shQuote(`${dir}/requests.log`)} </dev/null >/dev/null 2>&1 &) && ${shQuote(node)} -e ${shQuote(ready)}`);
  return {
    turns: async () => (await inDistro(distro, `cat ${shQuote(`${dir}/requests.log`)}`)).split('\n').filter((line) => line.includes('/chat/completions') && !line.endsWith('tools=1')).length,
    stop: async () => {
      await inDistro(distro, `pkill -f '[w]sl-model-stub.cjs'; rm -rf ${shQuote(dir)}; true`);
    },
  };
}

/** A POSIX sh single-quoted literal. */
export const shQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
