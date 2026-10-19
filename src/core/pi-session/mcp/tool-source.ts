import type {
  ListResourcesResult,
  ListResourceTemplatesResult,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
} from '@earendil-works/pi-mcp';
import type { McpServerStatusInfo, McpToolExposureSetting } from '../../../shared/types/mcp';
import type { McpToolDescriptor } from './types';
import type { ElicitationUI } from './elicitation-handler';
import type { McpCallResult } from './mcp-client-manager';

export interface McpToolCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  elicitationUi?: ElicitationUI;
  /** The call fails as a vanished tool or server when the live one under this name has another `serverId`. */
  expectedServerId?: string;
  /** The servers with resources the caller reaches, which a resource error names; the source's own list when omitted. */
  reachableResourceServers?: () => McpResourceServer[];
}

/** A server's effective resource exposure: config default (`exposeResources`, `exposure`) under `damocles.mcp.resourceExposure`. */
export type McpResourceExposure = McpToolExposureSetting;

/** A server the resource tools reach. */
export interface McpResourceServer {
  serverName: string;
  /** Opaque identity of the serving manager plus server name, as on `McpToolDescriptor`. */
  serverId: string;
  exposure: Exclude<McpResourceExposure, 'off'>;
}

/** The MCP tools, statuses and server actions one panel may use; a panel never reaches an MCP manager directly. */
export interface McpToolSource {
  getAllToolDescriptors(): McpToolDescriptor[];
  getToolDescriptor(piName: string): McpToolDescriptor | undefined;
  allToolNames(): string[];
  /** Tools whose exposure is `off`; the panel subtracts them from eligibility. */
  offToolNames(): string[];
  /** Tools whose exposure is `deferred`: the only MCP tools ToolSearch may offer or activate. */
  deferrableToolNames(): string[];
  /** Enabled servers still connecting whose tools include, or may include, an Always-loaded one. */
  pendingDirectServers(): string[];
  /** Unknown name is not read-only, so the permission gate asks. */
  isMcpReadOnly(piName: string): boolean;
  getServerStatuses(): McpServerStatusInfo[];
  onToolsChanged(listener: () => void): () => void;
  /** Throws for a tool this source does not expose. */
  callTool(piName: string, args: Record<string, unknown>, opts?: McpToolCallOptions): Promise<McpCallResult>;
  /** False for a server this source does not expose. */
  reconnectOrAuthenticate(name: string): Promise<boolean>;
  /** False for a server this source does not expose. */
  reauthenticate(name: string): Promise<boolean>;
  /** No-op for a server this source does not expose. */
  signOut(name: string): Promise<void>;

  /**
   * Servers this source exposes that offer resources (the live capability, else the cached flag) and
   * whose effective resource exposure is not off, sorted by name.
   *
   * Each resource request below awaits the server's connection and uses its timeout. It throws for a
   * server this source does not expose (naming the servers with resources), one whose resource exposure
   * is off, one without resources, and one whose `serverId` differs from `opts.expectedServerId`.
   */
  resourceServers(): McpResourceServer[];
  listResourcesPage(server: string, cursor: string | undefined, opts?: McpToolCallOptions): Promise<ListResourcesResult>;
  listResources(server: string, opts?: McpToolCallOptions): Promise<Resource[]>;
  listResourceTemplatesPage(server: string, cursor: string | undefined, opts?: McpToolCallOptions): Promise<ListResourceTemplatesResult>;
  listResourceTemplates(server: string, opts?: McpToolCallOptions): Promise<ResourceTemplate[]>;
  readResource(server: string, uri: string, opts?: McpToolCallOptions): Promise<ReadResourceResult>;
}

/**
 * The user's own browse and attach from the MCP panel (D13). Each request makes every check of the
 * resource requests on `McpToolSource` but resource exposure, which shapes only the agent's tools, so a
 * server whose resources are Off is still browsable here. Never handed to an agent tool.
 */
export interface McpUserResourcePort {
  /** The `serverId` of the server `server` routes to now, for `expectedServerId`; undefined for one this port does not reach. */
  serverIdOf(server: string): string | undefined;
  listResourcesPage(server: string, cursor: string | undefined, opts?: McpToolCallOptions): Promise<ListResourcesResult>;
  listResourceTemplatesPage(server: string, cursor: string | undefined, opts?: McpToolCallOptions): Promise<ListResourceTemplatesResult>;
  readResource(server: string, uri: string, opts?: McpToolCallOptions): Promise<ReadResourceResult>;
  /**
   * MCP `completion/complete` for one argument of a resource template, `context` holding the template's
   * other values. No values from a server without the `completions` capability.
   */
  completeResourceArgument(
    server: string,
    templateUri: string,
    argument: string,
    value: string,
    context: Readonly<Record<string, string>>,
    opts?: McpToolCallOptions,
  ): Promise<string[]>;
}
