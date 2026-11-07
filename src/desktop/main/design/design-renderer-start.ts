// Starts the design renderer process (D85): the app's own executable with DESIGN_RENDERER_SWITCH, on main's thread because
// its IPC channel belongs to the thread that starts it and the launcher has none (docs/perf.md "Starts outside the launcher").
// Main's thread spawn hook (lockThreadSpawns) holds the spawn lock around it.
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import { loggableUrl } from '../security';
import { DESIGN_RENDERER_DATA_PREFIX, DESIGN_RENDERER_DATA_SWITCH, DESIGN_RENDERER_SWITCH, rendererEnvironment } from './design-renderer-protocol';
import type { RendererChild } from './design-renderer-host';

const MAX_LOG_LINE_CHARS = 500;
// a renderer folder carries its main's pid: damocles-design-renderer-<pid>-<random>
const FOLDER_OWNER = /^damocles-design-renderer-(\d+)-[A-Za-z0-9]+$/;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists under another user
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// This main's ended renderers' folders whose removal failed (on Windows a child can hold files a while after TerminateProcess).
const leftFolders = new Set<string>();

// The folders a main that crashed left behind (its renderer's exit never came), and this main's in `left`; a live owner's stay.
export async function removeOrphanFolders(log: (line: string) => void, left: Set<string> = leftFolders): Promise<void> {
  for (const folder of [...left]) {
    await fs.promises.rm(folder, { recursive: true, force: true }).then(() => left.delete(folder), (err: unknown) => {
      log(`[design] removing the design renderer's folder ${folder} failed again: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  const tmp = os.tmpdir();
  for (const name of await fs.promises.readdir(tmp)) {
    const owner = FOLDER_OWNER.exec(name)?.[1];
    if (owner === undefined || Number(owner) === process.pid || alive(Number(owner))) continue;
    await fs.promises.rm(path.join(tmp, name), { recursive: true, force: true }).catch((err: unknown) => {
      log(`[design] removing the left design renderer folder ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

/** Resolves with how `child` ended: its exit, or the error that kept it from starting. */
export function processEnded(child: Pick<ChildProcess, 'once'>): Promise<string> {
  return new Promise<string>((resolve) => {
    let spawned = false;
    child.once('spawn', () => { spawned = true; });
    // after the spawn, an error (a failed kill or send) leaves the process running, and its 'exit' still follows
    child.once('error', (err: Error) => { if (!spawned) resolve(`it could not start: ${err.message}`); });
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => resolve(signal !== null ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`));
  });
}

/** `mainScript`: this bundle's file, which an unpackaged Electron needs as its first argument; a packaged app loads its own. */
export async function startDesignRenderer(mainScript: string, log: (line: string) => void): Promise<RendererChild> {
  await removeOrphanFolders(log);
  const data = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${DESIGN_RENDERER_DATA_PREFIX}${process.pid}-`));
  const args = [...(app.isPackaged ? [] : [mainScript]), DESIGN_RENDERER_SWITCH, `${DESIGN_RENDERER_DATA_SWITCH}${data}`];
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true, env: rendererEnvironment(process.env, process.platform) });
  log(`[design] started the design renderer (pid ${child.pid ?? 'unknown'})`);
  let partial = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    const lines = (partial + chunk).split('\n');
    partial = (lines.pop() ?? '').slice(-MAX_LOG_LINE_CHARS);
    for (const line of lines) if (line.trim() !== '') log(`[design-renderer] ${loggableUrl(line.slice(0, MAX_LOG_LINE_CHARS))}`);
  });
  // a later error (a failed kill, an IPC write past the channel's close) would be uncaught without a listener
  child.on('error', (err) => log(`[design] the design renderer process reported: ${err.message}`));
  const exited = processEnded(child).then(async (description) => {
    // the folder held only Chromium's state of the renderer's in-memory partition
    await fs.promises.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((err: unknown) => {
      leftFolders.add(data);
      log(`[design] removing the design renderer's folder ${data} failed; the next start tries again: ${err instanceof Error ? err.message : String(err)}`);
    });
    return description;
  });
  return {
    send: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (listener) => {
      child.on('message', listener);
      return { dispose: () => { child.off('message', listener); } };
    },
    onExit: (listener) => {
      let disposed = false;
      void exited.then((description) => {
        if (!disposed) listener(description);
      });
      return { dispose: () => { disposed = true; } };
    },
    // SIGKILL: a renderer frozen in a print dialog's modal loop answers no gentler signal
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}
