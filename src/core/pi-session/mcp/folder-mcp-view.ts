import type { McpServerStatusInfo } from '../../../shared/types/mcp';
import type { SettingInspection } from '../../../platform/settings-store';
import type { McpToolDescriptor } from './types';
import type { McpCallResult, McpClientManager } from './mcp-client-manager';
import type { LegacyToolNameInput } from './tool-name-migration';
import type { McpToolCallOptions, McpToolSource } from './tool-source';
import { layersExposeDirect, resolveToolExposure, toolExposureLayers, type ToolExposureLayer } from './exposure';
import { log } from '../../logger';

/** This folder's `damocles.mcp.toolExposure` layers and whether the folder is trusted, read on every call. */
export type ToolExposureContext = () => { inspection: SettingInspection<unknown>; trusted: boolean };

/**
 * One folder's MCP tools: its own folder-scope manager plus the user-scope servers visible in that folder.
 * A user server outside `userVisible`, or shadowed by a same-named folder server, never appears here and
 * cannot be called, reconnected, authenticated or signed out through it.
 *
 * The managers give each tool its config exposure; this view overlays `damocles.mcp.toolExposure`,
 * because project and local values apply only in a trusted folder and the user manager serves every folder.
 */
export class FolderMcpView implements McpToolSource {
  private userVisible = new Set<string>();
  private loggedConflicts = '';
  private readonly listeners = new Set<() => void>();
  private readonly user: McpClientManager;
  private readonly folder: McpClientManager;
  private readonly unsubscribers: (() => void)[];
  private readonly exposureContext: ToolExposureContext | undefined;

  constructor(user: McpClientManager, folder: McpClientManager, exposureContext?: ToolExposureContext) {
    this.user = user;
    this.folder = folder;
    this.exposureContext = exposureContext;
    this.unsubscribers = [
      user.onToolsChanged(() => {
        // User tool names can move on a user reconcile; the folder side must step off them before anyone reads names.
        // A folder rename already emitted through the folder listener below.
        if (!this.folder.refreshReservedToolNames()) this.emit();
      }),
      folder.onToolsChanged(() => this.emit()),
    ];
  }

  /** Replace the user servers visible in this folder; renames folder tools off newly visible user tool names. */
  setUserVisible(names: readonly string[]): void {
    const next = new Set(names);
    if (next.size === this.userVisible.size && [...next].every((name) => this.userVisible.has(name))) return;
    this.userVisible = next;
    if (!this.folder.refreshReservedToolNames()) this.emit();
  }

  /** The tool names the user servers visible here hold; the folder manager must avoid them. */
  reservedToolNames(): ReadonlySet<string> {
    return new Set(
      this.user.getAllToolDescriptors().filter((d) => this.isVisibleUserServer(d.serverName)).map((d) => d.piName),
    );
  }

  /** What this folder's tools' legacy names were built from, for migrating stored names. */
  legacyToolNameInput(): LegacyToolNameInput {
    return {
      userServers: this.user.enabledServerNames(),
      visibleUserServers: [...this.userVisible].filter((name) => !this.folderHas(name)),
      folderServers: this.folder.enabledServerNames(),
      userTools: this.user.toolNameEntries().filter((entry) => this.isVisibleUserServer(entry.serverName)),
      folderTools: this.folder.toolNameEntries(),
    };
  }

  onToolsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getAllToolDescriptors(): McpToolDescriptor[] {
    const folderTools = this.folder.getAllToolDescriptors();
    const userTools = this.user.getAllToolDescriptors().filter((d) => this.isVisibleUserServer(d.serverName));
    const conflicts = conflictingNames(folderTools, userTools);
    const layers = this.exposureLayers();
    return [...userTools, ...folderTools].filter((d) => !conflicts.has(d.piName)).map((d) => withExposure(d, layers));
  }

  getToolDescriptor(piName: string): McpToolDescriptor | undefined {
    const owner = this.toolOwner(piName);
    const descriptor = owner?.getToolDescriptor(piName);
    return descriptor && withExposure(descriptor, this.exposureLayers());
  }

  allToolNames(): string[] {
    return this.getAllToolDescriptors().map((d) => d.piName);
  }

  offToolNames(): string[] {
    return this.getAllToolDescriptors().filter((d) => d.exposure === 'off').map((d) => d.piName);
  }

  deferrableToolNames(): string[] {
    return this.getAllToolDescriptors().filter((d) => d.exposure === 'deferred').map((d) => d.piName);
  }

  pendingDirectServers(): string[] {
    const layers = this.exposureLayers();
    const descriptors = this.getAllToolDescriptors();
    const pending = (manager: McpClientManager, names: readonly string[]): string[] =>
      names.filter((name) =>
        manager.serverConfigMayExposeDirect(name) ||
        layersExposeDirect(layers, name) ||
        descriptors.some((d) => d.serverName === name && d.exposure === 'direct'));
    return [
      ...pending(this.user, this.user.connectingServerNames().filter((name) => this.isVisibleUserServer(name))),
      ...pending(this.folder, this.folder.connectingServerNames()),
    ];
  }

  isMcpReadOnly(piName: string): boolean {
    return this.getToolDescriptor(piName)?.readOnly === true;
  }

  getServerStatuses(): McpServerStatusInfo[] {
    const userStatuses = this.user.getServerStatuses().filter((status) => this.isVisibleUserServer(status.name));
    const layers = this.exposureLayers();
    return [...userStatuses, ...this.folder.getServerStatuses()].map((status) => {
      if (!status.tools) return status;
      const tools = status.tools.map((tool) => {
        const resolved = resolveToolExposure(layers, status.name, tool.name, tool.configExposure ?? 'deferred');
        return { ...tool, exposure: resolved.exposure, exposureSource: resolved.source };
      });
      return { ...status, tools };
    });
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

  private exposureLayers(): ToolExposureLayer[] {
    if (!this.exposureContext) return [];
    const { inspection, trusted } = this.exposureContext();
    return toolExposureLayers(inspection, trusted);
  }

  private folderHas(name: string): boolean {
    return this.folder.hasServer(name);
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

function withExposure(descriptor: McpToolDescriptor, layers: readonly ToolExposureLayer[]): McpToolDescriptor {
  if (layers.length === 0) return descriptor;
  const resolved = resolveToolExposure(layers, descriptor.serverName, descriptor.rawToolName, descriptor.configExposure);
  return { ...descriptor, exposure: resolved.exposure, exposureSource: resolved.source };
}

/** Names both sides claim; reserved tool names make this empty except while a rename is in flight. */
function conflictingNames(a: readonly McpToolDescriptor[], b: readonly McpToolDescriptor[]): Set<string> {
  const names = new Set(a.map((d) => d.piName));
  return new Set(b.filter((d) => names.has(d.piName)).map((d) => d.piName));
}
