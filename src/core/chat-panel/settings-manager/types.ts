import type { Platform } from "../../../platform/platform";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";
import type { McpServerConfig, McpServerErrorInfo, McpServerSource } from "../../../shared/types/mcp";
import type { PanelHost } from "../../../platform/window-service";
import type { FolderTarget } from "../../workspace-folders/folder-registry";

export type PostMessageFn = (host: PanelHost, message: ExtensionToWebviewMessage) => void;

/** `user` servers are shared by every folder; `folder` servers belong to one workspace folder. */
export type McpServerScope = "user" | "folder";

/** Why a configured server cannot be loaded; `message` is the English fallback and names no config value. */
export interface McpServerEntryError {
  message: string;
  errorInfo: McpServerErrorInfo;
}

export interface McpServerEntry {
  name: string;
  /** Null when the entry failed validation. */
  config: McpServerConfig | null;
  /** Set when the server cannot be loaded: an invalid entry, or one another server's name collides with. */
  error?: McpServerEntryError;
  enabled: boolean;
  /** Which config file this server was read from. See `McpServerSource` for what each member means. */
  source: McpServerSource;
  scope: McpServerScope;
  /**
   * True for servers the user cannot edit in Damocles: the Claude, Codex and pi imports, and
   * `damocles-local`, which is Damocles-owned but has no write path.
   */
  readonly?: boolean;
}

export interface SettingsManagerConfig {
  postMessage: PostMessageFn;
  /**
   * Host services. `state.workspace` backs the MCP disabled lists (user-scope names, and per-folder
   * names) and the progress keys of the one-time split between them.
   */
  platform: Platform;
  /** The open folders, whose MCP files are read and watched per folder. */
  folders: () => readonly FolderTarget[];
}
