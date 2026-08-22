/**
 * workspace-agent-registry.ts — The single workspace-level source of truth for markdown subagents.
 *
 * One process/workspace owns one `WorkspaceAgentRegistry` (built lazily by `PiRuntime`). It loads the
 * embedded defaults overlaid with project and global agents (pi-set and Claude-set locations — see
 * `agentDiscoveryDirs`), and runs exactly ONE filesystem watcher per agent directory — workspace-level,
 * never per-panel, so multiple open panels never multi-watch the same dirs. On any change (or a
 * workspace-trust grant) it reloads the registry in place and notifies subscribers; the shared
 * `AgentRegistry` instance is mutated via `register()`, so every `AgentManager` holding a reference to
 * it sees the reload automatically.
 */

import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { log } from '../../logger';
import { AgentRegistry } from './agent-types';
import { agentDiscoveryDirs, loadCustomAgents } from './custom-agents';
import type { ParseFrontmatter } from './custom-agents';

const RELOAD_DEBOUNCE_MS = 300;

export class WorkspaceAgentRegistry {
  private readonly registry = new AgentRegistry();
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly parseFrontmatter: ParseFrontmatter;
  private trustListener: vscode.Disposable | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private _disposed = false;

  constructor(cwd: string, parseFrontmatter: ParseFrontmatter, options?: { homeDir?: string }) {
    this.cwd = cwd;
    this.homeDir = options?.homeDir ?? homedir();
    this.parseFrontmatter = parseFrontmatter;
    this.reload();
    this.setupWatchers();
    // Reload when the user grants workspace trust so project agents appear without a window reload.
    this.trustListener = vscode.workspace.onDidGrantWorkspaceTrust(() => this.reload());
  }

  /** The shared, mutated-in-place registry. AgentManagers hold this same instance across reloads. */
  getRegistry(): AgentRegistry {
    return this.registry;
  }

  /** Subscribe to reloads; returns an unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Reload markdown agents into the registry (project scope trust-gated) and notify subscribers. */
  private reload(): void {
    if (this._disposed) return;
    try {
      const userAgents = loadCustomAgents(this.cwd, this.parseFrontmatter, {
        includeProjectScope: vscode.workspace.isTrusted,
        homeDir: this.homeDir,
      });
      this.registry.register(userAgents);
    } catch (err) {
      log('[WorkspaceAgentRegistry] load failed: %O', err);
      this.registry.register(new Map());
    }
    this.notify();
  }

  /** One watcher per agent directory (project + global, pi-set and Claude-set), debounced → reload. */
  private setupWatchers(): void {
    // Watch project dirs regardless of current trust so a later trust grant surfaces them on reload.
    const dirs = agentDiscoveryDirs({ cwd: this.cwd, homeDir: this.homeDir, includeProjectScope: true });
    for (const { dir } of dirs) {
      // A RelativePattern anchored at the dir Uri is required so the watcher fires for the global dirs,
      // which live outside the workspace folders (a plain string glob would not). `**/*.md` covers the
      // nested subfolders Claude organizes its profiles into.
      const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), '**/*.md');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
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

  private notify(): void {
    if (this._disposed) return;
    for (const cb of this.listeners) cb();
  }

  dispose(): void {
    this._disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.trustListener?.dispose();
    this.trustListener = null;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers.length = 0;
    this.listeners.clear();
  }
}
