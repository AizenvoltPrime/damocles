import type { McpServerStatusInfo } from '../../../shared/types/mcp';
import type { McpToolDescriptor } from './types';
import type { ElicitationUI } from './elicitation-handler';
import type { McpCallResult } from './mcp-client-manager';

export interface McpToolCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  elicitationUi?: ElicitationUI;
  /** The call fails as a vanished tool when the live tool under this name has another `serverId`. */
  expectedServerId?: string;
}

/** The MCP tools, statuses and server actions one panel may use; a panel never reaches an MCP manager directly. */
export interface McpToolSource {
  getAllToolDescriptors(): McpToolDescriptor[];
  getToolDescriptor(piName: string): McpToolDescriptor | undefined;
  allToolNames(): string[];
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
}
