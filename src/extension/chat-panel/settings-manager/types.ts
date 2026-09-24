import * as vscode from "vscode";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";
import type { McpServerConfig, McpServerSource } from "../../../shared/types/mcp";
import type { WebviewHost } from "../types";
import type { FolderTarget } from "../../workspace-folders/folder-registry";

export type PostMessageFn = (host: WebviewHost, message: ExtensionToWebviewMessage) => void;

/** `user` servers are shared by every folder; `folder` servers belong to one workspace folder. */
export type McpServerScope = "user" | "folder";

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  /** Which config file this server was read from. See `McpServerSource` for what each member means. */
  source: McpServerSource;
  scope: McpServerScope;
  /**
   * True for servers the user cannot edit in Damocles: the two Claude imports, the Codex import, and
   * `damocles-local`, which is Damocles-owned but has no write path.
   */
  readonly?: boolean;
}

export interface SettingsManagerConfig {
  postMessage: PostMessageFn;
  secrets: vscode.SecretStorage;
  /**
   * Workspace-scoped Memento backing the MCP disabled lists (user-scope names, and per-folder names)
   * and the progress keys of the one-time split between them.
   */
  workspaceState: vscode.Memento;
  /** The open folders, whose MCP files are read and watched per folder. */
  folders: () => readonly FolderTarget[];
}
