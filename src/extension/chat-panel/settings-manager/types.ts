import * as vscode from "vscode";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";
import type { McpServerConfig } from "../../../shared/types/mcp";
import type { WebviewHost } from "../types";

export type PostMessageFn = (host: WebviewHost, message: ExtensionToWebviewMessage) => void;

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
}

export interface PluginEntry {
  name: string;
  fullId: string;
  path: string;
  version?: string;
  description?: string;
  enabled: boolean;
}

export interface SettingsManagerConfig {
  postMessage: PostMessageFn;
  secrets: vscode.SecretStorage;
}
