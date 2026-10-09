import type { Disposable } from '../../../platform/disposable';
import { parseHostReply, type HostReply, type HostRequest } from '../../formatter-host/protocol';
import { EDITOR_FORMAT_TIMEOUT_MS } from '../../preload/shell-channels';

// A host nobody asked for this long is killed.
export const HOST_IDLE_MS: number = 5 * 60 * 1000;
// A request whose Prettier has not loaded this long after it was sent kills the host. The caller has its answer after the
// format budget either way, so a slow cold start keeps loading for the next request instead of starting cold again.
export const HOST_STARTUP_MS: number = 30 * 1000;
// Files whose change can swap the project's Prettier; the watcher kills the host so the next format loads the new one.
export const PRETTIER_INSTALL_GLOB = '{package.json,package-lock.json,npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml,bun.lock,bun.lockb}';

/** The utility process of one root as main sees it; formatter-process.ts adapts Electron's UtilityProcess. */
export interface HostProcess {
  postMessage(message: HostRequest): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

// timeout: starting when Prettier had not loaded within the budget (the host keeps loading), else the host was stopped.
// refused: the module at path, outside the root, was not loaded.
export type HostOutcome =
  | { readonly kind: 'formatted'; readonly text: string }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'refused'; readonly path: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'timeout'; readonly starting: boolean };

// key: the project's key; root: its real path, the host's cwd
export interface HostRoot {
  readonly key: string;
  readonly root: string;
}

export interface FormatterHostsDeps {
  // starts the host with its cwd at root and the login environment minus ELECTRON_*
  readonly spawn: (root: string) => HostProcess;
  // calls onChange when the root's package.json or lockfile changes
  readonly watch: (root: string, onChange: () => void) => Disposable;
  readonly log: (line: string) => void;
  readonly timeoutMs?: number;
  readonly idleMs?: number;
}

interface Pending {
  // undefined once the caller has its answer; the host's later messages for the request are then dropped
  resolve: ((outcome: HostOutcome) => void) | undefined;
  loaded: boolean;
  // the budget for loading Prettier, then the budget for the format from loaded on
  budget: NodeJS.Timeout;
  startup: NodeJS.Timeout | undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function settle(pending: Pending, outcome: HostOutcome): void {
  pending.resolve?.(outcome);
  pending.resolve = undefined;
}

interface Host {
  readonly key: string;
  readonly root: string;
  readonly process: HostProcess;
  readonly pending: Map<number, Pending>;
  readonly watcher: Disposable;
  idle: NodeJS.Timeout | undefined;
}

/** One formatter host per project root, started on first use. */
export class FormatterHosts implements Disposable {
  private readonly deps: FormatterHostsDeps;
  private readonly hosts = new Map<string, Host>();
  private nextId = 0;

  constructor(deps: FormatterHostsDeps) {
    this.deps = deps;
  }

  /**
   * Formats through the root's host, starting it when none runs, and never rejects. Prettier gets the budget to load and then
   * the budget to format, so a caller waits at most twice the budget.
   */
  format(target: HostRoot, request: Omit<HostRequest, 'id'>): Promise<HostOutcome> {
    return new Promise<HostOutcome>((resolve) => {
      let host: Host;
      try {
        host = this.hostFor(target);
      } catch (err) {
        this.deps.log(`[format] the formatter for ${target.root} could not start: ${errorText(err)}`);
        resolve({ kind: 'error', message: `The formatter process could not start: ${errorText(err)}` });
        return;
      }
      clearTimeout(host.idle);
      host.idle = undefined;
      const id = this.nextId++;
      host.pending.set(id, {
        resolve,
        loaded: false,
        budget: setTimeout(() => this.loadTimedOut(host, id), this.timeoutMs()),
        startup: setTimeout(() => this.stop(host, `it took longer than ${HOST_STARTUP_MS / 1000} s to load Prettier`), HOST_STARTUP_MS),
      });
      try {
        host.process.postMessage({ id, ...request });
      } catch (err) {
        this.stop(host, `the request could not be sent (${errorText(err)})`);
      }
    });
  }

  /** Stops the host of every project not in projectKeys, as when its project is removed. */
  retain(projectKeys: readonly string[]): void {
    const keep = new Set(projectKeys);
    for (const [key, host] of [...this.hosts]) if (!keep.has(key)) this.stop(host, 'its project was removed');
  }

  running(projectKey: string): boolean {
    return this.hosts.has(projectKey);
  }

  dispose(): void {
    for (const host of [...this.hosts.values()]) this.stop(host, 'the app is closing');
  }

  private hostFor({ key, root }: HostRoot): Host {
    const running = this.hosts.get(key);
    if (running) return running;
    const child = this.deps.spawn(root);
    let watcher: Disposable;
    try {
      watcher = this.deps.watch(root, () => this.stop(host, 'package.json or the lockfile changed'));
    } catch (err) {
      child.kill();
      throw err;
    }
    const host: Host = { key, root, process: child, pending: new Map(), watcher, idle: undefined };
    this.hosts.set(key, host);
    child.onMessage((raw) => this.reply(host, raw));
    child.onExit((code) => {
      if (this.hosts.get(key) !== host) return;
      this.deps.log(`[format] the formatter for ${root} exited with code ${code}`);
      this.forget(host, `The formatter process exited with code ${code}.`);
    });
    this.deps.log(`[format] started the formatter for ${root}`);
    return host;
  }

  private timeoutMs(): number {
    return this.deps.timeoutMs ?? EDITOR_FORMAT_TIMEOUT_MS;
  }

  // The caller has its answer, and the host keeps loading: killing it would make the next request start cold again.
  private loadTimedOut(host: Host, id: number): void {
    const pending = host.pending.get(id);
    if (!pending || pending.loaded) return;
    this.deps.log(`[format] the formatter for ${host.root} had not loaded Prettier after ${this.timeoutMs()} ms; it keeps loading`);
    settle(pending, { kind: 'timeout', starting: true });
  }

  private loaded(host: Host, id: number, pending: Pending): void {
    pending.loaded = true;
    clearTimeout(pending.budget);
    clearTimeout(pending.startup);
    pending.startup = undefined;
    const timeoutMs = this.timeoutMs();
    pending.budget = setTimeout(() => {
      this.deps.log(`[format] the formatter for ${host.root} took longer than ${timeoutMs} ms`);
      host.pending.delete(id);
      settle(pending, { kind: 'timeout', starting: false });
      this.stop(host, 'it timed out');
    }, timeoutMs);
  }

  // The host runs the project's code: a reply outside the contract, or for no pending request, stops it.
  private reply(host: Host, raw: unknown): void {
    const reply = parseHostReply(raw);
    const pending = reply === undefined ? undefined : host.pending.get(reply.id);
    if (!reply || !pending || (reply.kind === 'loaded' && pending.loaded)) {
      this.stop(host, 'it sent a message outside the contract');
      return;
    }
    if (reply.kind === 'loaded') {
      this.loaded(host, reply.id, pending);
      return;
    }
    clearTimeout(pending.budget);
    clearTimeout(pending.startup);
    host.pending.delete(reply.id);
    settle(pending, outcomeOf(reply));
    if (host.pending.size > 0) return;
    const idleMs = this.deps.idleMs ?? HOST_IDLE_MS;
    host.idle = setTimeout(() => this.stop(host, `it was idle for ${idleMs / 1000} s`), idleMs);
  }

  private stop(host: Host, why: string): void {
    if (this.hosts.get(host.key) !== host) return;
    this.deps.log(`[format] stopping the formatter for ${host.root}: ${why}`);
    this.forget(host, `The formatter process was stopped because ${why}.`);
    host.process.kill();
  }

  private forget(host: Host, message: string): void {
    this.hosts.delete(host.key);
    clearTimeout(host.idle);
    host.watcher.dispose();
    for (const pending of host.pending.values()) {
      clearTimeout(pending.budget);
      clearTimeout(pending.startup);
      settle(pending, { kind: 'error', message });
    }
    host.pending.clear();
  }
}

function outcomeOf(reply: Exclude<HostReply, { kind: 'loaded' }>): HostOutcome {
  switch (reply.kind) {
    case 'formatted': return { kind: 'formatted', text: reply.text };
    case 'ignored': return { kind: 'ignored' };
    case 'refused': return { kind: 'refused', path: reply.path };
    case 'error': return { kind: 'error', message: reply.message };
  }
}
