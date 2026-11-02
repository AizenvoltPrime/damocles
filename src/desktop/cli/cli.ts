// dist/cli.js: the damocles command on this computer, run under the app's binary as Node by resources/bin/damocles(.cmd). It
// checks the arguments, prints --help and --version itself, and otherwise starts the app detached with the request, which a
// running instance receives through second-instance (docs/invariants.md "The damocles command").
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DAMOCLES_HOME_DIR } from '../../core/paths';
import { readFileSync } from '../../core/resource-fs';
import { launchLanguage, normalizeLanguage, readLanguageSetting } from '../local-services/localization-service';
import { argErrorText, openItem, parseArgs, switchWarningText, usageText } from './args';
import { commandLineLimit, commandLineSwitch, parseCommandLine, waitMarkerFolder, type CliCommandLine } from './cli-protocol';
import { limitText, translator, type Translate } from './cli-text';

// --wait polls the marker once a second, as VS Code's client does
export const WAIT_POLL_MS = 1000;

export interface AppExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

// The app process the command started.
export interface LaunchedApp {
  // undefined while it runs
  exited(): AppExit | undefined;
}

export interface LocalCliIo {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  // the app's binary, which runs this script as Node and is started as the app
  readonly execPath: string;
  // the folder holding dist/cli.js: app.asar.unpacked/dist in a package, the checkout's dist/ in a development build
  readonly distDir: string;
  // the --wait markers' folder, waitMarkerFolder of ~/.damocles
  readonly waitDir: string;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  // starts the app detached and settles once it started or failed to
  readonly launch: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<LaunchedApp>;
  // the marker's text; undefined once it is gone
  readonly readMarker: (file: string) => Promise<string | undefined>;
  readonly isAlive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Where the app's own files are: app.asar beside app.asar.unpacked in a package, else the checkout. */
export function resourceRootOf(distDir: string): string {
  const parent = path.dirname(distDir);
  return path.basename(parent) === 'app.asar.unpacked' ? path.join(path.dirname(parent), 'app.asar') : parent;
}

/** The app's arguments before the request: none in a package, whose binary loads its app.asar; main's bundle in a development build. */
export function appArgsOf(distDir: string): string[] {
  return path.basename(path.dirname(distDir)) === 'app.asar.unpacked' ? [] : [path.join(distDir, 'desktop', 'main.js')];
}

/** A unique wait marker path in waitDir; main writes its pid into it when it takes the request and deletes it once the request's tabs closed. */
export function waitMarkerPath(waitDir: string): string {
  return path.join(waitDir, `damocles-wait-${randomBytes(16).toString('hex')}`);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Runs the command; resolves its exit code. */
export async function runLocalCli(io: LocalCliIo): Promise<number> {
  const root = resourceRootOf(io.distDir);
  const language = launchLanguage(readLanguageSetting(path.join(DAMOCLES_HOME_DIR, 'settings.json'), () => undefined), undefined, normalizeLanguage(Intl.DateTimeFormat().resolvedOptions().locale));
  const t = translator(language, path.join(root, 'l10n'), (file) => readFileSync(file, 'utf8'));
  const parsed = parseArgs(io.argv, 'local');
  switch (parsed.kind) {
    case 'version': {
      const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
      io.out(`${String(manifest.version)}\n`);
      return 0;
    }
    case 'help':
      io.out(`${usageText(t)}\n`);
      return 0;
    case 'error':
      io.err(`${argErrorText(parsed.error, t)}\n`);
      return 1;
    case 'openExternal':
      throw new Error('--open-external is a target terminal\'s option');
  }
  const local = parsed.remote === undefined;
  // a path on this computer resolves against the working folder; a --remote path is the host's and already absolute
  const place = (value: string): string => (local ? path.resolve(io.cwd, value) : value);
  const request: CliCommandLine['request'] = parsed.kind === 'diff'
    ? { kind: 'diff', cwd: io.cwd, left: place(parsed.left), right: place(parsed.right), wait: parsed.wait }
    : { kind: 'open', cwd: io.cwd, items: parsed.paths.map((value) => openItem(place(value))), wait: parsed.wait };
  const waitMarker = parsed.wait ? waitMarkerPath(io.waitDir) : undefined;
  // with no path and no --wait the app only starts or comes forward
  const commandLine: CliCommandLine | undefined = parsed.kind === 'open' && parsed.paths.length === 0 && !parsed.wait && parsed.remote === undefined
    ? undefined
    : { request, ...(parsed.remote !== undefined ? { remote: parsed.remote } : {}), ...(waitMarker !== undefined ? { waitMarker } : {}) };
  // main refuses a request outside the contract with no terminal to say so in, so the command says it first
  if (commandLine !== undefined) {
    const limit = commandLineLimit(commandLine);
    if (limit !== undefined) {
      io.err(`${limitText(limit, t)}\n`);
      return 1;
    }
    parseCommandLine([commandLineSwitch(commandLine)]);
  }
  const switches = parsed.kind === 'open' ? (parsed.switches ?? []) : [];
  for (const option of switches) io.err(`${switchWarningText(option, t)}\n`);
  if (waitMarker !== undefined) {
    try {
      await fs.mkdir(io.waitDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(waitMarker, '', { flag: 'wx' });
    } catch (err) {
      io.err(`${t('damocles: the --wait marker {0} could not be created: {1}', waitMarker, errorText(err))}\n`);
      return 1;
    }
  }
  const env = { ...io.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  const args = [
    ...appArgsOf(io.distDir),
    ...(parsed.userDataDir !== undefined ? [`--user-data-dir=${path.resolve(io.cwd, parsed.userDataDir)}`] : []),
    ...switches,
    ...(commandLine ? [commandLineSwitch(commandLine)] : []),
  ];
  let started: LaunchedApp;
  try {
    started = await io.launch(io.execPath, args, env);
  } catch (err) {
    if (waitMarker !== undefined) await fs.rm(waitMarker, { force: true });
    io.err(`${t('damocles: Damocles could not start: {0}', errorText(err))}\n`);
    return 1;
  }
  return waitMarker === undefined ? 0 : waitUntilDeleted(io, waitMarker, started, t);
}

// Polls until main deletes the marker, ending with an error once the app that took it, or the app started before any took it,
// is gone.
async function waitUntilDeleted(io: LocalCliIo, marker: string, started: LaunchedApp, t: Translate): Promise<number> {
  for (;;) {
    let text: string | undefined;
    try {
      text = await io.readMarker(marker);
    } catch (err) {
      io.err(`${t('damocles: the --wait marker {0} could not be read: {1}', marker, errorText(err))}\n`);
      return 1;
    }
    if (text === undefined) return 0;
    const failure = lostApp(io, text, started, t);
    if (failure !== undefined) {
      await fs.rm(marker, { force: true });
      io.err(`${failure}\n`);
      return 1;
    }
    await io.sleep(WAIT_POLL_MS);
  }
}

function lostApp(io: LocalCliIo, marker: string, started: LaunchedApp, t: Translate): string | undefined {
  const claimedBy = /^[1-9]\d*$/.test(marker) ? Number(marker) : undefined;
  if (claimedBy !== undefined) return io.isAlive(claimedBy) ? undefined : t('damocles: Damocles ended before the tabs were closed.');
  // a second instance exits 0 once it handed the request to the running one, which claims the marker next
  const exit = started.exited();
  return exit !== undefined && (exit.code !== 0 || exit.signal !== null) ? t('damocles: Damocles exited before it took the request.') : undefined;
}

if (require.main === module) {
  void runLocalCli({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    execPath: process.execPath,
    distDir: __dirname,
    waitDir: waitMarkerFolder(DAMOCLES_HOME_DIR),
    out: (value) => process.stdout.write(value),
    err: (value) => process.stderr.write(value),
    launch: (file, args, env) => new Promise((resolve, reject) => {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', env });
      let exit: AppExit | undefined;
      child.once('exit', (code, signal) => {
        exit = { code, signal };
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve({ exited: () => exit });
      });
    }),
    readMarker: async (file) => {
      try {
        return await fs.readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // EPERM: the process runs under another user
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }).then((code) => {
    process.exitCode = code;
  }, (err: unknown) => {
    process.stderr.write(`damocles: ${errorText(err)}\n`);
    process.exitCode = 1;
  });
}
