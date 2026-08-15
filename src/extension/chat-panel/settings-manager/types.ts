import * as vscode from "vscode";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";
import type { McpServerConfig, McpServerSource } from "../../../shared/types/mcp";
import type { WebviewHost } from "../types";

export type PostMessageFn = (host: WebviewHost, message: ExtensionToWebviewMessage) => void;

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  /** Which config file this server was read from. See `McpServerSource` for what each member means. */
  source?: McpServerSource;
  /** True for imported servers the user cannot edit in Damocles (`claude` and `codex`). */
  readonly?: boolean;
}

export interface SettingsManagerConfig {
  postMessage: PostMessageFn;
  secrets: vscode.SecretStorage;
  /** Workspace-scoped Memento backing the Damocles-owned MCP disabled-server set (US-014.2). */
  workspaceState: vscode.Memento;
}
