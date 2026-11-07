// The design renderer process (docs/invariants.md "Design mode" D85): the app's executable started by main with
// DESIGN_RENDERER_SWITCH. It holds core's render windows apart from main, so a page that hangs its browser process (a print
// dialog's modal loop, a busy renderer) costs only this process, which main kills. It has no window of the app, no tray, no
// menu, no single-instance lock, no secret and no core; every design byte comes from main through the IPC channel.
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { app } from 'electron';
import { MAX_CONSOLE_ERRORS } from '../../../shared/design-render';
import { hardenWebContents, loggableUrl } from '../security';
import { DESIGN_RENDERER_DATA_PREFIX, DESIGN_RENDERER_DATA_SWITCH, DESIGN_RENDERER_SWITCH, MAX_TEXT_CHARS, readRequest, type MainToRenderer, type RendererToMain } from './design-renderer-protocol';
import { openOffscreenPage, type RunnerPage } from './design-runner';
import { createDesignSession } from './design-session';

export function isDesignRendererLaunch(argv: readonly string[]): boolean {
  return argv.includes(DESIGN_RENDERER_SWITCH);
}

// A frozen main thread never sees its channel close, so a worker thread ends the process once main has gone.
const PARENT_WATCH = `
const { workerData } = require('node:worker_threads');
setInterval(() => {
  try { process.kill(workerData.parent, 0); } catch { process.kill(process.pid, 'SIGKILL'); }
}, 1000);
`;

/** The send to main; after a disconnect a send emits an error on the process, which no listener takes. */
export function channelSend(channel: Pick<NodeJS.Process, 'send' | 'connected'>): (message: RendererToMain) => void {
  return (message) => {
    if (channel.send && channel.connected) channel.send(message);
  };
}

/** Main's failure handlers are not installed in this process, so without these Electron would show its error dialog. */
export function reportFailures(target: Pick<NodeJS.Process, 'on'>, log: (line: string) => void, exit: (code: number) => void): void {
  target.on('uncaughtException', (err) => {
    log(`[design-renderer] uncaught exception: ${err.stack ?? err.message}`);
    exit(1);
  });
  target.on('unhandledRejection', (reason) => {
    log(`[design-renderer] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
}

/** A page's console errors to main, at most MAX_CONSOLE_ERRORS, all a run keeps, so a page logging in a loop sends no more. */
export function pageConsole(page: number, send: (message: RendererToMain) => void): (text: string) => void {
  let sent = 0;
  return (text) => {
    if (sent >= MAX_CONSOLE_ERRORS) return;
    sent++;
    send({ t: 'console', page, text: text.slice(0, MAX_TEXT_CHARS) });
  };
}

/** Runs this process as the design renderer; main is the parent whose IPC channel it serves. */
export function runDesignRenderer(argv: readonly string[]): void {
  const send = channelSend(process);
  const log = (line: string): void => {
    process.stderr.write(`${line.slice(0, MAX_TEXT_CHARS)}\n`);
  };
  reportFailures(process, log, (code) => app.exit(code));
  const data = argv.find((arg) => arg.startsWith(DESIGN_RENDERER_DATA_SWITCH))?.slice(DESIGN_RENDERER_DATA_SWITCH.length);
  if (!process.send || data === undefined || path.dirname(data) !== path.resolve(os.tmpdir()) || !path.basename(data).startsWith(DESIGN_RENDERER_DATA_PREFIX)) {
    log('[design-renderer] started without its channel or data folder');
    app.exit(1);
    return;
  }
  app.setPath('userData', data);
  app.dock?.hide();
  process.on('disconnect', () => app.exit(0));
  new Worker(PARENT_WATCH, { eval: true, workerData: { parent: process.ppid } }).unref();
  // a render window closing must never end this process; main ends it
  app.on('window-all-closed', () => undefined);
  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents, async (url) => {
      log(`[design-renderer] refused to open ${loggableUrl(url)} outside`);
      return false;
    }, log);
  });

  const reads = new Map<number, (message: Extract<MainToRenderer, { t: 'read' }>) => void>();
  let nextRead = 0;
  // every scheme request goes to main, which serves it as the preview's (serveDesignRequest) for a token of a live run; one
  // main's parser would refuse (a page's over-long URL) is answered here, since main kills a renderer that sends it
  const relay = (request: Request): Promise<Response> => new Promise((resolve) => {
    const id = ++nextRead;
    const read = readRequest(id, request.method, request.url);
    if (!read) {
      resolve(new Response(null, { status: 404 }));
      return;
    }
    reads.set(id, (answer) => resolve(new Response(answer.body as Uint8Array<ArrayBuffer>, { status: answer.status, headers: answer.headers.map(([name, value]): [string, string] => [name, value]) })));
    send(read);
  });
  const pages = new Map<number, RunnerPage>();
  const answer = (id: number, work: () => Promise<unknown>): void => {
    work().then(
      (value) => send({ t: 'done', id, ok: true, value }),
      (err: unknown) => send({ t: 'done', id, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, MAX_TEXT_CHARS) }),
    );
  };
  const pageOf = (page: number): RunnerPage => {
    const found = pages.get(page);
    if (!found) throw new Error('No such page');
    return found;
  };

  void app.whenReady().then(async () => {
    await createDesignSession(relay).ready;
    process.on('message', (raw: MainToRenderer) => {
      switch (raw.t) {
        case 'ping':
          send({ t: 'done', id: raw.id, ok: true, value: undefined });
          return;
        case 'read':
          reads.get(raw.id)?.(raw);
          reads.delete(raw.id);
          return;
        case 'open':
          answer(raw.id, async () => {
            pages.set(raw.page, openOffscreenPage(raw.origin, raw.width, {
              consoleError: pageConsole(raw.page, send),
              gone: (reason) => send({ t: 'gone', page: raw.page, reason: reason.slice(0, MAX_TEXT_CHARS) }),
            }));
          });
          return;
        case 'page':
          answer(raw.id, async () => {
            const page = pageOf(raw.page);
            const [a, b, c] = raw.args as [never, never, never];
            switch (raw.op) {
              case 'load': return page.load(a);
              case 'resize': return page.resize(a, b);
              case 'insertCss': return page.insertCss(a);
              case 'evaluate': return page.evaluate(a);
              case 'screenshot': return page.screenshot(a, b, c);
              case 'cdp': return page.cdp(a, b);
              case 'close':
                pages.delete(raw.page);
                page.close();
                return undefined;
            }
          });
          return;
      }
    });
    send({ t: 'ready' });
  }, (err: unknown) => {
    log(`[design-renderer] could not start: ${err instanceof Error ? err.message : String(err)}`);
    app.exit(1);
  });
}
