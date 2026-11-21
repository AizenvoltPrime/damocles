/**
 * workspace-agent-registry.ts — The source of truth for one workspace folder's markdown subagents.
 *
 * Each workspace folder owns one `WorkspaceAgentRegistry` (built lazily by `FolderRuntime`). It loads the
 * embedded defaults overlaid with project and global agents (pi-set and Claude-set locations — see
 * `agentDiscoveryDirs`), and runs one filesystem watcher per agent directory for the folder, never per
 * panel. Each registry watches the user-global agent dirs itself, so N open folders watch them N times.
 * It also watches the targets of the links its registered load followed.
 * On any change (or a workspace-trust change) it reloads the registry in place and notifies
 * subscribers; the shared `AgentRegistry` instance is mutated via `register()`, so every `AgentManager`
 * holding a reference to it sees the reload automatically.
 */

import { homedir } from 'node:os';
import { relative, sep } from 'node:path';
import { LinkTargetWatchers, type WatchTarget } from '../../assets';
import { userConfigBase } from '../../config/local-config-path';
import { log } from '../../logger';
import { AgentRegistry } from './agent-types';
import { agentDiscoveryDirs, loadCustomAgents } from './custom-agents';
import type { ParseFrontmatter } from './custom-agents';
import type { AgentConfig } from './types';
import type { Disposable } from '../../../platform/disposable';
import type { TrustService } from '../../../platform/trust-service';
import type { FileWatcher, FileWatcherFactory } from '../../../platform/file-watcher';

const RELOAD_DEBOUNCE_MS = 300;

export class WorkspaceAgentRegistry {
  private readonly registry = new AgentRegistry();
  private readonly watchers: FileWatcher[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly parseFrontmatter: ParseFrontmatter;
  private readonly trust: TrustService;
  private readonly fileWatchers: FileWatcherFactory;
  private readonly linkTargets: LinkTargetWatchers;
  private trustListener: Disposable | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private _disposed = false;
  /** The user-scope agents of the registered load, which a trust revoke registers at once. */
  private registeredUser = new Map<string, AgentConfig>();
  private registeredHasProject = false;
  // A load registers only when no later-started load has, so a burst of reloads cannot hold the registry back.
  private generation = 0;
  private settledGeneration = 0;
  private readonly waiters: Array<{ readonly generation: number; readonly resolve: () => void }> = [];

  constructor(
    cwd: string,
    parseFrontmatter: ParseFrontmatter,
    trust: TrustService,
    fileWatchers: FileWatcherFactory,
    options?: { homeDir?: string },
  ) {
    this.cwd = cwd;
    this.trust = trust;
    this.fileWatchers = fileWatchers;
    this.homeDir = options?.homeDir ?? homedir();
    this.parseFrontmatter = parseFrontmatter;
    this.linkTargets = new LinkTargetWatchers(fileWatchers, () => this.scheduleReload());
    this.reload();
    this.setupWatchers();
    // Project agents come and go with trust, without a window reload.
    this.trustListener = trust.onDidChangeTrust(() => this.onTrustChange());
  }

  /** The shared, mutated-in-place registry. AgentManagers hold this same instance across reloads. */
  getRegistry(): AgentRegistry {
    return this.registry;
  }

  /** Settles once the registry holds a load started no earlier than the newest one started before this call. */
  whenLoaded(): Promise<void> {
    const generation = this.generation;
    if (this._disposed || this.settledGeneration >= generation) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ generation, resolve }));
  }

  /** Subscribe to reloads; returns an unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** A revoke withdraws the project agents before the reload, so no reader between the two sees them. */
  private onTrustChange(): void {
    if (this._disposed) return;
    if (!this.trust.isTrusted(this.cwd) && this.registeredHasProject) {
      this.registeredHasProject = false;
      this.registry.register(this.registeredUser);
      this.notify();
    }
    this.reload();
  }

  /** Reload markdown agents into the registry (project scope trust-gated) and notify subscribers. */
  private reload(): void {
    if (this._disposed) return;
    const generation = ++this.generation;
    const includeProjectScope = this.trust.isTrusted(this.cwd);
    void loadCustomAgents(this.cwd, this.parseFrontmatter, { includeProjectScope, homeDir: this.homeDir }).then(
      ({ agents, userAgents, followed }) => this.settle(generation, includeProjectScope, agents, userAgents, followed),
      (err: unknown) => {
        log('[WorkspaceAgentRegistry] load failed: %O', err);
        this.settle(generation, includeProjectScope, new Map(), new Map(), null);
      },
    );
  }

  /** Register a finished load unless a later-started one already registered or a revoke overtook its project scope. */
  private settle(
    generation: number,
    includeProjectScope: boolean,
    agents: Map<string, AgentConfig>,
    userAgents: Map<string, AgentConfig>,
    followed: WatchTarget[] | null,
  ): void {
    if (this._disposed || generation <= this.settledGeneration) return;
    if (includeProjectScope && !this.trust.isTrusted(this.cwd)) return;
    this.settledGeneration = generation;
    this.registeredUser = userAgents;
    this.registeredHasProject = includeProjectScope;
    this.registry.register(agents);
    if (followed !== null) {
      try {
        this.linkTargets.sync(followed);
      } catch (err) {
        log('[WorkspaceAgentRegistry] watching the link targets of a load failed: %O', err);
      }
    }
    for (const waiter of this.waiters.filter((w) => w.generation <= generation)) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    this.notify();
  }

  /** One watcher per agent directory (project + global, pi-set and Claude-set), debounced → reload. */
  private setupWatchers(): void {
    // Watch project dirs regardless of current trust so a later trust grant surfaces them on reload.
    const dirs = agentDiscoveryDirs({ cwd: this.cwd, homeDir: this.homeDir, includeProjectScope: true });
    for (const { dir, source } of dirs) {
      // A watcher of its own is required so it fires for the global dirs, which live outside the workspace folders. Its base
      // is the dir's network-rule base (D10: the project, the home folder or the Damocles data folder), so the watcher judges a
      // link on the dir's path. `**` matches every entry, since a linked subfolder (agents/eng) has no .md suffix and no watch
      // enters a link.
      const base = source === 'global' ? userConfigBase(dir, this.homeDir) : this.cwd;
      const watcher = this.fileWatchers.watch(base, `${relative(base, dir).split(sep).join('/')}/**`);
      watcher.onDidCreate(() => this.scheduleReload());
      watcher.onDidChange(() => this.scheduleReload());
      watcher.onDidDelete(() => this.scheduleReload());
      this.watchers.push(watcher);
    }
  }

  /** Debounce rapid file events into one reload. */
  private scheduleReload(): void {
    if (this._disposed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reload();
    }, RELOAD_DEBOUNCE_MS);
  }

  /** Each listener runs on its own: one that throws is logged and the rest still run. */
  private notify(): void {
    if (this._disposed) return;
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (err) {
        log('[WorkspaceAgentRegistry] a change listener failed: %O', err);
      }
    }
  }

  dispose(): void {
    this._disposed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.trustListener?.dispose();
    this.trustListener = null;
    this.linkTargets.dispose();
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers.length = 0;
    this.listeners.clear();
  }
}
