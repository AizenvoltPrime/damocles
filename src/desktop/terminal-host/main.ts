// dist/terminal-host.js: the detached process that owns a server version's terminals, started by that version's daemon with
// `--run-dir=<the daemon's run folder> --node-pty=<the node-pty package>`. It outlives every daemon; a later one finds it
// through its record in the run folder and attaches over its endpoint.
import * as os from 'node:os';
import * as path from 'node:path';
import { createLauncherPool, installProcessLauncher, lockThreadSpawns } from '../../core/process-launcher';
import { closeInheritedFds } from '../daemon/process-starts';
import { readServerVersion } from '../daemon/server-version';
import { runPathsIn, terminalHostLogName, TOUCH_INTERVAL_MS } from '../daemon/token';
import { createDesktopLogSinkFactory } from '../local-services/log-sink';
import { NODE_PTY_ARG_PREFIX } from '../pty-host/protocol';
import { createPtyScreen } from '../pty-host/screen';
import { createTerminalHost } from './host';
import { RUN_DIR_ARG_PREFIX, serveTerminalHost, type ServedTerminalHost } from './records';

const EXIT_START_FAILED = 4;

function argument(prefix: string): string {
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined || !path.isAbsolute(value)) throw new Error(`the terminal host needs ${prefix}<absolute path>`);
  return value;
}

async function start(): Promise<void> {
  // before any pty starts, so no shell inherits them
  closeInheritedFds();
  const paths = runPathsIn(argument(RUN_DIR_ARG_PREFIX));
  const nodePtyPath = argument(NODE_PTY_ARG_PREFIX);
  const logSinks = createDesktopLogSinkFactory(paths.logsDir, false, () => undefined);
  const sink = logSinks.create(terminalHostLogName(process.pid));
  const log = (line: string): void => sink.appendLine(`[${new Date().toISOString()}] ${line}`);
  // set once the endpoint's start began
  const start: { served?: Promise<ServedTerminalHost> } = {};
  let stopping: Promise<never> | undefined;
  // The record goes first, so no daemon tries to adopt a host that is closing, and no endpoint is made after it. A start in
  // flight is awaited: what it made is removed by name, never left without a record.
  const stop = (reason: string, code: number): Promise<never> => {
    stopping ??= (async (): Promise<never> => {
      log(`[terminal-host] exiting (${code}): ${reason}`);
      host.stop();
      const step = async (name: string, run: () => Promise<void>): Promise<void> => {
        await run().catch((err: unknown) => log(`[terminal-host] ${name} failed: ${err instanceof Error ? err.message : String(err)}`));
      };
      const served = await start.served?.catch(() => undefined);
      if (served) await step('removing the record and the endpoint', served.close);
      await step('closing the connections', () => host.close());
      await logSinks.endAsyncWrites();
      process.exit(code);
    })();
    return stopping;
  };
  // a pty's or a screen's failure must never end the user's other shells
  process.on('uncaughtException', (err) => log(`[terminal-host] uncaught exception: ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (reason) => log(`[terminal-host] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`));
  // the bundle is dist/terminal-host.js; its package root holds dist/ and node_modules/
  const root = path.resolve(__dirname, '..');
  // the host's only starts besides its shells: macOS's start identity reads run ps on the launcher (process-identity.ts)
  if (process.platform === 'darwin') {
    lockThreadSpawns();
    installProcessLauncher(createLauncherPool({ workerPath: path.join(root, 'dist', 'process-launcher-worker.js'), sentinelPath: path.join(root, 'dist', 'sentinel.js') }));
  }
  const version = await readServerVersion(root);
  log(`Damocles terminal host ${version} starting (pid ${process.pid})`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the package location is known only at run time
  const nodePty = require(nodePtyPath) as typeof import('node-pty');
  const host = createTerminalHost({
    version,
    spawn: (file, args, options) => nodePty.spawn(file, [...args], { ...options, env: { ...options.env } }),
    // the shell's xterm sets the same windowsPty from main's os.release()
    screen: (options) => createPtyScreen(process.platform === 'win32' ? { ...options, windowsPty: { backend: 'conpty', buildNumber: Number(/^\d+\.\d+\.(\d+)/.exec(os.release())?.[1] ?? 0) } } : options),
    throttleConpty: process.platform === 'win32',
    readProcessName: process.platform !== 'win32',
    exit: (reason) => void stop(reason, 0),
    // a spawn reaches the host only over its endpoint, so the start is set by then
    endpointFolder: async () => {
      if (!start.served) throw new Error('the terminal host is not listening yet');
      return (await start.served).record.socketFolder;
    },
    // a terminal reaches the host only over its endpoint, so the start is set by then
    listed: (terminals) => void start.served?.then((served) => served.list(terminals)),
    log,
  });
  start.served = serveTerminalHost({ paths, version, accept: host.accept, touchIntervalMs: TOUCH_INTERVAL_MS, log });
  setInterval(() => {
    host.touchEndpoints().catch((err: unknown) => log(`[terminal-host] the touch of the terminals' endpoints failed: ${err instanceof Error ? err.message : String(err)}`));
  }, TOUCH_INTERVAL_MS).unref();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => void stop(`it received ${signal}`, 0));
  try {
    await start.served;
    host.serving();
  } catch (err) {
    await stop(`could not start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`, EXIT_START_FAILED);
  }
}

start().catch((err: unknown) => {
  process.stderr.write(`[terminal-host] could not start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(EXIT_START_FAILED);
});
