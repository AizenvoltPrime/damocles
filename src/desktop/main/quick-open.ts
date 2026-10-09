import { spawn } from 'node:child_process';
import { parseQuickOpenQuery } from '../../core/quick-open/fuzzy-match';
import type { WebContents } from 'electron';
import {
  MAX_QUICK_OPEN_QUERY_LENGTH,
  OVERLAY_CHANNELS,
  type OverlayAnswer,
  type OverlayRequest,
  type PaletteCommand,
  type QuickOpenMode,
  type QuickOpenPick,
  type QuickOpenResponse,
  type QuickOpenResult,
  type QuickOpenScope,
} from '../preload/overlay-channels';
import type { FileRef } from '../preload/shell-channels';
import { parseWorkerReply, ripgrepFileArgs, type WorkerReply, type WorkerRequest } from '../quick-open-worker/protocol';
import type { Project } from './documents/confine';
import type { MenuState } from './menu';
import type { RgProcess } from './search/search-service';
import { tickDeadline } from './tick-deadline';

// Characters of a listing's ripgrep stderr kept for the log and the failure.
const MAX_LISTING_STDERR_CHARS = 4096;

// A worker that posts nothing for this long while a query waits is stuck and replaced; a listing that still prints a file
// posts progress every WORKER_PROGRESS_INTERVAL_MS, so it is never cut short.
export const QUICK_OPEN_WORKER_SILENCE_MS = 30_000;

/** What QuickOpenIndex needs of a worker thread; node:worker_threads' Worker is one. */
export interface QuickOpenWorker {
  postMessage(request: WorkerRequest): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'messageerror' | 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export interface QuickOpenDeps {
  readonly projects: () => readonly Project[];
  readonly rgPath: () => Promise<string>;
  // ripgrep's ignore switches from the search.use*IgnoreFiles settings
  readonly ignoreArgs: () => readonly string[];
  // damocles.desktop.files.exclude globs that hide files
  readonly excludes: () => readonly string[];
  // keeps the project's watcher running, whose creates and deletes invalidate its list
  readonly watch: (project: Project) => void;
  // starts dist/quick-open-worker.js
  readonly startWorker: () => QuickOpenWorker;
  readonly log: (line: string) => void;
  readonly spawnRg?: (rgPath: string, args: readonly string[]) => RgProcess;
}

function spawnRipgrep(rgPath: string, args: readonly string[]): RgProcess {
  return spawn(rgPath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

export interface QuickOpenContext {
  readonly currentProjectKey: string | undefined;
  // most recent first
  readonly recent: readonly FileRef[];
  // only this project folder's files, in path order before a query, with no recent ones
  readonly scope?: QuickOpenScope;
}

export type QuickOpenAnswer = Omit<QuickOpenResponse, 'generation'>;

/** One query's place among an open Quick Open's queries: the open request's id and the overlay's generation. */
export interface QuickOpenSearch {
  readonly id: number;
  readonly generation: number;
}

interface Pending {
  readonly resolve: (answer: QuickOpenAnswer | undefined) => void;
  readonly projects: ReadonlyMap<string, Project>;
  readonly scope: QuickOpenScope | undefined;
  readonly base: QuickOpenAnswer;
}

function itemOf(relativePath: string): { label: string; description: string } {
  const slash = relativePath.lastIndexOf('/');
  return { label: relativePath.slice(slash + 1), description: slash < 0 ? '' : relativePath.slice(0, slash) };
}

/**
 * Quick Open's file lists and scoring, which run in a worker thread so a large project never blocks the main process (VS Code
 * runs them in its search process). Main relays each query, checks the worker's reply as untrusted data, and answers empty
 * when the worker fails or goes silent while a query waits, starting a fresh worker for the next query.
 */
export class QuickOpenIndex {
  private readonly deps: QuickOpenDeps;
  private worker: QuickOpenWorker | undefined;
  // main runs every listing's ripgrep, since terminating a worker thread leaves the processes it spawned running
  private readonly listings = new Set<RgProcess>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  // the open requests' search ids
  private readonly searches = new Set<number>();
  private nextSearch = 0;
  // cancels the deadline by which the worker must post something while a query waits
  private cancelSilence: (() => void) | undefined;

  constructor(deps: QuickOpenDeps) {
    this.deps = deps;
  }

  invalidate(projectKey?: string): void {
    this.worker?.postMessage({ kind: 'invalidate', ...(projectKey !== undefined ? { projectKey } : {}) });
  }

  /** A new open request's search id, for its queries. */
  open(): number {
    const search = this.nextSearch++;
    this.searches.add(search);
    return search;
  }

  /** The open request closed: a query of it still on its way is dropped, and the worker forgets its cache. */
  end(search: number): void {
    this.searches.delete(search);
    this.worker?.postMessage({ kind: 'end', search });
  }

  dispose(): void {
    this.stop();
  }

  /** The answer to raw, or undefined once a newer query of the same search replaced it or the search ended; never rejects. */
  async query(raw: string, context: QuickOpenContext, search: QuickOpenSearch): Promise<QuickOpenAnswer | undefined> {
    const parsed = parseQuickOpenQuery(raw);
    const base: QuickOpenAnswer = {
      ...(context.currentProjectKey !== undefined ? { currentProjectKey: context.currentProjectKey } : {}),
      ...(parsed.line !== undefined ? { line: parsed.line } : {}),
      mention: parsed.mention,
      results: [],
    };
    let id: number | undefined;
    try {
      const { scope } = context;
      const projects = this.deps.projects();
      for (const project of projects) if (scope === undefined || project.key === scope.projectKey) this.deps.watch(project);
      if (!this.searches.has(search.id)) return undefined;
      const worker = this.started();
      const queryId = this.nextId++;
      id = queryId;
      const answer = new Promise<QuickOpenAnswer | undefined>((resolve) => {
        this.pending.set(queryId, { resolve, projects: new Map(projects.map((project) => [project.key, project])), scope, base });
      });
      worker.postMessage({
        kind: 'query',
        id: queryId,
        search: search.id,
        generation: search.generation,
        raw,
        context: {
          ...(context.currentProjectKey !== undefined ? { currentProjectKey: context.currentProjectKey } : {}),
          recent: context.recent.map((ref) => ({ projectKey: ref.projectKey, relativePath: ref.relativePath })),
          ...(scope ? { scope: { projectKey: scope.projectKey, folder: scope.folder } } : {}),
        },
        projects: projects.map((project) => ({ key: project.key, fsPath: project.fsPath })),
      });
      // A new query never extends the deadline of queries already waiting on a silent worker.
      this.cancelSilence ??= this.silenceDeadline();
      return await answer;
    } catch (err) {
      if (id !== undefined) this.pending.delete(id);
      this.deps.log(`[quick-open] a query failed: ${err instanceof Error ? err.message : String(err)}`);
      return base;
    }
  }

  private started(): QuickOpenWorker {
    if (this.worker) return this.worker;
    const worker = this.deps.startWorker();
    this.worker = worker;
    worker.on('message', (message) => {
      if (this.worker !== worker) return;
      this.receive(worker, message);
      this.watchSilence();
    });
    worker.on('error', (err) => {
      if (this.worker === worker) this.fail(`the worker failed: ${err.message}`);
    });
    worker.on('messageerror', (err) => {
      if (this.worker === worker) this.fail(`a worker message could not be read: ${err.message}`);
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.fail(`the worker exited with ${code}`);
    });
    return worker;
  }

  private receive(worker: QuickOpenWorker, message: unknown): void {
    const reply = parseWorkerReply(message);
    if (!reply) {
      this.fail('the worker sent a malformed reply');
      return;
    }
    if (reply.kind === 'log') {
      this.deps.log(reply.line);
      return;
    }
    if (reply.kind === 'progress') return;
    if (reply.kind === 'list') {
      void this.list(worker, reply.listing, reply.projectKey);
      return;
    }
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    if (reply.kind === 'failed') {
      this.fail(`a query failed in the worker: ${reply.message}`);
      return;
    }
    const results = reply.kind === 'superseded' ? undefined : this.results(reply, pending);
    if (reply.kind === 'answer' && !results) {
      this.fail('the worker answered with a file outside the queried projects');
      return;
    }
    this.pending.delete(reply.id);
    pending.resolve(results && { ...pending.base, results });
  }

  // The answer's results as main's own: each one in a queried project (and the scope's folder), named from main's project list.
  private results(reply: Extract<WorkerReply, { kind: 'answer' }>, pending: Pending): QuickOpenResult[] | undefined {
    const results: QuickOpenResult[] = [];
    for (const result of reply.results) {
      const project = pending.projects.get(result.projectKey);
      if (!project) return undefined;
      if (pending.scope && (project.key !== pending.scope.projectKey || !result.relativePath.startsWith(pending.scope.folder))) return undefined;
      results.push({ projectKey: project.key, projectName: project.name, relativePath: result.relativePath, ...itemOf(result.relativePath), labelMatches: result.labelMatches, descriptionMatches: result.descriptionMatches, recent: result.recent });
    }
    return results;
  }

  // ripgrep for a project of main's list, its output streamed to the worker that asked.
  private async list(worker: QuickOpenWorker, listing: number, projectKey: string): Promise<void> {
    const project = this.deps.projects().find((candidate) => candidate.key === projectKey);
    if (!project) {
      worker.postMessage({ kind: 'listEnd', listing, error: 'not a project' });
      return;
    }
    let rgPath: string;
    try {
      rgPath = await this.deps.rgPath();
    } catch (err) {
      worker.postMessage({ kind: 'listEnd', listing, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // A worker stopped meanwhile has nobody left to kill a ripgrep started for it.
    if (this.worker !== worker) return;
    const rg = (this.deps.spawnRg ?? spawnRipgrep)(rgPath, ripgrepFileArgs(project.fsPath, this.deps.ignoreArgs(), this.deps.excludes()));
    this.listings.add(rg);
    let stderr = '';
    let ended = false;
    const end = (error: string | undefined): void => {
      if (ended) return;
      ended = true;
      this.listings.delete(rg);
      worker.postMessage({ kind: 'listEnd', listing, ...(error !== undefined ? { error } : {}) });
    };
    rg.stdout.on('data', (data: Buffer) => worker.postMessage({ kind: 'listOutput', listing, data }));
    rg.stderr.setEncoding('utf8');
    rg.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_LISTING_STDERR_CHARS) stderr += chunk.slice(0, MAX_LISTING_STDERR_CHARS - stderr.length);
    });
    rg.on('error', (err) => end(err.message));
    rg.on('close', (code) => {
      // 1 is ripgrep's "nothing found".
      if (code !== 0 && code !== 1) {
        end(`ripgrep exited with ${String(code)}: ${stderr.trim()}`);
        return;
      }
      if (stderr.trim() !== '') this.deps.log(`[quick-open] ripgrep: ${stderr.trim().slice(0, 500)}`);
      end(undefined);
    });
  }

  // Every message from the worker restarts the deadline; it runs only while a query waits.
  private watchSilence(): void {
    this.cancelSilence?.();
    this.cancelSilence = this.pending.size === 0 ? undefined : this.silenceDeadline();
  }

  private silenceDeadline(): () => void {
    return tickDeadline(QUICK_OPEN_WORKER_SILENCE_MS, () => this.fail(`the worker sent nothing for ${QUICK_OPEN_WORKER_SILENCE_MS} ms while a query waited`));
  }

  private fail(reason: string): void {
    this.deps.log(`[quick-open] ${reason}`);
    this.stop();
  }

  // Every query waiting on the worker answers empty, its ripgreps are killed, and the next query starts a fresh worker.
  private stop(): void {
    this.cancelSilence?.();
    this.cancelSilence = undefined;
    // ripgrep starts no process (its Windows console host ends with it), so this kill through the handle is the whole tree.
    for (const rg of this.listings) rg.kill();
    const worker = this.worker;
    this.worker = undefined;
    worker?.terminate().catch((err: unknown) => this.deps.log(`[quick-open] stopping the worker failed: ${err instanceof Error ? err.message : String(err)}`));
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const pending of waiting) pending.resolve(pending.base);
  }
}

export interface QuickOpenOverlay {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  isOpen(kind: OverlayRequest['kind']): boolean;
  request(request: OverlayRequest, returnFocus: WebContents | undefined): Promise<OverlayAnswer>;
}

// The command palette's side of the quickOpen request (AD11).
export interface QuickOpenCommands {
  // the focus context, read before the overlay shows and takes focus
  capture(): MenuState;
  list(context: MenuState): PaletteCommand[];
}

export type QuickOpenOutcome =
  | { readonly kind: 'pick'; readonly pick: QuickOpenPick }
  // a palette command, for main to run in the context captured when the request opened
  | { readonly kind: 'command'; readonly id: string; readonly context: MenuState };

function pickKey(projectKey: string, relativePath: string): string {
  return `${projectKey}\n${relativePath}`;
}

/**
 * One window's Quick Open and command palette: the overlay's queries and command lists, answered only while its quickOpen
 * request is open, and the pick or the command.
 */
export class QuickOpenPicker {
  private readonly overlay: QuickOpenOverlay;
  private readonly index: QuickOpenIndex;
  private readonly context: () => QuickOpenContext;
  private readonly commands: QuickOpenCommands;
  private readonly log: (line: string) => void;
  // every file a query of the open request returned; a pick must be one of them
  private returned = new Set<string>();
  // the focus context of the open request, for its command list and its command
  private captured: MenuState | undefined;
  // the folder the open request is limited to
  private scope: QuickOpenScope | undefined;
  // the open request's search id, which the index gave it
  private search: number | undefined;

  constructor(overlay: QuickOpenOverlay, index: QuickOpenIndex, context: () => QuickOpenContext, commands: QuickOpenCommands, log: (line: string) => void) {
    this.overlay = overlay;
    this.index = index;
    this.context = context;
    this.commands = commands;
    this.log = log;
    overlay.handle(OVERLAY_CHANNELS.commandsList, (raw) => {
      if (!this.overlay.isOpen('quickOpen') || !this.captured) throw new Error('Quick Open is not open');
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length > 0) throw new Error('Malformed command list request');
      return this.commands.list(this.captured);
    });
    overlay.handle(OVERLAY_CHANNELS.quickOpenQuery, async (raw) => {
      if (!this.overlay.isOpen('quickOpen')) throw new Error('Quick Open is not open');
      const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
      const query = value && Object.hasOwn(value, 'query') ? value['query'] : undefined;
      const generation = value && Object.hasOwn(value, 'generation') ? value['generation'] : undefined;
      if (typeof query !== 'string' || query.length > MAX_QUICK_OPEN_QUERY_LENGTH) throw new Error('Malformed Quick Open query');
      if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) throw new Error('Malformed Quick Open generation');
      const search = this.search;
      const returned = this.returned;
      const response = search === undefined ? undefined : await this.index.query(query, { ...this.context(), ...(this.scope ? { scope: this.scope } : {}) }, { id: search, generation });
      // A newer query replaced this one, so the overlay drops its answer.
      if (!response) return { generation, mention: false, results: [] };
      for (const result of response.results) returned.add(pickKey(result.projectKey, result.relativePath));
      return { generation, ...response };
    });
  }

  /**
   * Shows Quick Open in mode, limited to scope's folder when given; resolves the user's pick or command, or undefined for
   * Escape or a pick main never offered.
   */
  async show(returnFocus: WebContents | undefined, mode: QuickOpenMode, scope?: QuickOpenScope): Promise<QuickOpenOutcome | undefined> {
    this.returned = new Set();
    const search = this.index.open();
    this.search = search;
    const context = this.commands.capture();
    this.captured = context;
    this.scope = scope;
    let answer: OverlayAnswer;
    try {
      answer = await this.overlay.request({ kind: 'quickOpen', mode, ...(scope ? { scope } : {}) }, returnFocus);
    } finally {
      this.index.end(search);
      if (this.captured === context) {
        this.captured = undefined;
        this.scope = undefined;
        this.search = undefined;
      }
    }
    if (answer.kind !== 'quickOpen') return undefined;
    if ('command' in answer) return { kind: 'command', id: answer.command, context };
    if (answer.pick === null) return undefined;
    if (!this.returned.has(pickKey(answer.pick.projectKey, answer.pick.relativePath))) {
      this.log('[quick-open] ignoring a pick that no query returned');
      return undefined;
    }
    return { kind: 'pick', pick: answer.pick };
  }
}
