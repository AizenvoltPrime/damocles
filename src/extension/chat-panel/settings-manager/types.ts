import * as vscode from "vscode";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";
import type { McpServerConfig } from "../../../shared/types/mcp";
import type { WebviewHost } from "../types";

export type PostMessageFn = (host: WebviewHost, message: ExtensionToWebviewMessage) => void;

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  /** 'workspace' for .mcp.json entries, 'claude' for read-only Claude Code/Desktop imports (US-014.2). */
  source?: "workspace" | "claude";
  /** True for imported servers the user cannot edit in Damocles. */
  readonly?: boolean;
}

export interface SettingsManagerConfig {
  postMessage: PostMessageFn;
  secrets: vscode.SecretStorage;
  /** Workspace-scoped Memento backing the Damocles-owned MCP disabled-server set (US-014.2). */
  workspaceState: vscode.Memento;
}
