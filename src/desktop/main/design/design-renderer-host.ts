// Main's side of the design renderer process (docs/invariants.md "Design mode" D85): started at the first run, answered as
// hostile, and killed when it stops answering, when a page it holds will not close, when the main window closes and at quit.
import type { Disposable } from '../../../platform/disposable';
import { restartDecision, RESTART_LIMIT } from '../../local-services/restart-policy';
import { MAX_SCREENSHOT_BYTES, parseRendererMessage, type MainToRenderer, type PageOp, type RendererToMain } from './design-renderer-protocol';
import type { RunnerPage, RunnerPageEvents } from './design-runner';

/** The started process, as main drives it. */
export interface RendererChild {
  send(message: MainToRenderer): void;
  onMessage(listener: (raw: unknown) => void): Disposable;
  // fires once, after the process ended and its data folder was removed
  onExit(listener: (description: string) => void): Disposable;
  kill(): void;
}

export interface DesignRendererHostDeps {
  readonly start: () => Promise<RendererChild>;
  // the preview's answer to a design scheme request of a live run (serveDesignRequest)
  readonly read: (method: string, url: string) => Promise<Response>;
  readonly log: (line: string) => void;
  readonly pingMs?: number;
  readonly answerMs?: number;
  readonly startMs?: number;
  readonly idleMs?: number;
  // performance.now, for the restart policy
  readonly now?: () => number;
}

// While pages are open, a ping goes out this often, and an unanswered ping or close past ANSWER_MS kills the process; a
// start has longer, since a cold Electron start under an antivirus scan can take seconds.
const PING_MS = 2000;
const ANSWER_MS = 5000;
const START_MS = 20_000;
// a renderer that held no page this long is stopped; the next run starts a new one
const IDLE_MS = 5 * 60 * 1000;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly check: (value: unknown) => unknown;
}

interface Running {
  // set once the start resolved; requests go out only after ready, which follows it
  child: RendererChild | undefined;
  readonly ready: Promise<void>;
  // rejects `ready` once the process ended before it was ready
  readonly notReady: (err: Error) => void;
  readonly pending: Map<number, Pending>;
  readonly pages: Map<number, RunnerPageEvents>;
  readonly subscriptions: Disposable[];
  ping: ReturnType<typeof setInterval> | undefined;
  idle: ReturnType<typeof setTimeout> | undefined;
  ended: boolean;
}

const none = (value: unknown): undefined => {
  if (value !== undefined) throw new Error('The design renderer answered with a value where none was due');
  return undefined;
};
const png = (value: unknown): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_SCREENSHOT_BYTES) throw new Error('The design renderer answered a capture that is not bounded bytes');
  return value;
};
const ANSWERS: Readonly<Record<PageOp, (value: unknown) => unknown>> = {
  load: none,
  resize: none,
  insertCss: none,
  // the runner parses every evaluated answer as hostile (parseMeasure, parseProbeOutput)
  evaluate: (value) => value,
  screenshot: png,
  // the journey parses every CDP answer as hostile (design-journey.ts)
  cdp: (value) => value,
  close: none,
};

export class DesignRendererHost {
  private readonly deps: DesignRendererHostDeps;
  private running: Running | undefined;
  private nextId = 0;
  private nextPage = 0;
  // core's restart policy over the ends main did not ask for; past it, `halted` holds the last end's reason until `reset`
  private failures: readonly number[] = [];
  private halted: string | undefined;

  constructor(deps: DesignRendererHostDeps) {
    this.deps = deps;
  }

  /** Restart Engine: the renderer may start again after it ended too often. */
  reset(): void {
    this.failures = [];
    this.halted = undefined;
  }

  /** A page in the renderer process, started on the first need; the runner sees it as any RunnerPage. */
  openPage(origin: string, width: number, events: RunnerPageEvents): RunnerPage {
    const page = ++this.nextPage;
    let running: Running | undefined;
    const opened = (async () => {
      running = this.ensure();
      await running.ready;
      running.pages.set(page, events);
      this.watch(running);
      await this.request(running, { t: 'open', id: 0, page, origin, width }, none);
      return running;
    })();
    const call = async <T>(op: PageOp, args: readonly unknown[]): Promise<T> => {
      const holder = await opened;
      if (holder.ended) throw new Error('The design renderer ended');
      return this.request(holder, { t: 'page', id: 0, page, op, args }, ANSWERS[op]) as Promise<T>;
    };
    return {
      load: (url) => call('load', [url]),
      resize: (w, h) => call('resize', [w, h]),
      insertCss: (css) => call('insertCss', [css]),
      evaluate: (code) => call('evaluate', [code]),
      screenshot: (w, h, scale, options) => call('screenshot', options === undefined ? [w, h, scale] : [w, h, scale, options]),
      cdp: (method, params) => call('cdp', [method, params]),
      // a page that will not close within ANSWER_MS takes the process with it (a hung print dialog, a busy renderer)
      close: () => {
        opened.then((holder) => {
          if (holder.ended || !holder.pages.delete(page)) return;
          const deadline = setTimeout(() => this.kill(holder, `page ${page} did not close`), this.deps.answerMs ?? ANSWER_MS);
          this.request(holder, { t: 'page', id: 0, page, op: 'close', args: [] }, none).then(
            () => clearTimeout(deadline),
            (err: unknown) => {
              clearTimeout(deadline);
              if (!holder.ended) this.deps.log(`[design] closing a render page failed: ${err instanceof Error ? err.message : String(err)}`);
            },
          );
          this.watch(holder);
        }, () => {
          // the start or the open failed, so the page never opened; the run already failed with that error
          if (running?.ended !== false) return;
          running.pages.delete(page);
          this.watch(running);
        });
      },
    };
  }

  /** Ends the process at once: the main window closed, or the app quits. Its pages' runs fail. */
  stop(reason: string): void {
    if (this.running) this.kill(this.running, reason, true);
  }

  private ensure(): Running {
    if (this.running && !this.running.ended) return this.running;
    if (this.halted !== undefined) throw new Error(`The design renderer ended ${RESTART_LIMIT + 1} times in 5 minutes, so it was not started again (${this.halted}). Restart Engine starts it again.`);
    let readyResolve!: () => void;
    let readyReject!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const running: Running = { child: undefined, ready, notReady: (err) => readyReject(err), pending: new Map(), pages: new Map(), subscriptions: [], ping: undefined, idle: undefined, ended: false };
    this.running = running;
    ready.catch(() => undefined);
    const startDeadline = setTimeout(() => {
      this.kill(running, 'it did not start');
      readyReject(new Error('The design renderer did not start'));
    }, this.deps.startMs ?? START_MS);
    this.deps.start().then((child) => {
      // ended meanwhile (a close, a quit, the start deadline): nothing may outlive it
      if (running.ended) {
        child.kill();
        return;
      }
      running.child = child;
      this.subscribe(running, child, startDeadline, readyResolve, readyReject);
    }, (err: unknown) => {
      clearTimeout(startDeadline);
      const text = `The design renderer could not start: ${err instanceof Error ? err.message : String(err)}`;
      this.ended(running, text);
      readyReject(new Error(text));
    });
    return running;
  }

  private subscribe(running: Running, child: RendererChild, startDeadline: ReturnType<typeof setTimeout>, readyResolve: () => void, readyReject: (err: Error) => void): void {
    running.subscriptions.push(
      child.onMessage((raw) => {
        const message = parseRendererMessage(raw);
        if (!message) {
          this.kill(running, 'it sent a message outside the contract');
          return;
        }
        if (message.t === 'ready') {
          clearTimeout(startDeadline);
          readyResolve();
          return;
        }
        this.handle(running, message);
      }),
      child.onExit((description) => {
        clearTimeout(startDeadline);
        this.ended(running, `The design renderer ended (${description})`);
        readyReject(new Error(`The design renderer ended before it was ready (${description})`));
      }),
    );
  }

  private handle(running: Running, message: Exclude<RendererToMain, { t: 'ready' }>): void {
    switch (message.t) {
      case 'done': {
        const pending = running.pending.get(message.id);
        if (!pending) {
          this.kill(running, 'it answered a request main did not send');
          return;
        }
        running.pending.delete(message.id);
        if (!message.ok) {
          pending.reject(new Error(message.error));
          return;
        }
        try {
          pending.resolve(pending.check(message.value));
        } catch (err) {
          pending.reject(err as Error);
          this.kill(running, (err as Error).message);
        }
        return;
      }
      case 'read':
        void this.answerRead(running, message);
        return;
      case 'console':
        running.pages.get(message.page)?.consoleError(message.text);
        return;
      case 'gone':
        running.pages.get(message.page)?.gone(message.reason);
        return;
    }
  }

  // Every read is answered, a failed one with 500, so no page's request waits for the run's timeout.
  private async answerRead(running: Running, message: Extract<RendererToMain, { t: 'read' }>): Promise<void> {
    let answer: Extract<MainToRenderer, { t: 'read' }>;
    try {
      const response = await this.deps.read(message.method, message.url);
      answer = { t: 'read', id: message.id, status: response.status, headers: [...response.headers], body: new Uint8Array(await response.arrayBuffer()) };
    } catch (err) {
      this.deps.log(`[design] answering a render read failed: ${err instanceof Error ? err.message : String(err)}`);
      answer = { t: 'read', id: message.id, status: 500, headers: [], body: new Uint8Array() };
    }
    if (!running.ended) running.child?.send(answer);
  }

  private request(running: Running, message: MainToRenderer, check: (value: unknown) => unknown): Promise<unknown> {
    if (running.ended) return Promise.reject(new Error('The design renderer ended'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      running.pending.set(id, { resolve, reject, check });
      running.child?.send({ ...message, id } as MainToRenderer);
    });
  }

  // While the process holds pages it must keep answering pings; once it holds none for IDLE_MS it stops.
  private watch(running: Running): void {
    if (running.ended) return;
    if (running.pages.size === 0) {
      clearInterval(running.ping);
      running.ping = undefined;
      running.idle ??= setTimeout(() => this.kill(running, 'it held no page for 5 minutes', true), this.deps.idleMs ?? IDLE_MS);
      return;
    }
    clearTimeout(running.idle);
    running.idle = undefined;
    if (running.ping !== undefined) return;
    let outstanding: number | undefined;
    running.ping = setInterval(() => {
      if (outstanding !== undefined && Date.now() - outstanding > (this.deps.answerMs ?? ANSWER_MS)) {
        this.kill(running, 'it stopped answering');
        return;
      }
      if (outstanding !== undefined) return;
      outstanding = Date.now();
      this.request(running, { t: 'ping', id: 0 }, none).then(() => {
        outstanding = undefined;
      }, () => undefined);
    }, this.deps.pingMs ?? PING_MS);
  }

  // `asked`: main itself ended it (a window close, the quit, idle), which the restart policy does not count.
  private kill(running: Running, reason: string, asked = false): void {
    if (running.ended) return;
    this.deps.log(`[design] ending the design renderer: ${reason}`);
    this.ended(running, `The design renderer was ended: ${reason}`, asked);
    running.child?.kill();
  }

  // Every request fails and every page's run ends; the next run starts a new process unless the restart policy halts it.
  private ended(running: Running, text: string, asked = false): void {
    if (running.ended) return;
    running.ended = true;
    if (!asked) {
      const decision = restartDecision(this.failures, (this.deps.now ?? (() => performance.now()))());
      this.failures = decision.crashes;
      if (!decision.restart) {
        this.halted = text;
        this.deps.log(`[design] the design renderer ended ${RESTART_LIMIT + 1} times in 5 minutes; it starts again only after Restart Engine`);
      }
    }
    clearInterval(running.ping);
    clearTimeout(running.idle);
    for (const subscription of running.subscriptions.splice(0)) subscription.dispose();
    const error = new Error(text);
    running.notReady(error);
    for (const pending of running.pending.values()) pending.reject(error);
    running.pending.clear();
    for (const events of running.pages.values()) events.gone(text);
    running.pages.clear();
    if (this.running === running) this.running = undefined;
  }
}
