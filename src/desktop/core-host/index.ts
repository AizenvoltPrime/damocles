// Damocles Core's entry (dist/core-host.js): desktop main forks it as the "Damocles Core" utility process and talks to it over
// process.parentPort, the one ordered channel (docs/invariants.md "Desktop host"). Main's first message is the init.
import * as path from 'node:path';
import { installLogSink, log } from '../../core/logger';
import { installPlatform } from '../../core/platform-host';
import { setEndedLeaseHolders } from '../../core/pi-session/session-store/session-lease';
import { createLauncherPool, installProcessLauncher, lockThreadSpawns } from '../../core/process-launcher';
import { heldRepoLocksReleased } from '../../core/pi-session/checkpoints';
import { tempFoldersSettled } from '../../core/worktrees/create';
import type { Disposable } from '../../platform/disposable';
import { INVALID, parseCoreInit, type CoreProtocolError } from '../core-protocol';
import { createDesktopLogSinkFactory } from '../local-services/log-sink';
import { logUncaughtErrors } from '../local-services/process-errors';
import { processProfiler, StallMonitor } from '../local-services/stall-monitor';
import { startCoreService } from './core-service';
import { createCoreLocal, type CoreLocal } from './local';
import { installCaCertificates } from './network/ca-certificates';
import { httpIdleTimeoutMs, installProxyDispatcher } from './network/proxy-dispatcher';
import { createParentPortTransport, type ParentPort } from './parent-port';
import { createCorePlatform, type CorePlatform } from './platform';
import { startCoreScm } from './scm';
import { createFinishHolds, startCoreWorktrees } from './worktrees';

// Exit codes main reads as how core ended (core-process.ts); any exit main did not ask for takes the crash path.
const EXIT_NO_PARENT_PORT = 2;
const EXIT_PROTOCOL_VIOLATION = 3;
const EXIT_START_FAILED = 4;

// Core's own failure is told on stderr, whose tail main logs: its log may not exist yet, and a violation never reaches it.
function exit(code: number, message: string): never {
  process.stderr.write(`[core] ${message}\n`);
  process.exit(code);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.stack ?? err.message : String(err);
}

// A message outside the contract ends core at once; main sees the exit and takes the crash path.
function onViolation(error: CoreProtocolError): never {
  exit(EXIT_PROTOCOL_VIOLATION, error.message);
}

async function start(port: ParentPort): Promise<void> {
  const transport = createParentPortTransport(port);
  const init = parseCoreInit(await transport.init);
  if (init === INVALID) exit(EXIT_PROTOCOL_VIOLATION, 'Core protocol violation: init');
  // the channel a log tab is asked for on, once it exists
  const channel: { endpoint?: CorePlatform['endpoint'] } = {};
  const logSinks = createDesktopLogSinkFactory(init.logs.dir, init.logs.echo, (filePath, preserveFocus) => {
    channel.endpoint?.request('logs.show', { name: path.basename(filePath, '.log'), preserveFocus }).catch((err: unknown) => log(`[core] showing ${filePath} failed: ${errorText(err)}`));
  });
  const logSink = logSinks.create('Damocles Core');
  installLogSink(logSink);
  logUncaughtErrors(process, 'core', (line) => log(line));
  log(`Damocles Core starting (pid ${process.pid}, version ${init.appInfo.version})`);
  const owned: Disposable[] = [];
  let stalls: StallMonitor | undefined;
  try {
    stalls = new StallMonitor({ process: 'core', dir: path.join(init.logs.dir, 'stalls', 'core'), log: (line) => log(line), startProfile: processProfiler(process.platform) });
  } catch (err) {
    log(`[stall] the core process stall monitor could not start: ${err instanceof Error ? err.message : String(err)}`);
  }
  setEndedLeaseHolders(init.endedCores);
  // Before the first process start; core's environment is main's after main merged the login shell's.
  lockThreadSpawns();
  installProcessLauncher(createLauncherPool({ workerPath: init.paths.workers.processLauncher, sentinelPath: init.paths.workers.sentinel }));
  // Before any TLS connection opens.
  await installCaCertificates((line) => log(line));
  const idleTimeoutMs = await httpIdleTimeoutMs((line) => log(line));

  let local: CoreLocal | undefined;
  const platform = createCorePlatform(transport, init, (shared) => (local = createCoreLocal(shared, logSinks, (line) => log(line))), onViolation);
  const { endpoint } = platform;
  channel.endpoint = endpoint;
  const coreLocal = local!;
  if (stalls) {
    const monitor = stalls;
    owned.push(monitor, endpoint.onEvent('power.suspend', () => monitor.suspend()), endpoint.onEvent('power.resume', () => monitor.resume()));
  }
  owned.push(installProxyDispatcher({ resolveProxy: (url) => platform.resolveProxy(url), onResume: (listener) => endpoint.onEvent('power.resume', listener) }, idleTimeoutMs, (line) => log(line)));
  installPlatform(platform);
  // Source control's Git log (D36); every git call of the app runs here, so this process is its one writer.
  const gitLog = logSinks.create('Git');
  const scm = startCoreScm(platform, gitLog, (line) => log(line));
  const finishHolds = createFinishHolds();
  const worktrees = startCoreWorktrees(platform, scm, finishHolds, (line) => log(line));
  platform.setWorktrees(worktrees.services);

  startCoreService(platform, {
    finishHolds,
    chatFolders: coreLocal.chatFolders,
    setPlatform: (next) => coreLocal.setPlatform(next),
    // core's dispose interrupts no worktree git work (git apply must finish), so the shutdown waits for its temp folders
    teardown: async () => {
      worktrees.dispose();
      scm.dispose();
      await Promise.all([scm.close(), tempFoldersSettled(), heldRepoLocksReleased(), coreLocal.settings.flush(), coreLocal.fileWatchers.close()]);
      for (const disposable of owned.reverse()) disposable.dispose();
      coreLocal.dispose();
    },
    // main kills core once core.shutdown answers, so a line logged after this is written before its log call returns
    flushLogs: () => logSinks.endAsyncWrites(),
  });
  // Every request main sent meanwhile is answered from here on, by the services just registered.
  transport.open();
}

const parentPort = (process as NodeJS.Process & { readonly parentPort?: ParentPort }).parentPort;
if (!parentPort) exit(EXIT_NO_PARENT_PORT, 'Damocles Core runs only as a utility process of desktop main');
start(parentPort).catch((err: unknown) => exit(EXIT_START_FAILED, `Damocles Core could not start: ${errorText(err)}`));
