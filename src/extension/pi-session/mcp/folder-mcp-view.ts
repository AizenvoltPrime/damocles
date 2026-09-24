import type { McpServerStatusInfo } from '../../../shared/types/mcp';
import type { McpToolDescriptor } from './types';
import type { McpCallResult, McpClientManager } from './mcp-client-manager';
import type { McpToolCallOptions, McpToolSource } from './tool-source';
import { log } from '../../logger';

/**
 * One folder's MCP tools: its own folder-scope manager plus the user-scope servers visible in that folder.
 * A user server outside `userVisible`, or shadowed by a same-named folder server, never appears here and
 * cannot be called, reconnected, authenticated or signed out through it.
 */
export class FolderMcpView implements McpToolSource {
  private userVisible = new Set<string>();
  private loggedConflicts = '';
  private readonly listeners = new Set<() => void>();
  private readonly user: McpClientManager;
  private readonly folder: McpClientManager;
  private readonly unsubscribers: (() => void)[];

  constructor(user: McpClientManager, folder: McpClientManager) {
    this.user = user;
    this.folder = folder;
    this.unsubscribers = [
      user.onToolsChanged(() => {
        // User prefixes can move on a user reconcile; the folder side must step off them before anyone reads names.
        // A folder rename already emitted through the folder listener below.
        if (!this.folder.refreshReservedPrefixes()) this.emit();
      }),
      folder.onToolsChanged(() => this.emit()),
    ];
  }

  /** Replace the user servers visible in this folder; renames folder tools off newly visible user prefixes. */
  setUserVisible(names: readonly string[]): void {
    const next = new Set(names);
    if (next.size === this.userVisible.size && [...next].every((name) => this.userVisible.has(name))) return;
    this.userVisible = next;
    if (!this.folder.refreshReservedPrefixes()) this.emit();
  }

  /** The prefixes the user manager assigned to the user servers visible here; the folder manager must avoid them. */
  reservedPrefixes(): ReadonlySet<string> {
    const reserved = new Set<string>();
    for (const name of this.userVisible) {
      if (this.folderHas(name)) continue;
      const prefix = this.user.serverPrefix(name);
      if (prefix !== undefined) reserved.add(prefix);
    }
    return reserved;
  }

  onToolsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getAllToolDescriptors(): McpToolDescriptor[] {
    const folderTools = this.folder.getAllToolDescriptors();
    const userTools = this.user.getAllToolDescriptors().filter((d) => this.isVisibleUserServer(d.serverName));
    const conflicts = conflictingNames(folderTools, userTools);
    return [...userTools, ...folderTools].filter((d) => !conflicts.has(d.piName));
  }

  getToolDescriptor(piName: string): McpToolDescriptor | undefined {
    const owner = this.toolOwner(piName);
    return owner?.getToolDescriptor(piName);
  }

  allToolNames(): string[] {
    return this.getAllToolDescriptors().map((d) => d.piName);
  }

  isMcpReadOnly(piName: string): boolean {
    return this.getToolDescriptor(piName)?.readOnly === true;
  }

  getServerStatuses(): McpServerStatusInfo[] {
    const userStatuses = this.user.getServerStatuses().filter((status) => this.isVisibleUserServer(status.name));
    return [...userStatuses, ...this.folder.getServerStatuses()];
  }

  callTool(piName: string, args: Record<string, unknown>, opts?: McpToolCallOptions): Promise<McpCallResult> {
    const owner = this.toolOwner(piName);
    if (!owner) return Promise.reject(new Error(`Unknown MCP tool "${piName}"`));
    return owner.callTool(piName, args, opts);
  }

  reconnectOrAuthenticate(name: string): Promise<boolean> {
    const owner = this.serverOwner(name, 'reconnect');
    return owner ? owner.reconnectOrAuthenticate(name) : Promise.resolve(false);
  }

  reauthenticate(name: string): Promise<boolean> {
    const owner = this.serverOwner(name, 'reauthenticate');
    return owner ? owner.reauthenticate(name) : Promise.resolve(false);
  }

  signOut(name: string): Promise<void> {
    const owner = this.serverOwner(name, 'sign out');
    return owner ? owner.signOut(name) : Promise.resolve();
  }

  /** Detach from both managers. The managers themselves belong to their runtimes. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.listeners.clear();
  }

  private folderHas(name: string): boolean {
    return this.folder.serverPrefix(name) !== undefined;
  }

  private isVisibleUserServer(name: string): boolean {
    return this.userVisible.has(name) && !this.folderHas(name);
  }

  /** The manager that serves `piName` here, or undefined when neither exposes it or both claim it. */
  private toolOwner(piName: string): McpClientManager | undefined {
    const inFolder = this.folder.getToolDescriptor(piName) !== undefined;
    const userDescriptor = this.user.getToolDescriptor(piName);
    const inUser = userDescriptor !== undefined && this.isVisibleUserServer(userDescriptor.serverName);
    if (inFolder && inUser) {
      log('[FolderMcpView] %s is claimed by a folder and a user server; refusing to route it', piName);
      return undefined;
    }
    if (inFolder) return this.folder;
    return inUser ? this.user : undefined;
  }

  private serverOwner(name: string, action: string): McpClientManager | undefined {
    if (this.folderHas(name)) return this.folder;
    if (this.isVisibleUserServer(name)) return this.user;
    log('[FolderMcpView] %s rejected: MCP server "%s" is not available in this folder', action, name);
    return undefined;
  }

  private emit(): void {
    const conflicts = conflictingNames(
      this.folder.getAllToolDescriptors(),
      this.user.getAllToolDescriptors().filter((d) => this.isVisibleUserServer(d.serverName)),
    );
    const conflictKey = [...conflicts].sort().join('\n');
    if (conflictKey !== this.loggedConflicts) {
      this.loggedConflicts = conflictKey;
      if (conflicts.size > 0) log('[FolderMcpView] tool names claimed by both a folder and a user server, hidden: %o', [...conflicts]);
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        log('[FolderMcpView] tools-changed listener threw: %O', error);
      }
    }
  }
}

/** Names both sides claim; reserved prefixes make this empty except while a rename is in flight. */
function conflictingNames(a: readonly McpToolDescriptor[], b: readonly McpToolDescriptor[]): Set<string> {
  const names = new Set(a.map((d) => d.piName));
  return new Set(b.filter((d) => names.has(d.piName)).map((d) => d.piName));
}
